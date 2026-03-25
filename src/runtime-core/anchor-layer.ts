import type { ActionFeasibility, DeterministicActionId } from "./scene-loop.js";
import type { PressureArchetype, QuestEconomyState, QuestEconomyTickSummary, QuestLifecycleTransition } from "./quest-economy.js";

export type AnchorLifecycle = "candidate" | "active" | "escalated" | "resolved" | "failed" | "archived";

export type AnchorState = {
  anchorId: string;
  pressureId: string;
  archetype: PressureArchetype;
  lifecycle: AnchorLifecycle;
  title: string;
  intensity: number;
  createdAtIso: string;
  startedAtIso: string | null;
  terminalAtIso: string | null;
  archivedAtIso: string | null;
  lastAdvancedAtIso: string;
  terminalReason: string | null;
  linkedQuestIds: string[];
  recentEventRefs: string[];
  sourceRefs: string[];
  escalationCount: number;
};

export type AnchorRuntimeState = {
  version: 1;
  anchors: AnchorState[];
  nextAnchorSeq: number;
};

export type AnchorEventType = "formed" | "advanced" | "escalated" | "resolved" | "failed" | "archived";

export type AnchorTickEvent = {
  anchorId: string;
  eventType: AnchorEventType;
  pressureId: string;
  archetype: PressureArchetype;
  from: AnchorLifecycle | null;
  to: AnchorLifecycle;
  reason: string;
  intensity: number;
};

export type AnchorTickSummary = {
  formedNow: number;
  advancedNow: number;
  escalatedNow: number;
  resolvedNow: number;
  failedNow: number;
  archivedNow: number;
  activeCount: number;
  escalatedCount: number;
  events: AnchorTickEvent[];
  debug: {
    signalMode: "missing" | "invalid" | "noop" | "applied";
    signalReason: string | null;
    cappedDroppedCandidates: number;
  };
};

export type AnchorPanelSummary = {
  top: {
    anchorId: string;
    lifecycle: AnchorLifecycle;
    archetype: PressureArchetype;
    pressureId: string;
    intensity: number;
    text: string;
  } | null;
  activeCount: number;
  escalatedCount: number;
  text: string;
  debug: {
    anchorCount: number;
    activeIds: string[];
    terminalIds: string[];
    signalMode: "missing" | "invalid" | "noop" | "applied";
    signalReason: string | null;
  };
};

export type AnchorSignalInput = {
  pressureBoostById?: Array<{ pressureId: string; delta: number }>;
  markEscalatedAnchorIds?: string[];
  markResolvedAnchorIds?: string[];
};

export type AnchorTickInput = {
  anchor: AnchorRuntimeState | null | undefined;
  economyBefore: QuestEconomyState;
  economyAfter: QuestEconomyState;
  questSummary: QuestEconomyTickSummary;
  nowIso: string;
  deltaTimeSec: number;
  actionId: DeterministicActionId;
  classification: ActionFeasibility;
  sceneId: string;
  summaryOnly?: boolean;
  factionSignal?: unknown;
};

export type AnchorTickResult = {
  nextAnchor: AnchorRuntimeState;
  summary: AnchorTickSummary;
};

const MAX_ANCHORS = 24;
const MAX_ACTIVE_ESCALATED = 4;
const MAX_LINKED_QUESTS = 6;
const MAX_EVENT_REFS = 8;
const MAX_SOURCE_REFS = 8;
const MAX_EVENTS_RECORDED = 14;
const ARCHIVE_RETENTION_SEC = 1_800;

const TERMINAL_LIFECYCLE = new Set<AnchorLifecycle>(["resolved", "failed"]);

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function readIsoString(value: unknown, fallback: string): string {
  const text = readString(value);
  if (!text) {
    return fallback;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function readIsoNullable(value: unknown): string | null {
  const text = readString(value);
  if (!text) {
    return null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function scoreIsoDesc(a: string | null, b: string | null): number {
  const aMs = a ? Date.parse(a) : Number.NaN;
  const bMs = b ? Date.parse(b) : Number.NaN;
  const safeA = Number.isFinite(aMs) ? aMs : 0;
  const safeB = Number.isFinite(bMs) ? bMs : 0;
  return safeB - safeA;
}

function uniqStrings(values: string[], maxCount: number): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value || out.includes(value)) {
      continue;
    }
    out.push(value);
    if (out.length >= maxCount) {
      break;
    }
  }
  return out;
}

function anchorTitle(archetype: PressureArchetype): string {
  switch (archetype) {
    case "smuggling":
      return "밀수 축";
    case "outbreak":
      return "감염 확산 축";
    case "power_struggle":
      return "권력 다툼 축";
    case "artifact_race":
      return "유물 쟁탈 축";
    case "public_order":
      return "치안 붕괴 축";
    default:
      return "장기 충돌 축";
  }
}

function normalizeLifecycle(value: unknown): AnchorLifecycle {
  const normalized = readString(value);
  if (
    normalized === "candidate" ||
    normalized === "active" ||
    normalized === "escalated" ||
    normalized === "resolved" ||
    normalized === "failed" ||
    normalized === "archived"
  ) {
    return normalized;
  }
  return "candidate";
}

function normalizeAnchor(value: unknown, nowIso: string): AnchorState | null {
  const node = toRecord(value);
  const anchorId = readString(node.anchorId);
  const pressureId = readString(node.pressureId);
  const archetype = readString(node.archetype) as PressureArchetype;
  if (!anchorId || !pressureId) {
    return null;
  }

  const lifecycle = normalizeLifecycle(node.lifecycle);
  const startedAtIso = readIsoNullable(node.startedAtIso);
  const terminalAtIso = readIsoNullable(node.terminalAtIso);
  const archivedAtIso = readIsoNullable(node.archivedAtIso);

  return {
    anchorId,
    pressureId,
    archetype,
    lifecycle,
    title: readString(node.title) || anchorTitle(archetype),
    intensity: clampInt(readInt(node.intensity, 50), 0, 100),
    createdAtIso: readIsoString(node.createdAtIso, nowIso),
    startedAtIso,
    terminalAtIso,
    archivedAtIso,
    lastAdvancedAtIso: readIsoString(node.lastAdvancedAtIso, nowIso),
    terminalReason: readString(node.terminalReason) || null,
    linkedQuestIds: Array.isArray(node.linkedQuestIds)
      ? uniqStrings(node.linkedQuestIds.filter((entry): entry is string => typeof entry === "string"), MAX_LINKED_QUESTS)
      : [],
    recentEventRefs: Array.isArray(node.recentEventRefs)
      ? uniqStrings(node.recentEventRefs.filter((entry): entry is string => typeof entry === "string"), MAX_EVENT_REFS)
      : [],
    sourceRefs: Array.isArray(node.sourceRefs)
      ? uniqStrings(node.sourceRefs.filter((entry): entry is string => typeof entry === "string"), MAX_SOURCE_REFS)
      : [],
    escalationCount: Math.max(0, readInt(node.escalationCount, 0)),
  };
}

function makeDefaultAnchorState(): AnchorRuntimeState {
  return {
    version: 1,
    anchors: [],
    nextAnchorSeq: 1,
  };
}

function compareAnchorPriority(a: AnchorState, b: AnchorState): number {
  const rank = (value: AnchorLifecycle): number => {
    switch (value) {
      case "escalated":
        return 6;
      case "active":
        return 5;
      case "candidate":
        return 4;
      case "failed":
        return 3;
      case "resolved":
        return 2;
      case "archived":
      default:
        return 1;
    }
  };
  const diffRank = rank(b.lifecycle) - rank(a.lifecycle);
  if (diffRank !== 0) {
    return diffRank;
  }
  if (a.intensity !== b.intensity) {
    return b.intensity - a.intensity;
  }
  return scoreIsoDesc(a.lastAdvancedAtIso, b.lastAdvancedAtIso);
}

function parseSignal(input: unknown): {
  mode: "missing" | "invalid" | "noop" | "applied";
  reason: string | null;
  value: AnchorSignalInput;
} {
  if (input === undefined || input === null) {
    return {
      mode: "missing",
      reason: "signal_missing",
      value: {},
    };
  }

  const node = toRecord(input);
  const pressureBoostById = Array.isArray(node.pressureBoostById)
    ? node.pressureBoostById
        .map((entry) => {
          const item = toRecord(entry);
          const pressureId = readString(item.pressureId);
          if (!pressureId) {
            return null;
          }
          const delta = clampInt(readInt(item.delta, 0), -30, 30);
          return {
            pressureId,
            delta,
          };
        })
        .filter((entry): entry is { pressureId: string; delta: number } => entry !== null)
    : [];
  const markEscalatedAnchorIds = Array.isArray(node.markEscalatedAnchorIds)
    ? uniqStrings(node.markEscalatedAnchorIds.filter((entry): entry is string => typeof entry === "string"), 16)
    : [];
  const markResolvedAnchorIds = Array.isArray(node.markResolvedAnchorIds)
    ? uniqStrings(node.markResolvedAnchorIds.filter((entry): entry is string => typeof entry === "string"), 16)
    : [];

  const hasKnownField =
    Array.isArray(node.pressureBoostById) || Array.isArray(node.markEscalatedAnchorIds) || Array.isArray(node.markResolvedAnchorIds);
  if (!hasKnownField) {
    return {
      mode: "invalid",
      reason: "signal_invalid_shape",
      value: {},
    };
  }

  if (pressureBoostById.length === 0 && markEscalatedAnchorIds.length === 0 && markResolvedAnchorIds.length === 0) {
    return {
      mode: "noop",
      reason: "signal_noop",
      value: {
        pressureBoostById,
        markEscalatedAnchorIds,
        markResolvedAnchorIds,
      },
    };
  }

  return {
    mode: "applied",
    reason: null,
    value: {
      pressureBoostById,
      markEscalatedAnchorIds,
      markResolvedAnchorIds,
    },
  };
}

function transitionLifecycle(anchor: AnchorState, next: AnchorLifecycle, nowIso: string, reason: string): AnchorState {
  const nextState: AnchorState = {
    ...anchor,
    lifecycle: next,
    lastAdvancedAtIso: nowIso,
    terminalReason: TERMINAL_LIFECYCLE.has(next) ? reason : anchor.terminalReason,
  };
  if ((next === "active" || next === "escalated") && !nextState.startedAtIso) {
    nextState.startedAtIso = nowIso;
  }
  if (TERMINAL_LIFECYCLE.has(next)) {
    nextState.terminalAtIso = nowIso;
    nextState.archivedAtIso = null;
  }
  if (next === "archived") {
    nextState.archivedAtIso = nowIso;
  }
  return nextState;
}

function transitionsByQuestSummary(summary: QuestEconomyTickSummary): Map<string, QuestLifecycleTransition[]> {
  const out = new Map<string, QuestLifecycleTransition[]>();
  for (const transition of summary.transitions) {
    const list = out.get(transition.questId) ?? [];
    list.push(transition);
    out.set(transition.questId, list);
  }
  return out;
}

export function ensureAnchorRuntimeState(value: unknown): AnchorRuntimeState {
  const fallback = makeDefaultAnchorState();
  const root = toRecord(value);
  const anchorsRaw = Array.isArray(root.anchors) ? root.anchors : [];
  const nowIso = new Date().toISOString();
  const anchors = anchorsRaw
    .map((entry) => normalizeAnchor(entry, nowIso))
    .filter((entry): entry is AnchorState => entry !== null)
    .sort(compareAnchorPriority);

  const dedup = new Map<string, AnchorState>();
  for (const anchor of anchors) {
    if (!dedup.has(anchor.anchorId)) {
      dedup.set(anchor.anchorId, anchor);
    }
  }

  const nextAnchorSeq = Math.max(1, readInt(root.nextAnchorSeq, 1));
  const capped = capAnchorList(Array.from(dedup.values()));
  return {
    version: 1,
    anchors: capped.anchors,
    nextAnchorSeq,
  };
}

function getPressureIntensityById(economy: QuestEconomyState): Map<string, { intensity: number; archetype: PressureArchetype }> {
  const out = new Map<string, { intensity: number; archetype: PressureArchetype }>();
  for (const pressure of economy.worldPressures) {
    out.set(pressure.pressureId, {
      intensity: pressure.intensity,
      archetype: pressure.archetype,
    });
  }
  return out;
}

function linkedQuestIdsForPressure(economy: QuestEconomyState, pressureId: string): string[] {
  return uniqStrings(
    economy.quests
      .filter((quest) => quest.pressureId === pressureId && (quest.lifecycle === "active" || quest.lifecycle === "stalled" || quest.lifecycle === "surfaced"))
      .map((quest) => quest.questId),
    MAX_LINKED_QUESTS,
  );
}

function isStarted(anchor: AnchorState): boolean {
  return Boolean(anchor.startedAtIso || anchor.lifecycle === "active" || anchor.lifecycle === "escalated" || TERMINAL_LIFECYCLE.has(anchor.lifecycle) || anchor.lifecycle === "archived");
}

function capAnchorList(anchors: AnchorState[]): { anchors: AnchorState[]; droppedCandidates: number } {
  const started = anchors.filter((anchor) => isStarted(anchor));
  const candidates = anchors
    .filter((anchor) => !isStarted(anchor))
    .sort((a, b) => b.intensity - a.intensity || scoreIsoDesc(a.lastAdvancedAtIso, b.lastAdvancedAtIso));

  const space = Math.max(0, MAX_ANCHORS - started.length);
  const keptCandidates = candidates.slice(0, space);
  const kept = [...started, ...keptCandidates].sort(compareAnchorPriority).slice(0, MAX_ANCHORS);
  const droppedCandidates = Math.max(0, candidates.length - keptCandidates.length);
  return {
    anchors: kept,
    droppedCandidates,
  };
}

export function createNoopAnchorTickSummary(params?: {
  signalMode?: AnchorTickSummary["debug"]["signalMode"];
  signalReason?: string | null;
}): AnchorTickSummary {
  return {
    formedNow: 0,
    advancedNow: 0,
    escalatedNow: 0,
    resolvedNow: 0,
    failedNow: 0,
    archivedNow: 0,
    activeCount: 0,
    escalatedCount: 0,
    events: [],
    debug: {
      signalMode: params?.signalMode ?? "missing",
      signalReason: params?.signalReason ?? null,
      cappedDroppedCandidates: 0,
    },
  };
}

export function runAnchorTick(input: AnchorTickInput): AnchorTickResult {
  // v1 safety policy: anchor layer remains summary/projection-only even when summaryOnly=false.
  const current = ensureAnchorRuntimeState(input.anchor);
  const pressureById = getPressureIntensityById(input.economyAfter);
  const transitionsByQuest = transitionsByQuestSummary(input.questSummary);
  const signal = parseSignal(input.factionSignal);
  const pressureBoost = new Map<string, number>();
  for (const entry of signal.value.pressureBoostById ?? []) {
    pressureBoost.set(entry.pressureId, (pressureBoost.get(entry.pressureId) ?? 0) + entry.delta);
  }

  const escalateBySignal = new Set(signal.value.markEscalatedAnchorIds ?? []);
  const resolveBySignal = new Set(signal.value.markResolvedAnchorIds ?? []);
  const events: AnchorTickEvent[] = [];

  let nextAnchorSeq = current.nextAnchorSeq;
  let anchors = current.anchors.map((anchor) => ({ ...anchor }));

  const existingPressureIds = new Set(
    anchors
      .filter((anchor) => anchor.lifecycle !== "archived")
      .map((anchor) => anchor.pressureId),
  );

  for (const pressure of input.economyAfter.worldPressures) {
    if (!pressure.anchorCandidate) {
      continue;
    }
    if (pressure.intensity < 62) {
      continue;
    }
    if (existingPressureIds.has(pressure.pressureId)) {
      continue;
    }

    const anchorId = `anchor-${String(nextAnchorSeq).padStart(4, "0")}`;
    nextAnchorSeq += 1;
    const linkedQuestIds = linkedQuestIdsForPressure(input.economyAfter, pressure.pressureId);
    const created: AnchorState = {
      anchorId,
      pressureId: pressure.pressureId,
      archetype: pressure.archetype,
      lifecycle: "candidate",
      title: anchorTitle(pressure.archetype),
      intensity: pressure.intensity,
      createdAtIso: input.nowIso,
      startedAtIso: null,
      terminalAtIso: null,
      archivedAtIso: null,
      lastAdvancedAtIso: input.nowIso,
      terminalReason: null,
      linkedQuestIds,
      recentEventRefs: uniqStrings([`scene:${input.sceneId}`, `action:${input.actionId}`], MAX_EVENT_REFS),
      sourceRefs: uniqStrings([`pressure:${pressure.pressureId}`], MAX_SOURCE_REFS),
      escalationCount: 0,
    };
    anchors.push(created);
    existingPressureIds.add(pressure.pressureId);
    events.push({
      anchorId: created.anchorId,
      eventType: "formed",
      pressureId: created.pressureId,
      archetype: created.archetype,
      from: null,
      to: "candidate",
      reason: "pressure_anchor_candidate",
      intensity: created.intensity,
    });
  }

  let activeEscalatedCount = anchors.filter((entry) => entry.lifecycle === "active" || entry.lifecycle === "escalated").length;

  anchors = anchors.map((anchor) => {
    const pressureInfo = pressureById.get(anchor.pressureId);
    const boost = pressureBoost.get(anchor.pressureId) ?? 0;
    const pressureIntensity = clampInt((pressureInfo?.intensity ?? anchor.intensity) + boost, 0, 100);
    const linkedQuestIds = linkedQuestIdsForPressure(input.economyAfter, anchor.pressureId);
    const questTransitions = linkedQuestIds.flatMap((questId) => transitionsByQuest.get(questId) ?? []);
    const hasQuestResolved = questTransitions.some((entry) => entry.to === "resolved");
    const hasQuestFailed = questTransitions.some((entry) => entry.to === "failed");
    let next = {
      ...anchor,
      intensity: pressureIntensity,
      linkedQuestIds,
      recentEventRefs: uniqStrings([
        ...anchor.recentEventRefs,
        `scene:${input.sceneId}`,
        `action:${input.actionId}`,
        ...questTransitions.slice(0, 2).map((entry) => `quest:${entry.questId}:${entry.to}`),
      ], MAX_EVENT_REFS),
      sourceRefs: uniqStrings([
        ...anchor.sourceRefs,
        `pressure:${anchor.pressureId}`,
        ...(signal.mode === "applied" ? ["signal:faction"] : []),
      ], MAX_SOURCE_REFS),
    };

    if (anchor.lifecycle === "archived") {
      return next;
    }

    if (resolveBySignal.has(anchor.anchorId) && (anchor.lifecycle === "active" || anchor.lifecycle === "escalated")) {
      next = transitionLifecycle(next, "resolved", input.nowIso, "signal_resolved");
      events.push({
        anchorId: next.anchorId,
        eventType: "resolved",
        pressureId: next.pressureId,
        archetype: next.archetype,
        from: anchor.lifecycle,
        to: next.lifecycle,
        reason: "signal_resolved",
        intensity: next.intensity,
      });
      return next;
    }

    if (anchor.lifecycle === "candidate") {
      const canActivate = pressureIntensity >= 68 || linkedQuestIds.length > 0;
      if (canActivate && activeEscalatedCount < MAX_ACTIVE_ESCALATED) {
        next = transitionLifecycle(next, "active", input.nowIso, "candidate_promoted");
        activeEscalatedCount += 1;
        events.push({
          anchorId: next.anchorId,
          eventType: "advanced",
          pressureId: next.pressureId,
          archetype: next.archetype,
          from: "candidate",
          to: "active",
          reason: "candidate_promoted",
          intensity: next.intensity,
        });
      }
      return next;
    }

    if (anchor.lifecycle === "active") {
      const shouldEscalate =
        escalateBySignal.has(anchor.anchorId) ||
        pressureIntensity >= 85 ||
        input.classification === "reckless" ||
        input.questSummary.failedNow > 0;
      if (shouldEscalate) {
        next = transitionLifecycle(next, "escalated", input.nowIso, "pressure_or_signal_escalation");
        next.escalationCount += 1;
        events.push({
          anchorId: next.anchorId,
          eventType: "escalated",
          pressureId: next.pressureId,
          archetype: next.archetype,
          from: "active",
          to: "escalated",
          reason: "pressure_or_signal_escalation",
          intensity: next.intensity,
        });
        return next;
      }

      if (hasQuestResolved || (pressureIntensity <= 34 && linkedQuestIds.length === 0)) {
        next = transitionLifecycle(next, "resolved", input.nowIso, hasQuestResolved ? "quest_resolved" : "pressure_cooled");
        activeEscalatedCount = Math.max(0, activeEscalatedCount - 1);
        events.push({
          anchorId: next.anchorId,
          eventType: "resolved",
          pressureId: next.pressureId,
          archetype: next.archetype,
          from: "active",
          to: "resolved",
          reason: hasQuestResolved ? "quest_resolved" : "pressure_cooled",
          intensity: next.intensity,
        });
        return next;
      }

      if (hasQuestFailed && pressureIntensity >= 92) {
        next = transitionLifecycle(next, "failed", input.nowIso, "pressure_overrun");
        activeEscalatedCount = Math.max(0, activeEscalatedCount - 1);
        events.push({
          anchorId: next.anchorId,
          eventType: "failed",
          pressureId: next.pressureId,
          archetype: next.archetype,
          from: "active",
          to: "failed",
          reason: "pressure_overrun",
          intensity: next.intensity,
        });
        return next;
      }
    }

    if (anchor.lifecycle === "escalated") {
      if (hasQuestResolved && pressureIntensity <= 50) {
        next = transitionLifecycle(next, "resolved", input.nowIso, "escalation_contained");
        activeEscalatedCount = Math.max(0, activeEscalatedCount - 1);
        events.push({
          anchorId: next.anchorId,
          eventType: "resolved",
          pressureId: next.pressureId,
          archetype: next.archetype,
          from: "escalated",
          to: "resolved",
          reason: "escalation_contained",
          intensity: next.intensity,
        });
        return next;
      }
      if (pressureIntensity >= 95 || hasQuestFailed) {
        next = transitionLifecycle(next, "failed", input.nowIso, "escalation_broke_line");
        activeEscalatedCount = Math.max(0, activeEscalatedCount - 1);
        events.push({
          anchorId: next.anchorId,
          eventType: "failed",
          pressureId: next.pressureId,
          archetype: next.archetype,
          from: "escalated",
          to: "failed",
          reason: "escalation_broke_line",
          intensity: next.intensity,
        });
        return next;
      }
    }

    if ((anchor.lifecycle === "resolved" || anchor.lifecycle === "failed") && anchor.terminalAtIso) {
      const terminalMs = Date.parse(anchor.terminalAtIso);
      const nowMs = Date.parse(input.nowIso);
      const ageSec = Number.isFinite(terminalMs) && Number.isFinite(nowMs) ? Math.max(0, Math.floor((nowMs - terminalMs) / 1000)) : 0;
      if (ageSec >= ARCHIVE_RETENTION_SEC) {
        const terminalFrom = anchor.lifecycle;
        next = transitionLifecycle(next, "archived", input.nowIso, "terminal_retention_elapsed");
        events.push({
          anchorId: next.anchorId,
          eventType: "archived",
          pressureId: next.pressureId,
          archetype: next.archetype,
          from: terminalFrom,
          to: "archived",
          reason: "terminal_retention_elapsed",
          intensity: next.intensity,
        });
        return next;
      }
    }

    if (pressureIntensity !== anchor.intensity || linkedQuestIds.length !== anchor.linkedQuestIds.length) {
      events.push({
        anchorId: next.anchorId,
        eventType: "advanced",
        pressureId: next.pressureId,
        archetype: next.archetype,
        from: anchor.lifecycle,
        to: next.lifecycle,
        reason: "state_refreshed",
        intensity: next.intensity,
      });
      next.lastAdvancedAtIso = input.nowIso;
    }

    return next;
  });

  const capped = capAnchorList(anchors);
  anchors = capped.anchors;

  const boundedEvents = events.slice(0, MAX_EVENTS_RECORDED);
  const summary: AnchorTickSummary = {
    formedNow: boundedEvents.filter((entry) => entry.eventType === "formed").length,
    advancedNow: boundedEvents.filter((entry) => entry.eventType === "advanced").length,
    escalatedNow: boundedEvents.filter((entry) => entry.eventType === "escalated").length,
    resolvedNow: boundedEvents.filter((entry) => entry.eventType === "resolved").length,
    failedNow: boundedEvents.filter((entry) => entry.eventType === "failed").length,
    archivedNow: boundedEvents.filter((entry) => entry.eventType === "archived").length,
    activeCount: anchors.filter((entry) => entry.lifecycle === "active").length,
    escalatedCount: anchors.filter((entry) => entry.lifecycle === "escalated").length,
    events: boundedEvents,
    debug: {
      signalMode: signal.mode,
      signalReason: signal.reason,
      cappedDroppedCandidates: capped.droppedCandidates,
    },
  };

  return {
    nextAnchor: {
      version: 1,
      anchors: anchors.sort(compareAnchorPriority),
      nextAnchorSeq,
    },
    summary,
  };
}

function lifecycleText(lifecycle: AnchorLifecycle): string {
  switch (lifecycle) {
    case "candidate":
      return "형성 중";
    case "active":
      return "진행 중";
    case "escalated":
      return "격화";
    case "resolved":
      return "해결";
    case "failed":
      return "실패";
    case "archived":
      return "보관";
    default:
      return "상태 미상";
  }
}

export function buildAnchorQualitativeSummary(params: {
  anchor: AnchorRuntimeState;
  lastSummary?: AnchorTickSummary | null;
}): AnchorPanelSummary {
  const ranked = params.anchor.anchors.slice().sort(compareAnchorPriority);
  const top = ranked.find((entry) => entry.lifecycle !== "archived") ?? null;
  const activeIds = ranked
    .filter((entry) => entry.lifecycle === "active" || entry.lifecycle === "escalated")
    .slice(0, 6)
    .map((entry) => entry.anchorId);
  const terminalIds = ranked
    .filter((entry) => entry.lifecycle === "resolved" || entry.lifecycle === "failed")
    .slice(0, 6)
    .map((entry) => entry.anchorId);

  const topShape = top
    ? {
        anchorId: top.anchorId,
        lifecycle: top.lifecycle,
        archetype: top.archetype,
        pressureId: top.pressureId,
        intensity: top.intensity,
        text: `${top.title} (${lifecycleText(top.lifecycle)}, 강도 ${String(top.intensity)})`,
      }
    : null;

  return {
    top: topShape,
    activeCount: ranked.filter((entry) => entry.lifecycle === "active").length,
    escalatedCount: ranked.filter((entry) => entry.lifecycle === "escalated").length,
    text: topShape ? topShape.text : "장기 충돌 축은 아직 전면화되지 않았다.",
    debug: {
      anchorCount: ranked.length,
      activeIds,
      terminalIds,
      signalMode: params.lastSummary?.debug.signalMode ?? "missing",
      signalReason: params.lastSummary?.debug.signalReason ?? "signal_missing",
    },
  };
}
