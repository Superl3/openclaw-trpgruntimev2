import type { DeterministicSceneLoopState } from "./scene-loop.js";

export const RUNTIME_SCHEMA_VERSION = 1 as const;

export type SessionStatus = "active" | "ended";

export type PanelId = "fixed" | "main" | "sub";

export type PanelMetadata = {
  panelId: PanelId;
  uiVersion: number;
  sceneId: string;
  messageId: string | null;
  channelMessageRef: string | null;
  lastRenderedAt: string | null;
};

export type SessionState = {
  schemaVersion: typeof RUNTIME_SCHEMA_VERSION;
  sessionId: string;
  channelKey: string;
  ownerId: string;
  status: SessionStatus;
  sceneId: string;
  uiVersion: number;
  turnIndex: number;
  lastActionId: string | null;
  lastActionSummary: string | null;
  deterministicLoop: DeterministicSceneLoopState;
  panels: Record<PanelId, PanelMetadata>;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
};

export type InteractionRouteKey = {
  sessionId: string;
  uiVersion: number;
  sceneId: string;
  actionId: string;
};

export type InteractionRouteRecord = InteractionRouteKey & {
  createdAt: string;
  consumedAt: string | null;
  payload: Record<string, unknown>;
};

export type PanelRecoveryMode = "recreate" | "refresh";

export type PanelRecoveryInstruction = {
  panelId: PanelId;
  mode: PanelRecoveryMode;
  messageId: string | null;
  uiVersion: number;
  sceneId: string;
  routeKey: InteractionRouteKey;
};

export type NewSessionResult = {
  session: SessionState;
  routes: InteractionRouteRecord[];
};

export type ResumeSessionResult = {
  session: SessionState;
  recoveryPlan: PanelRecoveryInstruction[];
  routes: InteractionRouteRecord[];
};

export type EndSessionResult = {
  session: SessionState | null;
  removedRouteCount: number;
};

export function makeInteractionRouteStorageKey(key: InteractionRouteKey): string {
  return `${key.sessionId}::${String(key.uiVersion)}::${key.sceneId}::${key.actionId}`;
}
