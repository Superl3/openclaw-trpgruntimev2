import fs from "node:fs/promises";
import type { TrpgRuntimeConfig } from "../../config.js";
import {
  loadStructuredWorldFile,
  renderStructuredContent,
  resolveWorldAbsolutePath,
} from "../../world-store.js";
import {
  assessUnknownDestinationLabelQuality,
  extractUnknownDestinationLabel,
  inferZoneTypeFromLabel,
  isKnownDestinationAlias,
  normalizeZoneId,
  zoneName,
  type ZoneGraphNode,
} from "./travel-zone-helpers.js";

export type GeneratedZoneResult = {
  destinationZoneId: string | null;
  contextLine: string;
  zoneNameValue: string;
  zoneTypeValue: string;
  rejected?: boolean;
  rejectionReason?: string;
};

function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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

export async function generateLinkedZoneForUnknownDestination(params: {
  worldRoot: string;
  latestUserMessage: string;
  currentZoneId: string;
  zoneGraph: Record<string, ZoneGraphNode>;
  pressureParsed: unknown;
  pressureFormat: string;
  aliasMap: Record<string, string>;
}): Promise<GeneratedZoneResult | null> {
  const requestedLabel = extractUnknownDestinationLabel(params.latestUserMessage, params.aliasMap);
  if (!requestedLabel) return null;

  const quality = assessUnknownDestinationLabelQuality(requestedLabel);
  if (!quality.ok) {
    return {
      destinationZoneId: null,
      zoneNameValue: requestedLabel,
      zoneTypeValue: "settlement",
      rejected: true,
      rejectionReason: quality.reason || "low_quality_label",
      contextLine:
        `Requested destination '${requestedLabel}' is too vague (${quality.reason || "low_quality_label"}). ` +
        "Do not generate a new zone yet; ask the player for a concrete place name such as a district, landmark, road, or facility.",
    };
  }

  const normalizedLabel = quality.normalized;

  const pressureRoot = toObject(params.pressureParsed);
  const zoneTypeValue = inferZoneTypeFromLabel(normalizedLabel);
  const timestampSuffix = String(Date.now()).slice(-6);
  const zoneId = normalizeZoneId(`zone-${normalizedLabel}-${timestampSuffix}`);
  if (!zoneId || params.zoneGraph[zoneId]) return null;

  const links = uniqStrings([
    params.currentZoneId,
    ...(params.zoneGraph[params.currentZoneId]?.connections ?? []).slice(0, 1),
  ]).slice(0, 3);
  const pressure = Math.max(
    25,
    Math.min(90, Math.round(((params.zoneGraph[params.currentZoneId]?.pressure ?? 50) + 8) / 1.1)),
  );
  const pressureLevel = pressure >= 70 ? "high" : pressure >= 50 ? "medium" : "low";

  const zonesNode = pressureRoot.zones;
  const lifecycleNow = new Date().toISOString();
  const zonePayload = {
    id: zoneId,
    name: normalizedLabel,
    type: zoneTypeValue,
    parent_region: params.zoneGraph[params.currentZoneId]?.parentRegion || "generated-frontier",
    tags: ["generated", zoneTypeValue, "runtime"],
    aliases: [normalizedLabel],
    connections: links,
    nearby_zone_ids: links,
    exploration_surface: `${normalizedLabel} routes and clues`,
    social_surface: `${normalizedLabel} faction contact friction`,
    conflict_surface: `${normalizedLabel} control contest and hazard points`,
    faction_presence: ["city watch", "local brokers", "independent cells"],
    pressure_level: pressureLevel,
    pressure_signals: ["checkpoint_shift", "watch_rotation", "rumor_spread"],
    lifecycle_state: "active",
    significance_score: Math.max(35, Math.min(85, pressure + 4)),
    retention_weight: pressureLevel === "high" ? 0.78 : pressureLevel === "medium" ? 0.62 : 0.48,
    last_active_turn_or_tick: lifecycleNow,
    last_player_presence: lifecycleNow,
    last_meaningful_change: lifecycleNow,
    active_threads_count: 1,
    archived_summary_ref: null,
    reactivation_conditions: [
      "player revisit",
      "adjacent pressure spill",
      "faction influence expansion",
      "seed chain reconnect",
    ],
  };
  if (Array.isArray(zonesNode)) zonesNode.push(zonePayload);
  else {
    const zonesObj = toObject(zonesNode);
    zonesObj[zoneId] = zonePayload;
    pressureRoot.zones = zonesObj;
  }

  const topo = toObject(toObject(pressureRoot.zone_topology).nearby_zones);
  topo[zoneId] = links;
  for (const linked of links) topo[linked] = uniqStrings([...toStringArray(topo[linked]), zoneId]);
  pressureRoot.zone_topology = { ...toObject(pressureRoot.zone_topology), nearby_zones: topo };

  const zp = toObject(pressureRoot.zone_pressure);
  zp[zoneId] = {
    label: normalizedLabel,
    pressure,
    score: pressure,
    trend: "up",
    soft_threshold: Math.max(35, pressure - 12),
    hard_threshold: Math.min(95, pressure + 18),
    signals: ["checkpoint_shift", "watch_rotation", "rumor_spread"],
  };
  pressureRoot.zone_pressure = zp;

  const dt = toObject(pressureRoot.district_tension);
  dt[zoneId] = {
    label: normalizedLabel,
    score: pressure,
    trend: "up",
    soft_threshold: Math.max(35, pressure - 12),
    hard_threshold: Math.min(95, pressure + 18),
  };
  pressureRoot.district_tension = dt;

  pressureRoot.meta = { ...toObject(pressureRoot.meta), schema_version: 1, last_updated: new Date().toISOString() };
  const rendered = renderStructuredContent(params.pressureFormat as "yaml" | "json", pressureRoot);
  await fs.writeFile(resolveWorldAbsolutePath(params.worldRoot, "state/world-pressure.yaml"), rendered, "utf8");

  return {
    destinationZoneId: zoneId,
    zoneNameValue: normalizedLabel,
    zoneTypeValue,
    contextLine: `A new connected area emerges nearby: ${normalizedLabel}. It carries ${pressureLevel} pressure with exploration/social/conflict surfaces and active faction presence.`,
  };
}

export async function appendZoneSeeds(params: {
  cfg: TrpgRuntimeConfig;
  worldRoot: string;
  zoneIds: string[];
  zoneGraph: Record<string, ZoneGraphNode>;
}): Promise<string[]> {
  const zoneIds = uniqStrings(params.zoneIds.map((z) => normalizeZoneId(z))).slice(0, 3);
  if (zoneIds.length === 0) return [];
  const loaded = await loadStructuredWorldFile(params.worldRoot, "state/world-seeds.yaml", {
    allowMissing: true,
    maxReadBytes: params.cfg.maxReadBytes,
  });
  const root = toObject(loaded.parsed);
  const entries = (Array.isArray(root.zone_seeds) ? root.zone_seeds : []).map((e) => toObject(e));
  const types = [
    "rumor",
    "hidden_location",
    "npc_connection",
    "faction_interest",
    "environmental_mystery",
  ] as const;
  const hints: string[] = [];
  let changed = false;
  for (const zoneId of zoneIds) {
    const idx = Math.abs(zoneId.split("").reduce((a, c) => a + c.charCodeAt(0), 0)) % types.length;
    const seedType = types[idx];
    const duplicate = entries.some(
      (e) => normalizeZoneId(readString(e.zone_id)) === zoneId && readString(e.type) === seedType,
    );
    if (duplicate) continue;
    const zoneLabel = zoneName(params.zoneGraph, zoneId);
    entries.push({
      seed_id: `seed-${zoneId}-${seedType}-${String(Date.now()).slice(-6)}`,
      zone_id: zoneId,
      zone_name: zoneLabel,
      type: seedType,
      prerequisite: "set up at least one prerequisite action first",
      payoff: "delayed narrative leverage",
      tension_weight: idx + 1,
      state: "pending",
      created_at: new Date().toISOString(),
    });
    hints.push(`${zoneLabel}: deferred ${seedType.replace("_", " ")} hook available after setup.`);
    changed = true;
  }
  if (!changed) return [];
  root.zone_seeds = entries;
  root.meta = { ...toObject(root.meta), schema_version: 1, last_updated: new Date().toISOString() };
  const rendered = renderStructuredContent(loaded.format, root);
  await fs.writeFile(resolveWorldAbsolutePath(params.worldRoot, "state/world-seeds.yaml"), rendered, "utf8");
  return hints.slice(0, 3);
}

export function shouldPreferGeneratedDestination(params: {
  latestUserMessage: string;
  aliasMap: Record<string, string>;
}): boolean {
  const explicitUnknownDestination = extractUnknownDestinationLabel(params.latestUserMessage, params.aliasMap);
  return Boolean(
    explicitUnknownDestination && !isKnownDestinationAlias(explicitUnknownDestination, params.aliasMap),
  );
}
