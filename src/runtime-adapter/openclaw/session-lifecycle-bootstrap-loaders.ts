import type { TrpgRuntimeConfig } from "../../config.js";
import type { RuntimeBootstrapLoadResult } from "../../runtime-core/contracts.js";
import {
  buildFactionCanonFingerprint,
  buildFactionCanonReferenceIndexFromWorldSeed,
  detectFactionCanonScaffoldDrift,
  validateFactionCanon,
} from "../../faction-canon.js";
import type { RuntimeCanonicalProvenance } from "../../runtime-core/types.js";
import { buildRuntimeBootstrapInput, validateWorldSeed } from "../../runtime-core/world-seed.js";
import {
  createRuntimeCanonicalProvenance,
  driftStatusFromLoadStatus,
  type CanonicalLoadStatus,
} from "../../runtime-core/sync-meta.js";
import { loadStructuredWorldFile } from "../../world-store.js";

const FACTION_CANON_PATH = "canon/factions.yaml";
const WORLD_SEED_CANDIDATE_PATHS = [
  "canon/world-seed.yaml",
  "canon/world-seed.yml",
  "canon/world-seed.json",
  "state/world-seed.yaml",
  "state/world-seed.yml",
  "state/world-seed.json",
  "state/world-seeds.yaml",
  "state/world-seeds.yml",
  "state/world-seeds.json",
] as const;

function toSeedDiagnostics(
  issues: Array<{ code: string; message: string; path: string; severity: "warn" | "error" }>,
  sourcePath: string,
): RuntimeBootstrapLoadResult["diagnostics"] {
  return issues.slice(0, 24).map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: issue.path ? `${sourcePath}${issue.path}` : sourcePath,
    severity: issue.severity,
  }));
}

export async function loadRuntimeBootstrapFromWorldSeed(params: {
  worldRoot: string;
  cfg: TrpgRuntimeConfig;
}): Promise<RuntimeBootstrapLoadResult> {
  for (const candidatePath of WORLD_SEED_CANDIDATE_PATHS) {
    let loaded;
    try {
      loaded = await loadStructuredWorldFile(params.worldRoot, candidatePath, {
        allowMissing: true,
        maxReadBytes: params.cfg.maxReadBytes,
      });
    } catch (error) {
      return {
        status: "error",
        sourcePath: candidatePath,
        bootstrap: null,
        validatedSeed: null,
        diagnostics: [
          {
            code: "world_seed_load_error",
            message: error instanceof Error ? error.message : String(error),
            path: candidatePath,
            severity: "error",
          },
        ],
      };
    }

    if (!loaded.exists) {
      continue;
    }

    const validated = validateWorldSeed(loaded.parsed);
    if (!validated.ok) {
      return {
        status: "invalid",
        sourcePath: candidatePath,
        bootstrap: null,
        validatedSeed: null,
        diagnostics: toSeedDiagnostics(validated.issues, candidatePath),
      };
    }

    return {
      status: "used",
      sourcePath: candidatePath,
      bootstrap: buildRuntimeBootstrapInput(validated.seed),
      validatedSeed: validated.seed,
      diagnostics: toSeedDiagnostics(validated.issues, candidatePath),
    };
  }

  return {
    status: "missing",
    sourcePath: null,
    bootstrap: null,
    validatedSeed: null,
    diagnostics: [],
  };
}

export async function loadRuntimeCanonicalProvenance(params: {
  worldRoot: string;
  cfg: TrpgRuntimeConfig;
  seedBootstrap: RuntimeBootstrapLoadResult;
}): Promise<RuntimeCanonicalProvenance> {
  const nowIso = new Date().toISOString();
  const seedStatus = params.seedBootstrap.status as CanonicalLoadStatus;
  const seed = params.seedBootstrap.validatedSeed;

  let canonStatus: CanonicalLoadStatus = "missing";
  let canonSourcePath: string | null = null;
  let canonFingerprint: string | null = null;
  let canonWorldId: string | null = null;
  let driftCounts = {
    addedInSeed: 0,
    missingInSeed: 0,
    changedScaffold: 0,
    incompatible: 0,
  };
  let hasDrift = false;
  let hasIncompatible = false;

  try {
    const loadedCanon = await loadStructuredWorldFile(params.worldRoot, FACTION_CANON_PATH, {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    });

    if (!loadedCanon.exists) {
      canonStatus = "missing";
    } else {
      canonSourcePath = FACTION_CANON_PATH;
      const referenceIndex = seed ? buildFactionCanonReferenceIndexFromWorldSeed(seed) : null;
      const validatedCanon = validateFactionCanon(loadedCanon.parsed, {
        references: referenceIndex
          ? {
              worldId: referenceIndex.worldId,
              locationIds: referenceIndex.locationIds,
              pressureIds: referenceIndex.pressureIds,
            }
          : undefined,
      });

      if (!validatedCanon.ok) {
        canonStatus = "invalid";
      } else {
        canonStatus = "used";
        canonWorldId = validatedCanon.canon.worldId;
        canonFingerprint = buildFactionCanonFingerprint(validatedCanon.canon);
        if (seed) {
          const drift = detectFactionCanonScaffoldDrift({
            seed,
            canon: validatedCanon.canon,
          });
          driftCounts = {
            addedInSeed: drift.summary.addedInSeed,
            missingInSeed: drift.summary.missingInSeed,
            changedScaffold: drift.summary.changedScaffold,
            incompatible: drift.summary.incompatible,
          };
          hasDrift =
            drift.summary.addedInSeed > 0 ||
            drift.summary.missingInSeed > 0 ||
            drift.summary.changedScaffold > 0 ||
            drift.summary.incompatible > 0;
          hasIncompatible = drift.status === "incompatible";
        }
      }
    }
  } catch {
    canonStatus = "error";
  }

  const driftStatus = driftStatusFromLoadStatus({
    seedStatus,
    canonStatus,
    hasDrift,
    hasIncompatible,
  });

  return createRuntimeCanonicalProvenance({
    sourcePolicy: "canon_authoritative",
    worldId: seed?.worldId ?? canonWorldId ?? null,
    schemaVersion: seed?.schemaVersion ?? null,
    seedSourcePath: params.seedBootstrap.sourcePath,
    seedFingerprint: params.seedBootstrap.bootstrap?.seedFingerprint ?? null,
    canonSourcePath,
    canonFingerprint,
    generatedAtIso: seed?.createdAtIso ?? null,
    validatedAtIso: nowIso,
    driftStatus,
    driftCounts,
  });
}
