import path from "node:path";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import {
  DEFAULT_RUNTIME_SAFETY_FLAGS,
  normalizeRuntimeSafetyFlags,
  type RuntimeSafetyFlags,
} from "./runtime-core/safety-flags.js";

export type TrpgRuntimeConfig = {
  worldRoot?: string;
  allowPatchApply: boolean;
  diagnosticsEnabled: boolean;
  diagnosticsConsoleMirror: boolean;
  maxReadBytes: number;
  maxFilesPerQuery: number;
  maxOperationsPerPatch: number;
  allowedAgentIds: string[];
  traceMaxEvents: number;
  panelDispatchTtlSec: number;
  analyzerMemoryTtlSec: number;
  richHookTextEnabled: boolean;
  hookTextTimeoutMs: number;
  hookTextCacheTtlSec: number;
  debugRuntimeSignals: boolean;
  traceVerbose: boolean;
  telemetryExtended: boolean;
  canonicalSyncEnabled: boolean;
  canonicalWriteBackEnabled: boolean;
  runtimeSafetyFlags: RuntimeSafetyFlags;
};

type IntegerConfigSpec = {
  default: number;
  min: number;
  max: number;
};

export const TRPG_RUNTIME_INTEGER_CONFIG_SPECS = {
  maxReadBytes: { default: 262_144, min: 4_096, max: 1_048_576 },
  maxFilesPerQuery: { default: 40, min: 1, max: 200 },
  maxOperationsPerPatch: { default: 64, min: 1, max: 200 },
  traceMaxEvents: { default: 120, min: 20, max: 500 },
  panelDispatchTtlSec: { default: 180, min: 30, max: 3_600 },
  analyzerMemoryTtlSec: { default: 900, min: 60, max: 86_400 },
  hookTextTimeoutMs: { default: 350, min: 80, max: 2_000 },
  hookTextCacheTtlSec: { default: 900, min: 60, max: 7_200 },
} as const satisfies Record<string, IntegerConfigSpec>;

export const TRPG_RUNTIME_MANIFEST_BOOLEAN_DEFAULTS = {
  allowPatchApply: false,
  diagnosticsEnabled: true,
  diagnosticsConsoleMirror: true,
  behavioralDriftEnabled: DEFAULT_RUNTIME_SAFETY_FLAGS.behavioralDriftEnabled,
  behavioralDriftAffectsRules: DEFAULT_RUNTIME_SAFETY_FLAGS.behavioralDriftAffectsRules,
  anchorLifecycleEnabled: DEFAULT_RUNTIME_SAFETY_FLAGS.anchorLifecycleEnabled,
  anchorSummaryOnly: DEFAULT_RUNTIME_SAFETY_FLAGS.anchorSummaryOnly,
  richHookTextEnabled: false,
  richHookActionableEnabled: DEFAULT_RUNTIME_SAFETY_FLAGS.richHookActionableEnabled,
  richHookWorldPulseEnabled: DEFAULT_RUNTIME_SAFETY_FLAGS.richHookWorldPulseEnabled,
  richHookRecentOutcomesEnabled: DEFAULT_RUNTIME_SAFETY_FLAGS.richHookRecentOutcomesEnabled,
  debugRuntimeSignals: DEFAULT_RUNTIME_SAFETY_FLAGS.debugRuntimeSignals,
  traceVerbose: DEFAULT_RUNTIME_SAFETY_FLAGS.traceVerbose,
  telemetryExtended: DEFAULT_RUNTIME_SAFETY_FLAGS.telemetryExtended,
  canonicalSyncEnabled: DEFAULT_RUNTIME_SAFETY_FLAGS.canonicalSyncEnabled,
  canonicalWriteBackEnabled: DEFAULT_RUNTIME_SAFETY_FLAGS.canonicalWriteBackEnabled,
  recommendationWhimEnabled: DEFAULT_RUNTIME_SAFETY_FLAGS.recommendationWhimEnabled,
} as const;

export const TRPG_RUNTIME_DEFAULT_CONFIG: TrpgRuntimeConfig = {
  worldRoot: undefined,
  allowPatchApply: TRPG_RUNTIME_MANIFEST_BOOLEAN_DEFAULTS.allowPatchApply,
  diagnosticsEnabled: TRPG_RUNTIME_MANIFEST_BOOLEAN_DEFAULTS.diagnosticsEnabled,
  diagnosticsConsoleMirror: TRPG_RUNTIME_MANIFEST_BOOLEAN_DEFAULTS.diagnosticsConsoleMirror,
  maxReadBytes: TRPG_RUNTIME_INTEGER_CONFIG_SPECS.maxReadBytes.default,
  maxFilesPerQuery: TRPG_RUNTIME_INTEGER_CONFIG_SPECS.maxFilesPerQuery.default,
  maxOperationsPerPatch: TRPG_RUNTIME_INTEGER_CONFIG_SPECS.maxOperationsPerPatch.default,
  allowedAgentIds: [],
  traceMaxEvents: TRPG_RUNTIME_INTEGER_CONFIG_SPECS.traceMaxEvents.default,
  panelDispatchTtlSec: TRPG_RUNTIME_INTEGER_CONFIG_SPECS.panelDispatchTtlSec.default,
  analyzerMemoryTtlSec: TRPG_RUNTIME_INTEGER_CONFIG_SPECS.analyzerMemoryTtlSec.default,
  richHookTextEnabled: false,
  hookTextTimeoutMs: TRPG_RUNTIME_INTEGER_CONFIG_SPECS.hookTextTimeoutMs.default,
  hookTextCacheTtlSec: TRPG_RUNTIME_INTEGER_CONFIG_SPECS.hookTextCacheTtlSec.default,
  debugRuntimeSignals: false,
  traceVerbose: false,
  telemetryExtended: false,
  canonicalSyncEnabled: false,
  canonicalWriteBackEnabled: false,
  runtimeSafetyFlags: DEFAULT_RUNTIME_SAFETY_FLAGS,
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return parsed;
}

function readStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const values = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return values.length > 0 ? values : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

type IntegerConfigField = keyof typeof TRPG_RUNTIME_INTEGER_CONFIG_SPECS;

function readIntegerFromSpec(value: unknown, field: IntegerConfigField): number {
  const spec = TRPG_RUNTIME_INTEGER_CONFIG_SPECS[field];
  return readInteger(value, spec.default, spec.min, spec.max, field);
}

export function parseTrpgRuntimeConfig(raw: unknown): TrpgRuntimeConfig {
  const obj = asRecord(raw);
  const worldRoot = typeof obj.worldRoot === "string" && obj.worldRoot.trim() ? obj.worldRoot : undefined;
  const allowPatchApply = readBoolean(obj.allowPatchApply, TRPG_RUNTIME_DEFAULT_CONFIG.allowPatchApply);
  const diagnosticsEnabled = readBoolean(obj.diagnosticsEnabled, TRPG_RUNTIME_DEFAULT_CONFIG.diagnosticsEnabled);
  const diagnosticsConsoleMirror = readBoolean(obj.diagnosticsConsoleMirror, TRPG_RUNTIME_DEFAULT_CONFIG.diagnosticsConsoleMirror);
  const legacyRichHookTextEnabled =
    typeof obj.richHookTextEnabled === "boolean" ? obj.richHookTextEnabled : undefined;
  const runtimeSafetyFlags = normalizeRuntimeSafetyFlags({
    behavioralDriftEnabled: readBoolean(
      obj.behavioralDriftEnabled,
      DEFAULT_RUNTIME_SAFETY_FLAGS.behavioralDriftEnabled,
    ),
    behavioralDriftAffectsRules: readBoolean(
      obj.behavioralDriftAffectsRules,
      DEFAULT_RUNTIME_SAFETY_FLAGS.behavioralDriftAffectsRules,
    ),
    anchorLifecycleEnabled: readBoolean(
      obj.anchorLifecycleEnabled,
      DEFAULT_RUNTIME_SAFETY_FLAGS.anchorLifecycleEnabled,
    ),
    anchorSummaryOnly: readBoolean(obj.anchorSummaryOnly, DEFAULT_RUNTIME_SAFETY_FLAGS.anchorSummaryOnly),
    richHookActionableEnabled: readBoolean(
      obj.richHookActionableEnabled,
      legacyRichHookTextEnabled ?? DEFAULT_RUNTIME_SAFETY_FLAGS.richHookActionableEnabled,
    ),
    richHookWorldPulseEnabled: readBoolean(
      obj.richHookWorldPulseEnabled,
      legacyRichHookTextEnabled ?? DEFAULT_RUNTIME_SAFETY_FLAGS.richHookWorldPulseEnabled,
    ),
    richHookRecentOutcomesEnabled: readBoolean(
      obj.richHookRecentOutcomesEnabled,
      DEFAULT_RUNTIME_SAFETY_FLAGS.richHookRecentOutcomesEnabled,
    ),
    debugRuntimeSignals: readBoolean(obj.debugRuntimeSignals, DEFAULT_RUNTIME_SAFETY_FLAGS.debugRuntimeSignals),
    traceVerbose: readBoolean(obj.traceVerbose, DEFAULT_RUNTIME_SAFETY_FLAGS.traceVerbose),
    telemetryExtended: readBoolean(obj.telemetryExtended, DEFAULT_RUNTIME_SAFETY_FLAGS.telemetryExtended),
    canonicalSyncEnabled: readBoolean(obj.canonicalSyncEnabled, DEFAULT_RUNTIME_SAFETY_FLAGS.canonicalSyncEnabled),
    canonicalWriteBackEnabled: readBoolean(
      obj.canonicalWriteBackEnabled,
      DEFAULT_RUNTIME_SAFETY_FLAGS.canonicalWriteBackEnabled,
    ),
    recommendationWhimEnabled: readBoolean(
      obj.recommendationWhimEnabled,
      DEFAULT_RUNTIME_SAFETY_FLAGS.recommendationWhimEnabled,
    ),
  });
  const richHookTextEnabled = runtimeSafetyFlags.richHookActionableEnabled || runtimeSafetyFlags.richHookWorldPulseEnabled;

  return {
    worldRoot,
    allowPatchApply,
    diagnosticsEnabled,
    diagnosticsConsoleMirror,
    maxReadBytes: readIntegerFromSpec(obj.maxReadBytes, "maxReadBytes"),
    maxFilesPerQuery: readIntegerFromSpec(obj.maxFilesPerQuery, "maxFilesPerQuery"),
    maxOperationsPerPatch: readIntegerFromSpec(obj.maxOperationsPerPatch, "maxOperationsPerPatch"),
    allowedAgentIds: readStringArray(obj.allowedAgentIds, TRPG_RUNTIME_DEFAULT_CONFIG.allowedAgentIds),
    traceMaxEvents: readIntegerFromSpec(obj.traceMaxEvents, "traceMaxEvents"),
    panelDispatchTtlSec: readIntegerFromSpec(obj.panelDispatchTtlSec, "panelDispatchTtlSec"),
    analyzerMemoryTtlSec: readIntegerFromSpec(obj.analyzerMemoryTtlSec, "analyzerMemoryTtlSec"),
    richHookTextEnabled,
    hookTextTimeoutMs: readIntegerFromSpec(obj.hookTextTimeoutMs, "hookTextTimeoutMs"),
    hookTextCacheTtlSec: readIntegerFromSpec(obj.hookTextCacheTtlSec, "hookTextCacheTtlSec"),
    debugRuntimeSignals: runtimeSafetyFlags.debugRuntimeSignals,
    traceVerbose: runtimeSafetyFlags.traceVerbose,
    telemetryExtended: runtimeSafetyFlags.telemetryExtended,
    canonicalSyncEnabled: runtimeSafetyFlags.canonicalSyncEnabled,
    canonicalWriteBackEnabled: runtimeSafetyFlags.canonicalWriteBackEnabled,
    runtimeSafetyFlags,
  };
}

export const trpgRuntimeConfigSchema = {
  parse(value: unknown) {
    return parseTrpgRuntimeConfig(value);
  },
};

export function resolveWorldRootForContext(params: {
  cfg: TrpgRuntimeConfig;
  ctx: OpenClawPluginToolContext;
  resolvePath: (input: string) => string;
}): string {
  if (params.cfg.worldRoot) {
    return path.resolve(params.resolvePath(params.cfg.worldRoot));
  }

  return path.resolve(params.resolvePath("world"));
}

export function assertAgentAllowed(
  cfg: TrpgRuntimeConfig,
  ctx: OpenClawPluginToolContext,
): { ok: true } | { ok: false; error: string } {
  const agentId = typeof ctx.agentId === "string" ? ctx.agentId.trim() : "";
  if (!agentId) {
    return {
      ok: false,
      error: "agentId is missing in tool context.",
    };
  }

  if (cfg.allowedAgentIds.length === 0) {
    return { ok: true };
  }

  if (!cfg.allowedAgentIds.includes(agentId)) {
    return {
      ok: false,
      error: `agentId '${agentId}' is not allowed. Allowed agent ids: ${cfg.allowedAgentIds.join(", ")}`,
    };
  }

  return { ok: true };
}
