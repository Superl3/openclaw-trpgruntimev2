import type { ActionFeasibility, DeterministicActionId } from "./scene-loop.js";
import type { QuestTemporalSignal } from "./temporal-systems.js";

export type PressureArchetype = "smuggling" | "outbreak" | "power_struggle" | "artifact_race" | "public_order";

export type QuestLifecycle =
  | "seed"
  | "surfaced"
  | "active"
  | "stalled"
  | "resolved"
  | "failed"
  | "archived"
  | "deleted";

export type QuestHookType = "incident" | "rumor" | "witness" | "request";

export type QuestCost = {
  world: number;
  attention: number;
  narrative: number;
};

export type WorldPressureState = {
  pressureId: string;
  archetype: PressureArchetype;
  intensity: number;
  momentum: number;
  targetLocations: string[];
  cadenceSec: number;
  lastAdvancedAtIso: string;
  lastSeededAtIso: string | null;
  anchorCandidate: boolean;
};

export type QuestState = {
  questId: string;
  pressureId: string;
  archetype: PressureArchetype;
  lifecycle: QuestLifecycle;
  locationId: string | null;
  urgency: number;
  /**
   * Coarse aggregate marker only.
   * It never replaces lifecycle/deadline/mutation rules.
   */
  progress: number;
  surfacedAtIso: string | null;
  startedAtIso: string | null;
  deadlineAtIso: string | null;
  expiresAtIso: string | null;
  lastAdvancedAtIso: string;
  parentQuestId: string | null;
  successorQuestId: string | null;
  terminalReason: string | null;
  cost: QuestCost;
  hookType: QuestHookType;
  mutationCount: number;
  lastMutationAtIso: string | null;
  stallCount: number;
};

export type QuestBudgetState = {
  caps: {
    livePool: number;
    world: number;
    attention: number;
    narrative: number;
  };
  used: {
    livePool: number;
    world: number;
    attention: number;
    narrative: number;
  };
};

export type QuestSoftQuotaState = {
  caps: {
    perLocation: number;
    perPressure: number;
    perArchetype: number;
  };
  usageByLocation: Array<{ key: string; count: number }>;
  usageByPressure: Array<{ key: string; count: number }>;
  usageByArchetype: Array<{ key: string; count: number }>;
};

export type QuestEconomyState = {
  version: 1;
  worldPressures: WorldPressureState[];
  quests: QuestState[];
  budget: QuestBudgetState;
  softQuota: QuestSoftQuotaState;
  nextQuestSeq: number;
};

export type QuestLifecycleTransition = {
  questId: string;
  from: QuestLifecycle;
  to: QuestLifecycle;
  reason: string;
  parentQuestId: string | null;
  successorQuestId: string | null;
};

export type QuestEconomyQualitativeSummary = {
  surfaced: string;
  urgent: string;
  pressure: string;
  counts: {
    surfaced: number;
    active: number;
  };
  topPressure: {
    pressureId: string;
    archetype: PressureArchetype;
    intensity: number;
  } | null;
  urgentTop: {
    questId: string;
    lifecycle: "active" | "stalled";
    urgency: number;
    locationId: string | null;
  } | null;
  debug: {
    liveQuestCount: number;
    budget: QuestBudgetState;
    softQuota: QuestSoftQuotaState;
  };
};

export type QuestEconomyTickSummary = {
  pressureAdvancedCount: number;
  pressureTop: {
    pressureId: string;
    archetype: PressureArchetype;
    intensity: number;
  } | null;
  transitionCount: number;
  transitions: QuestLifecycleTransition[];
  spawnedSeeds: number;
  surfacedNow: number;
  expiredDeleted: number;
  failedNow: number;
  mutatedNow: number;
  archivedNow: number;
  budget: QuestBudgetState;
  softQuota: QuestSoftQuotaState;
  qualitative: QuestEconomyQualitativeSummary;
  debug: {
    severeQuotaBlocks: number;
    budgetBlocked: boolean;
  };
};

export type QuestEconomyTickInput = {
  economy: QuestEconomyState | null | undefined;
  nowIso: string;
  deltaTimeSec: number;
  sceneId: string;
  locationId: string | null;
  actionId: DeterministicActionId;
  classification: ActionFeasibility;
  temporalSignal: QuestTemporalSignal;
};

export type QuestEconomyTickResult = {
  nextEconomy: QuestEconomyState;
  summary: QuestEconomyTickSummary;
};

const DEFAULT_LIVE_POOL_CAP = 10;
const DEFAULT_WORLD_BUDGET_CAP = 40;
const DEFAULT_ATTENTION_BUDGET_CAP = 20;
const DEFAULT_NARRATIVE_BUDGET_CAP = 16;

const DEFAULT_LOCATION_QUOTA_CAP = 3;
const DEFAULT_PRESSURE_QUOTA_CAP = 4;
const DEFAULT_ARCHETYPE_QUOTA_CAP = 4;

const MAX_WORLD_PRESSURES = 12;
const MAX_QUESTS = 180;
const MAX_TARGET_LOCATIONS = 6;
const MAX_TRANSITIONS_RECORDED = 18;
const MAX_USAGE_ROWS = 18;

const SEED_EXPIRES_SEC = 2_100;
const SURFACED_EXPIRES_SEC = 1_000;
const STARTED_DEADLINE_BASE_SEC = 1_800;
const STARTED_DEADLINE_FLOOR_SEC = 700;
const STARTED_DEADLINE_CEILING_SEC = 4_200;
const TERMINAL_ARCHIVE_RETENTION_SEC = 1_800;

const MAX_SUCCESSOR_MUTATION_COUNT = 2;
const SUCCESSOR_COOLDOWN_SEC = 900;

const LIVE_LIFECYCLE_SET = new Set<QuestLifecycle>(["seed", "surfaced", "active", "stalled"]);
const VISIBLE_LIFECYCLE_SET = new Set<QuestLifecycle>(["surfaced", "active", "stalled"]);
const TERMINAL_LIFECYCLE_SET = new Set<QuestLifecycle>(["resolved", "failed", "deleted"]);

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
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

function readIsoMillis(value: string | null): number {
  if (!value) {
    return Number.NaN;
  }
  return Date.parse(value);
}

function readIsoString(value: unknown, fallback: string): string {
  const normalized = readString(value);
  if (!normalized) {
    return fallback;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function isoNowOrFallback(nowIso: string): string {
  const parsed = Date.parse(nowIso);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function addSecondsToIso(baseIso: string, deltaSec: number): string {
  const parsed = Date.parse(baseIso);
  const baseline = Number.isFinite(parsed) ? parsed : Date.now();
  return new Date(baseline + Math.max(0, Math.trunc(deltaSec)) * 1000).toISOString();
}

function elapsedSec(fromIso: string | null, toIso: string): number {
  const from = readIsoMillis(fromIso);
  const to = readIsoMillis(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return 0;
  }
  return Math.max(0, Math.floor((to - from) / 1000));
}

function normalizeArchetype(value: unknown): PressureArchetype {
  const normalized = readString(value);
  switch (normalized) {
    case "smuggling":
      return "smuggling";
    case "outbreak":
      return "outbreak";
    case "power_struggle":
      return "power_struggle";
    case "artifact_race":
      return "artifact_race";
    case "public_order":
      return "public_order";
    default:
      return "public_order";
  }
}

function normalizeHookType(value: unknown): QuestHookType {
  const normalized = readString(value);
  if (normalized === "rumor" || normalized === "witness" || normalized === "request") {
    return normalized;
  }
  return "incident";
}

function normalizeLifecycle(value: unknown): QuestLifecycle {
  const normalized = readString(value);
  switch (normalized) {
    case "seed":
      return "seed";
    case "surfaced":
      return "surfaced";
    case "active":
      return "active";
    case "stalled":
      return "stalled";
    case "resolved":
      return "resolved";
    case "failed":
      return "failed";
    case "archived":
      return "archived";
    case "deleted":
      return "deleted";
    default:
      return "seed";
  }
}

function isLiveLifecycle(value: QuestLifecycle): boolean {
  return LIVE_LIFECYCLE_SET.has(value);
}

function isVisibleLifecycle(value: QuestLifecycle): boolean {
  return VISIBLE_LIFECYCLE_SET.has(value);
}

function isTerminalLifecycle(value: QuestLifecycle): boolean {
  return TERMINAL_LIFECYCLE_SET.has(value);
}

function archetypeHookType(archetype: PressureArchetype): QuestHookType {
  switch (archetype) {
    case "smuggling":
      return "witness";
    case "outbreak":
      return "incident";
    case "power_struggle":
      return "request";
    case "artifact_race":
      return "rumor";
    case "public_order":
      return "incident";
    default:
      return "incident";
  }
}

function normalizeQuestCost(value: unknown, fallback: QuestCost): QuestCost {
  const node = toRecord(value);
  return {
    world: clampInt(readInt(node.world, fallback.world), 0, 12),
    attention: clampInt(readInt(node.attention, fallback.attention), 0, 12),
    narrative: clampInt(readInt(node.narrative, fallback.narrative), 0, 12),
  };
}

function pressureSeedCost(intensity: number): QuestCost {
  if (intensity >= 78) {
    return { world: 4, attention: 4, narrative: 2 };
  }
  if (intensity >= 62) {
    return { world: 3, attention: 3, narrative: 1 };
  }
  return { world: 2, attention: 2, narrative: 1 };
}

function pressureLabel(archetype: PressureArchetype): string {
  switch (archetype) {
    case "smuggling":
      return "smuggling";
    case "outbreak":
      return "outbreak";
    case "power_struggle":
      return "power struggle";
    case "artifact_race":
      return "artifact race";
    case "public_order":
      return "public order";
    default:
      return "world pressure";
  }
}

function scoreIsoDesc(a: string, b: string): number {
  const aMs = readIsoMillis(a);
  const bMs = readIsoMillis(b);
  const safeA = Number.isFinite(aMs) ? aMs : 0;
  const safeB = Number.isFinite(bMs) ? bMs : 0;
  return safeB - safeA;
}

function compareQuestPriority(a: QuestState, b: QuestState): number {
  const aLive = isLiveLifecycle(a.lifecycle) ? 1 : 0;
  const bLive = isLiveLifecycle(b.lifecycle) ? 1 : 0;
  if (aLive !== bLive) {
    return bLive - aLive;
  }
  if (a.urgency !== b.urgency) {
    return b.urgency - a.urgency;
  }
  return scoreIsoDesc(a.lastAdvancedAtIso, b.lastAdvancedAtIso);
}

function makeDefaultPressures(nowIso: string): WorldPressureState[] {
  return [
    {
      pressureId: "pressure-smuggling",
      archetype: "smuggling",
      intensity: 55,
      momentum: 2,
      targetLocations: [],
      cadenceSec: 200,
      lastAdvancedAtIso: nowIso,
      lastSeededAtIso: null,
      anchorCandidate: false,
    },
    {
      pressureId: "pressure-public-order",
      archetype: "public_order",
      intensity: 48,
      momentum: 1,
      targetLocations: [],
      cadenceSec: 170,
      lastAdvancedAtIso: nowIso,
      lastSeededAtIso: null,
      anchorCandidate: false,
    },
    {
      pressureId: "pressure-artifact-race",
      archetype: "artifact_race",
      intensity: 50,
      momentum: 1,
      targetLocations: [],
      cadenceSec: 240,
      lastAdvancedAtIso: nowIso,
      lastSeededAtIso: null,
      anchorCandidate: false,
    },
  ];
}

function makeDefaultEconomy(nowIso: string): QuestEconomyState {
  const resolvedNow = isoNowOrFallback(nowIso);
  return {
    version: 1,
    worldPressures: makeDefaultPressures(resolvedNow),
    quests: [],
    budget: {
      caps: {
        livePool: DEFAULT_LIVE_POOL_CAP,
        world: DEFAULT_WORLD_BUDGET_CAP,
        attention: DEFAULT_ATTENTION_BUDGET_CAP,
        narrative: DEFAULT_NARRATIVE_BUDGET_CAP,
      },
      used: {
        livePool: 0,
        world: 0,
        attention: 0,
        narrative: 0,
      },
    },
    softQuota: {
      caps: {
        perLocation: DEFAULT_LOCATION_QUOTA_CAP,
        perPressure: DEFAULT_PRESSURE_QUOTA_CAP,
        perArchetype: DEFAULT_ARCHETYPE_QUOTA_CAP,
      },
      usageByLocation: [],
      usageByPressure: [],
      usageByArchetype: [],
    },
    nextQuestSeq: 1,
  };
}

function normalizePressure(value: unknown, nowIso: string): WorldPressureState | null {
  const node = toRecord(value);
  const pressureId = readString(node.pressureId);
  if (!pressureId) {
    return null;
  }
  const intensity = clampInt(readInt(node.intensity, 45), 0, 100);
  const cadenceSec = clampInt(readInt(node.cadenceSec, 180), 60, 3600);
  const targets = Array.isArray(node.targetLocations)
    ? uniqStrings(node.targetLocations.filter((entry): entry is string => typeof entry === "string"), MAX_TARGET_LOCATIONS)
    : [];

  return {
    pressureId,
    archetype: normalizeArchetype(node.archetype),
    intensity,
    momentum: clampInt(readInt(node.momentum, 0), -20, 20),
    targetLocations: targets,
    cadenceSec,
    lastAdvancedAtIso: readIsoString(node.lastAdvancedAtIso, nowIso),
    lastSeededAtIso: readString(node.lastSeededAtIso) || null,
    anchorCandidate: readBoolean(node.anchorCandidate, false),
  };
}

function normalizeQuest(value: unknown, params: {
  nowIso: string;
  defaultPressureId: string;
}): QuestState | null {
  const node = toRecord(value);
  const questId = readString(node.questId);
  if (!questId) {
    return null;
  }

  let lifecycle = normalizeLifecycle(node.lifecycle);
  const surfacedAtIso = readString(node.surfacedAtIso) || null;
  let startedAtIso = readString(node.startedAtIso) || null;
  let deadlineAtIso = readString(node.deadlineAtIso) || null;
  let expiresAtIso = readString(node.expiresAtIso) || null;
  const nowIso = params.nowIso;

  if ((lifecycle === "active" || lifecycle === "stalled") && !startedAtIso) {
    startedAtIso = surfacedAtIso || nowIso;
  }

  if (lifecycle === "stalled" && !startedAtIso) {
    lifecycle = "surfaced";
  }

  if (lifecycle === "deleted" && startedAtIso) {
    lifecycle = "failed";
  }

  if (startedAtIso) {
    expiresAtIso = null;
  }

  if ((lifecycle === "active" || lifecycle === "stalled") && !deadlineAtIso) {
    deadlineAtIso = addSecondsToIso(startedAtIso || nowIso, STARTED_DEADLINE_BASE_SEC);
  }

  const terminalReason = readString(node.terminalReason) || null;

  const fallbackCost = pressureSeedCost(clampInt(readInt(node.urgency, 45), 0, 100));
  const cost = normalizeQuestCost(node.cost, fallbackCost);

  const parentQuestId = readString(node.parentQuestId) || null;
  let successorQuestId = readString(node.successorQuestId) || null;
  if (successorQuestId === questId) {
    successorQuestId = null;
  }

  const quest: QuestState = {
    questId,
    pressureId: readString(node.pressureId) || params.defaultPressureId,
    archetype: normalizeArchetype(node.archetype),
    lifecycle,
    locationId: readString(node.locationId) || null,
    urgency: clampInt(readInt(node.urgency, 45), 0, 100),
    progress: clampInt(readInt(node.progress, 0), 0, 100),
    surfacedAtIso,
    startedAtIso,
    deadlineAtIso,
    expiresAtIso,
    lastAdvancedAtIso: readIsoString(node.lastAdvancedAtIso, nowIso),
    parentQuestId,
    successorQuestId,
    terminalReason,
    cost,
    hookType: normalizeHookType(node.hookType),
    mutationCount: clampInt(readInt(node.mutationCount, 0), 0, 12),
    lastMutationAtIso: readString(node.lastMutationAtIso) || null,
    stallCount: clampInt(readInt(node.stallCount, 0), 0, 99),
  };

  if (quest.lifecycle === "deleted" && quest.startedAtIso) {
    quest.lifecycle = "failed";
    quest.terminalReason = quest.terminalReason || "started_non_delete_guard";
  }

  if (isTerminalLifecycle(quest.lifecycle) && !quest.terminalReason) {
    quest.terminalReason = quest.lifecycle === "resolved" ? "resolved" : "terminal";
  }

  return quest;
}

function extractQuestSeq(value: string): number {
  const matched = value.match(/(\d{1,9})$/);
  if (!matched) {
    return 0;
  }
  const parsed = Number.parseInt(matched[1], 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function recomputeNextQuestSeq(quests: QuestState[], current: number): number {
  const maxSeq = quests.reduce((max, quest) => Math.max(max, extractQuestSeq(quest.questId)), 0);
  return Math.max(Math.max(1, current), maxSeq + 1);
}

function dedupeQuestList(quests: QuestState[]): QuestState[] {
  const map = new Map<string, QuestState>();
  for (const quest of quests) {
    const existing = map.get(quest.questId);
    if (!existing) {
      map.set(quest.questId, quest);
      continue;
    }
    if (scoreIsoDesc(quest.lastAdvancedAtIso, existing.lastAdvancedAtIso) < 0) {
      continue;
    }
    map.set(quest.questId, quest);
  }
  return Array.from(map.values());
}

function pruneEconomy(state: QuestEconomyState): QuestEconomyState {
  const dedupedPressures = new Map<string, WorldPressureState>();
  for (const pressure of state.worldPressures) {
    dedupedPressures.set(pressure.pressureId, pressure);
  }
  const worldPressures = Array.from(dedupedPressures.values())
    .sort((a, b) => b.intensity - a.intensity || scoreIsoDesc(a.lastAdvancedAtIso, b.lastAdvancedAtIso))
    .slice(0, MAX_WORLD_PRESSURES);

  const dedupedQuests = dedupeQuestList(state.quests);
  dedupedQuests.sort(compareQuestPriority);

  const live = dedupedQuests.filter((quest) => isLiveLifecycle(quest.lifecycle));
  const nonLive = dedupedQuests
    .filter((quest) => !isLiveLifecycle(quest.lifecycle))
    .sort((a, b) => scoreIsoDesc(a.lastAdvancedAtIso, b.lastAdvancedAtIso));
  const quests = [...live, ...nonLive].slice(0, MAX_QUESTS);

  return {
    ...state,
    worldPressures,
    quests,
    nextQuestSeq: recomputeNextQuestSeq(quests, state.nextQuestSeq),
  };
}

function normalizeBudget(value: unknown, fallback: QuestBudgetState): QuestBudgetState {
  const node = toRecord(value);
  const capsNode = toRecord(node.caps);
  const usedNode = toRecord(node.used);
  return {
    caps: {
      livePool: clampInt(readInt(capsNode.livePool, fallback.caps.livePool), 3, 64),
      world: clampInt(readInt(capsNode.world, fallback.caps.world), 8, 300),
      attention: clampInt(readInt(capsNode.attention, fallback.caps.attention), 4, 200),
      narrative: clampInt(readInt(capsNode.narrative, fallback.caps.narrative), 2, 160),
    },
    used: {
      livePool: Math.max(0, readInt(usedNode.livePool, fallback.used.livePool)),
      world: Math.max(0, readInt(usedNode.world, fallback.used.world)),
      attention: Math.max(0, readInt(usedNode.attention, fallback.used.attention)),
      narrative: Math.max(0, readInt(usedNode.narrative, fallback.used.narrative)),
    },
  };
}

function normalizeSoftQuota(value: unknown, fallback: QuestSoftQuotaState): QuestSoftQuotaState {
  const node = toRecord(value);
  const capsNode = toRecord(node.caps);

  const parseUsageRows = (raw: unknown): Array<{ key: string; count: number }> => {
    if (!Array.isArray(raw)) {
      return [];
    }
    const out: Array<{ key: string; count: number }> = [];
    for (const entry of raw) {
      const row = toRecord(entry);
      const key = readString(row.key);
      if (!key) {
        continue;
      }
      out.push({
        key,
        count: Math.max(0, readInt(row.count, 0)),
      });
      if (out.length >= MAX_USAGE_ROWS) {
        break;
      }
    }
    return out;
  };

  return {
    caps: {
      perLocation: clampInt(readInt(capsNode.perLocation, fallback.caps.perLocation), 1, 24),
      perPressure: clampInt(readInt(capsNode.perPressure, fallback.caps.perPressure), 1, 24),
      perArchetype: clampInt(readInt(capsNode.perArchetype, fallback.caps.perArchetype), 1, 24),
    },
    usageByLocation: parseUsageRows(node.usageByLocation),
    usageByPressure: parseUsageRows(node.usageByPressure),
    usageByArchetype: parseUsageRows(node.usageByArchetype),
  };
}

type UsageMaps = {
  byLocation: Map<string, number>;
  byPressure: Map<string, number>;
  byArchetype: Map<string, number>;
};

function usageMapsFromLiveQuests(quests: QuestState[]): UsageMaps {
  const byLocation = new Map<string, number>();
  const byPressure = new Map<string, number>();
  const byArchetype = new Map<string, number>();

  const add = (map: Map<string, number>, key: string) => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };

  for (const quest of quests) {
    if (!isLiveLifecycle(quest.lifecycle)) {
      continue;
    }
    add(byLocation, quest.locationId ?? "none");
    add(byPressure, quest.pressureId);
    add(byArchetype, quest.archetype);
  }

  return {
    byLocation,
    byPressure,
    byArchetype,
  };
}

function mapToRows(map: Map<string, number>): Array<{ key: string; count: number }> {
  return Array.from(map.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, MAX_USAGE_ROWS);
}

function computeBudgetUsed(quests: QuestState[]): QuestBudgetState["used"] {
  const used = {
    livePool: 0,
    world: 0,
    attention: 0,
    narrative: 0,
  };

  for (const quest of quests) {
    if (isLiveLifecycle(quest.lifecycle)) {
      used.livePool += 1;
      used.world += quest.cost.world;
    }
    if (isVisibleLifecycle(quest.lifecycle)) {
      used.attention += quest.cost.attention;
    }
    if (quest.lifecycle === "active" || quest.lifecycle === "stalled") {
      used.narrative += quest.cost.narrative;
    }
  }

  return used;
}

function recalculateBudgetAndQuota(state: QuestEconomyState): QuestEconomyState {
  const used = computeBudgetUsed(state.quests);
  const usageMaps = usageMapsFromLiveQuests(state.quests);

  return {
    ...state,
    budget: {
      ...state.budget,
      used,
    },
    softQuota: {
      ...state.softQuota,
      usageByLocation: mapToRows(usageMaps.byLocation),
      usageByPressure: mapToRows(usageMaps.byPressure),
      usageByArchetype: mapToRows(usageMaps.byArchetype),
    },
  };
}

export function ensureQuestEconomyState(value: unknown, nowIso: string): QuestEconomyState {
  const resolvedNow = isoNowOrFallback(nowIso);
  const fallback = makeDefaultEconomy(resolvedNow);
  const root = toRecord(value);

  const worldPressuresRaw = Array.isArray(root.worldPressures) ? root.worldPressures : [];
  const worldPressures = worldPressuresRaw
    .map((entry) => normalizePressure(entry, resolvedNow))
    .filter((entry): entry is WorldPressureState => entry !== null);

  const pressurePool = worldPressures.length > 0 ? worldPressures : fallback.worldPressures;
  const defaultPressureId = pressurePool[0]?.pressureId ?? "pressure-public_order";

  const questsRaw = Array.isArray(root.quests) ? root.quests : [];
  const quests = questsRaw
    .map((entry) => normalizeQuest(entry, { nowIso: resolvedNow, defaultPressureId }))
    .filter((entry): entry is QuestState => entry !== null);

  let state: QuestEconomyState = {
    version: 1,
    worldPressures: pressurePool,
    quests,
    budget: normalizeBudget(root.budget, fallback.budget),
    softQuota: normalizeSoftQuota(root.softQuota, fallback.softQuota),
    nextQuestSeq: Math.max(1, readInt(root.nextQuestSeq, fallback.nextQuestSeq)),
  };

  state = pruneEconomy(state);
  state = recalculateBudgetAndQuota(state);
  return {
    ...state,
    nextQuestSeq: recomputeNextQuestSeq(state.quests, state.nextQuestSeq),
  };
}

function topPressure(pressures: WorldPressureState[]): WorldPressureState | null {
  if (pressures.length === 0) {
    return null;
  }
  const sorted = pressures
    .slice()
    .sort((a, b) => b.intensity - a.intensity || b.momentum - a.momentum || a.pressureId.localeCompare(b.pressureId));
  return sorted[0] ?? null;
}

function urgencyBand(urgency: number): string {
  if (urgency >= 80) {
    return "critical";
  }
  if (urgency >= 60) {
    return "high";
  }
  if (urgency >= 35) {
    return "moderate";
  }
  return "low";
}

function pressureBand(intensity: number): string {
  if (intensity >= 75) {
    return "surging";
  }
  if (intensity >= 55) {
    return "elevated";
  }
  if (intensity >= 35) {
    return "present";
  }
  return "cooling";
}

function pickUrgentTop(quests: QuestState[], locationId: string | null): QuestEconomyQualitativeSummary["urgentTop"] {
  const active = quests
    .filter((quest) => quest.lifecycle === "active" || quest.lifecycle === "stalled")
    .sort((a, b) => b.urgency - a.urgency || scoreIsoDesc(a.lastAdvancedAtIso, b.lastAdvancedAtIso));

  const localized = locationId
    ? active.filter((quest) => quest.locationId === locationId)
    : [];
  const selected = (localized[0] ?? active[0]) as QuestState | undefined;
  if (!selected) {
    return null;
  }
  return {
    questId: selected.questId,
    lifecycle: selected.lifecycle === "stalled" ? "stalled" : "active",
    urgency: selected.urgency,
    locationId: selected.locationId,
  };
}

export function buildQuestEconomyQualitativeSummary(params: {
  economy: QuestEconomyState;
  locationId: string | null;
}): QuestEconomyQualitativeSummary {
  const surfacedCount = params.economy.quests.filter((quest) => quest.lifecycle === "surfaced").length;
  const activeCount = params.economy.quests.filter(
    (quest) => quest.lifecycle === "active" || quest.lifecycle === "stalled",
  ).length;
  const top = topPressure(params.economy.worldPressures);
  const urgentTop = pickUrgentTop(params.economy.quests, params.locationId);

  const surfaced =
    surfacedCount > 0
      ? `${String(surfacedCount)} surfaced opportunities are available.`
      : "No surfaced opportunity right now.";

  const urgent = urgentTop
    ? `Urgent quest ${urgentTop.questId} is ${urgencyBand(urgentTop.urgency)} urgency.`
    : "No urgent active quest right now.";

  const pressure = top
    ? `${pressureLabel(top.archetype)} pressure is ${pressureBand(top.intensity)} (${String(top.intensity)}).`
    : "World pressure is stable.";

  return {
    surfaced,
    urgent,
    pressure,
    counts: {
      surfaced: surfacedCount,
      active: activeCount,
    },
    topPressure: top
      ? {
          pressureId: top.pressureId,
          archetype: top.archetype,
          intensity: top.intensity,
        }
      : null,
    urgentTop,
    debug: {
      liveQuestCount: params.economy.budget.used.livePool,
      budget: params.economy.budget,
      softQuota: params.economy.softQuota,
    },
  };
}

type TransitionAccumulator = {
  transitions: QuestLifecycleTransition[];
  expiredDeleted: number;
  failedNow: number;
  mutatedNow: number;
  archivedNow: number;
  surfacedNow: number;
};

function pushTransition(params: {
  acc: TransitionAccumulator;
  quest: QuestState;
  from: QuestLifecycle;
  to: QuestLifecycle;
  reason: string;
}): void {
  if (params.acc.transitions.length < MAX_TRANSITIONS_RECORDED) {
    params.acc.transitions.push({
      questId: params.quest.questId,
      from: params.from,
      to: params.to,
      reason: params.reason,
      parentQuestId: params.quest.parentQuestId,
      successorQuestId: params.quest.successorQuestId,
    });
  }

  if (params.to === "deleted") {
    params.acc.expiredDeleted += 1;
  }
  if (params.to === "failed") {
    params.acc.failedNow += 1;
  }
  if (params.to === "archived") {
    params.acc.archivedNow += 1;
  }
  if (params.to === "surfaced" && params.from === "seed") {
    params.acc.surfacedNow += 1;
  }
}

function setLifecycle(params: {
  quest: QuestState;
  to: QuestLifecycle;
  reason: string;
  nowIso: string;
  acc: TransitionAccumulator;
}): void {
  const from = params.quest.lifecycle;
  let to = params.to;
  let reason = params.reason;

  if (to === "deleted" && params.quest.startedAtIso) {
    to = "failed";
    reason = "started_non_delete_guard";
  }

  if (from === to && (to === "resolved" || to === "failed" || to === "deleted" ? params.quest.terminalReason === reason : true)) {
    return;
  }

  params.quest.lifecycle = to;
  params.quest.lastAdvancedAtIso = params.nowIso;

  switch (to) {
    case "surfaced":
      params.quest.surfacedAtIso = params.quest.surfacedAtIso ?? params.nowIso;
      params.quest.expiresAtIso = addSecondsToIso(params.nowIso, SURFACED_EXPIRES_SEC);
      params.quest.terminalReason = null;
      break;
    case "active":
      params.quest.startedAtIso = params.quest.startedAtIso ?? params.nowIso;
      params.quest.deadlineAtIso =
        params.quest.deadlineAtIso ?? addSecondsToIso(params.nowIso, STARTED_DEADLINE_BASE_SEC);
      params.quest.expiresAtIso = null;
      params.quest.terminalReason = null;
      params.quest.stallCount = 0;
      break;
    case "stalled":
      params.quest.startedAtIso = params.quest.startedAtIso ?? params.nowIso;
      params.quest.deadlineAtIso =
        params.quest.deadlineAtIso ?? addSecondsToIso(params.nowIso, STARTED_DEADLINE_BASE_SEC);
      params.quest.expiresAtIso = null;
      params.quest.stallCount = Math.max(1, params.quest.stallCount);
      break;
    case "resolved":
    case "failed":
    case "deleted":
      params.quest.terminalReason = reason;
      params.quest.expiresAtIso = null;
      break;
    case "archived":
      params.quest.expiresAtIso = null;
      break;
    default:
      break;
  }

  pushTransition({
    acc: params.acc,
    quest: params.quest,
    from,
    to,
    reason,
  });
}

function quotaPenalty(params: {
  quests: QuestState[];
  locationId: string | null;
  pressureId: string;
  archetype: PressureArchetype;
  caps: QuestSoftQuotaState["caps"];
}): { penalty: number; severe: boolean } {
  const usage = usageMapsFromLiveQuests(params.quests);
  const locationCount = usage.byLocation.get(params.locationId ?? "none") ?? 0;
  const pressureCount = usage.byPressure.get(params.pressureId) ?? 0;
  const archetypeCount = usage.byArchetype.get(params.archetype) ?? 0;

  const locationOver = Math.max(0, locationCount - params.caps.perLocation);
  const pressureOver = Math.max(0, pressureCount - params.caps.perPressure);
  const archetypeOver = Math.max(0, archetypeCount - params.caps.perArchetype);

  const severe = locationOver >= 2 || pressureOver >= 2 || archetypeOver >= 2;
  return {
    penalty: locationOver * 10 + pressureOver * 10 + archetypeOver * 10,
    severe,
  };
}

function canAllocateSeed(params: {
  quests: QuestState[];
  caps: QuestBudgetState["caps"];
  cost: QuestCost;
}): boolean {
  const used = computeBudgetUsed(params.quests);
  return (
    used.livePool + 1 <= params.caps.livePool &&
    used.world + params.cost.world <= params.caps.world &&
    used.attention <= params.caps.attention
  );
}

function canSurfaceSeed(params: {
  quests: QuestState[];
  caps: QuestBudgetState["caps"];
  seed: QuestState;
}): boolean {
  const used = computeBudgetUsed(params.quests);
  return used.attention + params.seed.cost.attention <= params.caps.attention;
}

function canActivateQuest(params: {
  quests: QuestState[];
  caps: QuestBudgetState["caps"];
  quest: QuestState;
}): boolean {
  const used = computeBudgetUsed(params.quests);
  return used.narrative + params.quest.cost.narrative <= params.caps.narrative;
}

function shouldTryStart(actionId: DeterministicActionId, classification: ActionFeasibility): boolean {
  if (classification !== "possible" && classification !== "reckless") {
    return false;
  }
  return actionId === "action.observe" || actionId === "action.talk" || actionId === "action.move" || actionId === "action.rush";
}

function progressDelta(params: {
  actionId: DeterministicActionId;
  classification: ActionFeasibility;
  signal: QuestTemporalSignal;
}): number {
  if (params.classification !== "possible" && params.classification !== "reckless") {
    return 0;
  }

  const base =
    params.actionId === "action.observe"
      ? 14
      : params.actionId === "action.talk"
        ? 12
        : params.actionId === "action.move"
          ? 9
          : params.actionId === "action.rush"
            ? 16
            : params.actionId === "action.wait"
              ? 2
              : 0;

  const traceBoost = Math.round(params.signal.residualTraceHeat / 25);
  const freshnessBoost = Math.round(params.signal.infoFreshness / 30);
  const recklessPenalty = params.classification === "reckless" ? 2 : 0;
  return clampInt(base + traceBoost + freshnessBoost - recklessPenalty, 0, 30);
}

function urgencyDrift(params: {
  quest: QuestState;
  pressure: WorldPressureState | undefined;
  signal: QuestTemporalSignal;
  nowIso: string;
}): number {
  const pressureIntensity = params.pressure?.intensity ?? 45;
  const pressureBias = Math.round((pressureIntensity - 45) / 12);
  const localStress = Math.round((params.signal.locationTension - 40) / 15) + Math.round(params.signal.residualTraceHeat / 35);
  const freshnessBias = Math.round((40 - params.signal.infoFreshness) / 20);

  if (params.quest.lifecycle === "seed" || params.quest.lifecycle === "surfaced") {
    return clampInt(pressureBias + localStress + freshnessBias, -4, 8);
  }

  if (params.quest.lifecycle === "active" || params.quest.lifecycle === "stalled") {
    const toDeadline = elapsedSec(params.nowIso, params.quest.deadlineAtIso ?? params.nowIso);
    const deadlineBias = params.quest.deadlineAtIso && toDeadline === 0 ? 8 : 0;
    return clampInt(2 + pressureBias + localStress + deadlineBias, -2, 10);
  }

  return 0;
}

function choosePrestartDeleteReason(params: {
  pressure: WorldPressureState | undefined;
  signal: QuestTemporalSignal;
}): string {
  const intensity = params.pressure?.intensity ?? 45;
  if (intensity < 38) {
    return "handled_elsewhere";
  }
  if (params.signal.infoFreshness < 28) {
    return "rumor_cooled";
  }
  return "opportunity_shifted";
}

function deadlineSecondsFromUrgency(urgency: number): number {
  const span = STARTED_DEADLINE_BASE_SEC - Math.round(urgency * 8);
  return clampInt(span, STARTED_DEADLINE_FLOOR_SEC, STARTED_DEADLINE_CEILING_SEC);
}

function pressureAdvanceDelta(params: {
  pressure: WorldPressureState;
  signal: QuestTemporalSignal;
}): number {
  const locationBias = params.signal.locationId && params.pressure.targetLocations.includes(params.signal.locationId) ? 1.4 : 0;
  const tensionBias = (params.signal.locationTension - 45) / 16;
  const alertBias = (params.signal.locationAlertness - 42) / 20;
  const traceBias = params.signal.residualTraceHeat / 28;
  const memoryBias = params.signal.memoryFamiliarity / 90;
  const freshnessCooling = (params.signal.infoFreshness - 45) / 28;
  const incidentBias = params.signal.incidentCount * 0.8;
  const momentumBias = params.pressure.momentum * 0.4;
  const raw = momentumBias + tensionBias + alertBias + traceBias + memoryBias + incidentBias - freshnessCooling + locationBias;
  return clampInt(Math.round(raw), -6, 6);
}

function adjustMomentum(current: number, delta: number): number {
  return clampInt(Math.round(current * 0.72 + delta * 0.68), -20, 20);
}

function createSeedQuest(params: {
  questId: string;
  pressure: WorldPressureState;
  locationId: string | null;
  nowIso: string;
  urgency: number;
}): QuestState {
  return {
    questId: params.questId,
    pressureId: params.pressure.pressureId,
    archetype: params.pressure.archetype,
    lifecycle: "seed",
    locationId: params.locationId,
    urgency: clampInt(params.urgency, 0, 100),
    progress: 0,
    surfacedAtIso: null,
    startedAtIso: null,
    deadlineAtIso: null,
    expiresAtIso: addSecondsToIso(params.nowIso, SEED_EXPIRES_SEC),
    lastAdvancedAtIso: params.nowIso,
    parentQuestId: null,
    successorQuestId: null,
    terminalReason: null,
    cost: pressureSeedCost(params.pressure.intensity),
    hookType: archetypeHookType(params.pressure.archetype),
    mutationCount: 0,
    lastMutationAtIso: null,
    stallCount: 0,
  };
}

function hasExistingSuccessor(quests: QuestState[], parentQuestId: string): boolean {
  return quests.some((quest) => quest.parentQuestId === parentQuestId && quest.lifecycle !== "archived");
}

function canMutateToSuccessor(params: {
  quest: QuestState;
  quests: QuestState[];
  nowIso: string;
  pressureIntensity: number;
}): boolean {
  if (params.quest.mutationCount >= MAX_SUCCESSOR_MUTATION_COUNT) {
    return false;
  }
  if (params.quest.successorQuestId) {
    return false;
  }
  if (hasExistingSuccessor(params.quests, params.quest.questId)) {
    return false;
  }
  if (params.pressureIntensity < 58) {
    return false;
  }
  const sinceMutation = elapsedSec(params.quest.lastMutationAtIso, params.nowIso);
  if (sinceMutation > 0 && sinceMutation < SUCCESSOR_COOLDOWN_SEC) {
    return false;
  }
  return true;
}

function enforceHardLiveCap(params: {
  quests: QuestState[];
  caps: QuestBudgetState["caps"];
  nowIso: string;
  acc: TransitionAccumulator;
}): boolean {
  let budgetBlocked = false;
  while (computeBudgetUsed(params.quests).livePool > params.caps.livePool) {
    const candidate = params.quests
      .filter((quest) => (quest.lifecycle === "surfaced" || quest.lifecycle === "seed") && !quest.startedAtIso)
      .sort((a, b) => a.urgency - b.urgency || scoreIsoDesc(b.lastAdvancedAtIso, a.lastAdvancedAtIso))[0];

    if (candidate) {
      setLifecycle({
        quest: candidate,
        to: "deleted",
        reason: "budget_evicted",
        nowIso: params.nowIso,
        acc: params.acc,
      });
      budgetBlocked = true;
      continue;
    }

    const startedCandidate = params.quests
      .filter((quest) => (quest.lifecycle === "active" || quest.lifecycle === "stalled") && quest.startedAtIso)
      .sort((a, b) => a.progress - b.progress || a.urgency - b.urgency || scoreIsoDesc(b.lastAdvancedAtIso, a.lastAdvancedAtIso))[0];

    if (!startedCandidate) {
      break;
    }

    setLifecycle({
      quest: startedCandidate,
      to: "failed",
      reason: "budget_overflow_failed",
      nowIso: params.nowIso,
      acc: params.acc,
    });
    budgetBlocked = true;
  }
  return budgetBlocked;
}

export function runQuestEconomyTick(input: QuestEconomyTickInput): QuestEconomyTickResult {
  const nowIso = isoNowOrFallback(input.nowIso);
  let state = ensureQuestEconomyState(input.economy, nowIso);

  let severeQuotaBlocks = 0;
  let spawnedSeeds = 0;

  const transitions: TransitionAccumulator = {
    transitions: [],
    expiredDeleted: 0,
    failedNow: 0,
    mutatedNow: 0,
    archivedNow: 0,
    surfacedNow: 0,
  };

  const pressures = state.worldPressures.slice();
  let pressureAdvancedCount = 0;

  for (let index = 0; index < pressures.length; index += 1) {
    const pressure = pressures[index] as WorldPressureState;
    const elapsed = elapsedSec(pressure.lastAdvancedAtIso, nowIso);
    if (elapsed < pressure.cadenceSec && input.deltaTimeSec < pressure.cadenceSec) {
      continue;
    }

    const delta = pressureAdvanceDelta({
      pressure,
      signal: input.temporalSignal,
    });
    const nextIntensity = clampInt(pressure.intensity + delta, 0, 100);
    const nextMomentum = adjustMomentum(pressure.momentum, delta);

    const targetLocations = pressure.targetLocations.slice();
    if (input.locationId && nextIntensity >= 52 && !targetLocations.includes(input.locationId)) {
      targetLocations.push(input.locationId);
    }

    pressures[index] = {
      ...pressure,
      intensity: nextIntensity,
      momentum: nextMomentum,
      targetLocations: uniqStrings(targetLocations, MAX_TARGET_LOCATIONS),
      lastAdvancedAtIso: nowIso,
    };
    pressureAdvancedCount += 1;
  }

  state = {
    ...state,
    worldPressures: pressures,
  };

  const pressureById = new Map(state.worldPressures.map((pressure) => [pressure.pressureId, pressure]));
  const quests = state.quests.map((quest) => ({ ...quest, cost: { ...quest.cost } }));

  // urgency drift
  for (const quest of quests) {
    if (!isLiveLifecycle(quest.lifecycle)) {
      continue;
    }
    const drift = urgencyDrift({
      quest,
      pressure: pressureById.get(quest.pressureId),
      signal: input.temporalSignal,
      nowIso,
    });
    quest.urgency = clampInt(quest.urgency + drift, 0, 100);
    quest.lastAdvancedAtIso = nowIso;
  }

  // pre-start expiration (seed/surfaced only)
  for (const quest of quests) {
    if ((quest.lifecycle !== "seed" && quest.lifecycle !== "surfaced") || quest.startedAtIso) {
      continue;
    }
    const expiresAt = readIsoMillis(quest.expiresAtIso);
    const nowMs = readIsoMillis(nowIso);
    const expires = Number.isFinite(expiresAt) && Number.isFinite(nowMs) && expiresAt <= nowMs;
    if (!expires) {
      continue;
    }
    setLifecycle({
      quest,
      to: "deleted",
      reason: choosePrestartDeleteReason({
        pressure: pressureById.get(quest.pressureId),
        signal: input.temporalSignal,
      }),
      nowIso,
      acc: transitions,
    });
  }

  // surfaced -> active engagement (deterministic, analyzer-independent)
  if (shouldTryStart(input.actionId, input.classification)) {
    const surfacedCandidates = quests
      .filter((quest) => quest.lifecycle === "surfaced")
      .filter((quest) => (input.locationId ? quest.locationId === input.locationId || quest.locationId === null : true))
      .sort((a, b) => b.urgency - a.urgency || scoreIsoDesc(a.lastAdvancedAtIso, b.lastAdvancedAtIso));

    const candidate = surfacedCandidates[0];
    if (candidate && canActivateQuest({ quests, caps: state.budget.caps, quest: candidate })) {
      setLifecycle({
        quest: candidate,
        to: "active",
        reason: "player_engaged",
        nowIso,
        acc: transitions,
      });
      candidate.deadlineAtIso = addSecondsToIso(nowIso, deadlineSecondsFromUrgency(candidate.urgency));
    }
  }

  // progress/stall handling on focused started quest
  const focusQuest = quests
    .filter((quest) => quest.lifecycle === "active" || quest.lifecycle === "stalled")
    .filter((quest) => (input.locationId ? quest.locationId === input.locationId || quest.locationId === null : true))
    .sort((a, b) => b.urgency - a.urgency || scoreIsoDesc(a.lastAdvancedAtIso, b.lastAdvancedAtIso))[0];

  if (focusQuest) {
    const delta = progressDelta({
      actionId: input.actionId,
      classification: input.classification,
      signal: input.temporalSignal,
    });

    if (delta > 0) {
      focusQuest.progress = clampInt(focusQuest.progress + delta, 0, 100);
      focusQuest.urgency = clampInt(
        focusQuest.urgency + (input.classification === "reckless" ? 6 : -2) + Math.round(input.temporalSignal.residualTraceHeat / 40),
        0,
        100,
      );
      if (focusQuest.lifecycle === "stalled" && input.actionId !== "action.wait") {
        setLifecycle({
          quest: focusQuest,
          to: "active",
          reason: "reengaged",
          nowIso,
          acc: transitions,
        });
      }
    } else if (input.classification === "currently_impossible" || input.classification === "impossible") {
      if (focusQuest.lifecycle === "active" && input.actionId !== "action.wait") {
        setLifecycle({
          quest: focusQuest,
          to: "stalled",
          reason: "blocked_progress",
          nowIso,
          acc: transitions,
        });
      }
      focusQuest.stallCount = clampInt(focusQuest.stallCount + 1, 0, 99);
      focusQuest.urgency = clampInt(focusQuest.urgency + 4, 0, 100);
    }

    if (focusQuest.progress >= 100 && (focusQuest.lifecycle === "active" || focusQuest.lifecycle === "stalled")) {
      setLifecycle({
        quest: focusQuest,
        to: "resolved",
        reason: "objective_completed",
        nowIso,
        acc: transitions,
      });
    }
  }

  // overdue started quest -> failed or mutated+successor (no hard delete)
  for (const quest of quests) {
    if (quest.lifecycle !== "active" && quest.lifecycle !== "stalled") {
      continue;
    }
    const deadline = readIsoMillis(quest.deadlineAtIso);
    const nowMs = readIsoMillis(nowIso);
    if (!Number.isFinite(deadline) || !Number.isFinite(nowMs) || deadline > nowMs) {
      continue;
    }

    const pressure = pressureById.get(quest.pressureId);
    const pressureIntensity = pressure?.intensity ?? 45;
    const mutate = canMutateToSuccessor({
      quest,
      quests,
      nowIso,
      pressureIntensity,
    });

    if (mutate) {
      const successorId = `quest-${String(state.nextQuestSeq).padStart(4, "0")}`;
      state = {
        ...state,
        nextQuestSeq: state.nextQuestSeq + 1,
      };

      quest.mutationCount = clampInt(quest.mutationCount + 1, 0, 12);
      quest.lastMutationAtIso = nowIso;
      quest.successorQuestId = successorId;
      setLifecycle({
        quest,
        to: "failed",
        reason: "mutated_to_successor",
        nowIso,
        acc: transitions,
      });

      const successor: QuestState = {
        questId: successorId,
        pressureId: quest.pressureId,
        archetype: quest.archetype,
        lifecycle: "surfaced",
        locationId: quest.locationId,
        urgency: clampInt(quest.urgency + 12, 0, 100),
        progress: 0,
        surfacedAtIso: nowIso,
        startedAtIso: null,
        deadlineAtIso: null,
        expiresAtIso: addSecondsToIso(nowIso, SURFACED_EXPIRES_SEC),
        lastAdvancedAtIso: nowIso,
        parentQuestId: quest.questId,
        successorQuestId: null,
        terminalReason: null,
        cost: { ...quest.cost },
        hookType: quest.hookType,
        mutationCount: quest.mutationCount,
        lastMutationAtIso: nowIso,
        stallCount: 0,
      };
      quests.push(successor);
      transitions.mutatedNow += 1;
      continue;
    }

    setLifecycle({
      quest,
      to: "failed",
      reason: "overdue_failed",
      nowIso,
      acc: transitions,
    });
  }

  // seed spawn from world pressure (bounded)
  const orderedPressures = state.worldPressures
    .slice()
    .sort((a, b) => b.intensity - a.intensity || b.momentum - a.momentum || a.pressureId.localeCompare(b.pressureId));

  for (const pressure of orderedPressures) {
    if (spawnedSeeds >= 1) {
      break;
    }
    if (pressure.intensity < 52) {
      continue;
    }
    const sinceSeed = elapsedSec(pressure.lastSeededAtIso, nowIso);
    if (sinceSeed > 0 && sinceSeed < Math.max(120, Math.floor(pressure.cadenceSec * 0.7))) {
      continue;
    }

    const locationId = input.locationId ?? pressure.targetLocations[0] ?? null;
    const quota = quotaPenalty({
      quests,
      locationId,
      pressureId: pressure.pressureId,
      archetype: pressure.archetype,
      caps: state.softQuota.caps,
    });
    if (quota.severe) {
      severeQuotaBlocks += 1;
      continue;
    }

    const score =
      pressure.intensity +
      Math.round(input.temporalSignal.locationTension * 0.24) +
      Math.round(input.temporalSignal.residualTraceHeat * 0.18) +
      Math.round(input.temporalSignal.incidentCount * 1.8) -
      quota.penalty;
    if (score < 74) {
      continue;
    }

    const cost = pressureSeedCost(pressure.intensity);
    if (!canAllocateSeed({ quests, caps: state.budget.caps, cost })) {
      continue;
    }

    const questId = `quest-${String(state.nextQuestSeq).padStart(4, "0")}`;
    state = {
      ...state,
      nextQuestSeq: state.nextQuestSeq + 1,
      worldPressures: state.worldPressures.map((entry) =>
        entry.pressureId === pressure.pressureId
          ? {
              ...entry,
              lastSeededAtIso: nowIso,
            }
          : entry,
      ),
    };

    quests.push(
      createSeedQuest({
        questId,
        pressure,
        locationId,
        nowIso,
        urgency: Math.round(score * 0.72),
      }),
    );
    spawnedSeeds += 1;
  }

  // seed -> surfaced
  const seedCandidates = quests
    .filter((quest) => quest.lifecycle === "seed")
    .sort((a, b) => b.urgency - a.urgency || scoreIsoDesc(a.lastAdvancedAtIso, b.lastAdvancedAtIso));
  let surfacedThisTick = 0;
  for (const quest of seedCandidates) {
    if (surfacedThisTick >= 2) {
      break;
    }

    const pressure = pressureById.get(quest.pressureId);
    const quota = quotaPenalty({
      quests,
      locationId: quest.locationId,
      pressureId: quest.pressureId,
      archetype: quest.archetype,
      caps: state.softQuota.caps,
    });
    if (quota.severe) {
      severeQuotaBlocks += 1;
      continue;
    }

    const pressureInfluence = pressure ? Math.round(pressure.intensity / 4) : 10;
    const surfaceScore = quest.urgency + pressureInfluence + Math.round(input.temporalSignal.locationTension / 5) - quota.penalty;
    if (surfaceScore < 78) {
      continue;
    }
    if (!canSurfaceSeed({ quests, caps: state.budget.caps, seed: quest })) {
      continue;
    }

    setLifecycle({
      quest,
      to: "surfaced",
      reason: "surfaced_from_seed",
      nowIso,
      acc: transitions,
    });
    surfacedThisTick += 1;
  }

  // terminal -> archived retention
  for (const quest of quests) {
    if (!isTerminalLifecycle(quest.lifecycle)) {
      continue;
    }
    if (elapsedSec(quest.lastAdvancedAtIso, nowIso) < TERMINAL_ARCHIVE_RETENTION_SEC) {
      continue;
    }
    setLifecycle({
      quest,
      to: "archived",
      reason: "retention_elapsed",
      nowIso,
      acc: transitions,
    });
  }

  const budgetBlocked = enforceHardLiveCap({
    quests,
    caps: state.budget.caps,
    nowIso,
    acc: transitions,
  });

  state = {
    ...state,
    quests,
  };
  state = pruneEconomy(state);
  state = recalculateBudgetAndQuota(state);

  const qualitative = buildQuestEconomyQualitativeSummary({
    economy: state,
    locationId: input.locationId,
  });

  const summary: QuestEconomyTickSummary = {
    pressureAdvancedCount,
    pressureTop: qualitative.topPressure,
    transitionCount: transitions.transitions.length,
    transitions: transitions.transitions,
    spawnedSeeds,
    surfacedNow: transitions.surfacedNow,
    expiredDeleted: transitions.expiredDeleted,
    failedNow: transitions.failedNow,
    mutatedNow: transitions.mutatedNow,
    archivedNow: transitions.archivedNow,
    budget: state.budget,
    softQuota: state.softQuota,
    qualitative,
    debug: {
      severeQuotaBlocks,
      budgetBlocked,
    },
  };

  return {
    nextEconomy: state,
    summary,
  };
}
