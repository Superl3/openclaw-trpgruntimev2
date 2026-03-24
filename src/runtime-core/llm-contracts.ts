export const LLM_CONTRACT_VERSION = 1 as const;

export type IntentLabel = "unknown" | "action" | "dialogue" | "meta";

export type DriftAxisVector = {
  warmth: number;
  boldness: number;
  caution: number;
  altruism: number;
  aggression: number;
  humor: number;
};

export type IntentActionCandidate = {
  actionId: string;
  score: number;
};

export type IntentAnalyzerInput = {
  contractVersion: typeof LLM_CONTRACT_VERSION;
  sessionId: string;
  sceneId: string;
  text: string;
  locale?: string;
  inputKind: "free_sentence";
  context: {
    scenePhase: string;
    pressure: number;
    npcAvailable: boolean;
    ongoingActionKind: string | null;
    availableActions: string[];
    lastMappedActionId: string | null;
  };
};

export type IntentAnalyzerOutput = {
  contractVersion: typeof LLM_CONTRACT_VERSION;
  intent: IntentLabel;
  confidence: number;
  normalizedText: string;
  extractedSignals: string[];
  candidateActions: IntentActionCandidate[];
  riskSignals: string[];
  preResolvedClaim: boolean;
};

export type PersonaDriftAnalyzerInput = {
  contractVersion: typeof LLM_CONTRACT_VERSION;
  sessionId: string;
  sceneId: string;
  recentFreeInputs: string[];
  recentResolvedActions: string[];
  recentClassifications: string[];
  currentBehavioralDrift: DriftAxisVector;
  coreIdentityRef: DriftAxisVector;
};

export type PersonaDriftAnalyzerOutput = {
  contractVersion: typeof LLM_CONTRACT_VERSION;
  confidence: number;
  driftDelta: DriftAxisVector;
  dominantSignals: string[];
  notes: string[];
};

export type SceneRendererInput = {
  contractVersion: typeof LLM_CONTRACT_VERSION;
  sessionId: string;
  sceneId: string;
  beatId: string;
  exchangeId: string;
  deterministicContext: Record<string, unknown>;
};

export type SceneRendererOutput = {
  contractVersion: typeof LLM_CONTRACT_VERSION;
  narration: string;
  panelHints: {
    fixed: string;
    main: string;
    sub: string;
  };
  optionalActionHints: string[];
};

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
} as const;

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
} as const;

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
} as const;

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
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isFiniteWithin(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function emptyDriftAxisVector(): DriftAxisVector {
  return {
    warmth: 0,
    boldness: 0,
    caution: 0,
    altruism: 0,
    aggression: 0,
    humor: 0,
  };
}

function isDriftAxisVector(value: unknown): value is DriftAxisVector {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteWithin(value.warmth, -1, 1) &&
    isFiniteWithin(value.boldness, -1, 1) &&
    isFiniteWithin(value.caution, -1, 1) &&
    isFiniteWithin(value.altruism, -1, 1) &&
    isFiniteWithin(value.aggression, -1, 1) &&
    isFiniteWithin(value.humor, -1, 1)
  );
}

function isIntentActionCandidate(value: unknown): value is IntentActionCandidate {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.actionId === "string" && value.actionId.length > 0 && isFiniteWithin(value.score, 0, 1);
}

export function isIntentAnalyzerOutput(value: unknown): value is IntentAnalyzerOutput {
  if (!isRecord(value)) {
    return false;
  }

  const candidateActions = Array.isArray(value.candidateActions) ? value.candidateActions : null;

  return (
    value.contractVersion === LLM_CONTRACT_VERSION &&
    (value.intent === "unknown" || value.intent === "action" || value.intent === "dialogue" || value.intent === "meta") &&
    isFiniteWithin(value.confidence, 0, 1) &&
    typeof value.normalizedText === "string" &&
    isStringArray(value.extractedSignals) &&
    candidateActions !== null &&
    candidateActions.every((entry) => isIntentActionCandidate(entry)) &&
    isStringArray(value.riskSignals) &&
    typeof value.preResolvedClaim === "boolean"
  );
}

export function isPersonaDriftAnalyzerOutput(value: unknown): value is PersonaDriftAnalyzerOutput {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.contractVersion === LLM_CONTRACT_VERSION &&
    isFiniteWithin(value.confidence, 0, 1) &&
    isDriftAxisVector(value.driftDelta) &&
    isStringArray(value.dominantSignals) &&
    isStringArray(value.notes)
  );
}
