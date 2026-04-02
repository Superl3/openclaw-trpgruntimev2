import type {
  QuestHookTextInput,
  QuestHookTextSlotType,
} from "./llm-contracts.js";
import {
  buildQuestHookSlotSourceHash,
  type QuestHookSlot,
} from "./quest-economy.js";
import type {
  DeterministicActionResolution,
  DeterministicSceneLoopState,
} from "./scene-loop.js";
import { pressureIntensityBand } from "./runtime-engine-helpers.js";

export type HookTextSlotMeta = {
  slotKey: string;
  slotType: QuestHookTextSlotType;
  source: "default" | "llm";
  cacheHit: boolean;
  skipReason: string | null;
};

export function buildHookTextInput(params: {
  contractVersion: QuestHookTextInput["contractVersion"];
  sessionId: string;
  nowIso: string;
  nextLoop: DeterministicSceneLoopState;
  resolution: DeterministicActionResolution;
  cacheMissCandidates: Array<{ slot: QuestHookSlot; slotType: QuestHookTextSlotType }>;
}): QuestHookTextInput {
  const worldPulseSnapshot = params.resolution.questSummary.panelSummary.worldPulse;

  return {
    contractVersion: params.contractVersion,
    sessionId: params.sessionId,
    sceneId: params.nextLoop.scene.sceneId,
    nowIso: params.nowIso,
    slots: params.cacheMissCandidates.map((entry) => {
      if (entry.slotType === "worldPulse") {
        return {
          slotKey: entry.slot.slotKey,
          slotType: "worldPulse" as const,
          archetype: worldPulseSnapshot.topPressure?.archetype ?? "public_order",
          trend: worldPulseSnapshot.topPressure?.trend ?? "steady",
          intensityBand: pressureIntensityBand(worldPulseSnapshot.topPressure?.intensity ?? 0),
          locationHint: params.nextLoop.scene.locationId,
          defaultText: entry.slot.defaultText,
          sourceHash: buildQuestHookSlotSourceHash(entry.slot),
        };
      }

      return {
        slotKey: entry.slot.slotKey,
        slotType: "actionable" as const,
        questId: entry.slot.questId,
        lifecycle: entry.slot.lifecycle,
        urgencyBand: entry.slot.urgencyBand,
        hookType: entry.slot.hookType,
        locationId: entry.slot.locationId,
        defaultText: entry.slot.defaultText,
        sourceHash: buildQuestHookSlotSourceHash(entry.slot),
      };
    }),
  };
}

export function buildHookTextSlotMeta(params: {
  nextLoop: DeterministicSceneLoopState;
  cacheHitBySlotKey: Map<string, true>;
  appliedSlotKeySet: Set<string>;
  cacheMissSlotKeys: Set<string>;
  actionableRichEnabled: boolean;
  worldPulseRichEnabled: boolean;
  hookTextResult: "applied" | "fallback" | "skipped";
  hookTextReason: string | null;
}): HookTextSlotMeta[] {
  const finalHookSlots = params.nextLoop.questEconomy.presentation.hookSlots.slice(0, 3);
  const finalSlotRows: Array<{ slot: (typeof finalHookSlots)[number]; slotType: QuestHookTextSlotType }> =
    finalHookSlots.map((slot) => ({
      slot,
      slotType: "actionable",
    }));

  if (params.nextLoop.questEconomy.presentation.worldPulseSlot) {
    finalSlotRows.push({
      slot: params.nextLoop.questEconomy.presentation.worldPulseSlot,
      slotType: "worldPulse",
    });
  }

  return finalSlotRows.map((row) => {
    const cacheHit = params.cacheHitBySlotKey.get(row.slot.slotKey) === true;
    const applied = params.appliedSlotKeySet.has(row.slot.slotKey);
    const slotTypeEnabled = row.slotType === "actionable" ? params.actionableRichEnabled : params.worldPulseRichEnabled;
    return {
      slotKey: row.slot.slotKey,
      slotType: row.slotType,
      source: row.slot.llmShortText ? "llm" : "default",
      cacheHit,
      skipReason:
        !slotTypeEnabled
          ? "skippedByPolicy"
          : cacheHit || applied
            ? null
            : !params.cacheMissSlotKeys.has(row.slot.slotKey)
              ? "skippedByBudget"
              : params.hookTextReason ?? (params.hookTextResult === "skipped" ? "skipped" : null),
    };
  });
}

export function buildTemporalTraceData(params: {
  resolution: DeterministicActionResolution;
  traceVerbose: boolean;
}): Record<string, unknown> {
  if (params.traceVerbose) {
    return {
      locationId: params.resolution.temporalSummary.locationId,
      memoryTouched: params.resolution.temporalSummary.memoryTouched,
      memoryDecayed: params.resolution.temporalSummary.memoryDecayed,
      freshnessUpdated: params.resolution.temporalSummary.freshnessUpdated,
      freshnessDecayed: params.resolution.temporalSummary.freshnessDecayed,
      tracesCreated: params.resolution.temporalSummary.tracesCreated,
      tracesUpdated: params.resolution.temporalSummary.tracesUpdated,
      tracesDecayed: params.resolution.temporalSummary.tracesDecayed,
      tracesExpired: params.resolution.temporalSummary.tracesExpired,
      locationShifted: params.resolution.temporalSummary.locationShifted,
      locationSnapshot: params.resolution.temporalSummary.locationSnapshot,
      qualitative: params.resolution.temporalSummary.qualitative,
    };
  }

  return {
    locationId: params.resolution.temporalSummary.locationId,
    memoryTouched: params.resolution.temporalSummary.memoryTouched,
    freshnessUpdated: params.resolution.temporalSummary.freshnessUpdated,
    tracesCreated: params.resolution.temporalSummary.tracesCreated,
    tracesExpired: params.resolution.temporalSummary.tracesExpired,
    locationShifted: params.resolution.temporalSummary.locationShifted,
    qualitative: params.resolution.temporalSummary.qualitative,
  };
}

export function buildQuestLifecycleTraceData(params: {
  resolution: DeterministicActionResolution;
  traceVerbose: boolean;
  telemetryExtended: boolean;
}): Record<string, unknown> {
  const questLifecycleTraceData: Record<string, unknown> = {
    transitionCount: params.resolution.questSummary.transitionCount,
    surfacedNow: params.resolution.questSummary.surfacedNow,
    expiredDeleted: params.resolution.questSummary.expiredDeleted,
    failedNow: params.resolution.questSummary.failedNow,
    mutatedNow: params.resolution.questSummary.mutatedNow,
    archivedNow: params.resolution.questSummary.archivedNow,
    budgetUsed: params.resolution.questSummary.budget.used,
    budgetCaps: params.resolution.questSummary.budget.caps,
    panelSummary: {
      actionable: {
        activeCount: params.resolution.questSummary.panelSummary.actionable.activeCount,
        surfacedCount: params.resolution.questSummary.panelSummary.actionable.surfacedCount,
      },
      worldPulse: {
        text: params.resolution.questSummary.panelSummary.worldPulse.text,
        trend: params.resolution.questSummary.panelSummary.worldPulse.topPressure?.trend ?? null,
      },
    },
  };

  if (params.traceVerbose) {
    questLifecycleTraceData.transitions = params.resolution.questSummary.transitions.slice(0, 6);
    questLifecycleTraceData.panelSummary = {
      actionable: {
        activeCount: params.resolution.questSummary.panelSummary.actionable.activeCount,
        surfacedCount: params.resolution.questSummary.panelSummary.actionable.surfacedCount,
        activeTop: params.resolution.questSummary.panelSummary.actionable.activeTop,
        surfacedTop: params.resolution.questSummary.panelSummary.actionable.surfacedTop,
      },
      worldPulse: params.resolution.questSummary.panelSummary.worldPulse,
      recentOutcomes: params.resolution.questSummary.panelSummary.recentOutcomes.items,
    };
  }

  if (params.telemetryExtended) {
    questLifecycleTraceData.softQuotaCaps = params.resolution.questSummary.softQuota.caps;
    questLifecycleTraceData.topQuotaUsage = {
      location: params.resolution.questSummary.softQuota.usageByLocation[0] ?? null,
      pressure: params.resolution.questSummary.softQuota.usageByPressure[0] ?? null,
      archetype: params.resolution.questSummary.softQuota.usageByArchetype[0] ?? null,
    };
    questLifecycleTraceData.tuningSnapshot = {
      surfacingRate: params.resolution.questSummary.tuningSnapshot.surfacingRate,
      expirationRate: params.resolution.questSummary.tuningSnapshot.expirationRate,
      mutationRate: params.resolution.questSummary.tuningSnapshot.mutationRate,
      successorRate: params.resolution.questSummary.tuningSnapshot.successorRate,
      budgetUtilization: params.resolution.questSummary.tuningSnapshot.budgetUtilization,
      quotaSaturation: params.resolution.questSummary.tuningSnapshot.quotaSaturation,
      averageUrgency: params.resolution.questSummary.tuningSnapshot.averageUrgency,
      activeVsSurfacedRatio: params.resolution.questSummary.tuningSnapshot.activeVsSurfacedRatio,
    };
  }

  return questLifecycleTraceData;
}

export function buildHookTraceData(params: {
  hookTextGenerationAttempted: boolean;
  hookTextResult: "applied" | "fallback" | "skipped";
  hookTextReason: string | null;
  hookTextSlotCount: number;
  hookTextUpdatedCount: number;
  hookTextSkippedByPolicy: boolean;
  hookTextSkippedByBudget: boolean;
  recentOutcomesRichRequested: boolean;
  recentOutcomesRichApplied: boolean;
  hookTextCacheHitCount: number;
  hookTextCacheMissCount: number;
  hookTextSlotMeta: HookTextSlotMeta[];
  traceVerbose: boolean;
  telemetryExtended: boolean;
}): Record<string, unknown> {
  const hookTraceData: Record<string, unknown> = {
    generationAttempted: params.hookTextGenerationAttempted,
    result: params.hookTextResult,
    reason: params.hookTextReason,
    slotCount: params.hookTextSlotCount,
    updatedCount: params.hookTextUpdatedCount,
    skippedByPolicy: params.hookTextSkippedByPolicy,
    skippedByBudget: params.hookTextSkippedByBudget,
    recentOutcomesRichRequested: params.recentOutcomesRichRequested,
    recentOutcomesRichApplied: params.recentOutcomesRichApplied,
  };

  if (params.traceVerbose || params.telemetryExtended) {
    hookTraceData.cacheHitCount = params.hookTextCacheHitCount;
    hookTraceData.cacheMissCount = params.hookTextCacheMissCount;
  }
  if (params.traceVerbose) {
    hookTraceData.slotMeta = params.hookTextSlotMeta;
  }

  return hookTraceData;
}

export function buildActionResolvedTraceData(params: {
  routeActionId: string;
  resolution: DeterministicActionResolution;
  selectedSource: "deterministic" | "analyzer";
  selectedConfidence: number;
  selectedAnalyzerWeight: number;
  selectedFallbackStrategy: "none" | "keep_previous" | "scene_safe_default" | "abstain";
  preResolvedClaimUntrusted: boolean;
  nextLoop: DeterministicSceneLoopState;
  sceneTransitioned: boolean;
}): Record<string, unknown> {
  return {
    inputActionId: params.routeActionId,
    resolvedActionId: params.resolution.resolvedActionId,
    classification: params.resolution.classification,
    deltaTimeSec: params.resolution.deltaTimeSec,
    selectedSource: params.selectedSource,
    selectedConfidence: params.selectedConfidence,
    analyzerWeight: params.selectedAnalyzerWeight,
    fallbackStrategy: params.selectedFallbackStrategy,
    preResolvedClaimUntrusted: params.preResolvedClaimUntrusted,
    locationId: params.nextLoop.scene.locationId,
    temporalLocationShifted: params.resolution.temporalSummary.locationShifted,
    questTransitionCount: params.resolution.questSummary.transitionCount,
    questSpawnedSeeds: params.resolution.questSummary.spawnedSeeds,
    sceneTransitioned: params.sceneTransitioned,
  };
}
