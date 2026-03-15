import { createHash } from "node:crypto";
import type { TrpgRuntimeConfig } from "./config.js";
import {
  runPatchDryRun,
  runPatchApply,
  type PatchApplyInput,
  type PatchCache,
  type PatchDryRunInput,
} from "./patch-engine.js";
import { loadStructuredWorldFile } from "./world-store.js";

export const STATE_COMPACT_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: ["dry-run", "audited-apply"] },
    trigger: {
      type: "string",
      enum: ["manual", "scene_transition", "fast_wait", "downtime", "zone_generation", "interval"],
    },
    maxCandidates: { type: "integer", minimum: 1, maximum: 80 },
    includeProtected: { type: "boolean" },
    applyEvenWhenNoCandidates: { type: "boolean" },
    audit: {
      type: "object",
      additionalProperties: false,
      properties: {
        approved: { type: "boolean" },
        approvedBy: { type: "string", enum: ["canon-auditor"] },
        verdict: { type: "string", enum: ["pass", "fail"] },
        conflictStatus: { type: "string", enum: ["non-conflicting", "conflicting"] },
        canonAbsorptionVerdict: {
          type: "string",
          enum: ["accept", "reconcile", "reject-hard-conflict"],
        },
        note: { type: "string" },
      },
      required: ["approved", "approvedBy", "verdict", "conflictStatus"],
    },
  },
} as const;

export type CompactionMode = "dry-run" | "audited-apply";
export type CompactionTrigger =
  | "manual"
  | "scene_transition"
  | "fast_wait"
  | "downtime"
  | "zone_generation"
  | "interval";

type LifecycleState = "active" | "dormant" | "archived";

type ZoneGraphNode = {
  id: string;
  type: string;
  tags: string[];
  connections: string[];
  pressure: number | null;
};

type ZoneLifecycleMeta = {
  lifecycle_state: LifecycleState;
  last_active_turn_or_tick: string;
  last_player_presence: string;
  last_meaningful_change: string;
  significance_score: number;
  retention_weight: number;
  active_threads_count: number;
  archived_summary_ref?: string;
  reactivation_conditions: string[];
};


type CompactionCandidate = {
  candidate_id: string;
  source_type: string;
  source_ref: string;
  planned_move:
    | "active_to_dormant"
    | "dormant_to_archived"
    | "signal_compact"
    | "memory_compact"
    | "rumor_compact"
    | "noise_remove";
  probability: number;
  sampled: number;
  selected: boolean;
  reasons: string[];
  protected: boolean;
};

export type LifecycleCompactionPlan = {
  trigger: CompactionTrigger;
  maxCandidates: number;
  operations: Array<Record<string, unknown>>;
  candidates: CompactionCandidate[];
  protectedRefs: string[];
  skippedRefs: string[];
  summary: {
    considered: number;
    selected: number;
    activeToDormant: number;
    dormantToArchived: number;
    signalCompacted: number;
    memoryCompacted: number;
    rumorCompacted: number;
    noiseRemoved: number;
  };
};

export type StateCompactInput = {
  mode?: string;
  trigger?: string;
  maxCandidates?: number;
  includeProtected?: boolean;
  applyEvenWhenNoCandidates?: boolean;
  audit?: PatchApplyInput["audit"];
};

function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniqStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function normalizeZoneId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  return trimmed
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function coerceFiniteInteger(value: unknown, fallback: number): number {
  const parsed = readFiniteNumber(value);
  if (parsed === null) {
    return fallback;
  }
  return Math.max(0, Math.trunc(parsed));
}

function toLifecycleState(value: unknown): LifecycleState {
  const normalized = readString(value).toLowerCase();
  if (normalized === "active" || normalized === "dormant" || normalized === "archived") {
    return normalized;
  }
  return "active";
}


function parseCompactionMode(value: unknown): CompactionMode {
  return readString(value) === "audited-apply" ? "audited-apply" : "dry-run";
}

function parseCompactionTrigger(value: unknown): CompactionTrigger {
  const normalized = readString(value);
  if (
    normalized === "manual" ||
    normalized === "scene_transition" ||
    normalized === "fast_wait" ||
    normalized === "downtime" ||
    normalized === "zone_generation" ||
    normalized === "interval"
  ) {
    return normalized;
  }
  return "manual";
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.01;
  }
  return Math.max(0.01, Math.min(0.97, value));
}

function deterministicSample(seed: string): number {
  const digest = createHash("sha256").update(seed, "utf8").digest("hex");
  const token = digest.slice(0, 8);
  const parsed = Number.parseInt(token, 16);
  if (!Number.isFinite(parsed)) {
    return 0.5;
  }
  return parsed / 0xffffffff;
}

function readIsoMillis(value: unknown): number | null {
  const asString = readString(value);
  if (!asString) {
    return null;
  }
  const parsed = Date.parse(asString);
  return Number.isFinite(parsed) ? parsed : null;
}

function daysSinceIso(value: unknown, nowMs: number): number {
  const millis = readIsoMillis(value);
  if (millis === null) {
    return 999;
  }
  return Math.max(0, (nowMs - millis) / (1000 * 60 * 60 * 24));
}

function zoneTypeSignificance(type: string): number {
  const lower = type.toLowerCase();
  if (lower.includes("settlement") || lower.includes("city") || lower.includes("district")) return 58;
  if (lower.includes("road") || lower.includes("frontier")) return 49;
  if (lower.includes("port") || lower.includes("sea")) return 53;
  if (lower.includes("ruin") || lower.includes("dungeon") || lower.includes("shrine")) return 52;
  if (lower.includes("wilderness") || lower.includes("forest")) return 44;
  return 46;
}

function compactionProbability(params: {
  ageSinceReferenceDays: number;
  ageSincePresenceDays: number;
  significanceScore: number;
  liveDependencyCount: number;
  linkedToRevealOrHook: boolean;
  linkedToFactionAgenda: boolean;
  playerWitnessed: boolean;
  replaceableBySummary: boolean;
}): number {
  let probability = 0.05;
  probability += Math.min(1, params.ageSinceReferenceDays / 35) * 0.36;
  probability += Math.min(1, params.ageSincePresenceDays / 60) * 0.12;
  probability += (1 - Math.max(0, Math.min(1, params.significanceScore / 100))) * 0.28;
  probability += params.replaceableBySummary ? 0.17 : 0;
  probability -= Math.min(0.44, params.liveDependencyCount * 0.09);
  probability -= params.linkedToRevealOrHook ? 0.3 : 0;
  probability -= params.linkedToFactionAgenda ? 0.16 : 0;
  probability -= params.playerWitnessed ? 0.22 : 0;
  return clampProbability(probability);
}

function scoreRetentionWeight(params: {
  significanceScore: number;
  isProtected: boolean;
  playerWitnessed: boolean;
  hasLongTailSeed: boolean;
}): number {
  let weight = params.significanceScore / 100;
  if (params.isProtected) weight += 0.25;
  if (params.playerWitnessed) weight += 0.16;
  if (params.hasLongTailSeed) weight += 0.14;
  return Math.max(0.05, Math.min(0.99, Number(weight.toFixed(3))));
}

function makeDefaultCompactionStateRoot(): Record<string, unknown> {
  return {
    meta: { schema_version: 1, last_updated: new Date().toISOString() },
    compaction_state: {
      version: 1,
      run_count: 0,
      last_trigger: "bootstrap",
      last_run_at: "",
      zone_lifecycle: {},
    },
  };
}

function makeDefaultArchiveSummaryRoot(): Record<string, unknown> {
  return {
    meta: { schema_version: 1, last_updated: new Date().toISOString() },
    archive_summaries: [],
  };
}

let archiveSummarySequence = 0;

function createArchiveSummaryId(params: {
  sourceType: string;
  sourceRefs: string[];
  summary: string;
  usedIds: Set<string>;
}): string {
  const timestamp = Date.now();
  const normalizedRefs = uniqStrings(params.sourceRefs).join("|");
  let localAttempt = 0;
  while (localAttempt < 64) {
    archiveSummarySequence = (archiveSummarySequence + 1) % 1_000_000;
    const hashSource = [
      params.sourceType,
      normalizedRefs,
      params.summary,
      String(timestamp),
      String(archiveSummarySequence),
      String(localAttempt),
    ].join("|");
    const shortHash = createHash("sha256").update(hashSource, "utf8").digest("hex").slice(0, 6);
    const summaryId = "arch-" + String(timestamp) + "-" + shortHash;
    if (!params.usedIds.has(summaryId)) {
      params.usedIds.add(summaryId);
      return summaryId;
    }
    localAttempt += 1;
  }

  const fallbackHash = createHash("sha256")
    .update([params.sourceType, normalizedRefs, params.summary, String(timestamp), "fallback"].join("|"), "utf8")
    .digest("hex")
    .slice(0, 10);
  const fallbackId = "arch-" + String(timestamp) + "-" + fallbackHash;
  params.usedIds.add(fallbackId);
  return fallbackId;
}

function buildArchiveSummaryEntry(params: {
  sourceType: string;
  sourceRefs: string[];
  summary: string;
  retainedTags: string[];
  triggers: string[];
  usedIds: Set<string>;
}): Record<string, unknown> {
  return {
    summary_id: createArchiveSummaryId({
      sourceType: params.sourceType,
      sourceRefs: params.sourceRefs,
      summary: params.summary,
      usedIds: params.usedIds,
    }),
    source_type: params.sourceType,
    source_refs: uniqStrings(params.sourceRefs),
    compressed_text: params.summary,
    retained_tags: uniqStrings(params.retainedTags).slice(0, 8),
    possible_reactivation_triggers: uniqStrings(params.triggers).slice(0, 8),
    created_at: new Date().toISOString(),
  };
}



function buildZoneGraph(parsedPressure: unknown): Record<string, ZoneGraphNode> {
  const root = toObject(parsedPressure);
  const out: Record<string, ZoneGraphNode> = {};

  const upsert = (rawNode: Record<string, unknown>, fallbackId = "") => {
    const zoneId = normalizeZoneId(readString(rawNode.id) || readString(rawNode.zone_id) || fallbackId);
    if (!zoneId) {
      return;
    }

    const existing = out[zoneId];
    const connections = uniqStrings([
      ...(existing?.connections ?? []),
      ...toStringArray(rawNode.connections),
      ...toStringArray(rawNode.nearby_zone_ids),
      ...toStringArray(rawNode.nearby_zones),
    ])
      .map((entry) => normalizeZoneId(entry))
      .filter(Boolean)
      .filter((entry) => entry !== zoneId);

    out[zoneId] = {
      id: zoneId,
      type: readString(rawNode.type) || readString(rawNode.zone_type) || existing?.type || "settlement",
      tags: uniqStrings([...(existing?.tags ?? []), ...toStringArray(rawNode.tags)]),
      connections,
      pressure:
        readFiniteNumber(rawNode.pressure) ?? readFiniteNumber(rawNode.score) ?? existing?.pressure ?? null,
    };
  };

  const zones = root.zones;
  if (Array.isArray(zones)) {
    for (const zone of zones) {
      upsert(toObject(zone));
    }
  } else {
    for (const [zoneId, zone] of Object.entries(toObject(zones))) {
      upsert(toObject(zone), zoneId);
    }
  }

  for (const [zoneId, zone] of Object.entries(toObject(root.zone_pressure))) {
    upsert(toObject(zone), zoneId);
  }
  for (const [zoneId, zone] of Object.entries(toObject(root.district_tension))) {
    upsert(toObject(zone), zoneId);
  }

  const topology = toObject(toObject(root.zone_topology).nearby_zones);
  for (const [zoneId, nearby] of Object.entries(topology)) {
    const normalized = normalizeZoneId(zoneId);
    if (!normalized) continue;
    if (!out[normalized]) upsert({}, normalized);
    const nearbyZones = toStringArray(nearby)
      .map((entry) => normalizeZoneId(entry))
      .filter(Boolean)
      .filter((entry) => entry !== normalized);
    out[normalized].connections = uniqStrings([...out[normalized].connections, ...nearbyZones]);
  }

  for (const node of Object.values(out)) {
    for (const linked of node.connections) {
      if (!out[linked]) upsert({}, linked);
      out[linked].connections = uniqStrings([...out[linked].connections, node.id]);
    }
  }

  return out;
}

function countSeedThreadsByZone(worldSeedsRoot: Record<string, unknown>): Record<string, { total: number; longTail: number }> {
  const result: Record<string, { total: number; longTail: number }> = {};
  const zoneSeeds = Array.isArray(worldSeedsRoot.zone_seeds) ? worldSeedsRoot.zone_seeds : [];
  for (const entry of zoneSeeds) {
    const node = toObject(entry);
    const zoneId = normalizeZoneId(readString(node.zone_id));
    if (!zoneId) {
      continue;
    }
    const state = readString(node.state).toLowerCase() || "pending";
    if (state === "resolved" || state === "closed") {
      continue;
    }
    const tension = coerceFiniteInteger(node.tension_weight, 1);
    if (!result[zoneId]) {
      result[zoneId] = { total: 0, longTail: 0 };
    }
    result[zoneId].total += 1;
    if (tension >= 3 || readString(node.type) !== "rumor") {
      result[zoneId].longTail += 1;
    }
  }
  return result;
}

function collectFactionLinkedZones(factionRoot: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const focus = toObject(factionRoot.faction_zone_focus);
  for (const value of Object.values(focus)) {
    const node = toObject(value);
    const primary = normalizeZoneId(readString(node.primary_zone));
    if (primary) {
      out.add(primary);
    }
    for (const zone of toStringArray(node.secondary_zones)) {
      const normalized = normalizeZoneId(zone);
      if (normalized) {
        out.add(normalized);
      }
    }
  }
  return out;
}

function collectCurrentNearbyZoneSet(params: {
  sceneRoot: Record<string, unknown>;
  travelRoot: Record<string, unknown>;
  zoneGraph: Record<string, ZoneGraphNode>;
}): Set<string> {
  const out = new Set<string>();
  const sceneLocation = toObject(toObject(params.sceneRoot.scene).location);
  const sceneZone = normalizeZoneId(readString(sceneLocation.zone_id));
  if (sceneZone) out.add(sceneZone);

  const travelState = toObject(params.travelRoot.travel_state);
  const currentZone = normalizeZoneId(readString(travelState.current_zone));
  if (currentZone) out.add(currentZone);
  const destinationZone = normalizeZoneId(readString(travelState.destination_zone));
  if (destinationZone) out.add(destinationZone);

  for (const zone of toStringArray(sceneLocation.nearby_zone_ids)) {
    const normalized = normalizeZoneId(zone);
    if (normalized) out.add(normalized);
  }

  for (const root of Array.from(out)) {
    const neighbors = params.zoneGraph[root]?.connections ?? [];
    for (const neighbor of neighbors.slice(0, 4)) {
      out.add(neighbor);
    }
  }

  return out;
}

function countRelationshipThreadsByZone(relationshipsRoot: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {};
  const rel = toObject(relationshipsRoot.relationships);
  const edges = Array.isArray(rel.edges)
    ? rel.edges
    : Array.isArray(relationshipsRoot.edges)
      ? relationshipsRoot.edges
      : [];

  for (const entry of edges as unknown[]) {
    const edge = toObject(entry);
    const strength = coerceFiniteInteger(edge.strength, 1);
    if (strength <= 0) continue;
    for (const zone of toStringArray(edge.zones)) {
      const zoneId = normalizeZoneId(zone);
      if (!zoneId) continue;
      result[zoneId] = (result[zoneId] ?? 0) + Math.max(1, Math.min(3, strength));
    }
  }

  return result;
}

function collectVisibleNpcIds(sceneRoot: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const actors = toObject(sceneRoot.actors);
  const visible = Array.isArray(actors.visible_npcs) ? actors.visible_npcs : [];
  for (const entry of visible as unknown[]) {
    const npcId = readString(toObject(entry).id);
    if (npcId) out.add(npcId);
  }
  return out;
}


export async function buildLifecycleCompactionPlan(params: {
  cfg: TrpgRuntimeConfig;
  worldRoot: string;
  trigger: CompactionTrigger;
  maxCandidates: number;
  includeProtected: boolean;
  applyEvenWhenNoCandidates: boolean;
}): Promise<LifecycleCompactionPlan> {
  const [
    pressureLoaded,
    sceneLoaded,
    travelLoaded,
    worldSeedsLoaded,
    factionLoaded,
    relationshipsLoaded,
    memoryLoaded,
    eventsLoaded,
    compactionLoaded,
    archiveLoaded,
  ] = await Promise.all([
    loadStructuredWorldFile(params.worldRoot, "state/world-pressure.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/current-scene.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/travel-state.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/world-seeds.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/faction-agendas.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/relationships.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/npc-memory.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/world-events.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/compaction-state.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/archive-summaries.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
  ]);

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const pressureRoot = toObject(pressureLoaded.parsed);
  const sceneRoot = toObject(sceneLoaded.parsed);
  const travelRoot = toObject(travelLoaded.parsed);
  const worldSeedsRoot = toObject(worldSeedsLoaded.parsed);
  const factionRoot = toObject(factionLoaded.parsed);
  const relationshipsRoot = toObject(relationshipsLoaded.parsed);
  const memoryRoot = toObject(memoryLoaded.parsed);
  const eventsRoot = toObject(eventsLoaded.parsed);

  const compactionRoot =
    Object.keys(toObject(compactionLoaded.parsed)).length > 0
      ? toObject(compactionLoaded.parsed)
      : makeDefaultCompactionStateRoot();
  const compactionState = toObject(compactionRoot.compaction_state);
  const zoneLifecycleMap = toObject(compactionState.zone_lifecycle);

  const archiveRoot =
    Object.keys(toObject(archiveLoaded.parsed)).length > 0
      ? toObject(archiveLoaded.parsed)
      : makeDefaultArchiveSummaryRoot();
  const archiveSummaries = Array.isArray(archiveRoot.archive_summaries) ? archiveRoot.archive_summaries : [];
  const usedArchiveSummaryIds = new Set<string>();
  for (const summaryEntry of archiveSummaries) {
    const summaryId = readString(toObject(summaryEntry).summary_id);
    if (summaryId) {
      usedArchiveSummaryIds.add(summaryId);
    }
  }

  const zoneGraph = buildZoneGraph(pressureRoot);
  const protectedZones = collectCurrentNearbyZoneSet({ sceneRoot, travelRoot, zoneGraph });
  const seedThreads = countSeedThreadsByZone(worldSeedsRoot);
  const factionLinkedZones = collectFactionLinkedZones(factionRoot);
  const relationThreads = countRelationshipThreadsByZone(relationshipsRoot);

  const candidates: CompactionCandidate[] = [];
  const protectedRefs = new Set<string>();
  const skippedRefs = new Set<string>();

  const summary = {
    considered: 0,
    selected: 0,
    activeToDormant: 0,
    dormantToArchived: 0,
    signalCompacted: 0,
    memoryCompacted: 0,
    rumorCompacted: 0,
    noiseRemoved: 0,
  };

  let stateChanged = false;
  let pressureChanged = false;
  let memoryChanged = false;
  let eventsChanged = false;
  let seedsChanged = false;
  let archiveChanged = false;

  for (const [zoneId, zone] of Object.entries(zoneGraph)) {
    const seedInfo = seedThreads[zoneId] ?? { total: 0, longTail: 0 };
    const relationCount = relationThreads[zoneId] ?? 0;
    const hasFactionLink = factionLinkedZones.has(zoneId);
    const isProtected = protectedZones.has(zoneId) || seedInfo.longTail > 0;

    const existing = toObject(zoneLifecycleMap[zoneId]);
    const lastActive = readString(existing.last_active_turn_or_tick) || nowIso;
    const lastPresence = readString(existing.last_player_presence);
    const lastChange = readString(existing.last_meaningful_change) || lastActive;
    const activeThreads = Math.max(coerceFiniteInteger(existing.active_threads_count, 0), seedInfo.total + relationCount);

    const significance =
      readFiniteNumber(existing.significance_score) ??
      Math.max(
        8,
        Math.min(
          100,
          zoneTypeSignificance(zone.type) +
            Math.min(12, zone.tags.length * 2) +
            (isProtected ? 20 : 0) +
            Math.min(18, activeThreads * 4) +
            (hasFactionLink ? 8 : 0),
        ),
      );

    const witnessedRecently = daysSinceIso(lastPresence, nowMs) < 28;
    const retentionWeight =
      readFiniteNumber(existing.retention_weight) ??
      scoreRetentionWeight({
        significanceScore: significance,
        isProtected,
        playerWitnessed: witnessedRecently,
        hasLongTailSeed: seedInfo.longTail > 0,
      });

    const lifecycleState = isProtected ? "active" : toLifecycleState(existing.lifecycle_state);

    const lifecycleNode: ZoneLifecycleMeta = {
      lifecycle_state: lifecycleState,
      last_active_turn_or_tick: lastActive,
      last_player_presence: lastPresence,
      last_meaningful_change: lastChange,
      significance_score: Math.round(significance),
      retention_weight: Math.max(0.05, Math.min(0.99, Number(retentionWeight.toFixed(3)))),
      active_threads_count: activeThreads,
      archived_summary_ref: readString(existing.archived_summary_ref) || undefined,
      reactivation_conditions: toStringArray(existing.reactivation_conditions).slice(0, 8),
    };

    if (isProtected) {
      protectedRefs.add(`zone:${zoneId}`);
      lifecycleNode.lifecycle_state = "active";
      lifecycleNode.last_active_turn_or_tick = nowIso;
      lifecycleNode.last_meaningful_change = nowIso;
      if (protectedZones.has(zoneId)) {
        lifecycleNode.last_player_presence = nowIso;
      }
    }

    if (JSON.stringify(existing) !== JSON.stringify(lifecycleNode)) {
      zoneLifecycleMap[zoneId] = lifecycleNode as unknown as Record<string, unknown>;
      stateChanged = true;
    }
  }


  const zonePressureRoot = toObject(pressureRoot.zone_pressure);

  for (const [zoneId, lifecycleRaw] of Object.entries(zoneLifecycleMap)) {
    if (candidates.length >= params.maxCandidates) {
      break;
    }

    const lifecycle = toObject(lifecycleRaw);
    const state = toLifecycleState(lifecycle.lifecycle_state);
    const isProtected = protectedZones.has(zoneId) || (seedThreads[zoneId]?.longTail ?? 0) > 0;
    if (isProtected) {
      continue;
    }

    const significance = Math.max(1, Math.min(100, coerceFiniteInteger(lifecycle.significance_score, 40)));
    const ageRef = daysSinceIso(lifecycle.last_meaningful_change || lifecycle.last_active_turn_or_tick, nowMs);
    const agePresence = daysSinceIso(lifecycle.last_player_presence, nowMs);
    const liveDeps = coerceFiniteInteger(lifecycle.active_threads_count, 0);
    const linkedToFaction = factionLinkedZones.has(zoneId);
    const linkedToReveal = (seedThreads[zoneId]?.longTail ?? 0) > 0;
    const playerWitnessed = agePresence < 45;
    const replaceable = liveDeps <= 1 && significance < 52;

    const probability = compactionProbability({
      ageSinceReferenceDays: ageRef,
      ageSincePresenceDays: agePresence,
      significanceScore: significance,
      liveDependencyCount: liveDeps,
      linkedToRevealOrHook: linkedToReveal,
      linkedToFactionAgenda: linkedToFaction,
      playerWitnessed,
      replaceableBySummary: replaceable,
    });

    let plannedMove: CompactionCandidate["planned_move"] | null = null;
    if (state === "active" && ageRef >= 5) {
      plannedMove = "active_to_dormant";
    } else if (state === "dormant" && ageRef >= 21 && liveDeps <= 1) {
      plannedMove = "dormant_to_archived";
    }

    if (!plannedMove) {
      continue;
    }

    summary.considered += 1;
    const sample = deterministicSample(`${params.trigger}:${zoneId}:${String(compactionState.run_count ?? 0)}:${plannedMove}`);
    const selected = sample < probability;

    const candidate: CompactionCandidate = {
      candidate_id: `zone-lifecycle-${zoneId}`,
      source_type: "zone_lifecycle",
      source_ref: `zone:${zoneId}`,
      planned_move: plannedMove,
      probability,
      sampled: sample,
      selected,
      reasons: [`age_ref_days=${ageRef.toFixed(2)}`, `deps=${String(liveDeps)}`, `significance=${String(significance)}`],
      protected: false,
    };
    candidates.push(candidate);

    if (!selected) {
      skippedRefs.add(`zone:${zoneId}`);
      continue;
    }

    summary.selected += 1;
    if (plannedMove === "active_to_dormant") {
      lifecycle.lifecycle_state = "dormant";
      lifecycle.last_meaningful_change = nowIso;
      lifecycle.reactivation_conditions = uniqStrings([
        ...toStringArray(lifecycle.reactivation_conditions),
        "player revisit",
        "adjacent pressure spill",
        "faction reach expansion",
        "reveal prerequisite met",
      ]).slice(0, 8);
      summary.activeToDormant += 1;
    } else {
      lifecycle.lifecycle_state = "archived";
      const archiveEntry = buildArchiveSummaryEntry({
        sourceType: "zone_lifecycle",
        sourceRefs: [`zone:${zoneId}`],
        summary: `Zone ${zoneId} moved to archived lifecycle tier after prolonged low-significance inactivity.`,
        retainedTags: ["zone", "lifecycle", "continuity"],
        triggers: ["player revisit", "faction spillover", "seed reconnect"],
        usedIds: usedArchiveSummaryIds,
      });
      archiveSummaries.push(archiveEntry);
      lifecycle.archived_summary_ref = readString(archiveEntry.summary_id);
      lifecycle.last_meaningful_change = nowIso;
      summary.dormantToArchived += 1;
      archiveChanged = true;
    }

    zoneLifecycleMap[zoneId] = lifecycle;
    stateChanged = true;
  }

  for (const [zoneId, zoneNode] of Object.entries(zonePressureRoot)) {
    if (candidates.length >= params.maxCandidates) {
      break;
    }
    if (protectedZones.has(zoneId)) {
      continue;
    }

    const lifecycle = toObject(zoneLifecycleMap[zoneId]);
    const state = toLifecycleState(lifecycle.lifecycle_state);
    const ageRef = daysSinceIso(lifecycle.last_meaningful_change || lifecycle.last_active_turn_or_tick, nowMs);
    const node = toObject(zoneNode);
    const signals = toStringArray(node.signals);
    if (signals.length <= 2 || ageRef < 7) {
      continue;
    }

    summary.considered += 1;
    const baseProbability = compactionProbability({
      ageSinceReferenceDays: ageRef,
      ageSincePresenceDays: daysSinceIso(lifecycle.last_player_presence, nowMs),
      significanceScore: Math.max(1, Math.min(100, coerceFiniteInteger(lifecycle.significance_score, 40))),
      liveDependencyCount: coerceFiniteInteger(lifecycle.active_threads_count, 0),
      linkedToRevealOrHook: false,
      linkedToFactionAgenda: factionLinkedZones.has(zoneId),
      playerWitnessed: false,
      replaceableBySummary: true,
    });
    const probability = clampProbability(baseProbability + 0.12);
    const sample = deterministicSample(`${params.trigger}:${zoneId}:signal`);
    const selected = sample < probability;

    candidates.push({
      candidate_id: `zone-signal-${zoneId}`,
      source_type: "zone_pressure_signal",
      source_ref: `state/world-pressure.yaml#/zone_pressure/${zoneId}/signals`,
      planned_move: "signal_compact",
      probability,
      sampled: sample,
      selected,
      reasons: [`signal_count=${String(signals.length)}`, `lifecycle=${state}`, `age_ref_days=${ageRef.toFixed(2)}`],
      protected: false,
    });

    if (!selected) {
      skippedRefs.add(`signal:${zoneId}`);
      continue;
    }

    node.signals = state === "archived" ? signals.slice(-1) : signals.slice(-2);
    zonePressureRoot[zoneId] = node;
    summary.selected += 1;
    summary.signalCompacted += 1;
    pressureChanged = true;
  }


  const zoneSeeds = Array.isArray(worldSeedsRoot.zone_seeds) ? worldSeedsRoot.zone_seeds : [];
  for (const entry of zoneSeeds as unknown[]) {
    if (candidates.length >= params.maxCandidates) {
      break;
    }

    const seed = toObject(entry);
    const seedType = readString(seed.type).toLowerCase();
    const tensionWeight = coerceFiniteInteger(seed.tension_weight, 1);
    const zoneId = normalizeZoneId(readString(seed.zone_id));
    const isProtected = tensionWeight >= 3 || seedType !== "rumor" || protectedZones.has(zoneId);
    if (isProtected) {
      protectedRefs.add(`seed:${readString(seed.seed_id) || zoneId}`);
      continue;
    }

    const createdAge = daysSinceIso(seed.created_at, nowMs);
    if (createdAge < 10) {
      continue;
    }

    const lifecycle = toLifecycleState(seed.lifecycle_state);
    const probability = clampProbability(0.25 + Math.min(createdAge / 45, 0.5));
    const sample = deterministicSample(`${params.trigger}:${readString(seed.seed_id)}:rumor`);
    const selected = sample < probability;

    summary.considered += 1;
    candidates.push({
      candidate_id: `rumor-${readString(seed.seed_id) || zoneId}`,
      source_type: "zone_seed_rumor",
      source_ref: `state/world-seeds.yaml#/zone_seeds/${readString(seed.seed_id) || zoneId}`,
      planned_move: "rumor_compact",
      probability,
      sampled: sample,
      selected,
      reasons: [`created_age_days=${createdAge.toFixed(2)}`, `tension=${String(tensionWeight)}`],
      protected: false,
    });

    if (!selected) {
      skippedRefs.add(`rumor:${readString(seed.seed_id) || zoneId}`);
      continue;
    }

    summary.selected += 1;
    summary.rumorCompacted += 1;
    if (createdAge >= 30 && lifecycle === "dormant") {
      seed.lifecycle_state = "archived";
      seed.state = "archived";
      const compactedSummary = `Dormant rumor thread for zone ${zoneId || "unknown-zone"} archived as low-impact historical signal.`;
      seed.compacted_summary = compactedSummary;
      const archiveEntry = buildArchiveSummaryEntry({
        sourceType: "rumor_seed",
        sourceRefs: [readString(seed.seed_id) || "unknown-seed"],
        summary: compactedSummary,
        retainedTags: ["rumor", "seed", "continuity"],
        triggers: ["player revisit", "faction motion", "new evidence"],
        usedIds: usedArchiveSummaryIds,
      });
      archiveSummaries.push(archiveEntry);
      archiveChanged = true;
    } else {
      seed.lifecycle_state = "dormant";
      seed.state = "pending";
      seed.compacted_at = nowIso;
    }
    seedsChanged = true;
  }

  const visibleNpcIds = collectVisibleNpcIds(sceneRoot);
  const byNpc = toObject(toObject(memoryRoot.memory).by_npc);
  for (const [npcId, npcState] of Object.entries(byNpc)) {
    if (candidates.length >= params.maxCandidates) {
      break;
    }
    if (visibleNpcIds.has(npcId)) {
      protectedRefs.add(`npc-memory:${npcId}`);
      continue;
    }

    const node = toObject(npcState);
    const notes = toStringArray(node.notes);
    if (notes.length <= 2) {
      continue;
    }

    const importantPattern = /(빚|원한|약속|배신|debt|grudge|promise|betray)/i;
    if (importantPattern.test(`${notes.join(" ")} ${readString(node.last_player_focus)}`)) {
      protectedRefs.add(`npc-memory:${npcId}`);
      continue;
    }

    const age = daysSinceIso(node.last_player_focus_at, nowMs);
    if (age < 7) {
      continue;
    }

    const probability = clampProbability(0.2 + Math.min(age / 40, 0.45));
    const sample = deterministicSample(`${params.trigger}:${npcId}:memory`);
    const selected = sample < probability;

    summary.considered += 1;
    candidates.push({
      candidate_id: `npc-memory-${npcId}`,
      source_type: "npc_memory",
      source_ref: `state/npc-memory.yaml#/memory/by_npc/${npcId}`,
      planned_move: "memory_compact",
      probability,
      sampled: sample,
      selected,
      reasons: [`note_count=${String(notes.length)}`, `age_days=${age.toFixed(2)}`],
      protected: false,
    });

    if (!selected) {
      skippedRefs.add(`npc-memory:${npcId}`);
      continue;
    }

    node.notes = [notes[0], `Residual impression retained (${String(notes.length)} -> 2).`].slice(0, 2);
    node.lifecycle_state = "dormant";
    node.last_compacted_at = nowIso;
    byNpc[npcId] = node;
    summary.selected += 1;
    summary.memoryCompacted += 1;
    memoryChanged = true;
  }

  if (memoryChanged) {
    const memory = toObject(memoryRoot.memory);
    memory.by_npc = byNpc;
    memoryRoot.memory = memory;
  }


  const eventsNode = toObject(eventsRoot.events);
  const history = Array.isArray(eventsNode.history) ? eventsNode.history : [];
  if (history.length > 24 && candidates.length < params.maxCandidates) {
    const overflow = history.length - 24;
    const removed = history.slice(0, overflow);
    eventsNode.history = history.slice(overflow);
    eventsRoot.events = eventsNode;
    eventsChanged = true;

    summary.considered += 1;
    summary.selected += 1;
    summary.noiseRemoved += 1;
    candidates.push({
      candidate_id: `event-history-overflow-${String(overflow)}`,
      source_type: "world_events",
      source_ref: "state/world-events.yaml#/events/history",
      planned_move: "noise_remove",
      probability: 1,
      sampled: 0,
      selected: true,
      reasons: [`overflow=${String(overflow)}`],
      protected: false,
    });

    archiveSummaries.push(
      buildArchiveSummaryEntry({
        sourceType: "world_events",
        sourceRefs: ["events.history"],
        summary: `Compacted ${String(removed.length)} low-impact historical event records into archive summary.`,
        retainedTags: ["events", "history", "compaction"],
        triggers: ["timeline recall", "forensic lookup"],
        usedIds: usedArchiveSummaryIds,
      }),
    );
    archiveChanged = true;
  }

  compactionState.version = 1;
  compactionState.run_count = coerceFiniteInteger(compactionState.run_count, 0) + 1;
  compactionState.last_trigger = params.trigger;
  compactionState.last_run_at = nowIso;
  compactionState.zone_lifecycle = zoneLifecycleMap;
  compactionRoot.compaction_state = compactionState;
  compactionRoot.meta = {
    ...toObject(compactionRoot.meta),
    schema_version: 1,
    last_updated: nowIso,
  };

  archiveRoot.archive_summaries = archiveSummaries;
  archiveRoot.meta = {
    ...toObject(archiveRoot.meta),
    schema_version: 1,
    last_updated: nowIso,
  };

  pressureRoot.zone_pressure = zonePressureRoot;
  if (pressureChanged) {
    pressureRoot.meta = {
      ...toObject(pressureRoot.meta),
      schema_version: 1,
      last_updated: nowIso,
    };
  }

  if (seedsChanged) {
    worldSeedsRoot.zone_seeds = zoneSeeds;
    worldSeedsRoot.meta = {
      ...toObject(worldSeedsRoot.meta),
      schema_version: 1,
      last_updated: nowIso,
    };
  }

  if (eventsChanged) {
    eventsRoot.meta = {
      ...toObject(eventsRoot.meta),
      schema_version: 1,
      last_updated: nowIso,
    };
  }

  const operations: Array<Record<string, unknown>> = [];
  const hasSelected = summary.selected > 0;
  if (stateChanged || params.applyEvenWhenNoCandidates || hasSelected) {
    operations.push({ op: "set", file: "state/compaction-state.yaml", pointer: "/", value: compactionRoot });
  }
  if (archiveChanged) {
    operations.push({ op: "set", file: "state/archive-summaries.yaml", pointer: "/", value: archiveRoot });
  }
  if (pressureChanged) {
    operations.push({ op: "set", file: "state/world-pressure.yaml", pointer: "/", value: pressureRoot });
  }
  if (memoryChanged) {
    operations.push({ op: "set", file: "state/npc-memory.yaml", pointer: "/", value: memoryRoot });
  }
  if (seedsChanged) {
    operations.push({ op: "set", file: "state/world-seeds.yaml", pointer: "/", value: worldSeedsRoot });
  }
  if (eventsChanged) {
    operations.push({ op: "set", file: "state/world-events.yaml", pointer: "/", value: eventsRoot });
  }

  return {
    trigger: params.trigger,
    maxCandidates: params.maxCandidates,
    operations,
    candidates: params.includeProtected ? candidates : candidates.filter((entry) => !entry.protected),
    protectedRefs: Array.from(protectedRefs).sort(),
    skippedRefs: Array.from(skippedRefs).sort(),
    summary,
  };
}


export async function runStateCompactionTool(params: {
  cfg: TrpgRuntimeConfig;
  worldRoot: string;
  agentId: string;
  cache: PatchCache;
  input: StateCompactInput;
}): Promise<Record<string, unknown>> {
  const mode = parseCompactionMode(params.input.mode);
  const trigger = parseCompactionTrigger(params.input.trigger);
  const maxCandidates = Math.max(1, Math.min(80, coerceFiniteInteger(params.input.maxCandidates, 24)));
  const includeProtected = params.input.includeProtected === true;
  const applyEvenWhenNoCandidates = params.input.applyEvenWhenNoCandidates === true;

  const plan = await buildLifecycleCompactionPlan({
    cfg: params.cfg,
    worldRoot: params.worldRoot,
    trigger,
    maxCandidates,
    includeProtected,
    applyEvenWhenNoCandidates,
  });

  const base = {
    ok: true,
    mode,
    trigger,
    summary: plan.summary,
    protected_refs: plan.protectedRefs,
    skipped_refs: plan.skippedRefs,
    candidates: plan.candidates,
    planned_operations: plan.operations,
  };

  if (plan.operations.length === 0) {
    return {
      ...base,
      noop: true,
      message: "No compaction operations selected under current protection/weight constraints.",
    };
  }

  const patchPayload: PatchDryRunInput = {
    title: `state compaction ${trigger}`,
    allowNewFiles: true,
    operations: plan.operations,
  };

  const dryRun = await runPatchDryRun({
    worldRoot: params.worldRoot,
    cfg: params.cfg,
    agentId: params.agentId,
    cache: params.cache,
    input: patchPayload,
  });

  if (mode === "dry-run") {
    return {
      ...base,
      dry_run_result: dryRun,
    };
  }

  const dryRunRoot = toObject(dryRun);
  if (dryRunRoot.ok !== true) {
    return {
      ...base,
      ok: false,
      error: readString(dryRunRoot.error) || "compaction dry-run failed",
      dry_run_result: dryRun,
    };
  }

  const patchId = readString(dryRunRoot.patchId);
  if (!patchId) {
    return {
      ...base,
      ok: false,
      error: "compaction dry-run returned no patch id",
      dry_run_result: dryRun,
    };
  }

  const applyResult = await runPatchApply({
    worldRoot: params.worldRoot,
    cfg: params.cfg,
    agentId: params.agentId,
    cache: params.cache,
    input: {
      validatedPatchId: patchId,
      audit: params.input.audit,
    } as PatchApplyInput,
  });

  const applyRoot = toObject(applyResult);
  return {
    ...base,
    ok: applyRoot.ok === true,
    dry_run_result: dryRun,
    apply_result: applyResult,
  };
}

export async function buildLifecycleCompactionPreview(params: {
  cfg: TrpgRuntimeConfig;
  worldRoot: string;
  trigger: CompactionTrigger;
  maxCandidates?: number;
}): Promise<Record<string, unknown>> {
  const plan = await buildLifecycleCompactionPlan({
    cfg: params.cfg,
    worldRoot: params.worldRoot,
    trigger: params.trigger,
    maxCandidates: Math.max(1, Math.min(24, coerceFiniteInteger(params.maxCandidates, 8))),
    includeProtected: false,
    applyEvenWhenNoCandidates: false,
  });

  return {
    trigger: params.trigger,
    summary: plan.summary,
    candidateCount: plan.candidates.length,
    protectedCount: plan.protectedRefs.length,
    operationCount: plan.operations.length,
  };
}
