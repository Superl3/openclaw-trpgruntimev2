export type ActionFeasibility = "possible" | "currently_impossible" | "reckless" | "impossible";

export type ScenePhase = "active" | "transitioning" | "resolved";

export type BeatStatus = "open" | "blocked" | "resolved";

export type OngoingActionStatus = "in_progress" | "completed" | "failed";

export type PaletteButtonStyle = "primary" | "secondary" | "success" | "danger";

export type DeterministicActionId =
  | "action.observe"
  | "action.move"
  | "action.wait"
  | "action.talk"
  | "action.rush"
  | "action.free_input.submit"
  | "action.unknown";

export type SceneState = {
  sceneId: string;
  sceneIndex: number;
  title: string;
  phase: ScenePhase;
  pressure: number;
  riskTier: "low" | "medium" | "high";
  npcAvailable: boolean;
};

export type BeatState = {
  beatId: string;
  beatIndex: number;
  objective: string;
  status: BeatStatus;
  lastInputActionId: string | null;
};

export type ExchangeState = {
  exchangeId: string;
  exchangeIndex: number;
  inputActionId: string;
  resolvedActionId: string;
  classification: ActionFeasibility;
  deltaTimeSec: number;
  resultSummary: string;
  riskNote: string | null;
  reactionChain: string[];
  occurredAtIso: string;
};

export type OngoingActionState = {
  id: string;
  kind: "move" | "investigate" | "dialogue" | "custom";
  status: OngoingActionStatus;
  requiredSec: number;
  elapsedSec: number;
  interruptible: boolean;
  startedAtIso: string;
};

export type ActionPaletteEntry = {
  actionId: string;
  label: string;
  availability: ActionFeasibility;
  reason: string;
  style: PaletteButtonStyle;
  showInButtons: boolean;
};

export type DeterministicTimeState = {
  worldElapsedSec: number;
  lastDeltaSec: number;
  worldNowIso: string;
};

export type BehavioralAxisVector = {
  warmth: number;
  boldness: number;
  caution: number;
  altruism: number;
  aggression: number;
  humor: number;
};

export type BehavioralDriftState = {
  coreIdentity: BehavioralAxisVector;
  drift: BehavioralAxisVector;
  lastUpdatedAtIso: string;
};

export type IntentInertiaState = {
  lastMappedActionId: string | null;
  streakCount: number;
  smoothedConfidence: number;
  lastSource: "deterministic" | "analyzer";
};

export type AnalyzerMemoryState = {
  /**
   * Bounded ephemeral analyzer cache. This is NOT deterministic source-of-truth.
   */
  recentFreeInputs: string[];
  recentResolvedActions: string[];
  recentClassifications: ActionFeasibility[];
  lastIntentSignals: string[];
  expiresAtIso: string | null;
};

export type DeterministicSceneLoopState = {
  scene: SceneState;
  beat: BeatState;
  exchange: ExchangeState | null;
  exchangeHistory: ExchangeState[];
  time: DeterministicTimeState;
  ongoingAction: OngoingActionState | null;
  behavioralDrift: BehavioralDriftState;
  intentInertia: IntentInertiaState;
  analyzerMemory: AnalyzerMemoryState;
  actionPalette: ActionPaletteEntry[];
};

export type DeterministicActionInput = {
  loop: DeterministicSceneLoopState;
  routeActionId: string;
  freeInput?: string;
  resolvedActionOverride?: string;
  nowIso: string;
};

export type DeterministicActionResolution = {
  nextLoop: DeterministicSceneLoopState;
  inputActionId: string;
  resolvedActionId: string;
  classification: ActionFeasibility;
  deltaTimeSec: number;
  resultSummary: string;
  riskNote: string | null;
  reactionChain: string[];
  exchange: ExchangeState;
};

const DEFAULT_SCENE_ID = "scene-bootstrap";
export const DEFAULT_ANALYZER_MEMORY_TTL_SEC = 900;

const BEAT_OBJECTIVES = [
  "현장을 파악한다.",
  "접근 경로를 확보한다.",
  "리스크를 관리한다.",
  "다음 장면 전환을 준비한다.",
];

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
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

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function clampFloat(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

export function zeroBehavioralAxisVector(): BehavioralAxisVector {
  return {
    warmth: 0,
    boldness: 0,
    caution: 0,
    altruism: 0,
    aggression: 0,
    humor: 0,
  };
}

function readBehavioralAxisVector(value: unknown, fallback: BehavioralAxisVector): BehavioralAxisVector {
  const node = toRecord(value);
  return {
    warmth: clampFloat(typeof node.warmth === "number" ? node.warmth : fallback.warmth, -1, 1),
    boldness: clampFloat(typeof node.boldness === "number" ? node.boldness : fallback.boldness, -1, 1),
    caution: clampFloat(typeof node.caution === "number" ? node.caution : fallback.caution, -1, 1),
    altruism: clampFloat(typeof node.altruism === "number" ? node.altruism : fallback.altruism, -1, 1),
    aggression: clampFloat(typeof node.aggression === "number" ? node.aggression : fallback.aggression, -1, 1),
    humor: clampFloat(typeof node.humor === "number" ? node.humor : fallback.humor, -1, 1),
  };
}

function parseSceneIndex(sceneId: string): number {
  const matched = sceneId.match(/(\d{1,6})$/);
  if (!matched) {
    return 1;
  }
  return clampInt(Number.parseInt(matched[1], 10), 1, 999_999);
}

function sceneTitle(sceneIndex: number): string {
  return `장면 ${String(sceneIndex).padStart(3, "0")}`;
}

function riskTierFromPressure(pressure: number): "low" | "medium" | "high" {
  if (pressure >= 70) {
    return "high";
  }
  if (pressure >= 35) {
    return "medium";
  }
  return "low";
}

function beatObjective(beatIndex: number): string {
  const index = Math.max(1, Math.trunc(beatIndex));
  return BEAT_OBJECTIVES[(index - 1) % BEAT_OBJECTIVES.length] as string;
}

function makeBeatId(sceneId: string, beatIndex: number): string {
  return `${sceneId}:beat-${String(Math.max(1, Math.trunc(beatIndex))).padStart(2, "0")}`;
}

function makeExchangeId(beatId: string, exchangeIndex: number): string {
  return `${beatId}:ex-${String(Math.max(1, Math.trunc(exchangeIndex))).padStart(3, "0")}`;
}

function addSecondsToIso(baseIso: string, deltaSec: number): string {
  const parsed = Date.parse(baseIso);
  const baseline = Number.isFinite(parsed) ? parsed : Date.now();
  return new Date(baseline + deltaSec * 1_000).toISOString();
}

function hasIsoExpired(expiresAtIso: string | null, nowIso: string): boolean {
  if (!expiresAtIso) {
    return false;
  }
  const expiresAt = Date.parse(expiresAtIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(now)) {
    return false;
  }
  return expiresAt <= now;
}

function nextAnalyzerMemoryExpiry(nowIso: string, ttlSec = DEFAULT_ANALYZER_MEMORY_TTL_SEC): string {
  return addSecondsToIso(nowIso, Math.max(60, Math.trunc(ttlSec)));
}

function normalizeActionId(actionId: string): DeterministicActionId {
  const normalized = readString(actionId).toLowerCase();
  switch (normalized) {
    case "action.observe":
      return "action.observe";
    case "action.move":
      return "action.move";
    case "action.wait":
      return "action.wait";
    case "action.talk":
      return "action.talk";
    case "action.rush":
      return "action.rush";
    case "action.free_input.submit":
      return "action.free_input.submit";
    default:
      return "action.unknown";
  }
}

export function actionLabelFor(actionId: string): string {
  switch (normalizeActionId(actionId)) {
    case "action.observe":
      return "조사";
    case "action.move":
      return "이동";
    case "action.wait":
      return "대기";
    case "action.talk":
      return "대화";
    case "action.rush":
      return "강행";
    case "action.free_input.submit":
      return "직접 입력";
    default:
      return "알 수 없는 행동";
  }
}

export function feasibilityLabel(value: ActionFeasibility): string {
  switch (value) {
    case "possible":
      return "가능";
    case "currently_impossible":
      return "현재 조건상 불가능";
    case "reckless":
      return "무모하지만 가능";
    default:
      return "불가능";
  }
}

function baseActionSeconds(actionId: DeterministicActionId): number {
  switch (actionId) {
    case "action.observe":
      return 35;
    case "action.move":
      return 90;
    case "action.wait":
      return 120;
    case "action.talk":
      return 55;
    case "action.rush":
      return 45;
    case "action.free_input.submit":
      return 70;
    default:
      return 20;
  }
}

function classificationMultiplier(classification: ActionFeasibility): number {
  switch (classification) {
    case "possible":
      return 1;
    case "reckless":
      return 1.6;
    case "currently_impossible":
      return 0.45;
    default:
      return 0.25;
  }
}

function buildReactionChain(params: {
  actionId: DeterministicActionId;
  classification: ActionFeasibility;
  sceneTransitioned: boolean;
}): string[] {
  if (params.classification === "impossible") {
    return ["행동이 성립하지 않는다.", "의도를 다시 제시해야 한다."];
  }

  if (params.classification === "currently_impossible") {
    return ["현재 조건으로는 실행할 수 없다.", "먼저 조건을 만족시킬 준비 행동이 필요하다."];
  }

  if (params.actionId === "action.rush") {
    return ["무리한 시도로 노출이 증가했다.", "위험 신호가 한 단계 상승했다."];
  }

  if (params.actionId === "action.move") {
    return params.sceneTransitioned
      ? ["이동 누적이 임계치를 넘어 장면이 전환되었다.", "새 장면에서 초기 정보 수집이 필요하다."]
      : ["이동을 계속 진행 중이다.", "추가 이동 또는 대기로 진행을 누적할 수 있다."];
  }

  if (params.actionId === "action.wait") {
    return ["시간이 흘렀다.", "환경 상태가 미세하게 변했다."];
  }

  if (params.actionId === "action.talk") {
    return ["짧은 대화를 시도했다.", "대화 흐름이 이어질 단서가 생겼다."];
  }

  return ["주변 단서를 정리했다.", "다음 행동 선택지가 갱신되었다."];
}

function computeDeltaTimeSec(params: {
  actionId: DeterministicActionId;
  classification: ActionFeasibility;
  loop: DeterministicSceneLoopState;
}): number {
  const base = baseActionSeconds(params.actionId);
  const classificationFactor = classificationMultiplier(params.classification);
  const pressureFactor = 1 + params.loop.scene.pressure / 200;
  const ongoingFactor = params.loop.ongoingAction && params.loop.ongoingAction.status === "in_progress" ? 0.85 : 1;
  return clampInt(Math.round(base * classificationFactor * pressureFactor * ongoingFactor), 5, 900);
}

export function mapFreeInputToActionDeterministic(freeInput: string): DeterministicActionId {
  const normalized = readString(freeInput).toLowerCase();
  if (!normalized) {
    return "action.unknown";
  }

  if (/(조사|살핀|탐색|observe|inspect|look)/.test(normalized)) {
    return "action.observe";
  }
  if (/(이동|옮기|간다|move|advance|travel)/.test(normalized)) {
    return "action.move";
  }
  if (/(대기|기다|wait|hold|pause)/.test(normalized)) {
    return "action.wait";
  }
  if (/(대화|말|질문|talk|speak|ask)/.test(normalized)) {
    return "action.talk";
  }
  if (/(강행|돌파|밀어|rush|force|push)/.test(normalized)) {
    return "action.rush";
  }

  return "action.unknown";
}

type ResolvedAction = {
  inputActionId: string;
  resolvedActionId: DeterministicActionId;
};

function resolveActionId(inputActionId: string, freeInput?: string, resolvedActionOverride?: string): ResolvedAction {
  const normalizedInput = normalizeActionId(inputActionId);

  const override = normalizeActionId(readString(resolvedActionOverride));
  if (override !== "action.unknown") {
    return {
      inputActionId: normalizedInput,
      resolvedActionId: override,
    };
  }

  if (normalizedInput === "action.free_input.submit") {
    return {
      inputActionId: normalizedInput,
      resolvedActionId: mapFreeInputToActionDeterministic(readString(freeInput)),
    };
  }

  return {
    inputActionId: normalizedInput,
    resolvedActionId: normalizedInput,
  };
}

function classifyAction(params: {
  loop: DeterministicSceneLoopState;
  resolvedActionId: DeterministicActionId;
}): { classification: ActionFeasibility; reason: string } {
  const actionId = params.resolvedActionId;
  const ongoing = params.loop.ongoingAction;

  if (actionId === "action.unknown" || actionId === "action.free_input.submit") {
    return {
      classification: "impossible",
      reason: "해석 가능한 행동 키가 없다.",
    };
  }

  if (
    ongoing &&
    ongoing.status === "in_progress" &&
    ongoing.kind !== "move" &&
    ongoing.interruptible === false &&
    actionId !== "action.wait"
  ) {
    return {
      classification: "currently_impossible",
      reason: "진행 중인 행동이 잠겨 있어 다른 행동으로 전환할 수 없다.",
    };
  }

  if (actionId === "action.talk" && !params.loop.scene.npcAvailable) {
    return {
      classification: "currently_impossible",
      reason: "현재 장면에 대화 가능한 대상이 없다.",
    };
  }

  if (actionId === "action.move" && params.loop.scene.phase === "resolved") {
    return {
      classification: "currently_impossible",
      reason: "장면이 이미 정리되어 이동 전 준비가 필요하다.",
    };
  }

  if (actionId === "action.rush") {
    return {
      classification: "reckless",
      reason: "위험 감수 행동으로 간주한다.",
    };
  }

  return {
    classification: "possible",
    reason: "현재 조건에서 실행 가능하다.",
  };
}

function updateBeat(params: {
  previous: BeatState;
  sceneId: string;
  classification: ActionFeasibility;
  sceneTransitioned: boolean;
  exchangeIndex: number;
  resolvedActionId: string;
}): BeatState {
  if (params.sceneTransitioned) {
    const beatIndex = 1;
    return {
      beatId: makeBeatId(params.sceneId, beatIndex),
      beatIndex,
      objective: beatObjective(beatIndex),
      status: "open",
      lastInputActionId: params.resolvedActionId,
    };
  }

  const advancedBeatIndex =
    params.classification !== "impossible" && params.classification !== "currently_impossible" && params.exchangeIndex % 3 === 0
      ? params.previous.beatIndex + 1
      : params.previous.beatIndex;

  const status: BeatStatus =
    params.classification === "impossible" || params.classification === "currently_impossible" ? "blocked" : "open";

  return {
    beatId: makeBeatId(params.sceneId, advancedBeatIndex),
    beatIndex: advancedBeatIndex,
    objective: beatObjective(advancedBeatIndex),
    status,
    lastInputActionId: params.resolvedActionId,
  };
}

export function createInitialDeterministicSceneLoop(params: {
  sceneId: string;
  nowIso: string;
}): DeterministicSceneLoopState {
  const sceneId = readString(params.sceneId, DEFAULT_SCENE_ID);
  const sceneIndex = parseSceneIndex(sceneId);
  const coreIdentity = zeroBehavioralAxisVector();

  const seed: DeterministicSceneLoopState = {
    scene: {
      sceneId,
      sceneIndex,
      title: sceneTitle(sceneIndex),
      phase: "active",
      pressure: 25,
      riskTier: "low",
      npcAvailable: false,
    },
    beat: {
      beatId: makeBeatId(sceneId, 1),
      beatIndex: 1,
      objective: beatObjective(1),
      status: "open",
      lastInputActionId: null,
    },
    exchange: null,
    exchangeHistory: [],
    time: {
      worldElapsedSec: 0,
      lastDeltaSec: 0,
      worldNowIso: params.nowIso,
    },
    ongoingAction: null,
    behavioralDrift: {
      coreIdentity,
      drift: zeroBehavioralAxisVector(),
      lastUpdatedAtIso: params.nowIso,
    },
    intentInertia: {
      lastMappedActionId: null,
      streakCount: 0,
      smoothedConfidence: 0,
      lastSource: "deterministic",
    },
    analyzerMemory: {
      recentFreeInputs: [],
      recentResolvedActions: [],
      recentClassifications: [],
      lastIntentSignals: [],
      expiresAtIso: nextAnalyzerMemoryExpiry(params.nowIso),
    },
    actionPalette: [],
  };

  seed.actionPalette = buildActionPalette(seed);
  return seed;
}

export function ensureDeterministicSceneLoopState(value: unknown, params: {
  sceneId: string;
  nowIso: string;
}): DeterministicSceneLoopState {
  const initial = createInitialDeterministicSceneLoop(params);
  const root = toRecord(value);

  const sceneObj = toRecord(root.scene);
  const sceneId = readString(sceneObj.sceneId, readString(params.sceneId, initial.scene.sceneId));
  const sceneIndex = clampInt(readInt(sceneObj.sceneIndex, parseSceneIndex(sceneId)), 1, 999_999);
  const pressure = clampInt(readInt(sceneObj.pressure, initial.scene.pressure), 0, 100);
  const scene: SceneState = {
    sceneId,
    sceneIndex,
    title: readString(sceneObj.title, sceneTitle(sceneIndex)),
    phase:
      readString(sceneObj.phase) === "transitioning"
        ? "transitioning"
        : readString(sceneObj.phase) === "resolved"
          ? "resolved"
          : "active",
    pressure,
    riskTier: riskTierFromPressure(pressure),
    npcAvailable: sceneObj.npcAvailable === true,
  };

  const beatObj = toRecord(root.beat);
  const beatIndex = clampInt(readInt(beatObj.beatIndex, 1), 1, 999_999);
  const beat: BeatState = {
    beatId: readString(beatObj.beatId, makeBeatId(scene.sceneId, beatIndex)),
    beatIndex,
    objective: readString(beatObj.objective, beatObjective(beatIndex)),
    status:
      readString(beatObj.status) === "blocked"
        ? "blocked"
        : readString(beatObj.status) === "resolved"
          ? "resolved"
          : "open",
    lastInputActionId: readString(beatObj.lastInputActionId) || null,
  };

  const timeObj = toRecord(root.time);
  const time: DeterministicTimeState = {
    worldElapsedSec: Math.max(0, readInt(timeObj.worldElapsedSec, 0)),
    lastDeltaSec: Math.max(0, readInt(timeObj.lastDeltaSec, 0)),
    worldNowIso: readString(timeObj.worldNowIso, params.nowIso),
  };

  const ongoingObj = toRecord(root.ongoingAction);
  const hasOngoing = Object.keys(ongoingObj).length > 0;
  const ongoingAction: OngoingActionState | null = hasOngoing
    ? {
        id: readString(ongoingObj.id, `ongoing-${scene.sceneId}`),
        kind: readString(ongoingObj.kind) === "investigate"
          ? "investigate"
          : readString(ongoingObj.kind) === "dialogue"
            ? "dialogue"
            : readString(ongoingObj.kind) === "custom"
              ? "custom"
              : "move",
        status:
          readString(ongoingObj.status) === "completed"
            ? "completed"
            : readString(ongoingObj.status) === "failed"
              ? "failed"
              : "in_progress",
        requiredSec: Math.max(1, readInt(ongoingObj.requiredSec, 180)),
        elapsedSec: Math.max(0, readInt(ongoingObj.elapsedSec, 0)),
        interruptible: ongoingObj.interruptible === true,
        startedAtIso: readString(ongoingObj.startedAtIso, params.nowIso),
      }
    : null;

  const behavioralObj = toRecord(root.behavioralDrift);
  const coreIdentity = readBehavioralAxisVector(behavioralObj.coreIdentity, initial.behavioralDrift.coreIdentity);
  const behavioralDrift: BehavioralDriftState = {
    coreIdentity,
    drift: readBehavioralAxisVector(behavioralObj.drift, initial.behavioralDrift.drift),
    lastUpdatedAtIso: readString(behavioralObj.lastUpdatedAtIso, params.nowIso),
  };

  const inertiaObj = toRecord(root.intentInertia);
  const intentInertia: IntentInertiaState = {
    lastMappedActionId: readString(inertiaObj.lastMappedActionId) || null,
    streakCount: Math.max(0, readInt(inertiaObj.streakCount, 0)),
    smoothedConfidence: clampFloat(readNumber(inertiaObj.smoothedConfidence, 0), 0, 1),
    lastSource: readString(inertiaObj.lastSource) === "analyzer" ? "analyzer" : "deterministic",
  };

  const analyzerMemoryObj = toRecord(root.analyzerMemory);
  const analyzerMemoryRaw: AnalyzerMemoryState = {
    recentFreeInputs: Array.isArray(analyzerMemoryObj.recentFreeInputs)
      ? analyzerMemoryObj.recentFreeInputs.filter((entry): entry is string => typeof entry === "string").slice(-8)
      : [],
    recentResolvedActions: Array.isArray(analyzerMemoryObj.recentResolvedActions)
      ? analyzerMemoryObj.recentResolvedActions.filter((entry): entry is string => typeof entry === "string").slice(-8)
      : [],
    recentClassifications: Array.isArray(analyzerMemoryObj.recentClassifications)
      ? analyzerMemoryObj.recentClassifications
          .filter(
            (entry): entry is ActionFeasibility =>
              entry === "possible" || entry === "currently_impossible" || entry === "reckless" || entry === "impossible",
          )
          .slice(-8)
      : [],
    lastIntentSignals: Array.isArray(analyzerMemoryObj.lastIntentSignals)
      ? analyzerMemoryObj.lastIntentSignals.filter((entry): entry is string => typeof entry === "string").slice(-8)
      : [],
    expiresAtIso: readString(analyzerMemoryObj.expiresAtIso) || null,
  };

  const analyzerMemory: AnalyzerMemoryState = hasIsoExpired(analyzerMemoryRaw.expiresAtIso, params.nowIso)
    ? {
        recentFreeInputs: [],
        recentResolvedActions: [],
        recentClassifications: [],
        lastIntentSignals: [],
        expiresAtIso: nextAnalyzerMemoryExpiry(params.nowIso),
      }
    : {
        ...analyzerMemoryRaw,
        expiresAtIso: analyzerMemoryRaw.expiresAtIso ?? nextAnalyzerMemoryExpiry(params.nowIso),
      };

  const exchangeObj = toRecord(root.exchange);
  const exchange: ExchangeState | null = Object.keys(exchangeObj).length
    ? {
        exchangeId: readString(exchangeObj.exchangeId, makeExchangeId(beat.beatId, 1)),
        exchangeIndex: Math.max(1, readInt(exchangeObj.exchangeIndex, 1)),
        inputActionId: readString(exchangeObj.inputActionId, "action.unknown"),
        resolvedActionId: readString(exchangeObj.resolvedActionId, "action.unknown"),
        classification:
          readString(exchangeObj.classification) === "possible"
            ? "possible"
            : readString(exchangeObj.classification) === "reckless"
              ? "reckless"
              : readString(exchangeObj.classification) === "currently_impossible"
                ? "currently_impossible"
                : "impossible",
        deltaTimeSec: Math.max(0, readInt(exchangeObj.deltaTimeSec, 0)),
        resultSummary: readString(exchangeObj.resultSummary, "최근 결과 없음"),
        riskNote: readString(exchangeObj.riskNote) || null,
        reactionChain: Array.isArray(exchangeObj.reactionChain)
          ? exchangeObj.reactionChain.filter((entry): entry is string => typeof entry === "string").slice(0, 6)
          : [],
        occurredAtIso: readString(exchangeObj.occurredAtIso, params.nowIso),
      }
    : null;

  const historyRaw = Array.isArray(root.exchangeHistory) ? root.exchangeHistory : [];
  const exchangeHistory: ExchangeState[] = historyRaw
    .map((entry) => ensureDeterministicSceneLoopState({ exchange: entry }, params).exchange)
    .filter((entry): entry is ExchangeState => entry !== null)
    .slice(-8);

  const normalized: DeterministicSceneLoopState = {
    scene,
    beat,
    exchange,
    exchangeHistory,
    time,
    ongoingAction,
    behavioralDrift,
    intentInertia,
    analyzerMemory,
    actionPalette: [],
  };

  normalized.actionPalette = buildActionPalette(normalized);
  return normalized;
}

export function buildActionPalette(loop: DeterministicSceneLoopState): ActionPaletteEntry[] {
  const moveAvailability: ActionFeasibility =
    loop.ongoingAction &&
    loop.ongoingAction.status === "in_progress" &&
    loop.ongoingAction.kind !== "move" &&
    loop.ongoingAction.interruptible === false
      ? "currently_impossible"
      : "possible";

  const talkAvailability: ActionFeasibility = loop.scene.npcAvailable ? "possible" : "currently_impossible";
  const showTalkButton = talkAvailability === "possible";

  const entries: ActionPaletteEntry[] = [
    {
      actionId: "action.observe",
      label: actionLabelFor("action.observe"),
      availability: "possible",
      reason: "장면 정보를 확보한다.",
      style: "primary",
      showInButtons: true,
    },
    {
      actionId: "action.move",
      label: actionLabelFor("action.move"),
      availability: moveAvailability,
      reason:
        moveAvailability === "possible"
          ? "다음 위치로 진행한다."
          : "잠긴 진행 행동이 있어 바로 이동 전환을 할 수 없다.",
      style: "secondary",
      showInButtons: moveAvailability === "possible",
    },
    {
      actionId: "action.wait",
      label: actionLabelFor("action.wait"),
      availability: "possible",
      reason: "시간을 흘려 진행 상태를 누적한다.",
      style: "secondary",
      showInButtons: true,
    },
    {
      actionId: "action.talk",
      label: actionLabelFor("action.talk"),
      availability: talkAvailability,
      reason: talkAvailability === "possible" ? "대화 가능한 대상과 상호작용한다." : "현재 대화 가능한 대상이 없다.",
      style: "success",
      showInButtons: showTalkButton,
    },
    {
      actionId: "action.rush",
      label: actionLabelFor("action.rush"),
      availability: "reckless",
      reason: "위험을 감수하고 강행한다.",
      style: "danger",
      showInButtons: !showTalkButton,
    },
  ];

  return entries;
}

export function collectButtonActionIds(loop: DeterministicSceneLoopState): string[] {
  const dedup = new Set<string>();
  for (const entry of loop.actionPalette) {
    if (!entry.showInButtons) {
      continue;
    }
    if (entry.availability !== "possible" && entry.availability !== "reckless") {
      continue;
    }
    dedup.add(entry.actionId);
    if (dedup.size >= 4) {
      break;
    }
  }
  return Array.from(dedup);
}

export function resolveDeterministicSceneAction(input: DeterministicActionInput): DeterministicActionResolution {
  const current = ensureDeterministicSceneLoopState(input.loop, {
    sceneId: input.loop.scene.sceneId,
    nowIso: input.nowIso,
  });
  const resolvedAction = resolveActionId(input.routeActionId, input.freeInput, input.resolvedActionOverride);
  const classified = classifyAction({
    loop: current,
    resolvedActionId: resolvedAction.resolvedActionId,
  });

  const deltaTimeSec = computeDeltaTimeSec({
    actionId: resolvedAction.resolvedActionId,
    classification: classified.classification,
    loop: current,
  });

  const nextScene: SceneState = {
    ...current.scene,
  };

  let ongoingAction: OngoingActionState | null = current.ongoingAction
    ? {
        ...current.ongoingAction,
      }
    : null;

  let sceneTransitioned = false;

  if (classified.classification === "possible" || classified.classification === "reckless") {
    switch (resolvedAction.resolvedActionId) {
      case "action.observe":
        nextScene.pressure = clampInt(nextScene.pressure - 6, 0, 100);
        if (nextScene.pressure <= 60) {
          nextScene.npcAvailable = true;
        }
        break;
      case "action.wait":
        nextScene.pressure = clampInt(nextScene.pressure + 4, 0, 100);
        if (ongoingAction && ongoingAction.kind === "move" && ongoingAction.status === "in_progress") {
          ongoingAction.elapsedSec += deltaTimeSec;
        }
        break;
      case "action.talk":
        nextScene.pressure = clampInt(nextScene.pressure - 3, 0, 100);
        nextScene.npcAvailable = true;
        break;
      case "action.rush":
        nextScene.pressure = clampInt(nextScene.pressure + 18, 0, 100);
        nextScene.npcAvailable = false;
        break;
      case "action.move": {
        const requiredSec = 180;
        if (!ongoingAction || ongoingAction.kind !== "move" || ongoingAction.status !== "in_progress") {
          ongoingAction = {
            id: `${nextScene.sceneId}:move-${Date.parse(input.nowIso) || Date.now()}`,
            kind: "move",
            status: "in_progress",
            requiredSec,
            elapsedSec: 0,
            interruptible: false,
            startedAtIso: input.nowIso,
          };
        }
        ongoingAction.elapsedSec += deltaTimeSec;
        nextScene.phase = "transitioning";
        nextScene.pressure = clampInt(nextScene.pressure + 2, 0, 100);
        break;
      }
      default:
        break;
    }
  } else if (classified.classification === "currently_impossible") {
    nextScene.pressure = clampInt(nextScene.pressure + 1, 0, 100);
  }

  if (ongoingAction && ongoingAction.kind === "move" && ongoingAction.status === "in_progress") {
    if (ongoingAction.elapsedSec >= ongoingAction.requiredSec) {
      ongoingAction = null;
      sceneTransitioned = true;
      const nextSceneIndex = nextScene.sceneIndex + 1;
      nextScene.sceneIndex = nextSceneIndex;
      nextScene.sceneId = `scene-${String(nextSceneIndex).padStart(3, "0")}`;
      nextScene.title = sceneTitle(nextSceneIndex);
      nextScene.phase = "active";
      nextScene.npcAvailable = false;
      nextScene.pressure = clampInt(Math.round(nextScene.pressure * 0.7), 5, 100);
    }
  }

  nextScene.riskTier = riskTierFromPressure(nextScene.pressure);

  const exchangeIndex = sceneTransitioned ? 1 : (current.exchange?.exchangeIndex ?? 0) + 1;
  const beat = updateBeat({
    previous: current.beat,
    sceneId: nextScene.sceneId,
    classification: classified.classification,
    sceneTransitioned,
    exchangeIndex,
    resolvedActionId: resolvedAction.resolvedActionId,
  });

  const riskNote =
    classified.classification === "reckless"
      ? "무리한 행동이라 위험이 상승했다. 다음 행동에서 보수적 선택이 권장된다."
      : null;

  const resultSummary =
    classified.classification === "impossible"
      ? `행동을 처리할 수 없다: ${classified.reason}`
      : classified.classification === "currently_impossible"
        ? `지금은 실행할 수 없다: ${classified.reason}`
        : classified.classification === "reckless"
          ? `${actionLabelFor(resolvedAction.resolvedActionId)}를 강행했다.`
          : `${actionLabelFor(resolvedAction.resolvedActionId)}를 처리했다.`;

  const reactionChain = buildReactionChain({
    actionId: resolvedAction.resolvedActionId,
    classification: classified.classification,
    sceneTransitioned,
  });

  const exchange: ExchangeState = {
    exchangeId: makeExchangeId(beat.beatId, exchangeIndex),
    exchangeIndex,
    inputActionId: resolvedAction.inputActionId,
    resolvedActionId: resolvedAction.resolvedActionId,
    classification: classified.classification,
    deltaTimeSec,
    resultSummary,
    riskNote,
    reactionChain,
    occurredAtIso: input.nowIso,
  };

  const worldNowIso = addSecondsToIso(current.time.worldNowIso || input.nowIso, deltaTimeSec);
  const nextLoop: DeterministicSceneLoopState = {
    scene: nextScene,
    beat,
    exchange,
    exchangeHistory: [...current.exchangeHistory, exchange].slice(-8),
    time: {
      worldElapsedSec: current.time.worldElapsedSec + deltaTimeSec,
      lastDeltaSec: deltaTimeSec,
      worldNowIso,
    },
    ongoingAction,
    behavioralDrift: current.behavioralDrift,
    intentInertia: current.intentInertia,
    analyzerMemory: {
      ...current.analyzerMemory,
      expiresAtIso: current.analyzerMemory.expiresAtIso ?? nextAnalyzerMemoryExpiry(input.nowIso),
    },
    actionPalette: [],
  };

  nextLoop.actionPalette = buildActionPalette(nextLoop);

  return {
    nextLoop,
    inputActionId: resolvedAction.inputActionId,
    resolvedActionId: resolvedAction.resolvedActionId,
    classification: classified.classification,
    deltaTimeSec,
    resultSummary,
    riskNote,
    reactionChain,
    exchange,
  };
}
