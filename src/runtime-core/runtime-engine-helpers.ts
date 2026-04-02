import { randomUUID } from "node:crypto";
import type { AnchorTickEvent } from "./anchor-layer.js";
import type {
  Clock,
  IdGenerator,
} from "./contracts.js";
import {
  isQuestHookTextCacheValid,
  type QuestEconomyState,
  type QuestHookSlot,
  type QuestHookTextSlotType,
} from "./quest-economy.js";
import {
  type RuntimeBootstrapDiagnostic,
  type RuntimeBootstrapInput,
  type RuntimeCanonicalProvenance,
  type RuntimeMetadata,
  ensureRuntimeMetadata,
} from "./types.js";

export const DEFAULT_SCENE_ID = "scene-bootstrap";
const MAX_HOOK_TEXT_MISS_CANDIDATES = 3;

export type QuestHookCacheState = {
  slot: QuestHookSlot;
  slotType: QuestHookTextSlotType;
  cacheHit: boolean;
};

export type QuestHookCacheMissCandidate = {
  slot: QuestHookSlot;
  slotType: QuestHookTextSlotType;
};

export type QuestHookCachePreparation = {
  nextEconomy: QuestEconomyState;
  cacheStates: QuestHookCacheState[];
  cacheHitBySlotKey: Map<string, true>;
  cacheMissCandidates: QuestHookCacheMissCandidate[];
  cacheMissSlotKeys: Set<string>;
  cacheHitCount: number;
  cacheMissCount: number;
  skippedByBudget: boolean;
};

export class SystemClock implements Clock {
  nowIso(): string {
    return new Date().toISOString();
  }
}

export class RuntimeIdGenerator implements IdGenerator {
  newSessionId(): string {
    return `sess-${randomUUID()}`;
  }

  newActionId(): string {
    return `act-${randomUUID()}`;
  }
}

export function readNonEmptyString(value: string | undefined, fallback: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
}

export function nextUiVersion(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.trunc(value) + 1;
}

export function nextActionSeq(currentActionSeq: number, legacyTurnIndex: number): number {
  const canonical = Number.isFinite(currentActionSeq) ? Math.trunc(currentActionSeq) : 0;
  const legacy = Number.isFinite(legacyTurnIndex) ? Math.trunc(legacyTurnIndex) : 0;
  return Math.max(canonical, legacy) + 1;
}

function normalizeBootstrapDiagnostics(value: RuntimeBootstrapDiagnostic[] | undefined): RuntimeBootstrapDiagnostic[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const diagnostics: RuntimeBootstrapDiagnostic[] = [];
  for (const entry of value) {
    const code = typeof entry?.code === "string" ? entry.code.trim() : "";
    const message = typeof entry?.message === "string" ? entry.message.trim() : "";
    if (!code || !message) {
      continue;
    }
    diagnostics.push({
      code,
      message,
      path: typeof entry.path === "string" && entry.path.trim() ? entry.path.trim() : null,
      severity: entry.severity === "info" || entry.severity === "warn" || entry.severity === "error" ? entry.severity : "warn",
    });
    if (diagnostics.length >= 24) {
      break;
    }
  }
  return diagnostics;
}

export function buildRuntimeMetadata(params: {
  runtimeBootstrap?: RuntimeBootstrapInput | null;
  runtimeBootstrapDiagnostics?: RuntimeBootstrapDiagnostic[];
  runtimeCanonicalProvenance?: RuntimeCanonicalProvenance | null;
}): RuntimeMetadata {
  const diagnostics = normalizeBootstrapDiagnostics(params.runtimeBootstrapDiagnostics);
  if (!params.runtimeBootstrap) {
    return ensureRuntimeMetadata({
      bootstrap: {
        source: "default",
        seed: null,
        diagnostics,
      },
      canonicalSync: params.runtimeCanonicalProvenance ?? undefined,
    });
  }
  return ensureRuntimeMetadata({
    bootstrap: {
      source: "worldSeed",
      seed: {
        worldId: params.runtimeBootstrap.worldId,
        schemaVersion: params.runtimeBootstrap.schemaVersion,
        seedValue: params.runtimeBootstrap.seedValue,
        seedFingerprint: params.runtimeBootstrap.seedFingerprint,
      },
      diagnostics,
    },
    canonicalSync: params.runtimeCanonicalProvenance ?? undefined,
  });
}

export function pressureIntensityBand(value: number): "low" | "moderate" | "high" | "critical" {
  if (!Number.isFinite(value) || value < 35) {
    return "low";
  }
  if (value < 60) {
    return "moderate";
  }
  if (value < 80) {
    return "high";
  }
  return "critical";
}

export function anchorEventTypeToTraceType(eventType: AnchorTickEvent["eventType"]):
  | "engine.anchor.formed"
  | "engine.anchor.advanced"
  | "engine.anchor.escalated"
  | "engine.anchor.resolved"
  | "engine.anchor.failed"
  | "engine.anchor.archived" {
  switch (eventType) {
    case "formed":
      return "engine.anchor.formed";
    case "advanced":
      return "engine.anchor.advanced";
    case "escalated":
      return "engine.anchor.escalated";
    case "resolved":
      return "engine.anchor.resolved";
    case "failed":
      return "engine.anchor.failed";
    case "archived":
      return "engine.anchor.archived";
    default:
      return "engine.anchor.advanced";
  }
}

function stripExpiredHookSlotCache(slot: QuestHookSlot): QuestHookSlot {
  return {
    ...slot,
    llmShortText: null,
    llmSourceHash: null,
    llmExpiresAtIso: null,
  };
}

function pruneHookSlotCache(slot: QuestHookSlot, nowIso: string): QuestHookSlot {
  if (!slot.llmShortText && !slot.llmSourceHash && !slot.llmExpiresAtIso) {
    return slot;
  }
  if (isQuestHookTextCacheValid(slot, nowIso)) {
    return slot;
  }
  return stripExpiredHookSlotCache(slot);
}

export function prepareQuestHookCacheState(params: {
  economy: QuestEconomyState;
  nowIso: string;
  actionableRichEnabled: boolean;
  worldPulseRichEnabled: boolean;
}): QuestHookCachePreparation {
  const hookSlotsPruned = params.economy.presentation.hookSlots.map((slot) => pruneHookSlotCache(slot, params.nowIso));
  const worldPulseSlotRaw = params.economy.presentation.worldPulseSlot;
  const worldPulseSlotPruned = worldPulseSlotRaw ? pruneHookSlotCache(worldPulseSlotRaw, params.nowIso) : null;

  const hookSlotsPolicyApplied = params.actionableRichEnabled
    ? hookSlotsPruned
    : hookSlotsPruned.map((slot) => stripExpiredHookSlotCache(slot));

  const worldPulseSlotPolicyApplied = params.worldPulseRichEnabled
    ? worldPulseSlotPruned
    : worldPulseSlotPruned
      ? stripExpiredHookSlotCache(worldPulseSlotPruned)
      : null;

  const hadPrunedSlots = hookSlotsPruned.some((slot, index) => slot !== params.economy.presentation.hookSlots[index]);
  const worldPulseSlotChanged = worldPulseSlotPruned !== worldPulseSlotRaw;
  const hadPolicyClearedActionable = hookSlotsPolicyApplied.some((slot, index) => slot !== hookSlotsPruned[index]);
  const hadPolicyClearedWorldPulse = worldPulseSlotPolicyApplied !== worldPulseSlotPruned;

  const nextEconomy = hadPrunedSlots || worldPulseSlotChanged || hadPolicyClearedActionable || hadPolicyClearedWorldPulse
    ? {
        ...params.economy,
        presentation: {
          ...params.economy.presentation,
          hookSlots: hookSlotsPolicyApplied,
          worldPulseSlot: worldPulseSlotPolicyApplied,
        },
      }
    : params.economy;

  const actionableHookSlots = nextEconomy.presentation.hookSlots.slice(0, 3);
  const worldPulseSlot = nextEconomy.presentation.worldPulseSlot;
  const cacheStates: QuestHookCacheState[] = [];

  if (params.actionableRichEnabled) {
    for (const slot of actionableHookSlots) {
      cacheStates.push({
        slot,
        slotType: "actionable",
        cacheHit: isQuestHookTextCacheValid(slot, params.nowIso),
      });
    }
  }

  if (worldPulseSlot && params.worldPulseRichEnabled) {
    cacheStates.push({
      slot: worldPulseSlot,
      slotType: "worldPulse",
      cacheHit: isQuestHookTextCacheValid(worldPulseSlot, params.nowIso),
    });
  }

  const cacheHitBySlotKey = new Map(
    cacheStates
      .filter((entry) => entry.cacheHit)
      .map((entry): [string, true] => [entry.slot.slotKey, true]),
  );

  const actionableMissSlots = cacheStates.filter((entry) => entry.slotType === "actionable" && !entry.cacheHit);
  const worldPulseMissSlot = cacheStates.find((entry) => entry.slotType === "worldPulse" && !entry.cacheHit) ?? null;

  const cacheMissCandidates: QuestHookCacheMissCandidate[] = [];
  if (worldPulseMissSlot) {
    cacheMissCandidates.push({
      slot: worldPulseMissSlot.slot,
      slotType: "worldPulse",
    });
  }
  for (const miss of actionableMissSlots) {
    if (cacheMissCandidates.length >= MAX_HOOK_TEXT_MISS_CANDIDATES) {
      break;
    }
    cacheMissCandidates.push({
      slot: miss.slot,
      slotType: "actionable",
    });
  }

  const missedTotalCount = actionableMissSlots.length + (worldPulseMissSlot ? 1 : 0);
  const skippedByBudget = missedTotalCount > cacheMissCandidates.length;
  const cacheMissSlotKeys = new Set(cacheMissCandidates.map((entry) => entry.slot.slotKey));

  return {
    nextEconomy,
    cacheStates,
    cacheHitBySlotKey,
    cacheMissCandidates,
    cacheMissSlotKeys,
    cacheHitCount: cacheHitBySlotKey.size,
    cacheMissCount: cacheMissCandidates.length,
    skippedByBudget,
  };
}
