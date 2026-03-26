export const RUNTIME_SCHEMA_VERSION = 1;
export const WORLD_SEED_SCHEMA_VERSION = 1;
export function makeInteractionRouteStorageKey(key) {
    return `${key.sessionId}::${String(key.uiVersion)}::${key.sceneId}::${key.actionId}`;
}
function toRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function readString(value) {
    return typeof value === "string" ? value.trim() : "";
}
function normalizeDiagnosticSeverity(value) {
    const normalized = readString(value);
    if (normalized === "info" || normalized === "warn" || normalized === "error") {
        return normalized;
    }
    return "warn";
}
function normalizeRuntimeSeedProvenance(value) {
    const node = toRecord(value);
    const worldId = readString(node.worldId);
    const seedValue = readString(node.seedValue);
    const seedFingerprint = readString(node.seedFingerprint);
    const schemaVersionRaw = Number(node.schemaVersion);
    const schemaVersion = Number.isFinite(schemaVersionRaw) ? Math.max(1, Math.trunc(schemaVersionRaw)) : 1;
    if (!worldId || !seedValue || !seedFingerprint) {
        return null;
    }
    return {
        worldId,
        seedValue,
        seedFingerprint,
        schemaVersion,
    };
}
function readInt(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}
function readIsoNullable(value) {
    const normalized = readString(value);
    if (!normalized) {
        return null;
    }
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function normalizeCanonicalSourcePolicy(value) {
    const normalized = readString(value);
    if (normalized === "seed_bootstrap_only" || normalized === "canon_authoritative") {
        return normalized;
    }
    return "seed_bootstrap_only";
}
function normalizeCanonicalDriftStatus(value) {
    const normalized = readString(value);
    if (normalized === "unknown" ||
        normalized === "aligned" ||
        normalized === "drifted" ||
        normalized === "missing_seed" ||
        normalized === "missing_canon" ||
        normalized === "invalid_seed" ||
        normalized === "invalid_canon") {
        return normalized;
    }
    return "unknown";
}
function normalizeRuntimeCanonicalProvenance(value) {
    const node = toRecord(value);
    const driftCountsNode = toRecord(node.driftCounts);
    return {
        sourcePolicy: normalizeCanonicalSourcePolicy(node.sourcePolicy),
        worldId: readString(node.worldId) || null,
        schemaVersion: Number.isFinite(Number(node.schemaVersion))
            ? Math.max(1, readInt(node.schemaVersion, 1))
            : null,
        seedSourcePath: readString(node.seedSourcePath) || null,
        seedFingerprint: readString(node.seedFingerprint) || null,
        canonSourcePath: readString(node.canonSourcePath) || null,
        canonFingerprint: readString(node.canonFingerprint) || null,
        generatedAtIso: readIsoNullable(node.generatedAtIso),
        validatedAtIso: readIsoNullable(node.validatedAtIso),
        driftStatus: normalizeCanonicalDriftStatus(node.driftStatus),
        driftCounts: {
            addedInSeed: Math.max(0, readInt(driftCountsNode.addedInSeed, 0)),
            missingInSeed: Math.max(0, readInt(driftCountsNode.missingInSeed, 0)),
            changedScaffold: Math.max(0, readInt(driftCountsNode.changedScaffold, 0)),
            incompatible: Math.max(0, readInt(driftCountsNode.incompatible, 0)),
        },
    };
}
export function createDefaultRuntimeCanonicalProvenance() {
    return {
        sourcePolicy: "seed_bootstrap_only",
        worldId: null,
        schemaVersion: null,
        seedSourcePath: null,
        seedFingerprint: null,
        canonSourcePath: null,
        canonFingerprint: null,
        generatedAtIso: null,
        validatedAtIso: null,
        driftStatus: "unknown",
        driftCounts: {
            addedInSeed: 0,
            missingInSeed: 0,
            changedScaffold: 0,
            incompatible: 0,
        },
    };
}
function normalizeRuntimeBootstrapDiagnostics(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const diagnostics = [];
    for (const entry of value) {
        const node = toRecord(entry);
        const code = readString(node.code);
        const message = readString(node.message);
        if (!code || !message) {
            continue;
        }
        diagnostics.push({
            code,
            message,
            path: readString(node.path) || null,
            severity: normalizeDiagnosticSeverity(node.severity),
        });
        if (diagnostics.length >= 24) {
            break;
        }
    }
    return diagnostics;
}
export function ensureSessionPresentationState(value) {
    const node = toRecord(value);
    return {
        verboseMode: node.verboseMode === true,
    };
}
export function ensureRuntimeMetadata(value) {
    const root = toRecord(value);
    const bootstrapNode = toRecord(root.bootstrap);
    const sourceRaw = readString(bootstrapNode.source);
    const source = sourceRaw === "worldSeed" ? "worldSeed" : "default";
    const canonicalSync = normalizeRuntimeCanonicalProvenance(root.canonicalSync);
    return {
        bootstrap: {
            source,
            seed: normalizeRuntimeSeedProvenance(bootstrapNode.seed),
            diagnostics: normalizeRuntimeBootstrapDiagnostics(bootstrapNode.diagnostics),
        },
        canonicalSync: {
            ...createDefaultRuntimeCanonicalProvenance(),
            ...canonicalSync,
            driftCounts: {
                ...createDefaultRuntimeCanonicalProvenance().driftCounts,
                ...canonicalSync.driftCounts,
            },
        },
    };
}
