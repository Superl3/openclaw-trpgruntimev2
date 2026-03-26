export const LLM_CONTRACT_VERSION = 1;
export const PRE_RESOLVED_CLAIM_POLICY = "warning-only:preResolvedClaim never authorizes success and cannot override deterministic engine rules";
export const INTENT_ANALYZER_INPUT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["contractVersion", "sessionId", "sceneId", "text", "inputKind", "context"],
    properties: {
        contractVersion: { type: "integer", enum: [LLM_CONTRACT_VERSION] },
        sessionId: { type: "string", minLength: 1, maxLength: 120 },
        sceneId: { type: "string", minLength: 1, maxLength: 120 },
        text: { type: "string", minLength: 1, maxLength: 600 },
        locale: { type: "string", minLength: 2, maxLength: 24 },
        inputKind: { type: "string", enum: ["free_sentence"] },
        context: {
            type: "object",
            additionalProperties: false,
            required: [
                "scenePhase",
                "pressure",
                "npcAvailable",
                "ongoingActionKind",
                "availableActions",
                "lastMappedActionId",
            ],
            properties: {
                scenePhase: { type: "string", minLength: 1, maxLength: 32 },
                pressure: { type: "number", minimum: 0, maximum: 100 },
                npcAvailable: { type: "boolean" },
                ongoingActionKind: { type: ["string", "null"], minLength: 1, maxLength: 32 },
                availableActions: {
                    type: "array",
                    maxItems: 12,
                    items: { type: "string", minLength: 1, maxLength: 64 },
                },
                lastMappedActionId: { type: ["string", "null"], minLength: 1, maxLength: 64 },
            },
        },
    },
};
export const INTENT_ANALYZER_OUTPUT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: [
        "contractVersion",
        "intent",
        "confidence",
        "normalizedText",
        "extractedSignals",
        "candidateActions",
        "riskSignals",
        "preResolvedClaim",
    ],
    properties: {
        contractVersion: { type: "integer", enum: [LLM_CONTRACT_VERSION] },
        intent: { type: "string", enum: ["unknown", "action", "dialogue", "meta"] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        normalizedText: { type: "string", minLength: 0, maxLength: 600 },
        extractedSignals: {
            type: "array",
            maxItems: 12,
            items: { type: "string", minLength: 1, maxLength: 64 },
        },
        candidateActions: {
            type: "array",
            maxItems: 8,
            items: {
                type: "object",
                additionalProperties: false,
                required: ["actionId", "score"],
                properties: {
                    actionId: { type: "string", minLength: 1, maxLength: 64 },
                    score: { type: "number", minimum: 0, maximum: 1 },
                },
            },
        },
        riskSignals: {
            type: "array",
            maxItems: 8,
            items: { type: "string", minLength: 1, maxLength: 64 },
        },
        preResolvedClaim: { type: "boolean" },
    },
};
export const PERSONA_DRIFT_INPUT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: [
        "contractVersion",
        "sessionId",
        "sceneId",
        "recentFreeInputs",
        "recentResolvedActions",
        "recentClassifications",
        "currentBehavioralDrift",
        "coreIdentityRef",
    ],
    properties: {
        contractVersion: { type: "integer", enum: [LLM_CONTRACT_VERSION] },
        sessionId: { type: "string", minLength: 1, maxLength: 120 },
        sceneId: { type: "string", minLength: 1, maxLength: 120 },
        recentFreeInputs: {
            type: "array",
            maxItems: 8,
            items: { type: "string", minLength: 1, maxLength: 300 },
        },
        recentResolvedActions: {
            type: "array",
            maxItems: 8,
            items: { type: "string", minLength: 1, maxLength: 64 },
        },
        recentClassifications: {
            type: "array",
            maxItems: 8,
            items: { type: "string", minLength: 1, maxLength: 32 },
        },
        currentBehavioralDrift: {
            type: "object",
            additionalProperties: false,
            required: ["warmth", "boldness", "caution", "altruism", "aggression", "humor"],
            properties: {
                warmth: { type: "number", minimum: -1, maximum: 1 },
                boldness: { type: "number", minimum: -1, maximum: 1 },
                caution: { type: "number", minimum: -1, maximum: 1 },
                altruism: { type: "number", minimum: -1, maximum: 1 },
                aggression: { type: "number", minimum: -1, maximum: 1 },
                humor: { type: "number", minimum: -1, maximum: 1 },
            },
        },
        coreIdentityRef: {
            type: "object",
            additionalProperties: false,
            required: ["warmth", "boldness", "caution", "altruism", "aggression", "humor"],
            properties: {
                warmth: { type: "number", minimum: -1, maximum: 1 },
                boldness: { type: "number", minimum: -1, maximum: 1 },
                caution: { type: "number", minimum: -1, maximum: 1 },
                altruism: { type: "number", minimum: -1, maximum: 1 },
                aggression: { type: "number", minimum: -1, maximum: 1 },
                humor: { type: "number", minimum: -1, maximum: 1 },
            },
        },
    },
};
export const PERSONA_DRIFT_OUTPUT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["contractVersion", "confidence", "driftDelta", "dominantSignals", "notes"],
    properties: {
        contractVersion: { type: "integer", enum: [LLM_CONTRACT_VERSION] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        driftDelta: {
            type: "object",
            additionalProperties: false,
            required: ["warmth", "boldness", "caution", "altruism", "aggression", "humor"],
            properties: {
                warmth: { type: "number", minimum: -1, maximum: 1 },
                boldness: { type: "number", minimum: -1, maximum: 1 },
                caution: { type: "number", minimum: -1, maximum: 1 },
                altruism: { type: "number", minimum: -1, maximum: 1 },
                aggression: { type: "number", minimum: -1, maximum: 1 },
                humor: { type: "number", minimum: -1, maximum: 1 },
            },
        },
        dominantSignals: {
            type: "array",
            maxItems: 8,
            items: { type: "string", minLength: 1, maxLength: 64 },
        },
        notes: {
            type: "array",
            maxItems: 8,
            items: { type: "string", minLength: 1, maxLength: 120 },
        },
    },
};
export const QUEST_HOOK_TEXT_INPUT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["contractVersion", "sessionId", "sceneId", "nowIso", "slots"],
    properties: {
        contractVersion: { type: "integer", enum: [LLM_CONTRACT_VERSION] },
        sessionId: { type: "string", minLength: 1, maxLength: 120 },
        sceneId: { type: "string", minLength: 1, maxLength: 120 },
        nowIso: { type: "string", minLength: 20, maxLength: 40 },
        locale: { type: "string", minLength: 2, maxLength: 24 },
        slots: {
            type: "array",
            maxItems: 3,
            items: {
                oneOf: [
                    {
                        type: "object",
                        additionalProperties: false,
                        required: [
                            "slotKey",
                            "slotType",
                            "questId",
                            "lifecycle",
                            "urgencyBand",
                            "hookType",
                            "locationId",
                            "defaultText",
                            "sourceHash",
                        ],
                        properties: {
                            slotKey: { type: "string", minLength: 1, maxLength: 80 },
                            slotType: { type: "string", enum: ["actionable"] },
                            questId: { type: "string", minLength: 1, maxLength: 80 },
                            lifecycle: { type: "string", enum: ["active", "stalled", "surfaced"] },
                            urgencyBand: { type: "string", enum: ["low", "moderate", "high", "critical"] },
                            hookType: { type: "string", enum: ["incident", "rumor", "witness", "request"] },
                            locationId: { type: ["string", "null"], minLength: 1, maxLength: 80 },
                            defaultText: { type: "string", minLength: 1, maxLength: 220 },
                            sourceHash: { type: "string", minLength: 4, maxLength: 40 },
                        },
                    },
                    {
                        type: "object",
                        additionalProperties: false,
                        required: [
                            "slotKey",
                            "slotType",
                            "archetype",
                            "trend",
                            "intensityBand",
                            "locationHint",
                            "defaultText",
                            "sourceHash",
                        ],
                        properties: {
                            slotKey: { type: "string", minLength: 1, maxLength: 80 },
                            slotType: { type: "string", enum: ["worldPulse"] },
                            archetype: { type: "string", enum: ["smuggling", "outbreak", "power_struggle", "artifact_race", "public_order"] },
                            trend: { type: "string", enum: ["rising", "steady", "cooling"] },
                            intensityBand: { type: "string", enum: ["low", "moderate", "high", "critical"] },
                            locationHint: { type: ["string", "null"], minLength: 1, maxLength: 80 },
                            defaultText: { type: "string", minLength: 1, maxLength: 220 },
                            sourceHash: { type: "string", minLength: 4, maxLength: 40 },
                        },
                    },
                ],
            },
        },
    },
};
export const QUEST_HOOK_TEXT_OUTPUT_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["contractVersion", "overrides"],
    properties: {
        contractVersion: { type: "integer", enum: [LLM_CONTRACT_VERSION] },
        overrides: {
            type: "array",
            maxItems: 3,
            items: {
                type: "object",
                additionalProperties: false,
                required: ["slotKey", "shortText"],
                properties: {
                    slotKey: { type: "string", minLength: 1, maxLength: 80 },
                    shortText: { type: "string", minLength: 1, maxLength: 220 },
                },
            },
        },
    },
};
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function isFiniteWithin(value, min, max) {
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
export function emptyDriftAxisVector() {
    return {
        warmth: 0,
        boldness: 0,
        caution: 0,
        altruism: 0,
        aggression: 0,
        humor: 0,
    };
}
function isDriftAxisVector(value) {
    if (!isRecord(value)) {
        return false;
    }
    return (isFiniteWithin(value.warmth, -1, 1) &&
        isFiniteWithin(value.boldness, -1, 1) &&
        isFiniteWithin(value.caution, -1, 1) &&
        isFiniteWithin(value.altruism, -1, 1) &&
        isFiniteWithin(value.aggression, -1, 1) &&
        isFiniteWithin(value.humor, -1, 1));
}
function isIntentActionCandidate(value) {
    if (!isRecord(value)) {
        return false;
    }
    return typeof value.actionId === "string" && value.actionId.length > 0 && isFiniteWithin(value.score, 0, 1);
}
export function isIntentAnalyzerOutput(value) {
    if (!isRecord(value)) {
        return false;
    }
    const candidateActions = Array.isArray(value.candidateActions) ? value.candidateActions : null;
    return (value.contractVersion === LLM_CONTRACT_VERSION &&
        (value.intent === "unknown" || value.intent === "action" || value.intent === "dialogue" || value.intent === "meta") &&
        isFiniteWithin(value.confidence, 0, 1) &&
        typeof value.normalizedText === "string" &&
        isStringArray(value.extractedSignals) &&
        candidateActions !== null &&
        candidateActions.every((entry) => isIntentActionCandidate(entry)) &&
        isStringArray(value.riskSignals) &&
        typeof value.preResolvedClaim === "boolean");
}
export function isPersonaDriftAnalyzerOutput(value) {
    if (!isRecord(value)) {
        return false;
    }
    return (value.contractVersion === LLM_CONTRACT_VERSION &&
        isFiniteWithin(value.confidence, 0, 1) &&
        isDriftAxisVector(value.driftDelta) &&
        isStringArray(value.dominantSignals) &&
        isStringArray(value.notes));
}
function isQuestHookTextOutputOverride(value) {
    if (!isRecord(value)) {
        return false;
    }
    return typeof value.slotKey === "string" && value.slotKey.length > 0 && typeof value.shortText === "string" && value.shortText.length > 0;
}
export function isQuestHookTextOutput(value) {
    if (!isRecord(value)) {
        return false;
    }
    const overrides = Array.isArray(value.overrides) ? value.overrides : null;
    if (value.contractVersion !== LLM_CONTRACT_VERSION || overrides === null || overrides.length > 3) {
        return false;
    }
    const seenKeys = new Set();
    for (const entry of overrides) {
        if (!isQuestHookTextOutputOverride(entry)) {
            return false;
        }
        const key = entry.slotKey.trim();
        if (!key || seenKeys.has(key)) {
            return false;
        }
        seenKeys.add(key);
    }
    return true;
}
