export function createRuntimeCanonicalProvenance(input) {
    const fallback = {
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
    const driftCounts = {
        ...fallback.driftCounts,
        ...(input?.driftCounts ?? {}),
    };
    return {
        ...fallback,
        ...(input ?? {}),
        driftCounts: {
            addedInSeed: Math.max(0, Math.trunc(driftCounts.addedInSeed)),
            missingInSeed: Math.max(0, Math.trunc(driftCounts.missingInSeed)),
            changedScaffold: Math.max(0, Math.trunc(driftCounts.changedScaffold)),
            incompatible: Math.max(0, Math.trunc(driftCounts.incompatible)),
        },
    };
}
export function driftStatusFromLoadStatus(params) {
    if (params.seedStatus === "invalid" || params.seedStatus === "error") {
        return "invalid_seed";
    }
    if (params.canonStatus === "invalid" || params.canonStatus === "error") {
        return "invalid_canon";
    }
    if (params.seedStatus === "missing") {
        return "missing_seed";
    }
    if (params.canonStatus === "missing") {
        return "missing_canon";
    }
    if (params.hasIncompatible || params.hasDrift) {
        return "drifted";
    }
    return "aligned";
}
