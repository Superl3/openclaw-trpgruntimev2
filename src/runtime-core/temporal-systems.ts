import type { ActionFeasibility, DeterministicActionId, OngoingActionState } from "./scene-loop.js";

export type ResidualTraceType = "noise" | "alarm" | "opened_path" | "witness" | "disorder";

export type LocationTemporalState = {
  locationId: string;
  tension: number;
  alertness: number;
  accessibility: number;
  recentIncidents: string[];
  lastVisitedAtIso: string | null;
  lastUpdatedAtIso: string;
};

export type NpcMemoryEmotionalResidue = "neutral" | "friendly" | "tense" | "hostile";

export type NpcMemoryState = {
  npcId: string;
  locationId: string | null;
  familiarity: number;
  sentiment: number;
  emotionalResidue: NpcMemoryEmotionalResidue;
  lastSeenAtIso: string | null;
  impressionTags: string[];
  lastUpdatedAtIso: string;
};

export type InfoFreshnessSourceType = "observation" | "dialogue" | "rumor" | "witness";

export type InfoFreshnessState = {
  clueId: string;
  locationId: string | null;
  sourceType: InfoFreshnessSourceType;
  freshness: number;
  discoveredAtIso: string;
  lastUpdatedAtIso: string;
};

export type ResidualTraceState = {
  traceType: ResidualTraceType;
  locationId: string | null;
  intensity: number;
  createdAtIso: string;
  lastUpdatedAtIso: string;
};

export type TemporalRuntimeState = {
  version: 1;
  locationStates: LocationTemporalState[];
  npcMemory: NpcMemoryState[];
  infoFreshness: InfoFreshnessState[];
  residualTraces: ResidualTraceState[];
};

export type TemporalLocationProjection = {
  locationId: string;
  tension: number;
  alertness: number;
  accessibility: number;
  recentIncidents: string[];
};

export type TemporalQualitativeSummary = {
  memory: string;
  traces: string;
  freshness: string;
  location: string;
  debug: {
    locationId: string | null;
    memoryCount: number;
    maxFamiliarity: number;
    maxFreshness: number;
    activeTraceCount: number;
    maxTraceIntensity: number;
    locationState: {
      tension: number;
      alertness: number;
      accessibility: number;
    } | null;
  };
};

export type TemporalUpdateSummary = {
  deltaTimeSec: number;
  locationId: string | null;
  memoryTouched: number;
  memoryDecayed: number;
  freshnessUpdated: number;
  freshnessDecayed: number;
  tracesCreated: number;
  tracesUpdated: number;
  tracesDecayed: number;
  tracesExpired: number;
  locationShifted: boolean;
  locationSnapshot: {
    tension: number;
    alertness: number;
    accessibility: number;
  } | null;
  qualitative: {
    memory: string;
    traces: string;
    freshness: string;
    location: string;
  };
};

export type QuestTemporalSignal = {
  locationId: string | null;
  locationTension: number;
  locationAlertness: number;
  locationAccessibility: number;
  infoFreshness: number;
  memoryFamiliarity: number;
  residualTraceHeat: number;
  incidentCount: number;
};

export type TemporalPipelineInput = {
  temporal: TemporalRuntimeState | null | undefined;
  sceneId: string;
  locationId: string | null;
  actionId: DeterministicActionId;
  classification: ActionFeasibility;
  deltaTimeSec: number;
  nowIso: string;
  ongoingAction: OngoingActionState | null;
};

export type TemporalPipelineResult = {
  nextTemporal: TemporalRuntimeState;
  projection: TemporalLocationProjection | null;
  summary: TemporalUpdateSummary;
};

export type TemporalBootstrapInput = {
  locationBaselines?: Array<{
    locationId: string;
    tension: number;
    alertness: number;
    accessibility: number;
    recentIncidents?: string[];
  }>;
};

const MAX_LOCATION_STATES = 12;
const MAX_NPC_MEMORY = 24;
const MAX_INFO_FRESHNESS = 32;
const MAX_RESIDUAL_TRACES = 40;
const MAX_INCIDENTS_PER_LOCATION = 6;
const MAX_IMPRESSION_TAGS = 6;

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

function normalizeLocationId(value: unknown): string | null {
  const normalized = readString(value);
  return normalized || null;
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

function scoreIsoDesc(a: string | null, b: string | null): number {
  const aMs = readIsoMillis(a);
  const bMs = readIsoMillis(b);
  const safeA = Number.isFinite(aMs) ? aMs : 0;
  const safeB = Number.isFinite(bMs) ? bMs : 0;
  return safeB - safeA;
}

function decayToward(value: number, target: number, step: number): number {
  const clampedStep = Math.max(0, step);
  if (value > target) {
    return Math.max(target, value - clampedStep);
  }
  if (value < target) {
    return Math.min(target, value + clampedStep);
  }
  return value;
}

function classifyResidue(sentiment: number): NpcMemoryEmotionalResidue {
  if (sentiment >= 25) {
    return "friendly";
  }
  if (sentiment <= -45) {
    return "hostile";
  }
  if (sentiment <= -10) {
    return "tense";
  }
  return "neutral";
}

function normalizeLocationTemporalState(value: unknown, nowIso: string): LocationTemporalState | null {
  const node = toRecord(value);
  const locationId = normalizeLocationId(node.locationId);
  if (!locationId) {
    return null;
  }

  const incidents = Array.isArray(node.recentIncidents)
    ? uniqStrings(
        node.recentIncidents.filter((entry): entry is string => typeof entry === "string"),
        MAX_INCIDENTS_PER_LOCATION,
      )
    : [];

  return {
    locationId,
    tension: clampInt(readInt(node.tension, 35), 0, 100),
    alertness: clampInt(readInt(node.alertness, 30), 0, 100),
    accessibility: clampInt(readInt(node.accessibility, 70), 0, 100),
    recentIncidents: incidents,
    lastVisitedAtIso: normalizeLocationId(node.lastVisitedAtIso),
    lastUpdatedAtIso: readIsoString(node.lastUpdatedAtIso, nowIso),
  };
}

function normalizeLocationBaseline(value: unknown, nowIso: string): LocationTemporalState | null {
  const node = toRecord(value);
  const locationId = normalizeLocationId(node.locationId);
  if (!locationId) {
    return null;
  }
  const recentIncidents = Array.isArray(node.recentIncidents)
    ? uniqStrings(node.recentIncidents.filter((entry): entry is string => typeof entry === "string"), MAX_INCIDENTS_PER_LOCATION)
    : [];
  return {
    locationId,
    tension: clampInt(readInt(node.tension, 35), 0, 100),
    alertness: clampInt(readInt(node.alertness, 30), 0, 100),
    accessibility: clampInt(readInt(node.accessibility, 70), 0, 100),
    recentIncidents,
    lastVisitedAtIso: null,
    lastUpdatedAtIso: nowIso,
  };
}

function normalizeBootstrapLocationStates(value: TemporalBootstrapInput["locationBaselines"], nowIso: string): LocationTemporalState[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = value
    .map((entry) => normalizeLocationBaseline(entry, nowIso))
    .filter((entry): entry is LocationTemporalState => entry !== null);
  if (normalized.length === 0) {
    return [];
  }
  const dedup = new Map<string, LocationTemporalState>();
  for (const location of normalized) {
    dedup.set(location.locationId, location);
  }
  return Array.from(dedup.values()).slice(0, MAX_LOCATION_STATES);
}

function normalizeNpcMemoryState(value: unknown, nowIso: string): NpcMemoryState | null {
  const node = toRecord(value);
  const npcId = readString(node.npcId);
  if (!npcId) {
    return null;
  }

  const sentiment = clampInt(readInt(node.sentiment, 0), -100, 100);
  const fallbackResidue = classifyResidue(sentiment);
  const residueRaw = readString(node.emotionalResidue);
  const emotionalResidue: NpcMemoryEmotionalResidue =
    residueRaw === "friendly" || residueRaw === "tense" || residueRaw === "hostile" || residueRaw === "neutral"
      ? residueRaw
      : fallbackResidue;

  const impressionTags = Array.isArray(node.impressionTags)
    ? uniqStrings(node.impressionTags.filter((entry): entry is string => typeof entry === "string"), MAX_IMPRESSION_TAGS)
    : [];

  return {
    npcId,
    locationId: normalizeLocationId(node.locationId),
    familiarity: clampInt(readInt(node.familiarity, 0), 0, 100),
    sentiment,
    emotionalResidue,
    lastSeenAtIso: normalizeLocationId(node.lastSeenAtIso),
    impressionTags,
    lastUpdatedAtIso: readIsoString(node.lastUpdatedAtIso, nowIso),
  };
}

function normalizeInfoFreshnessState(value: unknown, nowIso: string): InfoFreshnessState | null {
  const node = toRecord(value);
  const clueId = readString(node.clueId);
  if (!clueId) {
    return null;
  }

  const sourceRaw = readString(node.sourceType);
  const sourceType: InfoFreshnessSourceType =
    sourceRaw === "dialogue" || sourceRaw === "rumor" || sourceRaw === "witness" ? sourceRaw : "observation";

  const discoveredAtIso = readIsoString(node.discoveredAtIso, nowIso);

  return {
    clueId,
    locationId: normalizeLocationId(node.locationId),
    sourceType,
    freshness: clampInt(readInt(node.freshness, 0), 0, 100),
    discoveredAtIso,
    lastUpdatedAtIso: readIsoString(node.lastUpdatedAtIso, discoveredAtIso),
  };
}

function normalizeResidualTraceState(value: unknown, nowIso: string): ResidualTraceState | null {
  const node = toRecord(value);
  const traceTypeRaw = readString(node.traceType);
  const traceType: ResidualTraceType | null =
    traceTypeRaw === "noise" ||
    traceTypeRaw === "alarm" ||
    traceTypeRaw === "opened_path" ||
    traceTypeRaw === "witness" ||
    traceTypeRaw === "disorder"
      ? traceTypeRaw
      : null;

  if (!traceType) {
    return null;
  }

  const intensity = clampInt(readInt(node.intensity, 0), 0, 100);
  if (intensity <= 0) {
    return null;
  }

  const createdAtIso = readIsoString(node.createdAtIso, nowIso);

  return {
    traceType,
    locationId: normalizeLocationId(node.locationId),
    intensity,
    createdAtIso,
    lastUpdatedAtIso: readIsoString(node.lastUpdatedAtIso, createdAtIso),
  };
}

function pruneTemporalState(state: TemporalRuntimeState): TemporalRuntimeState {
  const locationStates = state.locationStates
    .slice()
    .sort((a, b) => scoreIsoDesc(a.lastUpdatedAtIso, b.lastUpdatedAtIso))
    .slice(0, MAX_LOCATION_STATES);

  const npcMemory = state.npcMemory
    .slice()
    .sort((a, b) => {
      const aScore = a.familiarity + Math.abs(a.sentiment);
      const bScore = b.familiarity + Math.abs(b.sentiment);
      if (aScore !== bScore) {
        return bScore - aScore;
      }
      return scoreIsoDesc(a.lastUpdatedAtIso, b.lastUpdatedAtIso);
    })
    .slice(0, MAX_NPC_MEMORY);

  const infoFreshness = state.infoFreshness
    .slice()
    .sort((a, b) => scoreIsoDesc(a.lastUpdatedAtIso, b.lastUpdatedAtIso))
    .slice(0, MAX_INFO_FRESHNESS);

  const residualTraces = state.residualTraces
    .slice()
    .sort((a, b) => {
      if (a.intensity !== b.intensity) {
        return b.intensity - a.intensity;
      }
      return scoreIsoDesc(a.lastUpdatedAtIso, b.lastUpdatedAtIso);
    })
    .slice(0, MAX_RESIDUAL_TRACES);

  return {
    version: 1,
    locationStates,
    npcMemory,
    infoFreshness,
    residualTraces,
  };
}

export function ensureTemporalRuntimeState(
  value: unknown,
  nowIso: string,
  bootstrap?: TemporalBootstrapInput,
): TemporalRuntimeState {
  const root = toRecord(value);
  const locationStatesRaw = Array.isArray(root.locationStates) ? root.locationStates : [];
  const npcMemoryRaw = Array.isArray(root.npcMemory) ? root.npcMemory : [];
  const infoFreshnessRaw = Array.isArray(root.infoFreshness) ? root.infoFreshness : [];
  const residualTracesRaw = Array.isArray(root.residualTraces) ? root.residualTraces : [];
  const bootstrapLocationStates = normalizeBootstrapLocationStates(bootstrap?.locationBaselines, nowIso);

  const normalized: TemporalRuntimeState = {
    version: 1,
    locationStates:
      locationStatesRaw.length > 0
        ? locationStatesRaw
            .map((entry) => normalizeLocationTemporalState(entry, nowIso))
            .filter((entry): entry is LocationTemporalState => entry !== null)
        : bootstrapLocationStates,
    npcMemory: npcMemoryRaw
      .map((entry) => normalizeNpcMemoryState(entry, nowIso))
      .filter((entry): entry is NpcMemoryState => entry !== null),
    infoFreshness: infoFreshnessRaw
      .map((entry) => normalizeInfoFreshnessState(entry, nowIso))
      .filter((entry): entry is InfoFreshnessState => entry !== null),
    residualTraces: residualTracesRaw
      .map((entry) => normalizeResidualTraceState(entry, nowIso))
      .filter((entry): entry is ResidualTraceState => entry !== null),
  };

  return pruneTemporalState(normalized);
}

type DecayResult = {
  nextTemporal: TemporalRuntimeState;
  memoryDecayed: number;
  freshnessDecayed: number;
  tracesDecayed: number;
  tracesExpired: number;
};

function applyTemporalDecay(params: {
  temporal: TemporalRuntimeState;
  deltaTimeSec: number;
  nowIso: string;
}): DecayResult {
  const deltaSec = Math.max(0, Math.trunc(params.deltaTimeSec));
  const familiarityStep = Math.max(1, Math.round(deltaSec / 120));
  const sentimentStep = Math.max(1, Math.round(deltaSec / 180));
  const freshnessStep = Math.max(1, Math.round(deltaSec / 90));
  const locationDriftStep = Math.max(1, Math.round(deltaSec / 220));

  let memoryDecayed = 0;
  let freshnessDecayed = 0;
  let tracesDecayed = 0;
  let tracesExpired = 0;

  const npcMemory = params.temporal.npcMemory.map((entry) => {
    const familiarity = clampInt(entry.familiarity - familiarityStep, 0, 100);
    const sentiment = clampInt(decayToward(entry.sentiment, 0, sentimentStep), -100, 100);
    const emotionalResidue = classifyResidue(sentiment);
    const changed = familiarity !== entry.familiarity || sentiment !== entry.sentiment;
    if (changed) {
      memoryDecayed += 1;
    }
    return {
      ...entry,
      familiarity,
      sentiment,
      emotionalResidue,
      lastUpdatedAtIso: changed ? params.nowIso : entry.lastUpdatedAtIso,
    };
  });

  const infoFreshness = params.temporal.infoFreshness.map((entry) => {
    const freshness = clampInt(entry.freshness - freshnessStep, 0, 100);
    if (freshness !== entry.freshness) {
      freshnessDecayed += 1;
    }
    return {
      ...entry,
      freshness,
      lastUpdatedAtIso: freshness !== entry.freshness ? params.nowIso : entry.lastUpdatedAtIso,
    };
  });

  const traceDecayPerType: Record<ResidualTraceType, number> = {
    noise: Math.max(1, Math.round(deltaSec / 40)),
    alarm: Math.max(1, Math.round(deltaSec / 55)),
    opened_path: Math.max(1, Math.round(deltaSec / 80)),
    witness: Math.max(1, Math.round(deltaSec / 70)),
    disorder: Math.max(1, Math.round(deltaSec / 95)),
  };

  const residualTraces: ResidualTraceState[] = [];
  for (const entry of params.temporal.residualTraces) {
    const decay = traceDecayPerType[entry.traceType];
    const intensity = clampInt(entry.intensity - decay, 0, 100);
    if (intensity !== entry.intensity) {
      tracesDecayed += 1;
    }
    if (intensity <= 3) {
      tracesExpired += 1;
      continue;
    }
    residualTraces.push({
      ...entry,
      intensity,
      lastUpdatedAtIso: intensity !== entry.intensity ? params.nowIso : entry.lastUpdatedAtIso,
    });
  }

  const locationStates = params.temporal.locationStates.map((entry) => ({
    ...entry,
    tension: clampInt(decayToward(entry.tension, 35, locationDriftStep), 0, 100),
    alertness: clampInt(decayToward(entry.alertness, 30, locationDriftStep), 0, 100),
    accessibility: clampInt(decayToward(entry.accessibility, 70, locationDriftStep), 0, 100),
    lastUpdatedAtIso: params.nowIso,
  }));

  return {
    nextTemporal: pruneTemporalState({
      version: 1,
      locationStates,
      npcMemory,
      infoFreshness,
      residualTraces,
    }),
    memoryDecayed,
    freshnessDecayed,
    tracesDecayed,
    tracesExpired,
  };
}

type FootprintResult = {
  nextTemporal: TemporalRuntimeState;
  memoryTouched: number;
  freshnessUpdated: number;
  tracesCreated: number;
  tracesUpdated: number;
  incidentNotes: string[];
};

function traceIncidentLabel(traceType: ResidualTraceType): string {
  switch (traceType) {
    case "noise":
      return "noise footprint";
    case "alarm":
      return "alarm pressure";
    case "opened_path":
      return "path opened";
    case "witness":
      return "witness chatter";
    case "disorder":
      return "local disorder";
    default:
      return "trace updated";
  }
}

function upsertResidualTrace(params: {
  traces: ResidualTraceState[];
  traceType: ResidualTraceType;
  locationId: string | null;
  amount: number;
  nowIso: string;
}): { traces: ResidualTraceState[]; created: boolean; updated: boolean } {
  const amount = clampInt(params.amount, 0, 100);
  if (amount <= 0) {
    return {
      traces: params.traces,
      created: false,
      updated: false,
    };
  }

  const index = params.traces.findIndex(
    (entry) => entry.traceType === params.traceType && entry.locationId === params.locationId,
  );
  if (index < 0) {
    return {
      traces: [
        ...params.traces,
        {
          traceType: params.traceType,
          locationId: params.locationId,
          intensity: amount,
          createdAtIso: params.nowIso,
          lastUpdatedAtIso: params.nowIso,
        },
      ],
      created: true,
      updated: false,
    };
  }

  const target = params.traces[index] as ResidualTraceState;
  const nextIntensity = clampInt(target.intensity + amount, 0, 100);
  if (nextIntensity === target.intensity) {
    return {
      traces: params.traces,
      created: false,
      updated: false,
    };
  }

  const nextTraces = params.traces.slice();
  nextTraces[index] = {
    ...target,
    intensity: nextIntensity,
    lastUpdatedAtIso: params.nowIso,
  };

  return {
    traces: nextTraces,
    created: false,
    updated: true,
  };
}

function upsertInfoFreshness(params: {
  freshness: InfoFreshnessState[];
  clueId: string;
  locationId: string | null;
  sourceType: InfoFreshnessSourceType;
  amount: number;
  nowIso: string;
}): InfoFreshnessState[] {
  const index = params.freshness.findIndex((entry) => entry.clueId === params.clueId);
  if (index < 0) {
    return [
      ...params.freshness,
      {
        clueId: params.clueId,
        locationId: params.locationId,
        sourceType: params.sourceType,
        freshness: clampInt(params.amount, 0, 100),
        discoveredAtIso: params.nowIso,
        lastUpdatedAtIso: params.nowIso,
      },
    ];
  }

  const current = params.freshness[index] as InfoFreshnessState;
  const next = params.freshness.slice();
  next[index] = {
    ...current,
    locationId: params.locationId,
    sourceType: params.sourceType,
    freshness: clampInt(current.freshness + params.amount, 0, 100),
    lastUpdatedAtIso: params.nowIso,
  };
  return next;
}

function upsertNpcMemory(params: {
  memory: NpcMemoryState[];
  npcId: string;
  locationId: string | null;
  familiarityDelta: number;
  sentimentDelta: number;
  nowIso: string;
  tags: string[];
}): NpcMemoryState[] {
  const index = params.memory.findIndex(
    (entry) => entry.npcId === params.npcId && entry.locationId === params.locationId,
  );
  if (index < 0) {
    const sentiment = clampInt(params.sentimentDelta, -100, 100);
    return [
      ...params.memory,
      {
        npcId: params.npcId,
        locationId: params.locationId,
        familiarity: clampInt(params.familiarityDelta, 0, 100),
        sentiment,
        emotionalResidue: classifyResidue(sentiment),
        lastSeenAtIso: params.nowIso,
        impressionTags: uniqStrings(params.tags, MAX_IMPRESSION_TAGS),
        lastUpdatedAtIso: params.nowIso,
      },
    ];
  }

  const current = params.memory[index] as NpcMemoryState;
  const familiarity = clampInt(current.familiarity + params.familiarityDelta, 0, 100);
  const sentiment = clampInt(current.sentiment + params.sentimentDelta, -100, 100);
  const tags = uniqStrings([...current.impressionTags, ...params.tags], MAX_IMPRESSION_TAGS);
  const next = params.memory.slice();
  next[index] = {
    ...current,
    familiarity,
    sentiment,
    emotionalResidue: classifyResidue(sentiment),
    lastSeenAtIso: params.nowIso,
    impressionTags: tags,
    lastUpdatedAtIso: params.nowIso,
  };
  return next;
}

function applyActionFootprint(params: {
  temporal: TemporalRuntimeState;
  sceneId: string;
  locationId: string | null;
  actionId: DeterministicActionId;
  classification: ActionFeasibility;
  nowIso: string;
  ongoingAction: OngoingActionState | null;
}): FootprintResult {
  let traces = params.temporal.residualTraces.slice();
  let npcMemory = params.temporal.npcMemory.slice();
  let infoFreshness = params.temporal.infoFreshness.slice();

  let memoryTouched = 0;
  let freshnessUpdated = 0;
  let tracesCreated = 0;
  let tracesUpdated = 0;

  const incidentNotes: string[] = [];

  const addTrace = (traceType: ResidualTraceType, amount: number) => {
    const result = upsertResidualTrace({
      traces,
      traceType,
      locationId: params.locationId,
      amount,
      nowIso: params.nowIso,
    });
    traces = result.traces;
    if (result.created) {
      tracesCreated += 1;
      incidentNotes.push(traceIncidentLabel(traceType));
    } else if (result.updated) {
      tracesUpdated += 1;
      incidentNotes.push(traceIncidentLabel(traceType));
    }
  };

  const actionSucceeded = params.classification === "possible" || params.classification === "reckless";

  if (params.actionId === "action.rush") {
    const riskyScale = params.classification === "reckless" ? 1 : actionSucceeded ? 0.7 : 0.4;
    addTrace("noise", Math.round(24 * riskyScale));
    addTrace("alarm", Math.round(20 * riskyScale));
    addTrace("disorder", Math.round(16 * riskyScale));
    addTrace("witness", Math.round(10 * riskyScale));
  }

  if (params.actionId === "action.move") {
    const moveScale = actionSucceeded ? 1 : 0.4;
    addTrace("opened_path", Math.round(14 * moveScale));
    addTrace("noise", Math.round(7 * moveScale));
  }

  if (params.actionId === "action.observe") {
    const clueId = params.locationId
      ? `clue:${params.locationId}:observation`
      : `clue:scene:${params.sceneId}:observation`;
    infoFreshness = upsertInfoFreshness({
      freshness: infoFreshness,
      clueId,
      locationId: params.locationId,
      sourceType: "observation",
      amount: actionSucceeded ? 28 : 12,
      nowIso: params.nowIso,
    });
    freshnessUpdated += 1;
  }

  if (params.actionId === "action.talk" && actionSucceeded) {
    const npcId = params.locationId ? `npc:${params.locationId}:ambient` : "npc:ambient";
    npcMemory = upsertNpcMemory({
      memory: npcMemory,
      npcId,
      locationId: params.locationId,
      familiarityDelta: params.classification === "reckless" ? 8 : 14,
      sentimentDelta: params.classification === "reckless" ? -5 : 9,
      nowIso: params.nowIso,
      tags: params.classification === "reckless" ? ["contact", "tense"] : ["contact", "cooperative"],
    });
    memoryTouched += 1;

    const clueId = params.locationId ? `clue:${params.locationId}:dialogue` : `clue:scene:${params.sceneId}:dialogue`;
    infoFreshness = upsertInfoFreshness({
      freshness: infoFreshness,
      clueId,
      locationId: params.locationId,
      sourceType: "dialogue",
      amount: 20,
      nowIso: params.nowIso,
    });
    freshnessUpdated += 1;

    addTrace("witness", 8);
  }

  if (
    params.actionId === "action.wait" &&
    params.ongoingAction &&
    params.ongoingAction.kind === "move" &&
    params.ongoingAction.status === "in_progress"
  ) {
    addTrace("opened_path", 5);
  }

  return {
    nextTemporal: pruneTemporalState({
      version: 1,
      locationStates: params.temporal.locationStates,
      npcMemory,
      infoFreshness,
      residualTraces: traces,
    }),
    memoryTouched,
    freshnessUpdated,
    tracesCreated,
    tracesUpdated,
    incidentNotes: uniqStrings(incidentNotes, MAX_INCIDENTS_PER_LOCATION),
  };
}

type ProjectionResult = {
  nextTemporal: TemporalRuntimeState;
  projection: TemporalLocationProjection | null;
  locationShifted: boolean;
};

function applyLocationProjection(params: {
  temporal: TemporalRuntimeState;
  locationId: string | null;
  nowIso: string;
  incidentNotes: string[];
}): ProjectionResult {
  if (!params.locationId) {
    return {
      nextTemporal: params.temporal,
      projection: null,
      locationShifted: false,
    };
  }

  const traces = params.temporal.residualTraces.filter((entry) => entry.locationId === params.locationId);
  const totals: Record<ResidualTraceType, number> = {
    noise: 0,
    alarm: 0,
    opened_path: 0,
    witness: 0,
    disorder: 0,
  };
  for (const trace of traces) {
    totals[trace.traceType] += trace.intensity;
  }

  const targetTension = clampInt(
    Math.round(22 + totals.alarm * 0.58 + totals.disorder * 0.4 + totals.witness * 0.25 + totals.noise * 0.16),
    0,
    100,
  );
  const targetAlertness = clampInt(Math.round(16 + totals.alarm * 0.68 + totals.witness * 0.44 + totals.noise * 0.19), 0, 100);
  const targetAccessibility = clampInt(
    Math.round(82 - targetAlertness * 0.3 - totals.disorder * 0.2 + totals.opened_path * 0.25),
    0,
    100,
  );

  const existingIndex = params.temporal.locationStates.findIndex((entry) => entry.locationId === params.locationId);
  const existing =
    existingIndex >= 0
      ? (params.temporal.locationStates[existingIndex] as LocationTemporalState)
      : {
          locationId: params.locationId,
          tension: 35,
          alertness: 30,
          accessibility: 70,
          recentIncidents: [],
          lastVisitedAtIso: null,
          lastUpdatedAtIso: params.nowIso,
        };

  const nextState: LocationTemporalState = {
    ...existing,
    tension: clampInt(Math.round(existing.tension * 0.72 + targetTension * 0.28), 0, 100),
    alertness: clampInt(Math.round(existing.alertness * 0.72 + targetAlertness * 0.28), 0, 100),
    accessibility: clampInt(Math.round(existing.accessibility * 0.72 + targetAccessibility * 0.28), 0, 100),
    recentIncidents: uniqStrings([...existing.recentIncidents, ...params.incidentNotes], MAX_INCIDENTS_PER_LOCATION),
    lastVisitedAtIso: params.nowIso,
    lastUpdatedAtIso: params.nowIso,
  };

  const locationShifted =
    nextState.tension !== existing.tension ||
    nextState.alertness !== existing.alertness ||
    nextState.accessibility !== existing.accessibility;

  const nextLocationStates = params.temporal.locationStates.slice();
  if (existingIndex < 0) {
    nextLocationStates.push(nextState);
  } else {
    nextLocationStates[existingIndex] = nextState;
  }

  const nextTemporal = pruneTemporalState({
    ...params.temporal,
    locationStates: nextLocationStates,
  });

  return {
    nextTemporal,
    projection: {
      locationId: nextState.locationId,
      tension: nextState.tension,
      alertness: nextState.alertness,
      accessibility: nextState.accessibility,
      recentIncidents: nextState.recentIncidents,
    },
    locationShifted,
  };
}

export function buildTemporalQualitativeSummary(params: {
  temporal: TemporalRuntimeState;
  locationId: string | null;
}): TemporalQualitativeSummary {
  const memoryPool = params.locationId
    ? params.temporal.npcMemory.filter((entry) => entry.locationId === params.locationId || entry.locationId === null)
    : params.temporal.npcMemory;
  const freshnessPool = params.locationId
    ? params.temporal.infoFreshness.filter((entry) => entry.locationId === params.locationId || entry.locationId === null)
    : params.temporal.infoFreshness;
  const tracePool = params.locationId
    ? params.temporal.residualTraces.filter((entry) => entry.locationId === params.locationId)
    : params.temporal.residualTraces;

  const locationState = params.locationId
    ? params.temporal.locationStates.find((entry) => entry.locationId === params.locationId) ?? null
    : null;

  const maxFamiliarity = memoryPool.reduce((max, entry) => Math.max(max, entry.familiarity), 0);
  const maxFreshness = freshnessPool.reduce((max, entry) => Math.max(max, entry.freshness), 0);
  const maxTraceIntensity = tracePool.reduce((max, entry) => Math.max(max, entry.intensity), 0);

  const memory =
    maxFamiliarity >= 70
      ? "NPC memory is vivid."
      : maxFamiliarity >= 35
        ? "NPC memory traces remain."
        : maxFamiliarity > 0
          ? "NPC memory is fading."
          : "No strong NPC memory cue.";

  const freshness =
    maxFreshness >= 70
      ? "Info freshness is high."
      : maxFreshness >= 35
        ? "Info freshness is decaying."
        : freshnessPool.length > 0
          ? "Info is stale and should be rechecked."
          : "No tracked freshness cue.";

  const traces =
    maxTraceIntensity >= 65
      ? "Residual traces are intense."
      : maxTraceIntensity >= 30
        ? "Residual traces persist."
        : tracePool.length > 0
          ? "Residual traces are settling."
          : "Residual traces are minimal.";

  const location = !params.locationId
    ? "No persistent location link."
    : !locationState
      ? "Location state is neutral."
      : locationState.tension >= 70 || locationState.alertness >= 70
        ? "Location tension and alertness are high."
        : locationState.accessibility <= 35
          ? "Location accessibility is constrained."
          : locationState.tension <= 40 && locationState.alertness <= 40
            ? "Location tension is easing."
            : "Location pressure is sustained.";

  return {
    memory,
    traces,
    freshness,
    location,
    debug: {
      locationId: params.locationId,
      memoryCount: memoryPool.length,
      maxFamiliarity,
      maxFreshness,
      activeTraceCount: tracePool.length,
      maxTraceIntensity,
      locationState: locationState
        ? {
            tension: locationState.tension,
            alertness: locationState.alertness,
            accessibility: locationState.accessibility,
          }
        : null,
    },
  };
}

export function buildQuestTemporalSignal(params: {
  temporal: TemporalRuntimeState;
  locationId: string | null;
}): QuestTemporalSignal {
  const locationState = params.locationId
    ? params.temporal.locationStates.find((entry) => entry.locationId === params.locationId) ?? null
    : null;

  const freshnessPool = params.locationId
    ? params.temporal.infoFreshness.filter((entry) => entry.locationId === params.locationId || entry.locationId === null)
    : params.temporal.infoFreshness;
  const memoryPool = params.locationId
    ? params.temporal.npcMemory.filter((entry) => entry.locationId === params.locationId || entry.locationId === null)
    : params.temporal.npcMemory;
  const tracePool = params.locationId
    ? params.temporal.residualTraces.filter((entry) => entry.locationId === params.locationId)
    : params.temporal.residualTraces;

  const infoFreshness = freshnessPool.reduce((max, entry) => Math.max(max, entry.freshness), 0);
  const memoryFamiliarity = memoryPool.reduce((max, entry) => Math.max(max, entry.familiarity), 0);
  const residualTraceHeat = tracePool.reduce((max, entry) => Math.max(max, entry.intensity), 0);

  return {
    locationId: params.locationId,
    locationTension: locationState?.tension ?? 35,
    locationAlertness: locationState?.alertness ?? 30,
    locationAccessibility: locationState?.accessibility ?? 70,
    infoFreshness,
    memoryFamiliarity,
    residualTraceHeat,
    incidentCount: locationState?.recentIncidents.length ?? 0,
  };
}

export function runTemporalUpdatePipeline(input: TemporalPipelineInput): TemporalPipelineResult {
  const normalized = ensureTemporalRuntimeState(input.temporal, input.nowIso);
  const decayed = applyTemporalDecay({
    temporal: normalized,
    deltaTimeSec: input.deltaTimeSec,
    nowIso: input.nowIso,
  });

  const footprint = applyActionFootprint({
    temporal: decayed.nextTemporal,
    sceneId: input.sceneId,
    locationId: input.locationId,
    actionId: input.actionId,
    classification: input.classification,
    nowIso: input.nowIso,
    ongoingAction: input.ongoingAction,
  });

  const projected = applyLocationProjection({
    temporal: footprint.nextTemporal,
    locationId: input.locationId,
    nowIso: input.nowIso,
    incidentNotes: footprint.incidentNotes,
  });

  const nextTemporal = pruneTemporalState(projected.nextTemporal);
  const qualitative = buildTemporalQualitativeSummary({
    temporal: nextTemporal,
    locationId: input.locationId,
  });

  return {
    nextTemporal,
    projection: projected.projection,
    summary: {
      deltaTimeSec: input.deltaTimeSec,
      locationId: input.locationId,
      memoryTouched: footprint.memoryTouched,
      memoryDecayed: decayed.memoryDecayed,
      freshnessUpdated: footprint.freshnessUpdated,
      freshnessDecayed: decayed.freshnessDecayed,
      tracesCreated: footprint.tracesCreated,
      tracesUpdated: footprint.tracesUpdated,
      tracesDecayed: decayed.tracesDecayed,
      tracesExpired: decayed.tracesExpired,
      locationShifted: projected.locationShifted,
      locationSnapshot: projected.projection
        ? {
            tension: projected.projection.tension,
            alertness: projected.projection.alertness,
            accessibility: projected.projection.accessibility,
          }
        : null,
      qualitative: {
        memory: qualitative.memory,
        traces: qualitative.traces,
        freshness: qualitative.freshness,
        location: qualitative.location,
      },
    },
  };
}
