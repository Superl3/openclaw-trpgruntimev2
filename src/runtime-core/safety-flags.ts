export type RuntimeSafetyFlags = {
  behavioralDriftEnabled: boolean;
  behavioralDriftAffectsRules: boolean;
  anchorLifecycleEnabled: boolean;
  anchorSummaryOnly: boolean;
  richHookActionableEnabled: boolean;
  richHookWorldPulseEnabled: boolean;
  richHookRecentOutcomesEnabled: boolean;
  debugRuntimeSignals: boolean;
  traceVerbose: boolean;
  telemetryExtended: boolean;
  canonicalSyncEnabled: boolean;
  canonicalWriteBackEnabled: boolean;
};

export const DEFAULT_RUNTIME_SAFETY_FLAGS: RuntimeSafetyFlags = {
  behavioralDriftEnabled: true,
  behavioralDriftAffectsRules: false,
  anchorLifecycleEnabled: true,
  anchorSummaryOnly: true,
  richHookActionableEnabled: true,
  richHookWorldPulseEnabled: true,
  richHookRecentOutcomesEnabled: false,
  debugRuntimeSignals: false,
  traceVerbose: false,
  telemetryExtended: false,
  canonicalSyncEnabled: false,
  canonicalWriteBackEnabled: false,
};

export function normalizeRuntimeSafetyFlags(
  value?: Partial<RuntimeSafetyFlags> | null,
): RuntimeSafetyFlags {
  return {
    behavioralDriftEnabled:
      typeof value?.behavioralDriftEnabled === "boolean"
        ? value.behavioralDriftEnabled
        : DEFAULT_RUNTIME_SAFETY_FLAGS.behavioralDriftEnabled,
    behavioralDriftAffectsRules:
      typeof value?.behavioralDriftAffectsRules === "boolean"
        ? value.behavioralDriftAffectsRules
        : DEFAULT_RUNTIME_SAFETY_FLAGS.behavioralDriftAffectsRules,
    anchorLifecycleEnabled:
      typeof value?.anchorLifecycleEnabled === "boolean"
        ? value.anchorLifecycleEnabled
        : DEFAULT_RUNTIME_SAFETY_FLAGS.anchorLifecycleEnabled,
    anchorSummaryOnly:
      typeof value?.anchorSummaryOnly === "boolean"
        ? value.anchorSummaryOnly
        : DEFAULT_RUNTIME_SAFETY_FLAGS.anchorSummaryOnly,
    richHookActionableEnabled:
      typeof value?.richHookActionableEnabled === "boolean"
        ? value.richHookActionableEnabled
        : DEFAULT_RUNTIME_SAFETY_FLAGS.richHookActionableEnabled,
    richHookWorldPulseEnabled:
      typeof value?.richHookWorldPulseEnabled === "boolean"
        ? value.richHookWorldPulseEnabled
        : DEFAULT_RUNTIME_SAFETY_FLAGS.richHookWorldPulseEnabled,
    richHookRecentOutcomesEnabled:
      typeof value?.richHookRecentOutcomesEnabled === "boolean"
        ? value.richHookRecentOutcomesEnabled
        : DEFAULT_RUNTIME_SAFETY_FLAGS.richHookRecentOutcomesEnabled,
    debugRuntimeSignals:
      typeof value?.debugRuntimeSignals === "boolean"
        ? value.debugRuntimeSignals
        : DEFAULT_RUNTIME_SAFETY_FLAGS.debugRuntimeSignals,
    traceVerbose:
      typeof value?.traceVerbose === "boolean"
        ? value.traceVerbose
        : DEFAULT_RUNTIME_SAFETY_FLAGS.traceVerbose,
    telemetryExtended:
      typeof value?.telemetryExtended === "boolean"
        ? value.telemetryExtended
        : DEFAULT_RUNTIME_SAFETY_FLAGS.telemetryExtended,
    canonicalSyncEnabled:
      typeof value?.canonicalSyncEnabled === "boolean"
        ? value.canonicalSyncEnabled
        : DEFAULT_RUNTIME_SAFETY_FLAGS.canonicalSyncEnabled,
    canonicalWriteBackEnabled:
      typeof value?.canonicalWriteBackEnabled === "boolean"
        ? value.canonicalWriteBackEnabled
        : DEFAULT_RUNTIME_SAFETY_FLAGS.canonicalWriteBackEnabled,
  };
}
