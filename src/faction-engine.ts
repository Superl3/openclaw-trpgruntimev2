import { createHash } from "node:crypto";
import type { TrpgRuntimeConfig } from "./config.js";
import { loadStructuredWorldFile } from "./world-store.js";

export type FactionTickTrigger = "turn" | "scene_transition" | "session" | "downtime";
export type FactionTickMode = "read-only" | "dry-run";

type Obj = Record<string, unknown>;

export type FactionTickInput = {
  trigger?: FactionTickTrigger;
  mode?: FactionTickMode;
  maxEvents?: number;
  includeUndropped?: boolean;
  forceAdvance?: boolean;
  prompt?: string;
};

type ZoneEventType =
  | "access_change"
  | "resource_shift"
  | "presence_shift"
  | "rumor_wave"
  | "environmental_omen"
  | "institutional_scrutiny"
  | "violence_trace"
  | "trade_disruption";

export type WorldEventObject = {
  event_id: string;
  source_factions: string[];
  event_type: ZoneEventType;
  trigger_cause: string;
  visibility_tier: "public" | "rumor" | "restricted" | "secret";
  directness_to_player: "direct" | "indirect" | "silent";
  affected_locations: string[];
  affected_zones: string[];
  affected_npcs: string[];
  clues_emitted: string[];
  rumors_emitted: string[];
  structural_consequences: Array<{
    kind:
      | "zone_pressure"
      | "district_tension"
      | "institution_scrutiny"
      | "access_control"
      | "npc_posture"
      | "pressure_clock";
    key: string;
    delta: number;
    summary: string;
  }>;
  expiration: {
    mode: "turns";
    remaining_turns: number;
    persistence: "temporary" | "persistent";
  };
  emission_policy: "drop_now" | "delay" | "silent";
  precursor_signals: string[];
  generated_at_tick: string;
};

export type FactionPatchDraft = {
  patchId: string;
  title: string;
  allowNewFiles: boolean;
  operations: Array<{ op: "set"; file: string; pointer: string; value: unknown }>;
};

export type FactionTickResult = {
  ok: boolean;
  engine_version: "faction-engine-v1";
  mode: FactionTickMode;
  trigger: FactionTickTrigger;
  tick: { current: string; previous: string; advanced: boolean; reason: string };
  generated_events: WorldEventObject[];
  emission_summary: { drop_now: string[]; delayed: string[]; silent: string[] };
  world_motion_summary: {
    pressure: string[];
    observations: string[];
    npc_posture: string[];
    rumors: string[];
    access_changes: string[];
  };
  patch_draft?: FactionPatchDraft;
};

function toObj(v: unknown): Obj {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}
function s(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function n(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const p = Number(v);
    if (Number.isFinite(p)) return p;
  }
  return fallback;
}
function b(v: unknown): boolean {
  return v === true;
}
function list(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean)
    : [];
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function h(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 10);
}

function inferPresence(raw: string): "low" | "medium" | "high" {
  return raw === "low" || raw === "high" ? raw : "medium";
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function normalizeZoneId(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function normalizeReachLevel(raw: unknown): ZoneReachLevel {
  if (typeof raw === "string") {
    const lowered = raw.trim().toLowerCase();
    if (lowered === "high" || lowered === "medium" || lowered === "low" || lowered === "none") {
      return lowered;
    }
  }
  return "none";
}

function reachScore(level: ZoneReachLevel): number {
  switch (level) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

function buildZoneLookup(params: { pressureRoot: Obj; scene: Obj }): Record<string, string> {
  const out: Record<string, string> = {};
  const register = (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    const normalized = normalizeZoneId(value);
    if (!normalized) return;
    out[value.toLowerCase()] = normalized;
    out[normalized] = normalized;
  };

  const zonesNode = params.pressureRoot.zones;
  if (Array.isArray(zonesNode)) {
    for (const entry of zonesNode) {
      const zone = toObj(entry);
      register(s(zone.id));
      register(s(zone.name));
      for (const alias of list(zone.aliases)) {
        register(alias);
      }
    }
  }

  const zonePressure = toObj(params.pressureRoot.zone_pressure);
  for (const zoneId of Object.keys(zonePressure)) {
    register(zoneId);
  }

  const districtTension = toObj(params.pressureRoot.district_tension);
  for (const zoneId of Object.keys(districtTension)) {
    register(zoneId);
  }

  const location = toObj(params.scene.location);
  register(s(location.zone_id));
  register(s(location.site));
  for (const zoneId of list(location.nearby_zone_ids)) {
    register(zoneId);
  }

  return out;
}

function resolveZoneId(raw: string, zoneLookup: Record<string, string>): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return zoneLookup[trimmed.toLowerCase()] || normalizeZoneId(trimmed);
}

function classifyEventType(params: {
  operation: string;
  major: boolean;
  visibility: WorldEventObject["visibility_tier"];
  directness: WorldEventObject["directness_to_player"];
}): ZoneEventType {
  const op = params.operation.toLowerCase();
  if (/검문|통행|출입|checkpoint|access|gate|봉쇄|lockdown|inspection|permit/.test(op)) return "access_change";
  if (/선적|하역|cargo|trade|market|supply|ledger|resource|shipment/.test(op)) return params.major ? "trade_disruption" : "resource_shift";
  if (/순찰|배치|presence|patrol|escort|deployment/.test(op)) return "presence_shift";
  if (/소문|rumor|whisper/.test(op)) return "rumor_wave";
  if (/의식|봉인|징조|omen|weather|blight|ritual/.test(op)) return "environmental_omen";
  if (/청문|심문|scrutiny|audit|tribunal|council|court/.test(op)) return "institutional_scrutiny";
  if (/습격|폭력|violence|blood|raid|ambush/.test(op)) return "violence_trace";
  if (params.visibility === "rumor") return "rumor_wave";
  if (params.major) return "trade_disruption";
  if (params.directness === "direct") return "presence_shift";
  return "resource_shift";
}

type ZoneReachLevel = "none" | "low" | "medium" | "high";

type Faction = {
  id: string;
  name: string;
  objectives: { short: string[]; mid: string[] };
  methods: string[];
  assets: string[];
  pressure: number;
  heat: number;
  instability: number;
  visibility: { public_presence: "low" | "medium" | "high"; covert_presence: "low" | "medium" | "high" };
  hooks: {
    default_locations: string[];
    default_zones: string[];
    default_npcs: string[];
    small: string[];
    major: string[];
  };
  reach: Record<string, ZoneReachLevel>;
};

type Agenda = {
  active_goals: string[];
  current_operations: string[];
  next_plausible_moves: string[];
  blockers: string[];
  escalation_threshold: { soft: number; hard: number; major_requires_precursors: number };
  decay_drift_rule: { pressure_decay_per_tick: number; instability_drift: number };
  pressure: number;
  instability: number;
  last_advanced_tick: string;
  minor_motion_streak: number;
};

function parseFactions(parsed: unknown, zoneLookup: Record<string, string>): Faction[] {
  const out: Faction[] = [];
  const arr = Array.isArray(toObj(parsed).factions) ? (toObj(parsed).factions as unknown[]) : [];
  for (const entry of arr) {
    const o = toObj(entry);
    const id = s(o.id || o.faction_id);
    if (!id) continue;

    const objectives = toObj(o.objectives);
    const methods = toObj(o.methods);
    const visibility = toObj(o.visibility);
    const pressure = toObj(o.pressure);
    const hooks = toObj(o.event_hooks);

    const defaultLocations = list(hooks.default_locations);
    const defaultZones = unique([
      ...list(hooks.default_zones).map((zoneId) => resolveZoneId(zoneId, zoneLookup)),
      ...defaultLocations.map((locationName) => resolveZoneId(locationName, zoneLookup)),
    ]).filter(Boolean);

    const reach: Record<string, ZoneReachLevel> = {};
    const reachRaw = toObj(o.faction_reach);
    for (const [rawZone, rawLevel] of Object.entries(reachRaw)) {
      const zoneId = resolveZoneId(rawZone, zoneLookup);
      if (!zoneId) continue;
      const level = normalizeReachLevel(rawLevel);
      if (level !== "none") {
        reach[zoneId] = level;
      }
    }

    for (const zoneId of defaultZones) {
      if (!reach[zoneId]) {
        reach[zoneId] = "medium";
      }
    }

    out.push({
      id,
      name: s(o.name) || id,
      objectives: {
        short: list(objectives.short).length ? list(objectives.short) : [s(o.current_goal || o.public_position || "maintain leverage")],
        mid: list(objectives.mid).length ? list(objectives.mid) : [s(o.hidden_objective || "expand influence")],
      },
      methods: list(methods.preferred_moves).length ? list(methods.preferred_moves) : [s(o.public_position || "pressure maneuver")],
      assets: list(o.assets),
      pressure: clamp(n(pressure.current, n(o.pressure, 50)), 0, 100),
      heat: clamp(n(o.heat, 45), 0, 100),
      instability: clamp(n(o.instability, 35), 0, 100),
      visibility: {
        public_presence: inferPresence(s(visibility.public_presence)),
        covert_presence: inferPresence(s(visibility.covert_presence)),
      },
      hooks: {
        default_locations: defaultLocations,
        default_zones: defaultZones,
        default_npcs: list(hooks.default_npcs),
        small: list(hooks.small_motion_signals).length ? list(hooks.small_motion_signals) : ["rumor drift", "presence shift"],
        major: list(hooks.major_motion_signals).length ? list(hooks.major_motion_signals) : ["access lockdown", "institution crackdown"],
      },
      reach,
    });
  }
  return out;
}

function normalizeAgenda(raw: Obj, faction: Faction): Agenda {
  const e = toObj(raw.escalation_threshold);
  const d = toObj(raw.decay_drift_rule);
  return {
    active_goals: list(raw.active_goals).length ? list(raw.active_goals) : faction.objectives.short.slice(0, 2),
    current_operations: list(raw.current_operations).length ? list(raw.current_operations) : faction.methods.slice(0, 2),
    next_plausible_moves: list(raw.next_plausible_moves).length ? list(raw.next_plausible_moves) : faction.methods.slice(0, 3),
    blockers: list(raw.blockers),
    escalation_threshold: {
      soft: clamp(n(e.soft, 55), 0, 100),
      hard: clamp(n(e.hard, 78), 0, 100),
      major_requires_precursors: clamp(n(e.major_requires_precursors, 2), 1, 6),
    },
    decay_drift_rule: {
      pressure_decay_per_tick: clamp(n(d.pressure_decay_per_tick, 1), 0, 5),
      instability_drift: clamp(n(d.instability_drift, 0), -3, 3),
    },
    pressure: clamp(n(raw.pressure, faction.pressure), 0, 100),
    instability: clamp(n(raw.instability, faction.instability), 0, 100),
    last_advanced_tick: s(raw.last_advanced_tick) || "bootstrap",
    minor_motion_streak: clamp(n(raw.minor_motion_streak, 0), 0, 99),
  };
}

function triggerFromPrompt(prompt?: string): FactionTickTrigger {
  const low = (prompt ?? "").toLowerCase();
  if (low.includes("/downtime")) return "downtime";
  if (low.includes("/scene")) return "scene_transition";
  if (low.includes("/new") || low.includes("/reset")) return "session";
  return "turn";
}
export { triggerFromPrompt as inferFactionTriggerFromPrompt };

function policyFor(visibility: WorldEventObject["visibility_tier"], directness: WorldEventObject["directness_to_player"]): WorldEventObject["emission_policy"] {
  if (directness === "direct" && visibility !== "secret") return "drop_now";
  if (visibility === "rumor" || directness === "indirect") return "delay";
  return "silent";
}

function formatAccess(controls: unknown): string[] {
  if (!Array.isArray(controls)) return [];
  return controls.slice(0, 6).map((entry) => {
    const o = toObj(entry);
    const zoneId = s(o.zone_id);
    const suffix = zoneId ? ` [${zoneId}]` : "";
    return `${s(o.label) || "access"}${suffix}: ${s(o.status) || "restricted"} (${s(o.cause) || "pressure"})`;
  });
}

export function formatFactionPromptSummary(result: FactionTickResult): string {
  const lines: string[] = [
    "[FACTION_ENGINE_WORLD_MOTION]",
    "Causality-first offscreen motion. Use as context and pressure, never as mandatory menu choices.",
    `tick=${result.tick.current} advanced=${result.tick.advanced ? "yes" : "no"} events=${result.generated_events.length}`,
  ];
  if (result.world_motion_summary.pressure.length) {
    lines.push("pressure:");
    for (const item of result.world_motion_summary.pressure.slice(0, 4)) lines.push(`- ${item}`);
  }
  if (result.world_motion_summary.observations.length) {
    lines.push("observations:");
    for (const item of result.world_motion_summary.observations.slice(0, 4)) lines.push(`- ${item}`);
  }
  if (result.world_motion_summary.npc_posture.length) {
    lines.push("npc_posture:");
    for (const item of result.world_motion_summary.npc_posture.slice(0, 4)) lines.push(`- ${item}`);
  }
  if (result.world_motion_summary.rumors.length) {
    lines.push("rumors:");
    for (const item of result.world_motion_summary.rumors.slice(0, 4)) lines.push(`- ${item}`);
  }
  if (result.world_motion_summary.access_changes.length) {
    lines.push("access_changes:");
    for (const item of result.world_motion_summary.access_changes.slice(0, 4)) lines.push(`- ${item}`);
  }
  lines.push("Prioritize current-zone and nearby-zone pressure signals before distant zones.");
  lines.push("Reflect events indirectly as environmental change, NPC posture shift, rumor hint, institution reaction, or access restriction.");
  lines.push("If the player already provided a freeform action, resolve it first and skip suggestion lists.");
  lines.push("Keep response order: context -> clues -> npc posture -> freeform invitation -> optional suggestions.");
  return lines.join("\n");
}

export async function runFactionEngineTick(params: { worldRoot: string; cfg: TrpgRuntimeConfig; input?: FactionTickInput }): Promise<FactionTickResult> {
  const mode: FactionTickMode = params.input?.mode === "dry-run" ? "dry-run" : "read-only";
  const trigger = params.input?.trigger ?? "scene_transition";
  const maxEvents = clamp(n(params.input?.maxEvents, 3), 1, 8);
  const includeUndropped = b(params.input?.includeUndropped);
  const forceAdvance = b(params.input?.forceAdvance);

  const [factionsFile, agendasFile, pressureFile, eventsFile, sceneFile, clockFile, travelFile] = await Promise.all([
    loadStructuredWorldFile(params.worldRoot, "canon/factions.yaml", { allowMissing: false, maxReadBytes: params.cfg.maxReadBytes }),
    loadStructuredWorldFile(params.worldRoot, "state/faction-agendas.yaml", { allowMissing: true, maxReadBytes: params.cfg.maxReadBytes }),
    loadStructuredWorldFile(params.worldRoot, "state/world-pressure.yaml", { allowMissing: true, maxReadBytes: params.cfg.maxReadBytes }),
    loadStructuredWorldFile(params.worldRoot, "state/world-events.yaml", { allowMissing: true, maxReadBytes: params.cfg.maxReadBytes }),
    loadStructuredWorldFile(params.worldRoot, "state/current-scene.yaml", { allowMissing: true, maxReadBytes: params.cfg.maxReadBytes }),
    loadStructuredWorldFile(params.worldRoot, "state/world-clock.yaml", { allowMissing: true, maxReadBytes: params.cfg.maxReadBytes }),
    loadStructuredWorldFile(params.worldRoot, "state/travel-state.yaml", { allowMissing: true, maxReadBytes: params.cfg.maxReadBytes }),
  ]);

  const scene = toObj(toObj(sceneFile.parsed).scene);
  const pressureRoot = toObj(pressureFile.parsed);
  const zoneLookup = buildZoneLookup({ pressureRoot, scene });
  const factions = parseFactions(factionsFile.parsed, zoneLookup);

  const location = toObj(scene.location);
  const travelState = toObj(toObj(travelFile.parsed).travel_state);
  const currentZoneId =
    resolveZoneId(s(travelState.current_zone), zoneLookup) ||
    resolveZoneId(s(location.zone_id) || s(location.site), zoneLookup) ||
    "zone-unknown";

  const topology = toObj(pressureRoot.zone_topology);
  const nearbyMap = toObj(topology.nearby_zones);
  const zonesNode = Array.isArray(pressureRoot.zones) ? pressureRoot.zones : [];
  const zoneNode = (zonesNode as unknown[])
    .map((entry) => toObj(entry))
    .find((entry) => resolveZoneId(s(entry.id), zoneLookup) === currentZoneId);

  const nearbyZoneIds = unique(
    [
      ...list(location.nearby_zone_ids),
      ...list(travelState.path).slice(0, 2),
      ...list(zoneNode?.connections),
      ...list(zoneNode?.nearby_zone_ids),
      ...list(nearbyMap[currentZoneId]),
    ]
      .map((zoneId) => resolveZoneId(zoneId, zoneLookup))
      .filter(Boolean)
      .filter((zoneId) => zoneId !== currentZoneId),
  );

  const clockObj = toObj(toObj(clockFile.parsed).clock);
  const day = clamp(n(clockObj.campaign_day, 1), 1, 9999);
  const sceneId = s(scene.id) || "scene-unknown";
  const turnIndex = clamp(n(scene.turn_index, 1), 1, 9999);
  const tick =
    trigger === "scene_transition"
      ? `${trigger}:day-${day}:scene-${sceneId}`
      : `${trigger}:day-${day}:scene-${sceneId}:turn-${turnIndex}`;

  const agendaRoot = toObj(agendasFile.parsed);
  const agendaMap = toObj(agendaRoot.faction_agenda_state);
  const engine = toObj(pressureRoot.engine_state);
  const previousTick = s(engine.last_advanced_tick) || "bootstrap";
  const advanced = forceAdvance || previousTick != tick;

  const zonePressure = toObj(pressureRoot.zone_pressure);
  const district = toObj(pressureRoot.district_tension);
  if (Object.keys(zonePressure).length === 0) {
    for (const [zoneId, entry] of Object.entries(district)) {
      const legacy = toObj(entry);
      const score = clamp(n(legacy.score, n(legacy.pressure, 45)), 0, 100);
      zonePressure[zoneId] = {
        label: s(legacy.label) || zoneId,
        pressure: score,
        score,
        trend: s(legacy.trend) || "stable",
        soft_threshold: clamp(n(legacy.soft_threshold, 55), 0, 100),
        hard_threshold: clamp(n(legacy.hard_threshold, 80), 0, 100),
        signals: list(legacy.signals),
      };
    }
  }

  if (!zonePressure[currentZoneId]) {
    zonePressure[currentZoneId] = {
      label: s(location.site) || currentZoneId,
      pressure: 45,
      score: 45,
      trend: "stable",
      soft_threshold: 55,
      hard_threshold: 80,
      signals: [],
    };
  }

  const scrutiny = toObj(pressureRoot.institution_scrutiny);
  const clocks = Array.isArray(pressureRoot.offscreen_pressure_clocks) ? pressureRoot.offscreen_pressure_clocks : [];
  const accessControls = Array.isArray(pressureRoot.access_controls) ? pressureRoot.access_controls : [];

  const eventsRoot = toObj(eventsFile.parsed);
  const eventsNode = toObj(eventsRoot.events);
  const history = Array.isArray(eventsNode.history) ? [...(eventsNode.history as WorldEventObject[])] : [];
  const pendingDrop = Array.isArray(eventsNode.pending_drop) ? [...(eventsNode.pending_drop as WorldEventObject[])] : [];
  const delayed = Array.isArray(eventsNode.delayed_reflections) ? [...(eventsNode.delayed_reflections as WorldEventObject[])] : [];
  const silent = Array.isArray(eventsNode.silent_state_changes) ? [...(eventsNode.silent_state_changes as WorldEventObject[])] : [];

  const generated: WorldEventObject[] = [];
  if (advanced) {
    const ranked = factions
      .map((faction) => {
        const agenda = normalizeAgenda(toObj(agendaMap[faction.id]), faction);
        const score =
          agenda.pressure + Math.round(agenda.instability * 0.4) + Math.round(faction.heat * 0.25) - agenda.blockers.length * 3;
        return { faction, agenda, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, maxEvents);

    for (let i = 0; i < ranked.length; i += 1) {
      const row = ranked[i] as (typeof ranked)[number];
      const major =
        row.score >= row.agenda.escalation_threshold.hard &&
        row.agenda.minor_motion_streak >= row.agenda.escalation_threshold.major_requires_precursors;
      const opSeed = `${tick}:${row.faction.id}:${i}`;
      const opPool = row.agenda.current_operations.length
        ? row.agenda.current_operations
        : row.agenda.next_plausible_moves.length
          ? row.agenda.next_plausible_moves
          : row.faction.methods;
      const op = opPool[Number.parseInt(h(opSeed).slice(0, 2), 16) % opPool.length] || "pressure maneuver";
      const goalPool = row.agenda.active_goals.length ? row.agenda.active_goals : row.faction.objectives.short;
      const goal = goalPool[Number.parseInt(h(opSeed + ":goal").slice(0, 2), 16) % goalPool.length] || "retain influence";

      const visibility: WorldEventObject["visibility_tier"] = major
        ? row.faction.visibility.public_presence === "high"
          ? "public"
          : "restricted"
        : row.faction.visibility.covert_presence === "high"
          ? "secret"
          : row.faction.visibility.public_presence === "low"
            ? "rumor"
            : "restricted";

      const fallbackZones = row.faction.hooks.default_zones.length
        ? row.faction.hooks.default_zones
        : [currentZoneId];
      const affectedZones = unique(
        [
          ...Object.keys(row.faction.reach)
            .sort((a, b) => reachScore(row.faction.reach[b] ?? "none") - reachScore(row.faction.reach[a] ?? "none"))
            .slice(0, 2),
          ...fallbackZones,
        ].filter(Boolean),
      ).slice(0, 2);

      const reachesCurrentZone = reachScore(row.faction.reach[currentZoneId] ?? "none") >= reachScore("medium");
      const touchesCurrentZone = affectedZones.includes(currentZoneId);
      const touchesNearbyZone = affectedZones.some((zoneId) => nearbyZoneIds.includes(zoneId));

      const directness: WorldEventObject["directness_to_player"] =
        visibility === "secret"
          ? "silent"
          : touchesCurrentZone || reachesCurrentZone
            ? "direct"
            : touchesNearbyZone
              ? "indirect"
              : "indirect";

      const eventType = classifyEventType({ operation: op, major, visibility, directness });
      const policy = policyFor(visibility, directness);

      const event: WorldEventObject = {
        event_id: `evt-${h(opSeed)}`,
        source_factions: [row.faction.id],
        event_type: eventType,
        trigger_cause: `${row.faction.name} advances '${goal}' via '${op}' (pressure=${row.agenda.pressure}, instability=${row.agenda.instability})`,
        visibility_tier: visibility,
        directness_to_player: directness,
        affected_locations: affectedZones,
        affected_zones: affectedZones,
        affected_npcs: row.faction.hooks.default_npcs.slice(0, 3),
        clues_emitted: [
          `${row.faction.name} shifted operation focus to ${op}`,
          `${row.faction.name} pressure trend crossed ${major ? "hard" : "soft"} threshold pressure`,
          `Motion concentrates around zones: ${affectedZones.join(", ")}`,
        ],
        rumors_emitted: visibility === "secret" ? [] : [`Rumor: ${row.faction.name} is repositioning around ${affectedZones.join(", ")}`],
        structural_consequences: [
          ...affectedZones.map((zoneId, index) => ({
            kind: "zone_pressure" as const,
            key: zoneId,
            delta: major ? (index === 0 ? 6 : 4) : index === 0 ? 2 : 1,
            summary: major ? "zone pressure spikes" : "zone pressure rises",
          })),
          { kind: "institution_scrutiny", key: row.faction.id, delta: major ? 4 : 1, summary: "institution scrutiny rises" },
          { kind: "pressure_clock", key: row.faction.id, delta: major ? 4 : 1, summary: "offscreen pressure clock advances" },
          ...(major ? [{ kind: "access_control", key: affectedZones[0] || currentZoneId, delta: 1, summary: "access restrictions tighten" } as const] : []),
          ...(row.faction.hooks.default_npcs.length
            ? [{ kind: "npc_posture", key: row.faction.hooks.default_npcs[0] as string, delta: major ? 2 : 1, summary: "npc posture hardens" } as const]
            : []),
        ],
        expiration: { mode: "turns", remaining_turns: major ? 5 : 2, persistence: major ? "persistent" : "temporary" },
        emission_policy: policy,
        precursor_signals: major ? row.faction.hooks.major.slice(0, 3) : row.faction.hooks.small.slice(0, 3),
        generated_at_tick: tick,
      };
      generated.push(event);

      row.agenda.pressure = clamp(
        row.agenda.pressure + (major ? 4 : 2) - row.agenda.decay_drift_rule.pressure_decay_per_tick,
        0,
        100,
      );
      row.agenda.instability = clamp(
        row.agenda.instability + row.agenda.decay_drift_rule.instability_drift + (major ? 2 : 0),
        0,
        100,
      );
      row.agenda.last_advanced_tick = tick;
      row.agenda.minor_motion_streak = major ? 0 : clamp(row.agenda.minor_motion_streak + 1, 0, 99);
      agendaMap[row.faction.id] = row.agenda;

      for (const c of event.structural_consequences) {
        if (c.kind === "zone_pressure" || c.kind === "district_tension") {
          const prev = toObj(zonePressure[c.key]);
          const current = clamp(n(prev.pressure, n(prev.score, 45)), 0, 100);
          const next = clamp(current + c.delta, 0, 100);
          const signals = unique([...list(prev.signals), event.event_type, ...event.precursor_signals]).slice(0, 8);

          zonePressure[c.key] = {
            label: s(prev.label) || c.key,
            pressure: next,
            score: next,
            trend: c.delta > 0 ? "up" : c.delta < 0 ? "down" : "stable",
            soft_threshold: clamp(n(prev.soft_threshold, 55), 0, 100),
            hard_threshold: clamp(n(prev.hard_threshold, 80), 0, 100),
            signals,
          };

          district[c.key] = {
            label: s(toObj(zonePressure[c.key]).label) || c.key,
            score: next,
            trend: c.delta > 0 ? "up" : c.delta < 0 ? "down" : "stable",
            soft_threshold: clamp(n(prev.soft_threshold, 55), 0, 100),
            hard_threshold: clamp(n(prev.hard_threshold, 80), 0, 100),
          };
        } else if (c.kind === "institution_scrutiny") {
          const prev = toObj(scrutiny[c.key]);
          scrutiny[c.key] = {
            label: s(prev.label) || c.key,
            score: clamp(n(prev.score, 40) + c.delta, 0, 100),
            trend: c.delta > 0 ? "up" : c.delta < 0 ? "down" : "stable",
          };
        } else if (c.kind === "pressure_clock") {
          const found = (clocks as unknown[]).find((entry) => s(toObj(entry).id) === c.key) as Obj | undefined;
          if (found) {
            found.score = clamp(n(found.score, 40) + c.delta + n(found.drift, 1), 0, 100);
          } else {
            (clocks as unknown[]).push({
              id: c.key,
              label: `${c.key} pressure`,
              score: clamp(40 + c.delta, 0, 100),
              soft_threshold: 55,
              hard_threshold: 80,
              drift: 1,
            });
          }
        } else if (c.kind === "access_control") {
          (accessControls as unknown[]).unshift({
            id: `access-${event.event_id}`,
            zone_id: c.key,
            label: s(toObj(zonePressure[c.key]).label) || c.key,
            status: "restricted",
            cause: c.summary,
            event_id: event.event_id,
          });
        }
      }

      if (policy === "drop_now") pendingDrop.unshift(event);
      else if (policy === "delay") delayed.unshift(event);
      else silent.unshift(event);
      history.unshift(event);
    }
  }

  const focusZones = new Set(unique([currentZoneId, ...nearbyZoneIds]));
  const eventTouchesFocus = (event: WorldEventObject) => {
    if (focusZones.size === 0) return true;
    const zones = unique([...list(event.affected_zones), ...list(event.affected_locations)]);
    return zones.some((zoneId) => focusZones.has(zoneId));
  };

  const generatedFocus = generated.filter(eventTouchesFocus);
  const historyFocus = history.filter(eventTouchesFocus);
  const pendingFocus = pendingDrop.filter(eventTouchesFocus);

  const summarySource = generatedFocus.length
    ? generatedFocus
    : includeUndropped
      ? historyFocus.length
        ? historyFocus.slice(0, 4)
        : history.slice(0, 4)
      : pendingFocus.length
        ? pendingFocus.slice(0, 4)
        : pendingDrop.slice(0, 4);

  const focusPressure = Array.from(focusZones)
    .map((zoneId) => {
      const node = toObj(zonePressure[zoneId]);
      if (Object.keys(node).length === 0) return "";
      const label = s(node.label) || zoneId;
      const pressure = clamp(n(node.pressure, n(node.score, 45)), 0, 100);
      const trend = s(node.trend) || "stable";
      return `${label}: pressure ${pressure} (${trend})`;
    })
    .filter(Boolean);

  const consequencePressure = summarySource
    .flatMap((e) => e.structural_consequences)
    .filter((c) => c.kind === "zone_pressure" || c.kind === "district_tension" || c.kind === "pressure_clock")
    .slice(0, 6)
    .map((c) => `${c.key}: ${c.summary} (${c.delta >= 0 ? "+" : ""}${c.delta})`);
  const result: FactionTickResult = {
    ok: true,
    engine_version: "faction-engine-v1",
    mode,
    trigger,
    tick: {
      current: tick,
      previous: previousTick,
      advanced,
      reason: advanced ? (forceAdvance ? "forceAdvance=true" : "tick changed") : "already advanced for this tick",
    },
    generated_events: generated,
    emission_summary: {
      drop_now: generated.filter((e) => e.emission_policy === "drop_now").map((e) => e.event_id),
      delayed: generated.filter((e) => e.emission_policy === "delay").map((e) => e.event_id),
      silent: generated.filter((e) => e.emission_policy === "silent").map((e) => e.event_id),
    },
    world_motion_summary: {
      pressure: unique([...focusPressure, ...consequencePressure]).slice(0, 6),
      observations: summarySource.flatMap((e) => e.clues_emitted).slice(0, 6),
      npc_posture: summarySource.flatMap((e) => e.affected_npcs.map((npc) => `${npc}: caution increased`)).slice(0, 6),
      rumors: summarySource.flatMap((e) => e.rumors_emitted).slice(0, 6),
      access_changes: formatAccess(accessControls),
    },
  };

  if (!advanced) return result;

  for (const [zoneId, zoneEntry] of Object.entries(zonePressure)) {
    const zone = toObj(zoneEntry);
    district[zoneId] = {
      label: s(zone.label) || zoneId,
      score: clamp(n(zone.score, n(zone.pressure, 45)), 0, 100),
      trend: s(zone.trend) || "stable",
      soft_threshold: clamp(n(zone.soft_threshold, 55), 0, 100),
      hard_threshold: clamp(n(zone.hard_threshold, 80), 0, 100),
    };
  }

  const now = new Date().toISOString();

  const nextZones = Array.isArray(pressureRoot.zones)
    ? pressureRoot.zones
    : Object.keys(zonePressure).map((zoneId) => ({
        id: zoneId,
        name: s(toObj(zonePressure[zoneId]).label) || zoneId,
        type: "settlement",
        parent_region: "",
        tags: [],
      }));

  const nextNearbyMap = {
    ...toObj(toObj(pressureRoot.zone_topology).nearby_zones),
    [currentZoneId]: unique(nearbyZoneIds),
  };

  const nextPressure = {
    meta: { schema_version: 1, last_updated: now },
    engine_state: {
      version: 1,
      last_advanced_tick: tick,
      total_advanced_ticks: clamp(n(engine.total_advanced_ticks, 0) + 1, 0, 1000000),
      last_trigger: trigger,
      last_scene_id: sceneId,
      last_scene_zone_id: currentZoneId,
    },
    zones: nextZones,
    zone_topology: {
      ...toObj(pressureRoot.zone_topology),
      nearby_zones: nextNearbyMap,
    },
    zone_pressure: zonePressure,
    offscreen_pressure_clocks: clocks,
    district_tension: district,
    institution_scrutiny: scrutiny,
    crisis_clocks: Array.isArray(pressureRoot.crisis_clocks) ? pressureRoot.crisis_clocks : [],
    access_controls: (accessControls as unknown[]).slice(0, 20),
  };
  const nextAgendas = {
    meta: { schema_version: 1, last_updated: now },
    engine_state: {
      version: 1,
      last_advanced_tick: tick,
      total_advanced_ticks: clamp(n(toObj(agendaRoot.engine_state).total_advanced_ticks, 0) + 1, 0, 1000000),
      last_trigger: trigger,
      last_scene_id: sceneId,
      last_scene_zone_id: currentZoneId,
    },
    faction_agenda_state: agendaMap,
  };
  const nextEvents = {
    meta: { schema_version: 1, last_updated: now },
    events: {
      history: history.slice(0, 240),
      pending_drop: pendingDrop.slice(0, 80),
      delayed_reflections: delayed.slice(0, 120),
      silent_state_changes: silent.slice(0, 120),
    },
  };

  result.patch_draft = {
    patchId: `faction-${h(tick)}`,
    title: `Faction Engine tick ${tick}`,
    allowNewFiles: true,
    operations: [
      { op: "set", file: "state/faction-agendas.yaml", pointer: "/", value: nextAgendas },
      { op: "set", file: "state/world-pressure.yaml", pointer: "/", value: nextPressure },
      { op: "set", file: "state/world-events.yaml", pointer: "/", value: nextEvents },
    ],
  };

  return result;
}
