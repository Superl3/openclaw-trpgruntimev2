import type { IntentAnalyzer, PersonaDriftAnalyzer } from "./contracts.js";
import {
  LLM_CONTRACT_VERSION,
  emptyDriftAxisVector,
  isIntentAnalyzerOutput,
  isPersonaDriftAnalyzerOutput,
  type DriftAxisVector,
  type IntentAnalyzerInput,
  type IntentAnalyzerOutput,
  type PersonaDriftAnalyzerInput,
  type PersonaDriftAnalyzerOutput,
} from "./llm-contracts.js";
import type {
  ActionFeasibility,
  BehavioralAxisVector,
  BehavioralDriftState,
  DeterministicActionId,
  IntentInertiaState,
} from "./scene-loop.js";
import { mapFreeInputToActionDeterministic, DEFAULT_ANALYZER_MEMORY_TTL_SEC } from "./scene-loop.js";
import type { SessionState } from "./types.js";

const INTENT_CONFIDENCE_LOW = 0.45;
const INTENT_CONFIDENCE_HIGH = 0.75;
const DRIFT_DECAY = 0.92;
const DRIFT_GAIN = 0.08;

const DRIFT_AXES: Array<keyof DriftAxisVector> = [
  "warmth",
  "boldness",
  "caution",
  "altruism",
  "aggression",
  "humor",
];

export type StructuredIntentSelection = {
  actionId: string;
  source: "deterministic" | "analyzer";
  confidence: number;
  analyzerWeight: number;
  fallbackStrategy: "none" | "keep_previous" | "scene_safe_default" | "abstain";
  preResolvedClaimUntrusted: boolean;
  analyzerOutput: IntentAnalyzerOutput | null;
};

export type AnalyzerModelInvoker = {
  inferJson(prompt: string): Promise<unknown>;
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSignals(value: string): string[] {
  return value
    .split(/\s+/g)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 10);
}

function pushSignal(out: string[], value: string): void {
  const normalized = value.trim();
  if (!normalized || out.includes(normalized)) {
    return;
  }
  out.push(normalized);
}

function addSecondsToIso(baseIso: string, deltaSec: number): string {
  const base = Date.parse(baseIso);
  const now = Number.isFinite(base) ? base : Date.now();
  return new Date(now + deltaSec * 1_000).toISOString();
}

function chooseConservativeFallback(availableActions: string[], lastMappedActionId: string | null): {
  actionId: string;
  strategy: "keep_previous" | "scene_safe_default" | "abstain";
} {
  const available = new Set(availableActions);
  if (lastMappedActionId && available.has(lastMappedActionId)) {
    return {
      actionId: lastMappedActionId,
      strategy: "keep_previous",
    };
  }

  if (available.has("action.wait")) {
    return {
      actionId: "action.wait",
      strategy: "scene_safe_default",
    };
  }

  if (available.has("action.observe")) {
    return {
      actionId: "action.observe",
      strategy: "scene_safe_default",
    };
  }

  return {
    actionId: "action.unknown",
    strategy: "abstain",
  };
}

function promptEnvelope(task: string, input: unknown): string {
  return [
    `TASK=${task}`,
    "ROLE=You are a strict classifier. Do not narrate. Output JSON only.",
    "RULES=Return exactly one JSON object matching schema. No markdown. No prose.",
    "INPUT_JSON=",
    JSON.stringify(input),
  ].join("\n");
}

function scoreToIntentLabel(text: string): IntentAnalyzerOutput["intent"] {
  const lower = text.toLowerCase();
  if (!lower) {
    return "unknown";
  }
  if (/^\//.test(lower) || /(설정|옵션|도움|meta|ooc|rule)/.test(lower)) {
    return "meta";
  }
  if (/(말하|대화|질문|"|“|”|'|talk|say|ask)/.test(lower)) {
    return "dialogue";
  }
  return "action";
}

function detectPreResolvedClaim(text: string): boolean {
  const lower = text.toLowerCase();
  return /(이미|벌써|already).*(성공|해결|끝|완료|passed|resolved|done|secured)/.test(lower);
}

function detectRiskSignals(text: string): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  if (/(강행|rush|force|밀어붙)/.test(lower)) {
    pushSignal(out, "risk:rush");
  }
  if (/(협박|위협|attack|폭력|때리)/.test(lower)) {
    pushSignal(out, "risk:aggressive");
  }
  if (/(잠입|침투|속이|deceive|sneak)/.test(lower)) {
    pushSignal(out, "risk:deception");
  }
  return out;
}

function scoreActionCandidates(text: string, allowedActions: string[]): Array<{ actionId: string; score: number }> {
  const lower = text.toLowerCase();
  const scores = new Map<string, number>();

  const addScore = (actionId: string, delta: number) => {
    if (!allowedActions.includes(actionId)) {
      return;
    }
    scores.set(actionId, clamp((scores.get(actionId) ?? 0) + delta, 0, 1));
  };

  if (/(조사|살핀|탐색|inspect|observe|look)/.test(lower)) addScore("action.observe", 0.8);
  if (/(이동|간다|전진|advance|move|travel)/.test(lower)) addScore("action.move", 0.85);
  if (/(대기|기다|멈추|hold|wait)/.test(lower)) addScore("action.wait", 0.8);
  if (/(대화|말|질문|talk|ask|speak)/.test(lower)) addScore("action.talk", 0.82);
  if (/(강행|돌파|rush|force|push)/.test(lower)) addScore("action.rush", 0.9);

  if (scores.size === 0) {
    const deterministic = mapFreeInputToActionDeterministic(text);
    if (deterministic !== "action.unknown" && allowedActions.includes(deterministic)) {
      addScore(deterministic, 0.55);
    }
  }

  return Array.from(scores.entries())
    .map(([actionId, score]) => ({ actionId, score: clamp(score, 0, 1) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

function heuristicIntentOutput(input: IntentAnalyzerInput): IntentAnalyzerOutput {
  const normalizedText = input.text.trim().slice(0, 600);
  const extractedSignals = normalizeSignals(normalizedText);
  const candidateActions = scoreActionCandidates(normalizedText, input.context.availableActions);
  const topScore = candidateActions[0]?.score ?? 0;
  const preResolvedClaim = detectPreResolvedClaim(normalizedText);
  const baseConfidence = normalizedText ? 0.35 + topScore * 0.45 : 0;
  const confidence = clamp(preResolvedClaim ? baseConfidence * 0.85 : baseConfidence, 0, 1);

  return {
    contractVersion: LLM_CONTRACT_VERSION,
    intent: scoreToIntentLabel(normalizedText),
    confidence,
    normalizedText,
    extractedSignals,
    candidateActions,
    riskSignals: detectRiskSignals(normalizedText),
    preResolvedClaim,
  };
}

function axisDeltaTemplate(): DriftAxisVector {
  return emptyDriftAxisVector();
}

function addAxis(delta: DriftAxisVector, axis: keyof DriftAxisVector, amount: number): void {
  delta[axis] = clamp(delta[axis] + amount, -1, 1);
}

function heuristicDriftOutput(input: PersonaDriftAnalyzerInput): PersonaDriftAnalyzerOutput {
  const textBlob = input.recentFreeInputs.join(" ").toLowerCase();
  const delta = axisDeltaTemplate();
  const signals: string[] = [];

  if (/(고마|감사|도와|함께|친절|thank|help)/.test(textBlob)) {
    addAxis(delta, "warmth", 0.22);
    addAxis(delta, "altruism", 0.18);
    pushSignal(signals, "warmth-up");
  }
  if (/(강행|돌파|밀어|rush|force|push)/.test(textBlob)) {
    addAxis(delta, "boldness", 0.26);
    addAxis(delta, "caution", -0.16);
    pushSignal(signals, "boldness-up");
  }
  if (/(조심|신중|대기|wait|careful|slow)/.test(textBlob)) {
    addAxis(delta, "caution", 0.24);
    addAxis(delta, "boldness", -0.12);
    pushSignal(signals, "caution-up");
  }
  if (/(위협|공격|때리|협박|attack|threat)/.test(textBlob)) {
    addAxis(delta, "aggression", 0.3);
    addAxis(delta, "warmth", -0.12);
    pushSignal(signals, "aggression-up");
  }
  if (/(농담|웃|joke|lol|haha|funny)/.test(textBlob)) {
    addAxis(delta, "humor", 0.24);
    pushSignal(signals, "humor-up");
  }

  for (const classification of input.recentClassifications.slice(-3)) {
    if (classification === "reckless") {
      addAxis(delta, "boldness", 0.05);
      addAxis(delta, "caution", -0.04);
    }
    if (classification === "currently_impossible") {
      addAxis(delta, "caution", 0.04);
    }
  }

  const magnitude = DRIFT_AXES.reduce((sum, axis) => sum + Math.abs(delta[axis]), 0);
  const confidence = clamp(0.2 + magnitude * 0.25, 0, 0.9);

  return {
    contractVersion: LLM_CONTRACT_VERSION,
    confidence,
    driftDelta: delta,
    dominantSignals: signals.slice(0, 6),
    notes: ["behavioral-drift-classifier-v1"],
  };
}

export function validateIntentAnalyzerOutput(value: unknown): IntentAnalyzerOutput | null {
  return isIntentAnalyzerOutput(value) ? value : null;
}

export function validatePersonaDriftAnalyzerOutput(value: unknown): PersonaDriftAnalyzerOutput | null {
  return isPersonaDriftAnalyzerOutput(value) ? value : null;
}

export function buildIntentAnalyzerInput(params: {
  session: SessionState;
  freeInput: string;
  locale?: string;
}): IntentAnalyzerInput {
  const loop = params.session.deterministicLoop;
  return {
    contractVersion: LLM_CONTRACT_VERSION,
    sessionId: params.session.sessionId,
    sceneId: params.session.sceneId,
    text: params.freeInput.trim().slice(0, 600),
    locale: params.locale,
    inputKind: "free_sentence",
    context: {
      scenePhase: loop.scene.phase,
      pressure: loop.scene.pressure,
      npcAvailable: loop.scene.npcAvailable,
      ongoingActionKind: loop.ongoingAction?.kind ?? null,
      availableActions: loop.actionPalette.map((entry) => entry.actionId).slice(0, 12),
      lastMappedActionId: loop.intentInertia.lastMappedActionId,
    },
  };
}

export function buildPersonaDriftAnalyzerInput(params: { session: SessionState; nowIso?: string }): PersonaDriftAnalyzerInput {
  const loop = params.session.deterministicLoop;
  const nowIso = params.nowIso ?? new Date().toISOString();
  const expiresAt = loop.analyzerMemory.expiresAtIso ? Date.parse(loop.analyzerMemory.expiresAtIso) : NaN;
  const now = Date.parse(nowIso);
  const cacheExpired = Number.isFinite(expiresAt) && Number.isFinite(now) ? expiresAt <= now : false;

  const recentFreeInputs = cacheExpired ? [] : loop.analyzerMemory.recentFreeInputs.slice(-8);
  const recentResolvedActions = cacheExpired ? [] : loop.analyzerMemory.recentResolvedActions.slice(-8);
  const recentClassifications = cacheExpired ? [] : loop.analyzerMemory.recentClassifications.slice(-8);

  return {
    contractVersion: LLM_CONTRACT_VERSION,
    sessionId: params.session.sessionId,
    sceneId: params.session.sceneId,
    recentFreeInputs,
    recentResolvedActions,
    recentClassifications,
    currentBehavioralDrift: loop.behavioralDrift.drift,
    coreIdentityRef: loop.behavioralDrift.coreIdentity,
  };
}

export function selectStructuredActionIntent(params: {
  deterministicActionId: DeterministicActionId;
  availableActions: string[];
  analyzerOutput: IntentAnalyzerOutput | null;
  inertia: IntentInertiaState;
}): StructuredIntentSelection {
  const available = new Set(params.availableActions);
  const actionScores = new Map<string, number>();

  for (const actionId of available) {
    actionScores.set(actionId, 0);
  }

  const deterministicCandidate =
    params.deterministicActionId !== "action.unknown" && available.has(params.deterministicActionId)
      ? params.deterministicActionId
      : null;
  if (deterministicCandidate) {
    actionScores.set(deterministicCandidate, (actionScores.get(deterministicCandidate) ?? 0) + 0.7);
  }

  const analyzer = params.analyzerOutput;
  let analyzerWeight = analyzer
    ? clamp(((analyzer.confidence - INTENT_CONFIDENCE_LOW) / (1 - INTENT_CONFIDENCE_LOW)) * 0.55, 0, 0.55)
    : 0;

  // preResolvedClaim is warning-only. It cannot authorize success, so we cap analyzer influence.
  const preResolvedClaimUntrusted = analyzer?.preResolvedClaim === true;
  if (preResolvedClaimUntrusted) {
    analyzerWeight = Math.min(analyzerWeight, 0.15);
  }

  if (analyzer && analyzerWeight > 0) {
    for (const candidate of analyzer.candidateActions) {
      if (!available.has(candidate.actionId)) {
        continue;
      }
      const prev = actionScores.get(candidate.actionId) ?? 0;
      actionScores.set(candidate.actionId, prev + candidate.score * analyzerWeight);
    }
  }

  if (params.inertia.lastMappedActionId && available.has(params.inertia.lastMappedActionId)) {
    const inertiaBonus = clamp(params.inertia.streakCount * 0.03, 0, 0.12) * (1 - analyzerWeight);
    const prev = actionScores.get(params.inertia.lastMappedActionId) ?? 0;
    actionScores.set(params.inertia.lastMappedActionId, prev + inertiaBonus);
  }

  const conservative = chooseConservativeFallback(params.availableActions, params.inertia.lastMappedActionId);
  let selectedActionId = deterministicCandidate ?? conservative.actionId;
  let selectedScore = actionScores.get(selectedActionId) ?? 0;
  let fallbackStrategy: StructuredIntentSelection["fallbackStrategy"] = conservative.strategy;

  for (const [actionId, score] of actionScores.entries()) {
    if (score > selectedScore) {
      selectedActionId = actionId;
      selectedScore = score;
      fallbackStrategy = "none";
    }
  }

  const analyzerLowConfidence = !analyzer || analyzer.confidence < INTENT_CONFIDENCE_LOW;
  if (!deterministicCandidate && analyzerLowConfidence) {
    selectedActionId = conservative.actionId;
    selectedScore = Math.max(selectedScore, 0.28);
    fallbackStrategy = conservative.strategy;
  }

  if (deterministicCandidate && selectedScore < 0.42) {
    selectedActionId = deterministicCandidate;
    selectedScore = actionScores.get(deterministicCandidate) ?? 0.7;
    fallbackStrategy = "none";
  }

  const source: "deterministic" | "analyzer" =
    analyzerWeight >= 0.2 && analyzer !== null && analyzer.confidence >= INTENT_CONFIDENCE_HIGH && selectedActionId !== deterministicCandidate
      ? "analyzer"
      : "deterministic";

  const confidence = clamp(0.2 + selectedScore * 0.7, 0, 1);

  return {
    actionId: selectedActionId,
    source,
    confidence,
    analyzerWeight,
    fallbackStrategy,
    preResolvedClaimUntrusted,
    analyzerOutput: analyzer,
  };
}

export function updateIntentInertia(params: {
  current: IntentInertiaState;
  selectedActionId: string;
  selectedConfidence: number;
  source: "deterministic" | "analyzer";
}): IntentInertiaState {
  const streakCount =
    params.current.lastMappedActionId && params.current.lastMappedActionId === params.selectedActionId
      ? params.current.streakCount + 1
      : 1;

  return {
    lastMappedActionId: params.selectedActionId,
    streakCount,
    smoothedConfidence: clamp(params.current.smoothedConfidence * 0.8 + params.selectedConfidence * 0.2, 0, 1),
    lastSource: params.source,
  };
}

export function accumulateBehavioralDrift(params: {
  current: BehavioralDriftState;
  analyzerOutput: PersonaDriftAnalyzerOutput | null;
  nowIso: string;
}): BehavioralDriftState {
  if (!params.analyzerOutput) {
    return {
      ...params.current,
      drift: {
        warmth: clamp(params.current.drift.warmth * DRIFT_DECAY, -1, 1),
        boldness: clamp(params.current.drift.boldness * DRIFT_DECAY, -1, 1),
        caution: clamp(params.current.drift.caution * DRIFT_DECAY, -1, 1),
        altruism: clamp(params.current.drift.altruism * DRIFT_DECAY, -1, 1),
        aggression: clamp(params.current.drift.aggression * DRIFT_DECAY, -1, 1),
        humor: clamp(params.current.drift.humor * DRIFT_DECAY, -1, 1),
      },
      lastUpdatedAtIso: params.nowIso,
    };
  }

  const gain = DRIFT_GAIN * clamp(params.analyzerOutput.confidence, 0, 1);
  return {
    coreIdentity: params.current.coreIdentity,
    drift: {
      warmth: clamp(params.current.drift.warmth * DRIFT_DECAY + params.analyzerOutput.driftDelta.warmth * gain, -1, 1),
      boldness: clamp(
        params.current.drift.boldness * DRIFT_DECAY + params.analyzerOutput.driftDelta.boldness * gain,
        -1,
        1,
      ),
      caution: clamp(params.current.drift.caution * DRIFT_DECAY + params.analyzerOutput.driftDelta.caution * gain, -1, 1),
      altruism: clamp(
        params.current.drift.altruism * DRIFT_DECAY + params.analyzerOutput.driftDelta.altruism * gain,
        -1,
        1,
      ),
      aggression: clamp(
        params.current.drift.aggression * DRIFT_DECAY + params.analyzerOutput.driftDelta.aggression * gain,
        -1,
        1,
      ),
      humor: clamp(params.current.drift.humor * DRIFT_DECAY + params.analyzerOutput.driftDelta.humor * gain, -1, 1),
    },
    lastUpdatedAtIso: params.nowIso,
  };
}

export class RuleBasedIntentAnalyzer implements IntentAnalyzer {
  constructor(private readonly invoker?: AnalyzerModelInvoker) {}

  async analyze(input: IntentAnalyzerInput): Promise<IntentAnalyzerOutput> {
    const fallback = heuristicIntentOutput(input);

    if (!this.invoker) {
      return fallback;
    }

    try {
      const prompt = promptEnvelope("intent_analyzer_v1", input);
      const raw = await this.invoker.inferJson(prompt);
      const validated = validateIntentAnalyzerOutput(raw);
      return validated ?? fallback;
    } catch {
      return fallback;
    }
  }
}

export class RuleBasedPersonaDriftAnalyzer implements PersonaDriftAnalyzer {
  constructor(private readonly invoker?: AnalyzerModelInvoker) {}

  async analyze(input: PersonaDriftAnalyzerInput): Promise<PersonaDriftAnalyzerOutput> {
    const fallback = heuristicDriftOutput(input);

    if (!this.invoker) {
      return fallback;
    }

    try {
      const prompt = promptEnvelope("persona_drift_analyzer_v1", input);
      const raw = await this.invoker.inferJson(prompt);
      const validated = validatePersonaDriftAnalyzerOutput(raw);
      return validated ?? fallback;
    } catch {
      return fallback;
    }
  }
}

export function rememberFreeInputTrace(params: {
  current: {
    recentFreeInputs: string[];
    recentResolvedActions: string[];
    recentClassifications: ActionFeasibility[];
    lastIntentSignals: string[];
    expiresAtIso: string | null;
  };
  freeInput: string;
  resolvedActionId: string;
  classification: ActionFeasibility;
  intentSignals: string[];
  nowIso: string;
  ttlSec?: number;
}): {
  recentFreeInputs: string[];
  recentResolvedActions: string[];
  recentClassifications: ActionFeasibility[];
  lastIntentSignals: string[];
  expiresAtIso: string | null;
} {
  const nextInputs = [...params.current.recentFreeInputs, readString(params.freeInput)].filter(Boolean).slice(-8);
  const nextActions = [...params.current.recentResolvedActions, params.resolvedActionId].filter(Boolean).slice(-8);
  const nextClassifications = [...params.current.recentClassifications, params.classification].slice(-8);
  const lastIntentSignals = params.intentSignals.slice(0, 8);
  const ttlSec = Math.max(60, Math.trunc(params.ttlSec ?? DEFAULT_ANALYZER_MEMORY_TTL_SEC));
  const expiresAtIso = addSecondsToIso(params.nowIso, ttlSec);

  return {
    recentFreeInputs: nextInputs,
    recentResolvedActions: nextActions,
    recentClassifications: nextClassifications,
    lastIntentSignals,
    expiresAtIso,
  };
}

export function deterministicActionFromFreeInput(text: string): DeterministicActionId {
  return mapFreeInputToActionDeterministic(text);
}

export function freezeCoreIdentity(core: BehavioralAxisVector): BehavioralAxisVector {
  return {
    warmth: clamp(core.warmth, -1, 1),
    boldness: clamp(core.boldness, -1, 1),
    caution: clamp(core.caution, -1, 1),
    altruism: clamp(core.altruism, -1, 1),
    aggression: clamp(core.aggression, -1, 1),
    humor: clamp(core.humor, -1, 1),
  };
}
