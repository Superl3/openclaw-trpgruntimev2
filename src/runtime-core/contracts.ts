import type {
  IntentAnalyzerInput,
  IntentAnalyzerOutput,
  PersonaDriftAnalyzerInput,
  PersonaDriftAnalyzerOutput,
  SceneRendererInput,
  SceneRendererOutput,
} from "./llm-contracts.js";
import type {
  EndSessionResult,
  InteractionRouteKey,
  InteractionRouteRecord,
  NewSessionResult,
  ResumeSessionResult,
  SessionState,
} from "./types.js";
import type { DeterministicActionResolution } from "./scene-loop.js";

export interface IntentAnalyzer {
  analyze(input: IntentAnalyzerInput): Promise<IntentAnalyzerOutput>;
}

export interface PersonaDriftAnalyzer {
  analyze(input: PersonaDriftAnalyzerInput): Promise<PersonaDriftAnalyzerOutput>;
}

export interface SceneRenderer {
  render(input: SceneRendererInput): Promise<SceneRendererOutput>;
}

export interface StateStore {
  readSession(sessionId: string): Promise<SessionState | null>;
  readActiveSessionByChannel(channelKey: string): Promise<SessionState | null>;
  upsertSession(session: SessionState): Promise<void>;

  upsertInteractionRoute(route: InteractionRouteRecord): Promise<void>;
  readInteractionRoute(key: InteractionRouteKey): Promise<InteractionRouteRecord | null>;
  consumeInteractionRoute(key: InteractionRouteKey, consumedAt: string): Promise<InteractionRouteRecord | null>;
  deleteRoutesForSession(sessionId: string): Promise<number>;
  listRoutesForSession(sessionId: string, uiVersion?: number): Promise<InteractionRouteRecord[]>;
}

export interface Clock {
  nowIso(): string;
}

export interface IdGenerator {
  newSessionId(): string;
  newActionId(): string;
}

export type StartNewSessionInput = {
  channelKey: string;
  ownerId: string;
  initialSceneId?: string;
};

export type ResumeSessionInput = {
  channelKey?: string;
  sessionId?: string;
};

export type EndSessionInput = {
  channelKey?: string;
  sessionId?: string;
  reason?: string;
};

export type BindInteractionRouteInput = {
  sessionId: string;
  uiVersion: number;
  sceneId: string;
  actionId?: string;
  payload?: Record<string, unknown>;
};

export type ResolveInteractionRouteInput = InteractionRouteKey & {
  consume?: boolean;
};

export type ProcessSceneActionInput = {
  session: SessionState;
  routeActionId: string;
  freeInput?: string;
};

export type ProcessSceneActionResult = {
  session: SessionState;
  resolution: DeterministicActionResolution;
};

export interface RuntimeEngine {
  startNewSession(input: StartNewSessionInput): Promise<NewSessionResult>;
  resumeSession(input: ResumeSessionInput): Promise<ResumeSessionResult | null>;
  endSession(input: EndSessionInput): Promise<EndSessionResult>;

  bindInteractionRoute(input: BindInteractionRouteInput): Promise<InteractionRouteRecord>;
  resolveInteractionRoute(input: ResolveInteractionRouteInput): Promise<InteractionRouteRecord | null>;
  processSceneAction(input: ProcessSceneActionInput): Promise<ProcessSceneActionResult>;

  analyzeIntent(input: IntentAnalyzerInput): Promise<IntentAnalyzerOutput>;
  analyzePersonaDrift(input: PersonaDriftAnalyzerInput): Promise<PersonaDriftAnalyzerOutput>;
  renderScene(input: SceneRendererInput): Promise<SceneRendererOutput>;
}
