const PATCH_OPERATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    op: { type: "string", enum: ["set", "delete", "append_list"] },
    file: { type: "string" },
    pointer: { type: "string" },
    value: {},
    expectedSha256: { type: "string" },
  },
  required: ["op", "file", "pointer"],
} as const;

const GOVERNANCE_FIELDS = {
  requestId: { type: "string" },
  idempotencyKey: { type: "string" },
  expectedStateVersion: { type: "integer", minimum: 0 },
  confirm: { type: "boolean" },
} as const;

const PATCH_DRY_RUN_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...GOVERNANCE_FIELDS,
    patchId: { type: "string" },
    title: { type: "string" },
    allowNewFiles: { type: "boolean" },
    operations: { type: "array", items: PATCH_OPERATION_SCHEMA, minItems: 1 },
  },
  required: ["operations"],
} as const;

export const STORE_GET_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...GOVERNANCE_FIELDS,
    entityIds: { type: "array", items: { type: "string" } },
    paths: { type: "array", items: { type: "string" } },
    scope: { type: "string", enum: ["all", "canon", "state", "secrets", "logs"] },
    viewMode: {
      type: "string",
      enum: ["raw", "truth", "player_known", "public_rumor", "npc_beliefs"],
    },
    maxFiles: { type: "integer", minimum: 1, maximum: 200 },
    includeRaw: { type: "boolean" },
  },
} as const;

export const PATCH_DRY_RUN_TOOL_PARAMETERS = PATCH_DRY_RUN_PARAMETERS;

export const PATCH_APPLY_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...GOVERNANCE_FIELDS,
    validatedPatchId: { type: "string" },
    patchPayload: PATCH_DRY_RUN_PARAMETERS,
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
  required: ["audit"],
} as const;

export const HOOKS_QUERY_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...GOVERNANCE_FIELDS,
    currentSceneTags: { type: "array", items: { type: "string" } },
    actorIds: { type: "array", items: { type: "string" } },
    pacingTarget: { type: "string", enum: ["slow-burn", "steady", "escalate", "cooldown"] },
    revealBudget: { type: "integer", minimum: 0, maximum: 20 },
  },
} as const;

export const DICE_ROLL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...GOVERNANCE_FIELDS,
    notation: { type: "string" },
    modifier: { type: "number" },
    seedPolicy: { type: "string", enum: ["session", "fixed", "random"] },
    seed: { type: "string" },
    repeat: { type: "integer", minimum: 1, maximum: 20 },
  },
} as const;

export const FACTION_TICK_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...GOVERNANCE_FIELDS,
    trigger: { type: "string", enum: ["turn", "scene_transition", "session", "downtime"] },
    mode: { type: "string", enum: ["read-only", "dry-run"] },
    maxEvents: { type: "integer", minimum: 1, maximum: 8 },
    includeUndropped: { type: "boolean" },
    forceAdvance: { type: "boolean" },
  },
} as const;

export const STATE_COMPACT_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...GOVERNANCE_FIELDS,
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

export const STATUS_INVENTORY_REPAIR_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...GOVERNANCE_FIELDS,
    dryRun: { type: "boolean" },
    repairStatus: { type: "boolean" },
    repairInventory: { type: "boolean" },
  },
} as const;
