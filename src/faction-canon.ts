import { createHash } from "node:crypto";
import type { CanonicalSourcePolicy, WorldSeed } from "./runtime-core/types.js";

export const FACTION_CANON_SCHEMA_VERSION = 1 as const;

export type FactionCanonPosture = "low_profile" | "balanced" | "assertive";

export type FactionCanonEntry = {
  factionId: string;
  name: string;
  enabled: boolean;
  homeLocationIds: string[];
  pressureAffinityIds: string[];
  resources: number;
  heat: number;
  posture: FactionCanonPosture;
};

export type FactionCanonFile = {
  schemaVersion: typeof FACTION_CANON_SCHEMA_VERSION;
  worldId: string;
  factions: FactionCanonEntry[];
};

export type FactionCanonDiagnostic = {
  code: string;
  message: string;
  path: string;
  severity: "warn" | "error";
};

export type FactionCanonReferenceIndex = {
  worldId: string;
  locationIds: Set<string>;
  pressureIds: Set<string>;
};

export type FactionScaffoldField =
  | "name"
  | "enabled"
  | "homeLocationIds"
  | "pressureAffinityIds"
  | "posture";

export type FactionScaffoldChangedEntry = {
  factionId: string;
  fields: Array<{
    field: FactionScaffoldField;
    seedValue: unknown;
    canonValue: unknown;
  }>;
};

export type FactionOperationalDivergenceEntry = {
  factionId: string;
  resources: {
    seedProjected: number;
    canonCurrent: number;
  };
  heat: {
    seedProjected: number;
    canonCurrent: number;
  };
};

export type FactionScaffoldDriftStatus = "aligned" | "drifted" | "incompatible";

export type FactionScaffoldDriftReport = {
  sourcePolicy: CanonicalSourcePolicy;
  generatedAtIso: string;
  world: {
    seedWorldId: string;
    canonWorldId: string;
  };
  fingerprints: {
    seedScaffold: string;
    canon: string;
  };
  status: FactionScaffoldDriftStatus;
  summary: {
    addedInSeed: number;
    missingInSeed: number;
    changedScaffold: number;
    incompatible: number;
    operationalDivergence: number;
  };
  details: {
    addedInSeed: string[];
    missingInSeed: string[];
    changedScaffold: FactionScaffoldChangedEntry[];
    incompatible: string[];
    operationalDivergence: FactionOperationalDivergenceEntry[];
  };
};

export type FactionScaffoldSyncPolicy = "preserve_operational" | "replace_all";

export type FactionScaffoldSyncResult = {
  policy: FactionScaffoldSyncPolicy;
  nextCanon: FactionCanonFile;
  drift: FactionScaffoldDriftReport;
  summary: {
    addedFromSeed: number;
    updatedFromSeed: number;
    preservedOperational: number;
    preservedCanonOnly: number;
    removedByPolicy: number;
  };
};

export type FactionCanonValidationResult =
  | {
      ok: true;
      canon: FactionCanonFile;
      diagnostics: FactionCanonDiagnostic[];
    }
  | {
      ok: false;
      diagnostics: FactionCanonDiagnostic[];
    };

type FactionCanonValidationOptions = {
  references?: {
    worldId?: string;
    locationIds?: Iterable<string>;
    pressureIds?: Iterable<string>;
  };
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

function toTitleCaseFromId(id: string): string {
  const cleaned = id
    .trim()
    .replace(/[._]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-/, "")
    .replace(/-$/, "");
  if (!cleaned) {
    return "Unknown Faction";
  }
  return cleaned
    .split("-")
    .map((part) => {
      if (!part) {
        return "";
      }
      return `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`;
    })
    .join(" ");
}

function normalizePosture(value: unknown): FactionCanonPosture {
  const normalized = readString(value);
  if (normalized === "low_profile" || normalized === "balanced" || normalized === "assertive") {
    return normalized;
  }
  return "balanced";
}

function normalizeFactionEntry(value: unknown, index: number): FactionCanonEntry {
  const node = toRecord(value);
  const factionId =
    readString(node.factionId) ||
    readString(node.id) ||
    `faction-${String(index + 1).padStart(2, "0")}`;
  const homeLocationIds = uniqStrings(
    [
      ...readStringArray(node.homeLocationIds, 16),
      readString(node.homeLocationId),
    ].filter(Boolean),
    16,
  );
  const pressureAffinityIds = uniqStrings(
    [
      ...readStringArray(node.pressureAffinityIds, 16),
      readString(node.pressureAffinityId),
    ].filter(Boolean),
    16,
  );
  const name = readString(node.name) || toTitleCaseFromId(factionId);
  return {
    factionId,
    name,
    enabled: typeof node.enabled === "boolean" ? node.enabled : true,
    homeLocationIds,
    pressureAffinityIds,
    resources: clampInt(readInt(node.resources, 50), 0, 100),
    heat: clampInt(readInt(node.heat, 40), 0, 100),
    posture: normalizePosture(node.posture),
  };
}

function pushDiagnostic(params: {
  diagnostics: FactionCanonDiagnostic[];
  code: string;
  message: string;
  path: string;
  severity?: "warn" | "error";
}): void {
  params.diagnostics.push({
    code: params.code,
    message: params.message,
    path: params.path,
    severity: params.severity ?? "error",
  });
}

function collectDuplicateIds(params: {
  diagnostics: FactionCanonDiagnostic[];
  values: string[];
  path: string;
  label: string;
  duplicateCode: string;
}): void {
  const seen = new Set<string>();
  for (const value of params.values) {
    if (seen.has(value)) {
      pushDiagnostic({
        diagnostics: params.diagnostics,
        code: params.duplicateCode,
        message: `Duplicate ${params.label} id: ${value}`,
        path: params.path,
      });
      continue;
    }
    seen.add(value);
  }
}

function toIdSet(value: Iterable<string> | undefined): Set<string> {
  const out = new Set<string>();
  if (!value) {
    return out;
  }
  for (const entry of value) {
    const normalized = entry.trim();
    if (normalized) {
      out.add(normalized);
    }
  }
  return out;
}

export function validateFactionCanon(
  value: unknown,
  options?: FactionCanonValidationOptions,
): FactionCanonValidationResult {
  const diagnostics: FactionCanonDiagnostic[] = [];
  const root = toRecord(value);
  if (Object.keys(root).length === 0) {
    pushDiagnostic({
      diagnostics,
      code: "faction_canon_not_object",
      message: "Faction canon payload must be an object.",
      path: "/",
    });
    return {
      ok: false,
      diagnostics,
    };
  }

  const schemaVersion = clampInt(
    readInt(root.schemaVersion ?? root.schema_version, FACTION_CANON_SCHEMA_VERSION),
    1,
    9999,
  );
  if (schemaVersion !== FACTION_CANON_SCHEMA_VERSION) {
    pushDiagnostic({
      diagnostics,
      code: "unsupported_schema_version",
      message: `Unsupported factions schemaVersion: ${String(schemaVersion)}`,
      path: "/schemaVersion",
    });
  }

  const worldId = readString(root.worldId);
  if (!worldId) {
    pushDiagnostic({
      diagnostics,
      code: "world_id_missing",
      message: "worldId is required.",
      path: "/worldId",
    });
  }

  const factionsRaw = Array.isArray(root.factions) ? root.factions : [];
  if (!Array.isArray(root.factions)) {
    pushDiagnostic({
      diagnostics,
      code: "factions_missing",
      message: "factions must be an array.",
      path: "/factions",
    });
  }
  const factions = factionsRaw.map((entry, index) => normalizeFactionEntry(entry, index));

  if (factions.length === 0) {
    pushDiagnostic({
      diagnostics,
      code: "factions_empty",
      message: "No factions defined. tick will return no-op until factions are added.",
      path: "/factions",
      severity: "warn",
    });
  }

  collectDuplicateIds({
    diagnostics,
    values: factions.map((entry) => entry.factionId),
    path: "/factions",
    label: "faction",
    duplicateCode: "duplicate_faction_id",
  });

  const referenceLocationIds = toIdSet(options?.references?.locationIds);
  const referencePressureIds = toIdSet(options?.references?.pressureIds);
  const referenceWorldId = readString(options?.references?.worldId);
  if (referenceWorldId && worldId && referenceWorldId !== worldId) {
    pushDiagnostic({
      diagnostics,
      code: "world_id_mismatch",
      message: `worldId differs from reference index. canon=${worldId} reference=${referenceWorldId}`,
      path: "/worldId",
      severity: "warn",
    });
  }

  for (const [index, entry] of factions.entries()) {
    const sourceNode = toRecord(factionsRaw[index]);
    if (!readString(sourceNode.name)) {
      pushDiagnostic({
        diagnostics,
        code: "faction_name_missing",
        message: `Faction ${entry.factionId} is missing name; derived fallback was used.`,
        path: `/factions/${String(index)}/name`,
        severity: "warn",
      });
    }
    if (entry.homeLocationIds.length === 0) {
      pushDiagnostic({
        diagnostics,
        code: "faction_home_locations_empty",
        message: `Faction ${entry.factionId} must declare at least one homeLocationIds entry.`,
        path: `/factions/${String(index)}/homeLocationIds`,
      });
    }
    if (entry.pressureAffinityIds.length === 0) {
      pushDiagnostic({
        diagnostics,
        code: "faction_pressure_affinity_empty",
        message: `Faction ${entry.factionId} must declare at least one pressureAffinityIds entry.`,
        path: `/factions/${String(index)}/pressureAffinityIds`,
      });
    }

    if (referenceLocationIds.size > 0) {
      for (const locationId of entry.homeLocationIds) {
        if (referenceLocationIds.has(locationId)) {
          continue;
        }
        pushDiagnostic({
          diagnostics,
          code: "faction_home_location_invalid",
          message: `Faction ${entry.factionId} references unknown home location ${locationId}.`,
          path: `/factions/${String(index)}/homeLocationIds`,
        });
      }
    }

    if (referencePressureIds.size > 0) {
      for (const pressureId of entry.pressureAffinityIds) {
        if (referencePressureIds.has(pressureId)) {
          continue;
        }
        pushDiagnostic({
          diagnostics,
          code: "faction_pressure_affinity_invalid",
          message: `Faction ${entry.factionId} references unknown pressure affinity ${pressureId}.`,
          path: `/factions/${String(index)}/pressureAffinityIds`,
        });
      }
    }
  }

  const hasError = diagnostics.some((entry) => entry.severity === "error");
  if (hasError) {
    return {
      ok: false,
      diagnostics,
    };
  }

  return {
    ok: true,
    canon: {
      schemaVersion: FACTION_CANON_SCHEMA_VERSION,
      worldId,
      factions,
    },
    diagnostics,
  };
}

export function buildFactionCanonReferenceIndexFromWorldSeed(seed: WorldSeed): FactionCanonReferenceIndex {
  return {
    worldId: seed.worldId,
    locationIds: new Set(seed.locations.map((entry) => entry.locationId)),
    pressureIds: new Set(seed.pressures.map((entry) => entry.pressureId)),
  };
}

function postureFromSeed(params: { resources: number; heat: number }): FactionCanonPosture {
  if (params.heat >= 70) {
    return "assertive";
  }
  if (params.resources >= 70 && params.heat <= 35) {
    return "low_profile";
  }
  return "balanced";
}

export function projectFactionCanonFromWorldSeed(seed: WorldSeed): FactionCanonFile {
  const fallbackPressureId =
    seed.pressures
      .map((entry) => entry.pressureId)
      .sort((a, b) => a.localeCompare(b))[0] ??
    "pressure-public-order";

  const factions = seed.factions
    .slice()
    .sort((a, b) => a.factionId.localeCompare(b.factionId))
    .map((entry) => {
      const homeLocationIds = uniqStrings([entry.homeLocationId], 16);
      const pressureAffinityIds = uniqStrings(
        entry.pressureBiasRefs.length > 0 ? entry.pressureBiasRefs : [fallbackPressureId],
        16,
      );
      const resources = clampInt(45 + pressureAffinityIds.length * 6, 0, 100);
      const heat = clampInt(35 + pressureAffinityIds.length * 5, 0, 100);
      return {
        factionId: entry.factionId,
        name: toTitleCaseFromId(entry.factionId),
        enabled: true,
        homeLocationIds,
        pressureAffinityIds,
        resources,
        heat,
        posture: postureFromSeed({ resources, heat }),
      } as FactionCanonEntry;
    });

  return {
    schemaVersion: FACTION_CANON_SCHEMA_VERSION,
    worldId: seed.worldId,
    factions,
  };
}

function normalizeFactionForFingerprint(entry: FactionCanonEntry): Record<string, unknown> {
  return {
    factionId: entry.factionId,
    name: entry.name,
    enabled: entry.enabled,
    homeLocationIds: uniqStrings(entry.homeLocationIds, 64).slice().sort((a, b) => a.localeCompare(b)),
    pressureAffinityIds: uniqStrings(entry.pressureAffinityIds, 64).slice().sort((a, b) => a.localeCompare(b)),
    resources: clampInt(entry.resources, 0, 100),
    heat: clampInt(entry.heat, 0, 100),
    posture: normalizePosture(entry.posture),
  };
}

function normalizeFactionScaffoldForFingerprint(entry: FactionCanonEntry): Record<string, unknown> {
  return {
    factionId: entry.factionId,
    name: entry.name,
    enabled: entry.enabled,
    homeLocationIds: uniqStrings(entry.homeLocationIds, 64).slice().sort((a, b) => a.localeCompare(b)),
    pressureAffinityIds: uniqStrings(entry.pressureAffinityIds, 64).slice().sort((a, b) => a.localeCompare(b)),
    posture: normalizePosture(entry.posture),
  };
}

function canonicalByFactionId(canon: FactionCanonFile): Map<string, FactionCanonEntry> {
  const entries: Array<[string, FactionCanonEntry]> = canon.factions.map((entry) => [entry.factionId, entry]);
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return new Map(entries);
}

function equalStringArrayAsSet(a: string[], b: string[]): boolean {
  const left = uniqStrings(a, 128).slice().sort((x, y) => x.localeCompare(y));
  const right = uniqStrings(b, 128).slice().sort((x, y) => x.localeCompare(y));
  if (left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => entry === right[index]);
}

function compareScaffoldFields(seedEntry: FactionCanonEntry, canonEntry: FactionCanonEntry): FactionScaffoldChangedEntry["fields"] {
  const fields: FactionScaffoldChangedEntry["fields"] = [];
  if (seedEntry.name !== canonEntry.name) {
    fields.push({
      field: "name",
      seedValue: seedEntry.name,
      canonValue: canonEntry.name,
    });
  }
  if (seedEntry.enabled !== canonEntry.enabled) {
    fields.push({
      field: "enabled",
      seedValue: seedEntry.enabled,
      canonValue: canonEntry.enabled,
    });
  }
  if (!equalStringArrayAsSet(seedEntry.homeLocationIds, canonEntry.homeLocationIds)) {
    fields.push({
      field: "homeLocationIds",
      seedValue: uniqStrings(seedEntry.homeLocationIds, 64).slice().sort((a, b) => a.localeCompare(b)),
      canonValue: uniqStrings(canonEntry.homeLocationIds, 64).slice().sort((a, b) => a.localeCompare(b)),
    });
  }
  if (!equalStringArrayAsSet(seedEntry.pressureAffinityIds, canonEntry.pressureAffinityIds)) {
    fields.push({
      field: "pressureAffinityIds",
      seedValue: uniqStrings(seedEntry.pressureAffinityIds, 64).slice().sort((a, b) => a.localeCompare(b)),
      canonValue: uniqStrings(canonEntry.pressureAffinityIds, 64).slice().sort((a, b) => a.localeCompare(b)),
    });
  }
  if (seedEntry.posture !== canonEntry.posture) {
    fields.push({
      field: "posture",
      seedValue: seedEntry.posture,
      canonValue: canonEntry.posture,
    });
  }
  return fields;
}

export function buildFactionCanonFingerprint(canon: FactionCanonFile): string {
  return hashSha256(
    stableStringify({
      schemaVersion: canon.schemaVersion,
      worldId: canon.worldId,
      factions: canon.factions
        .slice()
        .sort((a, b) => a.factionId.localeCompare(b.factionId))
        .map((entry) => normalizeFactionForFingerprint(entry)),
    }),
  );
}

export function buildFactionScaffoldFingerprint(canon: FactionCanonFile): string {
  return hashSha256(
    stableStringify({
      schemaVersion: canon.schemaVersion,
      worldId: canon.worldId,
      factions: canon.factions
        .slice()
        .sort((a, b) => a.factionId.localeCompare(b.factionId))
        .map((entry) => normalizeFactionScaffoldForFingerprint(entry)),
    }),
  );
}

export function detectFactionCanonScaffoldDrift(params: {
  seed: WorldSeed;
  canon: FactionCanonFile;
}): FactionScaffoldDriftReport {
  const projected = projectFactionCanonFromWorldSeed(params.seed);
  const projectedById = canonicalByFactionId(projected);
  const canonById = canonicalByFactionId(params.canon);

  const addedInSeed: string[] = [];
  const missingInSeed: string[] = [];
  const changedScaffold: FactionScaffoldChangedEntry[] = [];
  const operationalDivergence: FactionOperationalDivergenceEntry[] = [];
  const incompatible: string[] = [];

  if (projected.worldId !== params.canon.worldId) {
    incompatible.push(`world_id_mismatch:${projected.worldId}:${params.canon.worldId}`);
  }

  for (const seedFactionId of Array.from(projectedById.keys()).sort((a, b) => a.localeCompare(b))) {
    const seedEntry = projectedById.get(seedFactionId);
    if (!seedEntry) {
      continue;
    }
    const canonEntry = canonById.get(seedFactionId);
    if (!canonEntry) {
      addedInSeed.push(seedFactionId);
      continue;
    }

    const fieldChanges = compareScaffoldFields(seedEntry, canonEntry);
    if (fieldChanges.length > 0) {
      changedScaffold.push({
        factionId: seedFactionId,
        fields: fieldChanges,
      });
    }

    if (seedEntry.resources !== canonEntry.resources || seedEntry.heat !== canonEntry.heat) {
      operationalDivergence.push({
        factionId: seedFactionId,
        resources: {
          seedProjected: seedEntry.resources,
          canonCurrent: canonEntry.resources,
        },
        heat: {
          seedProjected: seedEntry.heat,
          canonCurrent: canonEntry.heat,
        },
      });
    }
  }

  for (const canonFactionId of Array.from(canonById.keys()).sort((a, b) => a.localeCompare(b))) {
    if (!projectedById.has(canonFactionId)) {
      missingInSeed.push(canonFactionId);
    }
  }

  const status: FactionScaffoldDriftStatus =
    incompatible.length > 0
      ? "incompatible"
      : addedInSeed.length > 0 || missingInSeed.length > 0 || changedScaffold.length > 0
        ? "drifted"
        : "aligned";

  return {
    sourcePolicy: "canon_authoritative",
    generatedAtIso: new Date().toISOString(),
    world: {
      seedWorldId: projected.worldId,
      canonWorldId: params.canon.worldId,
    },
    fingerprints: {
      seedScaffold: buildFactionScaffoldFingerprint(projected),
      canon: buildFactionCanonFingerprint(params.canon),
    },
    status,
    summary: {
      addedInSeed: addedInSeed.length,
      missingInSeed: missingInSeed.length,
      changedScaffold: changedScaffold.length,
      incompatible: incompatible.length,
      operationalDivergence: operationalDivergence.length,
    },
    details: {
      addedInSeed,
      missingInSeed,
      changedScaffold,
      incompatible,
      operationalDivergence,
    },
  };
}

export function syncFactionCanonFromSeedScaffold(params: {
  seed: WorldSeed;
  currentCanon: FactionCanonFile | null;
  policy?: FactionScaffoldSyncPolicy;
}): FactionScaffoldSyncResult {
  const policy = params.policy ?? "preserve_operational";
  const projected = projectFactionCanonFromWorldSeed(params.seed);
  const drift = detectFactionCanonScaffoldDrift({
    seed: params.seed,
    canon: params.currentCanon ?? projected,
  });

  if (!params.currentCanon || policy === "replace_all") {
    return {
      policy,
      nextCanon: projected,
      drift,
      summary: {
        addedFromSeed: projected.factions.length,
        updatedFromSeed: 0,
        preservedOperational: 0,
        preservedCanonOnly: 0,
        removedByPolicy: params.currentCanon
          ? params.currentCanon.factions.filter((entry) => !projected.factions.some((seedEntry) => seedEntry.factionId === entry.factionId)).length
          : 0,
      },
    };
  }

  const currentById = canonicalByFactionId(params.currentCanon);
  const nextFactions: FactionCanonEntry[] = [];
  let addedFromSeed = 0;
  let updatedFromSeed = 0;
  let preservedOperational = 0;

  for (const projectedFaction of projected.factions.slice().sort((a, b) => a.factionId.localeCompare(b.factionId))) {
    const current = currentById.get(projectedFaction.factionId);
    if (!current) {
      addedFromSeed += 1;
      nextFactions.push(projectedFaction);
      continue;
    }
    updatedFromSeed += 1;
    preservedOperational += 1;
    nextFactions.push({
      ...projectedFaction,
      resources: current.resources,
      heat: current.heat,
    });
  }

  const canonOnly = params.currentCanon.factions
    .filter((entry) => !projected.factions.some((seedEntry) => seedEntry.factionId === entry.factionId))
    .sort((a, b) => a.factionId.localeCompare(b.factionId));
  for (const retained of canonOnly) {
    nextFactions.push(retained);
  }

  return {
    policy,
    nextCanon: {
      schemaVersion: FACTION_CANON_SCHEMA_VERSION,
      worldId: projected.worldId,
      factions: nextFactions,
    },
    drift,
    summary: {
      addedFromSeed,
      updatedFromSeed,
      preservedOperational,
      preservedCanonOnly: canonOnly.length,
      removedByPolicy: 0,
    },
  };
}
