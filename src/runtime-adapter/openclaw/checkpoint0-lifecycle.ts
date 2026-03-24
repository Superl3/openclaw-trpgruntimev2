import path from "node:path";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import {
  assertAgentAllowed,
  parseTrpgRuntimeConfig,
  resolveWorldRootForContext,
  type TrpgRuntimeConfig,
} from "../../config.js";
import { createCheckpoint0RuntimeEngine } from "../../runtime-core/runtime-engine.js";
import { RuleBasedIntentAnalyzer, RuleBasedPersonaDriftAnalyzer } from "../../runtime-core/analyzer-lane.js";
import { NoopSceneRenderer } from "../../runtime-core/noop-lane.js";
import {
  buildCheckpoint1Panel,
  collectPanelRouteActionIds,
  parsePanelCustomId,
  type PanelMessageMode,
} from "../../runtime-core/panel-mvp.js";
import { ensureDeterministicSceneLoopState } from "../../runtime-core/scene-loop.js";
import { JsonFileStateStore } from "../../runtime-store/file-state-store.js";
import type { InteractionRouteRecord, SessionState } from "../../runtime-core/types.js";

const CHECKPOINT0_STORE_RELATIVE_PATH = "state/runtime-core";

const SESSION_NEW_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    channelKey: { type: "string" },
    ownerId: { type: "string" },
    actorId: { type: "string" },
    sceneId: { type: "string" },
  },
} as const;

const SESSION_RESUME_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    sessionId: { type: "string" },
    channelKey: { type: "string" },
    actorId: { type: "string" },
    forceRecreate: { type: "boolean" },
  },
} as const;

const SESSION_END_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    sessionId: { type: "string" },
    channelKey: { type: "string" },
    actorId: { type: "string" },
    reason: { type: "string" },
  },
} as const;

const PANEL_INTERACT_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    customId: { type: "string" },
    sessionId: { type: "string" },
    uiVersion: { type: "integer" },
    sceneId: { type: "string" },
    actionId: { type: "string" },
    actorId: { type: "string" },
    freeInput: { type: "string" },
  },
} as const;

const PANEL_MESSAGE_COMMIT_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    sessionId: { type: "string" },
    actorId: { type: "string" },
    messageId: { type: "string" },
    channelMessageRef: { type: "string" },
    uiVersion: { type: "integer" },
    sceneId: { type: "string" },
    clear: { type: "boolean" },
  },
  required: ["sessionId"],
} as const;

function jsonToolResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function toObject(value: unknown): Record<string, unknown> {
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

function readInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function resolveChannelKey(params: Record<string, unknown>, ctx: OpenClawPluginToolContext): string {
  const fromParams = readString(params.channelKey);
  if (fromParams) {
    return fromParams;
  }

  const fromContextSession = readString(ctx.sessionId);
  if (fromContextSession) {
    return `session:${fromContextSession}`;
  }

  return "channel:unknown";
}

function resolveActorId(params: Record<string, unknown>, ctx: OpenClawPluginToolContext): string {
  const fromParams = readString(params.actorId);
  if (fromParams) {
    return fromParams;
  }

  const fromContextUser = readString(ctx.userId);
  if (fromContextUser) {
    return fromContextUser;
  }

  const fromContextSession = readString(ctx.sessionId);
  if (fromContextSession) {
    return `session:${fromContextSession}`;
  }

  return "";
}

function resolveOwnerId(params: Record<string, unknown>, ctx: OpenClawPluginToolContext): string {
  const explicitOwner = readString(params.ownerId);
  if (explicitOwner) {
    return explicitOwner;
  }
  return resolveActorId(params, ctx) || "owner:unknown";
}

function normalizeSession(session: SessionState): SessionState {
  const nowIso = readString((session as Record<string, unknown>).updatedAt) || new Date().toISOString();
  const deterministicLoop = ensureDeterministicSceneLoopState((session as Record<string, unknown>).deterministicLoop, {
    sceneId: readString((session as Record<string, unknown>).sceneId) || "scene-bootstrap",
    nowIso,
  });
  const sceneId = deterministicLoop.scene.sceneId;
  const ownerId = readString((session as Record<string, unknown>).ownerId) || "owner:unknown";
  const turnIndex = readInteger((session as Record<string, unknown>).turnIndex) ?? 0;
  const lastActionId = readString((session as Record<string, unknown>).lastActionId) || null;
  const lastActionSummary = readString((session as Record<string, unknown>).lastActionSummary) || null;
  return {
    ...session,
    sceneId,
    ownerId,
    turnIndex,
    lastActionId,
    lastActionSummary,
    deterministicLoop,
    panels: {
      fixed: {
        ...session.panels.fixed,
        sceneId,
      },
      main: {
        ...session.panels.main,
        sceneId,
      },
      sub: {
        ...session.panels.sub,
        sceneId,
      },
    },
  };
}

function createGate(params: {
  cfg: TrpgRuntimeConfig;
  ctx: OpenClawPluginToolContext;
  api: OpenClawPluginApi;
}): { ok: true; worldRoot: string } | { ok: false; payload: Record<string, unknown> } {
  const allowed = assertAgentAllowed(params.cfg, params.ctx);
  if (!allowed.ok) {
    return {
      ok: false,
      payload: {
        ok: false,
        error: allowed.error,
      },
    };
  }

  const worldRoot = resolveWorldRootForContext({
    cfg: params.cfg,
    ctx: params.ctx,
    resolvePath: params.api.resolvePath,
  });

  return {
    ok: true,
    worldRoot,
  };
}

function createRuntimeContext(worldRoot: string) {
  const storeRoot = path.resolve(worldRoot, CHECKPOINT0_STORE_RELATIVE_PATH);
  const store = new JsonFileStateStore(storeRoot);
  const engine = createCheckpoint0RuntimeEngine({
    store,
    intentAnalyzer: new RuleBasedIntentAnalyzer(),
    personaDriftAnalyzer: new RuleBasedPersonaDriftAnalyzer(),
    sceneRenderer: new NoopSceneRenderer(),
  });
  return {
    storeRoot,
    store,
    engine,
  };
}

async function resolveSessionTarget(params: {
  store: JsonFileStateStore;
  sessionId?: string;
  channelKey?: string;
}): Promise<SessionState | null> {
  const byId = params.sessionId ? await params.store.readSession(params.sessionId) : null;
  if (byId) {
    return normalizeSession(byId);
  }
  if (params.channelKey) {
    const byChannel = await params.store.readActiveSessionByChannel(params.channelKey);
    if (byChannel) {
      return normalizeSession(byChannel);
    }
  }
  return null;
}

async function syncMessageMetadata(params: {
  store: JsonFileStateStore;
  sessionId: string;
  messageId: string | null;
  channelMessageRef?: string;
  uiVersion?: number;
  sceneId?: string;
}): Promise<SessionState | null> {
  const loaded = await params.store.readSession(params.sessionId);
  if (!loaded) {
    return null;
  }

  const session = normalizeSession(loaded);

  if (params.uiVersion !== undefined && params.uiVersion !== session.uiVersion) {
    throw new Error(
      `uiVersion mismatch while syncing metadata. expected=${String(session.uiVersion)} actual=${String(params.uiVersion)}`,
    );
  }
  if (params.sceneId && params.sceneId !== session.sceneId) {
    throw new Error(`sceneId mismatch while syncing metadata. expected=${session.sceneId} actual=${params.sceneId}`);
  }

  const nowIso = new Date().toISOString();
  const nextMessageId = params.messageId;
  const nextRef = params.channelMessageRef ?? null;
  const next: SessionState = {
    ...session,
    updatedAt: nowIso,
    panels: {
      fixed: {
        ...session.panels.fixed,
        messageId: nextMessageId,
        channelMessageRef: nextRef,
        lastRenderedAt: nowIso,
      },
      main: {
        ...session.panels.main,
        messageId: nextMessageId,
        channelMessageRef: nextRef,
        lastRenderedAt: nowIso,
      },
      sub: {
        ...session.panels.sub,
        messageId: nextMessageId,
        channelMessageRef: nextRef,
        lastRenderedAt: nowIso,
      },
    },
  };

  await params.store.upsertSession(next);
  return next;
}

function assertOwner(session: SessionState, actorId: string): { ok: true } | { ok: false; error: string } {
  if (!actorId) {
    return {
      ok: false,
      error: "actorId is required for owner-only panel control.",
    };
  }

  if (!session.ownerId || session.ownerId === "owner:unknown") {
    return {
      ok: false,
      error: "Session owner is not set. Create a new session with ownerId.",
    };
  }

  if (session.ownerId !== actorId) {
    return {
      ok: false,
      error: `Only session owner can control panel. ownerId=${session.ownerId} actorId=${actorId}`,
    };
  }

  return { ok: true };
}

function panelDispatchPayload(params: {
  session: SessionState;
  routes: InteractionRouteRecord[];
  mode?: PanelMessageMode;
  errorHint?: string;
}) {
  const mode: PanelMessageMode =
    params.mode ?? (params.session.panels.main.messageId ? "edit" : "send");
  const loop = params.session.deterministicLoop;
  const availableButtons = collectPanelRouteActionIds(params.session).filter(
    (actionId) => actionId !== "action.free_input.submit",
  );

  const panel = buildCheckpoint1Panel({
    session: params.session,
    routes: params.routes,
    mode,
    errorHint: params.errorHint,
  });

  return {
    sourceOfTruth: "state-store",
    panel: {
      fixed: {
        sessionId: params.session.sessionId,
        ownerId: params.session.ownerId,
        sceneId: params.session.sceneId,
        uiVersion: params.session.uiVersion,
        status: params.session.status,
        worldNowIso: loop.time.worldNowIso,
        worldElapsedSec: loop.time.worldElapsedSec,
      },
      main: {
        turnIndex: params.session.turnIndex,
        lastActionSummary: params.session.lastActionSummary,
        beatId: loop.beat.beatId,
        exchangeId: loop.exchange?.exchangeId ?? null,
        deltaTimeSec: loop.time.lastDeltaSec,
      },
      sub: {
        availableButtons,
        modalSubmitAction: "action.free_input.submit",
        blockedActions: loop.actionPalette
          .filter((entry) => entry.availability === "currently_impossible" || entry.availability === "impossible")
          .map((entry) => ({ actionId: entry.actionId, reason: entry.reason })),
      },
    },
    panelDispatch: {
      action: panel.mode,
      message: panel.message,
      messageId: panel.messageId,
      components: panel.components,
    },
    panelCommitTemplate: {
      tool: "trpg_panel_message_commit",
      params: {
        sessionId: params.session.sessionId,
        uiVersion: params.session.uiVersion,
        sceneId: params.session.sceneId,
        messageId: "<discord_message_id>",
      },
    },
  };
}

function resolveRouteInput(input: Record<string, unknown>) {
  const customId = readString(input.customId);
  if (customId) {
    const parsed = parsePanelCustomId(customId);
    if (!parsed) {
      throw new Error("Invalid customId format. expected trpg:v1:<sessionId>:<uiVersion>:<sceneId>:<actionId>");
    }
    return parsed;
  }

  const sessionId = readString(input.sessionId);
  const uiVersion = readInteger(input.uiVersion);
  const sceneId = readString(input.sceneId);
  const actionId = readString(input.actionId);
  if (!sessionId || !sceneId || !actionId || !uiVersion || uiVersion < 1) {
    throw new Error("Route key is incomplete. Provide customId or all of sessionId/uiVersion/sceneId/actionId.");
  }

  return {
    sessionId,
    uiVersion,
    sceneId,
    actionId,
  };
}

export function registerCheckpoint0LifecycleTools(api: OpenClawPluginApi): void {
  const cfg = parseTrpgRuntimeConfig(api.pluginConfig);

  api.registerTool(
    (ctx) => ({
      name: "trpg_session_new",
      description:
        "Checkpoint 1 lifecycle entry for /trpg new. Creates owner-scoped session state and returns render payload for panel send.",
      parameters: SESSION_NEW_PARAMETERS,
      async execute(_toolCallId, params) {
        const gate = createGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        try {
          const input = toObject(params);
          const channelKey = resolveChannelKey(input, ctx);
          const ownerId = resolveOwnerId(input, ctx);
          const sceneId = readString(input.sceneId);

          const runtime = createRuntimeContext(gate.worldRoot);
          const result = await runtime.engine.startNewSession({
            channelKey,
            ownerId,
            initialSceneId: sceneId || undefined,
          });
          const session = normalizeSession(result.session);

          const payload = {
            ok: true,
            command: "/trpg new",
            storeRoot: runtime.storeRoot,
            session,
            routes: result.routes,
            ...panelDispatchPayload({
              session,
              routes: result.routes,
              mode: "send",
            }),
          };

          return jsonToolResult(payload);
        } catch (error) {
          return jsonToolResult({
            ok: false,
            command: "/trpg new",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }),
    { name: "trpg_session_new" },
  );

  api.registerTool(
    (ctx) => ({
      name: "trpg_session_resume",
      description:
        "Checkpoint 1 lifecycle entry for /trpg resume. Owner-only restore/recreate flow with uiVersion rotation and panel render payload.",
      parameters: SESSION_RESUME_PARAMETERS,
      async execute(_toolCallId, params) {
        const gate = createGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        try {
          const input = toObject(params);
          const runtime = createRuntimeContext(gate.worldRoot);
          const actorId = resolveActorId(input, ctx);
          const sessionId = readString(input.sessionId) || undefined;
          const channelKey = resolveChannelKey(input, ctx);
          const forceRecreate = readBoolean(input.forceRecreate, false);

          const current = await resolveSessionTarget({
            store: runtime.store,
            sessionId,
            channelKey,
          });

          if (!current || current.status !== "active") {
            return jsonToolResult({
              ok: false,
              command: "/trpg resume",
              error: "No active session found for the given session/channel key.",
            });
          }

          const ownerCheck = assertOwner(current, actorId);
          if (!ownerCheck.ok) {
            return jsonToolResult({
              ok: false,
              command: "/trpg resume",
              error: ownerCheck.error,
            });
          }

          if (forceRecreate) {
            await syncMessageMetadata({
              store: runtime.store,
              sessionId: current.sessionId,
              messageId: null,
            });
          }

          const resumed = await runtime.engine.resumeSession({
            sessionId: current.sessionId,
          });

          if (!resumed) {
            return jsonToolResult({
              ok: false,
              command: "/trpg resume",
              error: "Active session exists but resume failed.",
            });
          }

          const session = normalizeSession(resumed.session);
          const payload = {
            ok: true,
            command: "/trpg resume",
            storeRoot: runtime.storeRoot,
            session,
            recoveryPlan: resumed.recoveryPlan,
            routes: resumed.routes,
            ...panelDispatchPayload({
              session,
              routes: resumed.routes,
              mode: session.panels.main.messageId ? "edit" : "send",
              errorHint: forceRecreate ? "강제 재생성 모드: 새 메시지로 패널을 다시 올려야 한다." : undefined,
            }),
          };

          return jsonToolResult(payload);
        } catch (error) {
          return jsonToolResult({
            ok: false,
            command: "/trpg resume",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }),
    { name: "trpg_session_resume" },
  );

  api.registerTool(
    (ctx) => ({
      name: "trpg_session_end",
      description:
        "Checkpoint 1 lifecycle entry for /trpg end. Owner-only session termination and panel finalization payload.",
      parameters: SESSION_END_PARAMETERS,
      async execute(_toolCallId, params) {
        const gate = createGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        try {
          const input = toObject(params);
          const runtime = createRuntimeContext(gate.worldRoot);
          const actorId = resolveActorId(input, ctx);
          const sessionId = readString(input.sessionId) || undefined;
          const channelKey = resolveChannelKey(input, ctx);
          const reason = readString(input.reason) || undefined;

          const current = await resolveSessionTarget({
            store: runtime.store,
            sessionId,
            channelKey,
          });
          if (!current) {
            return jsonToolResult({
              ok: false,
              command: "/trpg end",
              error: "No target session found.",
            });
          }

          const ownerCheck = assertOwner(current, actorId);
          if (!ownerCheck.ok) {
            return jsonToolResult({
              ok: false,
              command: "/trpg end",
              error: ownerCheck.error,
            });
          }

          const result = await runtime.engine.endSession({
            sessionId: current.sessionId,
            channelKey,
            reason,
          });

          if (!result.session) {
            return jsonToolResult({
              ok: false,
              command: "/trpg end",
              error: "Session not found during end flow.",
            });
          }

          const session = normalizeSession(result.session);
          const payload = {
            ok: true,
            command: "/trpg end",
            storeRoot: runtime.storeRoot,
            session,
            removedRouteCount: result.removedRouteCount,
            ...panelDispatchPayload({
              session,
              routes: [],
              mode: session.panels.main.messageId ? "edit" : "send",
            }),
          };

          return jsonToolResult(payload);
        } catch (error) {
          return jsonToolResult({
            ok: false,
            command: "/trpg end",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }),
    { name: "trpg_session_end" },
  );

  api.registerTool(
    (ctx) => ({
      name: "trpg_panel_interact",
      description:
        "Owner-only panel interaction callback handler. Validates routing key from customId against state store, updates session, and returns edit payload.",
      parameters: PANEL_INTERACT_PARAMETERS,
      async execute(_toolCallId, params) {
        const gate = createGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        try {
          const input = toObject(params);
          const actorId = resolveActorId(input, ctx);
          const routeKey = resolveRouteInput(input);
          const freeInput = readString(input.freeInput) || undefined;
          const runtime = createRuntimeContext(gate.worldRoot);

          const routePreview = await runtime.engine.resolveInteractionRoute({
            ...routeKey,
            consume: false,
          });

          if (!routePreview) {
            return jsonToolResult({
              ok: false,
              error: "Expired or invalid interaction route. Run /trpg resume to regenerate panel routes.",
              brokenPanel: true,
            });
          }

          const loadedSession = await runtime.store.readSession(routePreview.sessionId);
          if (!loadedSession) {
            return jsonToolResult({
              ok: false,
              error: "Session not found for route key.",
              brokenPanel: true,
            });
          }

          const session = normalizeSession(loadedSession);
          const ownerCheck = assertOwner(session, actorId);
          if (!ownerCheck.ok) {
            return jsonToolResult({
              ok: false,
              error: ownerCheck.error,
            });
          }

          if (session.status !== "active") {
            return jsonToolResult({
              ok: false,
              error: "Session is not active. Run /trpg new to start again.",
            });
          }

          const route = await runtime.engine.resolveInteractionRoute({
            ...routeKey,
            consume: true,
          });
          if (!route) {
            return jsonToolResult({
              ok: false,
              error: "Interaction route was already consumed. Run /trpg resume to refresh panel buttons.",
              brokenPanel: true,
            });
          }

          const processed = await runtime.engine.processSceneAction({
            session,
            routeActionId: routePreview.actionId,
            freeInput,
          });
          const updated = normalizeSession(processed.session);
          await runtime.store.upsertSession(updated);

          const resumed = await runtime.engine.resumeSession({ sessionId: updated.sessionId });
          if (!resumed) {
            return jsonToolResult({
              ok: false,
              error: "Interaction succeeded but panel refresh failed. Run /trpg resume.",
              brokenPanel: true,
            });
          }

          const nextSession = normalizeSession(resumed.session);
          const mode: PanelMessageMode = nextSession.panels.main.messageId ? "edit" : "send";

          return jsonToolResult({
            ok: true,
            command: "panel-interaction",
            consumedRoute: route,
            storeRoot: runtime.storeRoot,
            session: nextSession,
            resolution: processed.resolution,
            routes: resumed.routes,
            ...panelDispatchPayload({
              session: nextSession,
              routes: resumed.routes,
              mode,
              errorHint:
                mode === "send"
                  ? "기존 messageId가 없어서 새 패널 전송이 필요하다. 이후 trpg_panel_message_commit을 호출하라."
                  : undefined,
            }),
          });
        } catch (error) {
          return jsonToolResult({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }),
    { name: "trpg_panel_interact" },
  );

  api.registerTool(
    (ctx) => ({
      name: "trpg_panel_message_commit",
      description:
        "Commit panel message metadata into state store after a message send/edit operation. Required for resume and update/edit loops.",
      parameters: PANEL_MESSAGE_COMMIT_PARAMETERS,
      async execute(_toolCallId, params) {
        const gate = createGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        try {
          const input = toObject(params);
          const runtime = createRuntimeContext(gate.worldRoot);
          const sessionId = readString(input.sessionId);
          const actorId = resolveActorId(input, ctx);
          const clear = readBoolean(input.clear, false);
          const messageId = clear ? null : readString(input.messageId);
          const channelMessageRef = readString(input.channelMessageRef) || undefined;
          const uiVersion = readInteger(input.uiVersion) ?? undefined;
          const sceneId = readString(input.sceneId) || undefined;

          if (!sessionId) {
            return jsonToolResult({
              ok: false,
              error: "sessionId is required.",
            });
          }

          if (!clear && !messageId) {
            return jsonToolResult({
              ok: false,
              error: "messageId is required unless clear=true.",
            });
          }

          const existing = await runtime.store.readSession(sessionId);
          if (!existing) {
            return jsonToolResult({
              ok: false,
              error: "Session not found.",
            });
          }

          const session = normalizeSession(existing);
          const ownerCheck = assertOwner(session, actorId);
          if (!ownerCheck.ok) {
            return jsonToolResult({
              ok: false,
              error: ownerCheck.error,
            });
          }

          const synced = await syncMessageMetadata({
            store: runtime.store,
            sessionId,
            messageId,
            channelMessageRef,
            uiVersion,
            sceneId,
          });

          if (!synced) {
            return jsonToolResult({
              ok: false,
              error: "Session disappeared while syncing metadata.",
            });
          }

          return jsonToolResult({
            ok: true,
            command: "panel-message-commit",
            storeRoot: runtime.storeRoot,
            sourceOfTruth: "state-store",
            session: synced,
          });
        } catch (error) {
          return jsonToolResult({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }),
    { name: "trpg_panel_message_commit" },
  );

  api.logger.info(
    "[trpg-runtime] checkpoint1 lifecycle tools registered: trpg_session_new, trpg_session_resume, trpg_session_end, trpg_panel_interact, trpg_panel_message_commit",
  );
}
