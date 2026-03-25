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

const DEFAULT_CONFIG: TrpgRuntimeConfig = {
  worldRoot: undefined,
  allowPatchApply: false,
  maxReadBytes: 262_144,
  maxFilesPerQuery: 40,
  maxOperationsPerPatch: 64,
  allowedAgentIds: [],
  traceMaxEvents: 120,
  panelDispatchTtlSec: 180,
  analyzerMemoryTtlSec: 900,
  richHookTextEnabled: false,
  hookTextTimeoutMs: 350,
  hookTextCacheTtlSec: 900,
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

export function parseTrpgRuntimeConfig(raw: unknown): TrpgRuntimeConfig {
  const obj = asRecord(raw);
  const worldRoot = typeof obj.worldRoot === "string" && obj.worldRoot.trim() ? obj.worldRoot : undefined;
  const allowPatchApply = typeof obj.allowPatchApply === "boolean" ? obj.allowPatchApply : false;
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
  });
  const richHookTextEnabled = runtimeSafetyFlags.richHookActionableEnabled || runtimeSafetyFlags.richHookWorldPulseEnabled;

  return {
    worldRoot,
    allowPatchApply,
    maxReadBytes: readInteger(
      obj.maxReadBytes,
      DEFAULT_CONFIG.maxReadBytes,
      4_096,
      1_048_576,
      "maxReadBytes",
    ),
    maxFilesPerQuery: readInteger(
      obj.maxFilesPerQuery,
      DEFAULT_CONFIG.maxFilesPerQuery,
      1,
      200,
      "maxFilesPerQuery",
    ),
    maxOperationsPerPatch: readInteger(
      obj.maxOperationsPerPatch,
      DEFAULT_CONFIG.maxOperationsPerPatch,
      1,
      200,
      "maxOperationsPerPatch",
    ),
    allowedAgentIds: readStringArray(obj.allowedAgentIds, DEFAULT_CONFIG.allowedAgentIds),
    traceMaxEvents: readInteger(obj.traceMaxEvents, DEFAULT_CONFIG.traceMaxEvents, 20, 500, "traceMaxEvents"),
    panelDispatchTtlSec: readInteger(
      obj.panelDispatchTtlSec,
      DEFAULT_CONFIG.panelDispatchTtlSec,
      30,
      3600,
      "panelDispatchTtlSec",
    ),
    analyzerMemoryTtlSec: readInteger(
      obj.analyzerMemoryTtlSec,
      DEFAULT_CONFIG.analyzerMemoryTtlSec,
      60,
      86_400,
      "analyzerMemoryTtlSec",
    ),
    richHookTextEnabled,
    hookTextTimeoutMs: readInteger(obj.hookTextTimeoutMs, DEFAULT_CONFIG.hookTextTimeoutMs, 80, 2_000, "hookTextTimeoutMs"),
    hookTextCacheTtlSec: readInteger(
      obj.hookTextCacheTtlSec,
      DEFAULT_CONFIG.hookTextCacheTtlSec,
      60,
      7_200,
      "hookTextCacheTtlSec",
    ),
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
