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

export type RuntimeTraceEventType =
  | "session.new"
  | "session.resume"
  | "session.end"
  | "interaction.received"
  | "interaction.rejected"
  | "interaction.consumed"
  | "analyzer.intent.used"
  | "analyzer.intent.fallback"
  | "analyzer.intent.rejected"
  | "analyzer.drift.used"
  | "analyzer.drift.fallback"
  | "analyzer.drift.rejected"
  | "panel.dispatch.prepared"
  | "panel.commit.success"
  | "panel.commit.failed"
  | "panel.commit.expired"
  | "engine.time.advanced"
  | "engine.temporal.updated"
  | "engine.pressure.advanced"
  | "engine.quest.lifecycle"
  | "engine.action.resolved";

export type RuntimeTraceEvent = {
  traceId: string;
  tsIso: string;
  lane: "adapter" | "engine" | "analyzer" | "store";
  type: RuntimeTraceEventType;
  severity: "info" | "warn" | "error";
  code?: string;
  recoverable?: boolean;
  data: Record<string, unknown>;
};

export type RuntimeTraceState = {
  maxEvents: number;
  events: RuntimeTraceEvent[];
};

export type PendingPanelDispatchState = {
  dispatchId: string;
  preparedAtIso: string;
  expiresAtIso: string;
  uiVersion: number;
  sceneId: string;
  mode: "send" | "edit";
  status: "prepared" | "committed" | "expired" | "failed";
  messageId: string | null;
};

export type PanelDispatchState = {
  pending: PendingPanelDispatchState | null;
  committedDispatchIds: string[];
};

export type SessionState = {
  schemaVersion: typeof RUNTIME_SCHEMA_VERSION;
  sessionId: string;
  channelKey: string;
  ownerId: string;
  status: SessionStatus;
  sceneId: string;
  uiVersion: number;
  actionSeq: number;
  /**
   * @deprecated Compatibility-only legacy field; use actionSeq.
   */
  turnIndex: number;
  lastActionId: string | null;
  lastActionSummary: string | null;
  deterministicLoop: DeterministicSceneLoopState;
  panelDispatch: PanelDispatchState;
  trace: RuntimeTraceState;
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
