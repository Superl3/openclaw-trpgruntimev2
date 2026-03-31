import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import type { TrpgRuntimeConfig } from "../../config.js";
import type { PatchCache } from "../../patch-engine.js";
import type { RuntimePhase } from "../../discord-components.js";

export type BootstrapGateResult = {
  bootstrapComplete: boolean;
  justCompleted: boolean;
  runtimePhase: RuntimePhase;
  phaseSignals: Record<string, unknown>;
  contextChunk?: string;
};

export type StatusPanelData = {
  hpCurrent: number | null;
  hpMax: number | null;
  staminaCurrent: number | null;
  staminaMax: number | null;
  stressCurrent: number | null;
  stressMax: number | null;
  money: number | null;
  staminaState: string;
  conditionState: string;
  tags: string[];
  fundsText: string;
  inventoryHighlights: string[];
  carriedItems: string[];
  equippedItems: string[];
  inventoryNotes: string[];
  worldTime: string;
  playerName: string;
  currentGoal: string;
  bootstrapCharacterCreated: boolean;
  bootstrapComplete: boolean;
};

export type ScenePersistenceSignals = {
  interrogation: boolean;
  negotiation: boolean;
  investigation: boolean;
  explicitTransition: boolean;
  pressurePush: boolean;
};

export type SceneIntroGuardResult = {
  introRequired: boolean;
  sceneId: string;
  majorSceneStart: boolean;
};

export type ScenePersistenceState = {
  changed: boolean;
  sceneFlow: Record<string, unknown>;
  signals: ScenePersistenceSignals;
};

export type FastWaitContext = {
  waitApplied: boolean;
  contextChunk?: string;
};

export type TravelTransitionResult = {
  movementIntent: boolean;
  occurred: boolean;
  reason: string;
  contextChunk?: string;
  generatedZone?: boolean;
};

export type SceneTransitionResult = {
  shouldTick: boolean;
  reason: string;
};

export type RegisterBeforePromptBuildHookDeps = {
  isAllowedRuntimeAgent: (cfg: TrpgRuntimeConfig, agentId: string) => boolean;
  resolveWorldRootForContext: (params: {
    cfg: TrpgRuntimeConfig;
    ctx: OpenClawPluginToolContext;
    resolvePath: OpenClawPluginApi["resolvePath"];
  }) => string;
  extractLatestUserMessageFromPrompt: (prompt: string) => string;
  extractLatestUserMessage: (messages: unknown[]) => string;
  sanitizeIntentText: (value: string, maxLength: number) => string;
  runCharacterBootstrapGate: (params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
    agentId: string;
    sessionId?: string;
    patchCache: PatchCache;
    messages: unknown[];
    prompt: string;
  }) => Promise<BootstrapGateResult>;
  applySceneIntroGuard: (params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
  }) => Promise<SceneIntroGuardResult>;
  toObject: (value: unknown) => Record<string, unknown>;
  loadStatusPanelData: (params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
  }) => Promise<StatusPanelData>;
  buildStatusPanelGuardChunk: (params: {
    status: StatusPanelData;
    latestAction: string;
  }) => string;
  buildActionFeasibilityGuardChunk: (params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
    messages: unknown[];
    prompt: string;
    sceneParsed?: unknown;
    statusPanelData?: StatusPanelData;
  }) => Promise<string>;
  applyScenePersistenceDefaults: (params: {
    sceneParsed: Record<string, unknown>;
    latestAction: string;
  }) => ScenePersistenceState;
  buildScenePersistenceGuardChunk: (params: {
    sceneParsed: unknown;
    latestAction: string;
    sceneFlow: Record<string, unknown>;
    signals: ScenePersistenceSignals;
  }) => string;
  buildNpcVisibilityGuardChunk: (sceneParsed: Record<string, unknown>) => string;
  applyLightweightEconomyUpdate: (params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
    latestAction: string;
  }) => Promise<{ contextChunk?: string }>;
  updateAndBuildNpcMemoryChunk: (params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
    sceneParsed: Record<string, unknown>;
    latestAction: string;
  }) => Promise<string>;
  applyFastWaitV1: (params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
    latestAction: string;
    prompt: string;
  }) => Promise<FastWaitContext>;
  runTravelMovement: (params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
    messages: unknown[];
    prompt: string;
  }) => Promise<TravelTransitionResult>;
  detectSceneTransition: (params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
    guard: SceneIntroGuardResult;
    travelTransition?: TravelTransitionResult;
  }) => Promise<SceneTransitionResult>;
  isNpcMemoryRelevantAction: (latestAction: string) => boolean;
};

export type RegisterBeforePromptBuildHookParams = {
  api: OpenClawPluginApi;
  cfg: TrpgRuntimeConfig;
  patchCache: PatchCache;
  deps: RegisterBeforePromptBuildHookDeps;
};
