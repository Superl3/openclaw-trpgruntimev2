import { createHash } from "node:crypto";
import type {
  FactionSeed,
  GenerationProfile,
  LocationSeed,
  NpcArchetypePool,
  PressureSeed,
  RuntimeBootstrapInput,
  SeedPressureArchetype,
  WorldSeed,
} from "./types.js";
import { WORLD_SEED_SCHEMA_VERSION } from "./types.js";

export const WORLD_SEED_MIN_LOCATIONS = 3;
export const WORLD_SEED_MIN_PRESSURES = 2;
export const WORLD_SEED_MIN_FACTIONS = 2;
export const WORLD_SEED_MIN_NPC_POOL = 6;

export type WorldSeedValidationIssue = {
  code: string;
  message: string;
  path: string;
  severity: "warn" | "error";
};

export type WorldSeedValidationResult =
  | {
      ok: true;
      seed: WorldSeed;
      issues: WorldSeedValidationIssue[];
    }
  | {
      ok: false;
      issues: WorldSeedValidationIssue[];
    };

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function uniqStrings(values: string[], maxCount: number): string[] {
  const dedup: string[] = [];
  for (const raw of values) {
    const normalized = raw.trim();
    if (!normalized || dedup.includes(normalized)) {
      continue;
    }
    dedup.push(normalized);
    if (dedup.length >= maxCount) {
      break;
    }
  }
  return dedup;
}

function readStringArray(value: unknown, maxCount: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqStrings(
    value.filter((entry): entry is string => typeof entry === "string"),
    maxCount,
  );
}

function normalizeArchetype(value: unknown): SeedPressureArchetype {
  const normalized = readString(value);
  if (
    normalized === "smuggling" ||
    normalized === "outbreak" ||
    normalized === "power_struggle" ||
    normalized === "artifact_race" ||
    normalized === "public_order"
  ) {
    return normalized;
  }
  return "public_order";
}

function normalizeLocationVolatility(value: unknown): GenerationProfile["locationVolatility"] {
  const normalized = readString(value);
  if (normalized === "stable" || normalized === "mixed" || normalized === "volatile") {
    return normalized;
  }
  return "mixed";
}

function normalizeGenerationProfile(value: unknown): GenerationProfile {
  const node = toRecord(value);
  return {
    profileId: readString(node.profileId) || "baseline",
    pressureScalePercent: clampInt(readInt(node.pressureScalePercent, 100), 50, 150),
    locationVolatility: normalizeLocationVolatility(node.locationVolatility),
  };
}

function normalizeLocationSeed(value: unknown, index: number): LocationSeed {
  const node = toRecord(value);
  const baselineNode = toRecord(node.baseline);
  return {
    locationId: readString(node.locationId) || readString(node.id) || `location-${String(index + 1).padStart(2, "0")}`,
    tags: readStringArray(node.tags, 16),
    baseline: {
      tension: clampInt(readInt(baselineNode.tension, 35), 0, 100),
      alertness: clampInt(readInt(baselineNode.alertness, 30), 0, 100),
      accessibility: clampInt(readInt(baselineNode.accessibility, 70), 0, 100),
    },
    pressureAffinityIds: readStringArray(node.pressureAffinityIds, 10),
  };
}

function normalizePressureSeed(value: unknown, index: number): PressureSeed {
  const node = toRecord(value);
  return {
    pressureId: readString(node.pressureId) || readString(node.id) || `pressure-${String(index + 1).padStart(2, "0")}`,
    archetype: normalizeArchetype(node.archetype),
    intensity: clampInt(readInt(node.intensity, 45), 0, 100),
    momentum: clampInt(readInt(node.momentum, 0), -20, 20),
    cadenceSec: clampInt(readInt(node.cadenceSec, 180), 60, 3600),
    targetLocationIds: readStringArray(node.targetLocationIds, 10),
  };
}

function normalizeFactionSeed(value: unknown, index: number): FactionSeed {
  const node = toRecord(value);
  return {
    factionId: readString(node.factionId) || readString(node.id) || `faction-${String(index + 1).padStart(2, "0")}`,
    homeLocationId: readString(node.homeLocationId),
    agendaTags: readStringArray(node.agendaTags, 16),
    pressureBiasRefs: readStringArray(node.pressureBiasRefs, 10),
  };
}

function normalizeNpcArchetypePool(value: unknown, index: number): NpcArchetypePool {
  const node = toRecord(value);
  const factionId = readString(node.factionId);
  return {
    npcArchetypeId:
      readString(node.npcArchetypeId) ||
      readString(node.npcId) ||
      readString(node.id) ||
      `npc-archetype-${String(index + 1).padStart(2, "0")}`,
    factionId: factionId || null,
    locationAffinityIds: readStringArray(node.locationAffinityIds, 12),
    roleTags: readStringArray(node.roleTags, 16),
  };
}

function pushIssue(params: {
  issues: WorldSeedValidationIssue[];
  code: string;
  message: string;
  path: string;
  severity?: "warn" | "error";
}): void {
  params.issues.push({
    code: params.code,
    message: params.message,
    path: params.path,
    severity: params.severity ?? "error",
  });
}

function collectDuplicateIds(params: {
  values: string[];
  path: string;
  duplicateCode: string;
  label: string;
  issues: WorldSeedValidationIssue[];
}): void {
  const seen = new Set<string>();
  for (const value of params.values) {
    if (seen.has(value)) {
      pushIssue({
        issues: params.issues,
        code: params.duplicateCode,
        message: `Duplicate ${params.label} id: ${value}`,
        path: params.path,
      });
      continue;
    }
    seen.add(value);
  }
}

function ensureIsoOrFallback(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }
  return "1970-01-01T00:00:00.000Z";
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const node = value as Record<string, unknown>;
  const keys = Object.keys(node).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(node[key])}`).join(",")}}`;
}

function hashSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function extractWorldSeedEnvelope(value: unknown): unknown {
  const root = toRecord(value);
  if (root.worldSeed && typeof root.worldSeed === "object") {
    return root.worldSeed;
  }
  if (root.world_seed && typeof root.world_seed === "object") {
    return root.world_seed;
  }
  if (root.seed && typeof root.seed === "object") {
    return root.seed;
  }
  return value;
}

export function validateWorldSeed(value: unknown): WorldSeedValidationResult {
  const issues: WorldSeedValidationIssue[] = [];
  const candidate = extractWorldSeedEnvelope(value);
  const root = toRecord(candidate);
  if (Object.keys(root).length === 0) {
    pushIssue({
      issues,
      code: "world_seed_not_object",
      message: "World seed payload must be an object.",
      path: "/",
    });
    return {
      ok: false,
      issues,
    };
  }

  const schemaVersion = clampInt(readInt(root.schemaVersion, WORLD_SEED_SCHEMA_VERSION), 1, 9999);
  if (schemaVersion !== WORLD_SEED_SCHEMA_VERSION) {
    pushIssue({
      issues,
      code: "unsupported_schema_version",
      message: `Unsupported world seed schemaVersion: ${String(schemaVersion)}`,
      path: "/schemaVersion",
    });
  }

  const worldId = readString(root.worldId);
  if (!worldId) {
    pushIssue({
      issues,
      code: "world_id_missing",
      message: "worldId is required.",
      path: "/worldId",
    });
  }

  const seedValue = readString(root.seedValue);
  if (!seedValue) {
    pushIssue({
      issues,
      code: "seed_value_missing",
      message: "seedValue is required.",
      path: "/seedValue",
    });
  }

  const createdAtIsoRaw = readString(root.createdAtIso);
  const createdAtIso = ensureIsoOrFallback(createdAtIsoRaw);
  if (!createdAtIsoRaw || createdAtIsoRaw !== createdAtIso) {
    pushIssue({
      issues,
      code: "created_at_normalized",
      message: "createdAtIso is missing or invalid; epoch fallback was used during normalization.",
      path: "/createdAtIso",
      severity: "warn",
    });
  }

  const locations = (Array.isArray(root.locations) ? root.locations : []).map((entry, index) =>
    normalizeLocationSeed(entry, index),
  );
  const pressures = (Array.isArray(root.pressures) ? root.pressures : []).map((entry, index) =>
    normalizePressureSeed(entry, index),
  );
  const factions = (Array.isArray(root.factions) ? root.factions : []).map((entry, index) =>
    normalizeFactionSeed(entry, index),
  );
  const npcPool = (Array.isArray(root.npcPool) ? root.npcPool : []).map((entry, index) =>
    normalizeNpcArchetypePool(entry, index),
  );

  const generationProfile = normalizeGenerationProfile(root.generationProfile);

  if (locations.length < WORLD_SEED_MIN_LOCATIONS) {
    pushIssue({
      issues,
      code: "locations_too_few",
      message: `locations must contain at least ${String(WORLD_SEED_MIN_LOCATIONS)} entries.`,
      path: "/locations",
    });
  }
  if (pressures.length < WORLD_SEED_MIN_PRESSURES) {
    pushIssue({
      issues,
      code: "pressures_too_few",
      message: `pressures must contain at least ${String(WORLD_SEED_MIN_PRESSURES)} entries.`,
      path: "/pressures",
    });
  }
  if (factions.length < WORLD_SEED_MIN_FACTIONS) {
    pushIssue({
      issues,
      code: "factions_too_few",
      message: `factions must contain at least ${String(WORLD_SEED_MIN_FACTIONS)} entries.`,
      path: "/factions",
    });
  }
  if (npcPool.length < WORLD_SEED_MIN_NPC_POOL) {
    pushIssue({
      issues,
      code: "npc_pool_too_few",
      message: `npcPool must contain at least ${String(WORLD_SEED_MIN_NPC_POOL)} entries.`,
      path: "/npcPool",
    });
  }

  collectDuplicateIds({
    values: locations.map((entry) => entry.locationId),
    path: "/locations",
    duplicateCode: "duplicate_location_id",
    label: "location",
    issues,
  });
  collectDuplicateIds({
    values: pressures.map((entry) => entry.pressureId),
    path: "/pressures",
    duplicateCode: "duplicate_pressure_id",
    label: "pressure",
    issues,
  });
  collectDuplicateIds({
    values: factions.map((entry) => entry.factionId),
    path: "/factions",
    duplicateCode: "duplicate_faction_id",
    label: "faction",
    issues,
  });
  collectDuplicateIds({
    values: npcPool.map((entry) => entry.npcArchetypeId),
    path: "/npcPool",
    duplicateCode: "duplicate_npc_pool_id",
    label: "npc archetype",
    issues,
  });

  const locationIdSet = new Set(locations.map((entry) => entry.locationId));
  const pressureIdSet = new Set(pressures.map((entry) => entry.pressureId));
  const factionIdSet = new Set(factions.map((entry) => entry.factionId));

  for (const [index, faction] of factions.entries()) {
    if (!faction.homeLocationId) {
      pushIssue({
        issues,
        code: "faction_home_location_missing",
        message: `Faction ${faction.factionId} is missing homeLocationId.`,
        path: `/factions/${String(index)}/homeLocationId`,
      });
      continue;
    }
    if (!locationIdSet.has(faction.homeLocationId)) {
      pushIssue({
        issues,
        code: "faction_home_location_invalid",
        message: `Faction ${faction.factionId} references unknown homeLocationId ${faction.homeLocationId}.`,
        path: `/factions/${String(index)}/homeLocationId`,
      });
    }

    for (const biasRef of faction.pressureBiasRefs) {
      if (pressureIdSet.has(biasRef)) {
        continue;
      }
      pushIssue({
        issues,
        code: "faction_pressure_bias_invalid",
        message: `Faction ${faction.factionId} references unknown pressure bias id ${biasRef}.`,
        path: `/factions/${String(index)}/pressureBiasRefs`,
      });
    }
  }

  for (const [index, npc] of npcPool.entries()) {
    if (npc.factionId && !factionIdSet.has(npc.factionId)) {
      pushIssue({
        issues,
        code: "npc_faction_invalid",
        message: `NPC archetype ${npc.npcArchetypeId} references unknown factionId ${npc.factionId}.`,
        path: `/npcPool/${String(index)}/factionId`,
      });
    }
    if (npc.locationAffinityIds.length === 0) {
      pushIssue({
        issues,
        code: "npc_location_affinity_empty",
        message: `NPC archetype ${npc.npcArchetypeId} must declare at least one location affinity.`,
        path: `/npcPool/${String(index)}/locationAffinityIds`,
      });
      continue;
    }
    for (const locationId of npc.locationAffinityIds) {
      if (locationIdSet.has(locationId)) {
        continue;
      }
      pushIssue({
        issues,
        code: "npc_location_affinity_invalid",
        message: `NPC archetype ${npc.npcArchetypeId} references unknown location affinity ${locationId}.`,
        path: `/npcPool/${String(index)}/locationAffinityIds`,
      });
    }
  }

  for (const [index, location] of locations.entries()) {
    for (const pressureId of location.pressureAffinityIds) {
      if (pressureIdSet.has(pressureId)) {
        continue;
      }
      pushIssue({
        issues,
        code: "location_pressure_affinity_invalid",
        message: `Location ${location.locationId} references unknown pressure affinity ${pressureId}.`,
        path: `/locations/${String(index)}/pressureAffinityIds`,
      });
    }
  }

  const hasError = issues.some((issue) => issue.severity === "error");
  if (hasError) {
    return {
      ok: false,
      issues,
    };
  }

  return {
    ok: true,
    seed: {
      schemaVersion: WORLD_SEED_SCHEMA_VERSION,
      worldId,
      seedValue,
      createdAtIso,
      generationProfile,
      locations,
      pressures,
      factions,
      npcPool,
    },
    issues,
  };
}

function locationVolatilityDelta(value: GenerationProfile["locationVolatility"]): {
  tension: number;
  alertness: number;
  accessibility: number;
} {
  if (value === "stable") {
    return {
      tension: -4,
      alertness: -4,
      accessibility: 6,
    };
  }
  if (value === "volatile") {
    return {
      tension: 4,
      alertness: 5,
      accessibility: -6,
    };
  }
  return {
    tension: 0,
    alertness: 0,
    accessibility: 0,
  };
}

function normalizeDeterminismKey(seed: WorldSeed): string {
  return hashSha256(
    stableStringify({
      schemaVersion: seed.schemaVersion,
      seedValue: seed.seedValue,
      generationProfile: seed.generationProfile,
    }),
  );
}

export function buildWorldSeedFingerprint(seed: WorldSeed): string {
  return hashSha256(
    stableStringify({
      schemaVersion: seed.schemaVersion,
      worldId: seed.worldId,
      seedValue: seed.seedValue,
      generationProfile: seed.generationProfile,
      locations: seed.locations,
      pressures: seed.pressures,
      factions: seed.factions,
      npcPool: seed.npcPool,
    }),
  );
}

export function buildRuntimeBootstrapInput(seed: WorldSeed): RuntimeBootstrapInput {
  const pressureScale = clampInt(seed.generationProfile.pressureScalePercent, 50, 150) / 100;
  const volatility = locationVolatilityDelta(seed.generationProfile.locationVolatility);
  const worldPressures = seed.pressures
    .slice()
    .sort((a, b) => a.pressureId.localeCompare(b.pressureId))
    .map((pressure) => ({
      pressureId: pressure.pressureId,
      archetype: pressure.archetype,
      intensity: clampInt(Math.round(pressure.intensity * pressureScale), 0, 100),
      momentum: clampInt(pressure.momentum, -20, 20),
      cadenceSec: clampInt(pressure.cadenceSec, 60, 3600),
      targetLocations: pressure.targetLocationIds.slice().sort(),
      anchorCandidate: false,
    }));

  const locationBaselines = seed.locations
    .slice()
    .sort((a, b) => a.locationId.localeCompare(b.locationId))
    .map((location) => ({
      locationId: location.locationId,
      tension: clampInt(location.baseline.tension + volatility.tension, 0, 100),
      alertness: clampInt(location.baseline.alertness + volatility.alertness, 0, 100),
      accessibility: clampInt(location.baseline.accessibility + volatility.accessibility, 0, 100),
      recentIncidents: [],
    }));

  return {
    source: "worldSeed",
    worldId: seed.worldId,
    schemaVersion: seed.schemaVersion,
    seedValue: seed.seedValue,
    seedFingerprint: buildWorldSeedFingerprint(seed),
    determinismKey: normalizeDeterminismKey(seed),
    generationProfile: {
      ...seed.generationProfile,
    },
    questEconomy: {
      worldPressures,
    },
    temporal: {
      locationBaselines,
    },
    scaffold: {
      factionIds: seed.factions.map((entry) => entry.factionId).slice().sort(),
      npcArchetypeIds: seed.npcPool.map((entry) => entry.npcArchetypeId).slice().sort(),
    },
  };
}
