import path from "node:path";
import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import {
  assertAgentAllowed,
  parseTrpgRuntimeConfig,
  resolveWorldRootForContext,
  type TrpgRuntimeConfig,
} from "../../config.js";
import type { RuntimeBootstrapLoadResult } from "../../runtime-core/contracts.js";
import { createCheckpoint0RuntimeEngine } from "../../runtime-core/runtime-engine.js";
import { RuleBasedIntentAnalyzer, RuleBasedPersonaDriftAnalyzer } from "../../runtime-core/analyzer-lane.js";
import { RuleBasedQuestHookTextRenderer } from "../../runtime-core/hook-lane.js";
import { NoopQuestHookTextRenderer, NoopSceneRenderer } from "../../runtime-core/noop-lane.js";
import {
  buildCheckpoint1Panel,
  collectPanelRouteActionIds,
  parsePanelCustomId,
  type PanelMessageMode,
} from "../../runtime-core/panel-mvp.js";
import { buildQuestEconomyQualitativeSummary } from "../../runtime-core/quest-economy.js";
import { buildTemporalQualitativeSummary } from "../../runtime-core/temporal-systems.js";
import { ensureDeterministicSceneLoopState } from "../../runtime-core/scene-loop.js";
import { buildRuntimeBootstrapInput, validateWorldSeed } from "../../runtime-core/world-seed.js";
import { appendTraceEvent, createTraceEvent, ensureTraceState } from "../../runtime-core/trace.js";
import { JsonFileStateStore } from "../../runtime-store/file-state-store.js";
import { ensureRuntimeMetadata, type InteractionRouteRecord, type SessionState } from "../../runtime-core/types.js";
import { loadStructuredWorldFile } from "../../world-store.js";

const CHECKPOINT0_STORE_RELATIVE_PATH = "state/runtime-core";
const WORLD_SEED_CANDIDATE_PATHS = [
  "canon/world-seed.yaml",
  "canon/world-seed.yml",
  "canon/world-seed.json",
  "state/world-seed.yaml",
  "state/world-seed.yml",
  "state/world-seed.json",
  "state/world-seeds.yaml",
  "state/world-seeds.yml",
  "state/world-seeds.json",
] as const;

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
    dispatchId: { type: "string" },
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

function runtimeError(params: {
  command?: string;
  errorCode: string;
  message: string;
  recoverable?: boolean;
  recoveryHint?: string;
}): Record<string, unknown> {
  return {
    ok: false,
    command: params.command,
    errorCode: params.errorCode,
    error: params.message,
    recoverable: params.recoverable ?? true,
    recoveryHint: params.recoveryHint,
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

function toSeedDiagnostics(
  issues: Array<{ code: string; message: string; path: string; severity: "warn" | "error" }>,
  sourcePath: string,
): RuntimeBootstrapLoadResult["diagnostics"] {
  return issues.slice(0, 24).map((issue) => ({
    code: issue.code,
    message: issue.message,
    path: issue.path ? `${sourcePath}${issue.path}` : sourcePath,
    severity: issue.severity,
  }));
}

async function loadRuntimeBootstrapFromWorldSeed(params: {
  worldRoot: string;
  cfg: TrpgRuntimeConfig;
}): Promise<RuntimeBootstrapLoadResult> {
  for (const candidatePath of WORLD_SEED_CANDIDATE_PATHS) {
    let loaded;
    try {
      loaded = await loadStructuredWorldFile(params.worldRoot, candidatePath, {
        allowMissing: true,
        maxReadBytes: params.cfg.maxReadBytes,
      });
    } catch (error) {
      return {
        status: "error",
        sourcePath: candidatePath,
        bootstrap: null,
        diagnostics: [
          {
            code: "world_seed_load_error",
            message: error instanceof Error ? error.message : String(error),
            path: candidatePath,
            severity: "error",
          },
        ],
      };
    }

    if (!loaded.exists) {
      continue;
    }

    const validated = validateWorldSeed(loaded.parsed);
    if (!validated.ok) {
      return {
        status: "invalid",
        sourcePath: candidatePath,
        bootstrap: null,
        diagnostics: toSeedDiagnostics(validated.issues, candidatePath),
      };
    }

    return {
      status: "used",
      sourcePath: candidatePath,
      bootstrap: buildRuntimeBootstrapInput(validated.seed),
      diagnostics: toSeedDiagnostics(validated.issues, candidatePath),
    };
  }

  return {
    status: "missing",
    sourcePath: null,
    bootstrap: null,
    diagnostics: [],
  };
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
  const runtimeMetadata = ensureRuntimeMetadata((session as Record<string, unknown>).runtimeMetadata);
  const sceneId = deterministicLoop.scene.sceneId;
  const ownerId = readString((session as Record<string, unknown>).ownerId) || "owner:unknown";
  const actionSeq = Math.max(
    0,
    readInteger((session as Record<string, unknown>).actionSeq) ?? 0,
    readInteger((session as Record<string, unknown>).turnIndex) ?? 0,
  );
  const turnIndex = readInteger((session as Record<string, unknown>).turnIndex) ?? 0;
  const lastActionId = readString((session as Record<string, unknown>).lastActionId) || null;
  const lastActionSummary = readString((session as Record<string, unknown>).lastActionSummary) || null;
  const normalized: SessionState = {
    ...session,
    sceneId,
    ownerId,
    actionSeq,
    turnIndex: actionSeq || turnIndex,
    lastActionId,
    lastActionSummary,
    deterministicLoop,
    runtimeMetadata,
    panelDispatch: {
      pending: session.panelDispatch?.pending ?? null,
      committedDispatchIds: Array.isArray(session.panelDispatch?.committedDispatchIds)
        ? session.panelDispatch.committedDispatchIds.filter((entry): entry is string => typeof entry === "string").slice(-32)
        : [],
    },
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

  return ensureTraceState(normalized);
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

function createRuntimeContext(worldRoot: string, cfg: TrpgRuntimeConfig) {
  const storeRoot = path.resolve(worldRoot, CHECKPOINT0_STORE_RELATIVE_PATH);
  const store = new JsonFileStateStore(storeRoot);
  const questHookTextRenderer = cfg.richHookTextEnabled
    ? new RuleBasedQuestHookTextRenderer()
    : new NoopQuestHookTextRenderer();
  const engine = createCheckpoint0RuntimeEngine({
    store,
    intentAnalyzer: new RuleBasedIntentAnalyzer(),
    personaDriftAnalyzer: new RuleBasedPersonaDriftAnalyzer(),
    sceneRenderer: new NoopSceneRenderer(),
    questHookTextRenderer,
    richHookTextEnabled: cfg.richHookTextEnabled,
    hookTextTimeoutMs: cfg.hookTextTimeoutMs,
    hookTextCacheTtlSec: cfg.hookTextCacheTtlSec,
    traceMaxEvents: cfg.traceMaxEvents,
    analyzerMemoryTtlSec: cfg.analyzerMemoryTtlSec,
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

function markDispatchExpired(session: SessionState, nowIso: string): SessionState {
  if (!session.panelDispatch.pending) {
    return session;
  }

  const pending = session.panelDispatch.pending;
  const next = {
    ...session,
    panelDispatch: {
      ...session.panelDispatch,
      pending: {
        ...pending,
        status: "expired" as const,
      },
    },
  };

  return appendTraceEvent(
    next,
    createTraceEvent({
      lane: "adapter",
      type: "panel.commit.expired",
      tsIso: nowIso,
      severity: "warn",
      recoverable: true,
      code: "dispatch_expired",
      data: {
        dispatchId: pending.dispatchId,
        expiresAtIso: pending.expiresAtIso,
      },
    }),
  );
}

function markDispatchCommitted(params: {
  session: SessionState;
  dispatchId: string;
  messageId: string | null;
  nowIso: string;
}): SessionState {
  const previousIds = params.session.panelDispatch.committedDispatchIds.slice(-31);
  const committedDispatchIds = [...previousIds, params.dispatchId];

  const pending = params.session.panelDispatch.pending;
  const next = {
    ...params.session,
    panelDispatch: {
      pending: null,
      committedDispatchIds,
    },
  };

  return appendTraceEvent(
    next,
    createTraceEvent({
      lane: "adapter",
      type: "panel.commit.success",
      tsIso: params.nowIso,
      data: {
        dispatchId: params.dispatchId,
        messageId: params.messageId,
      },
    }),
  );
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

function createDispatchId(): string {
  return `disp-${randomUUID()}`;
}

function isPendingDispatchExpired(session: SessionState, nowIso: string): boolean {
  const pending = session.panelDispatch.pending;
  if (!pending || pending.status !== "prepared") {
    return false;
  }
  const expiresAt = Date.parse(pending.expiresAtIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(now)) {
    return false;
  }
  return expiresAt <= now;
}

function hasCommittedDispatch(session: SessionState, dispatchId: string): boolean {
  return session.panelDispatch.committedDispatchIds.includes(dispatchId);
}

type PreparedPanelDispatch = {
  session: SessionState;
  payload: Record<string, unknown>;
};

function preparePanelDispatch(params: {
  session: SessionState;
  routes: InteractionRouteRecord[];
  nowIso: string;
  mode?: PanelMessageMode;
  errorHint?: string;
  dispatchTtlSec: number;
  debugRuntimeSignals: boolean;
}): PreparedPanelDispatch {
  const mode: PanelMessageMode =
    params.mode ?? (params.session.panels.main.messageId ? "edit" : "send");
  const loop = params.session.deterministicLoop;
  const availableButtons = collectPanelRouteActionIds(params.session).filter(
    (actionId) => actionId !== "action.free_input.submit",
  );
  const dispatchId = createDispatchId();
  const expiresAtIso = new Date(Date.parse(params.nowIso) + Math.max(30, params.dispatchTtlSec) * 1_000).toISOString();

  const panel = buildCheckpoint1Panel({
    session: params.session,
    routes: params.routes,
    mode,
    errorHint: params.errorHint,
    debugRuntimeSignals: params.debugRuntimeSignals,
  });
  const temporalSummary = buildTemporalQualitativeSummary({
    temporal: loop.temporal,
    locationId: loop.scene.locationId,
  });
  const questSummary = buildQuestEconomyQualitativeSummary({
    economy: loop.questEconomy,
    locationId: loop.scene.locationId,
  });
  const temporalSummaryPayload = params.debugRuntimeSignals
    ? temporalSummary
    : {
        memory: temporalSummary.memory,
        traces: temporalSummary.traces,
        freshness: temporalSummary.freshness,
        location: temporalSummary.location,
      };
  const questSummaryPayload = params.debugRuntimeSignals
    ? questSummary
    : {
        actionable: {
          activeCount: questSummary.actionable.activeCount,
          surfacedCount: questSummary.actionable.surfacedCount,
          activeTop: questSummary.actionable.activeTop
            ? {
                slotKey: questSummary.actionable.activeTop.slotKey,
                questId: questSummary.actionable.activeTop.questId,
                lifecycle: questSummary.actionable.activeTop.lifecycle,
                urgencyBand: questSummary.actionable.activeTop.urgencyBand,
                text:
                  questSummary.actionable.activeTop.llmShortText ??
                  questSummary.actionable.activeTop.defaultText,
              }
            : null,
          surfacedTop: questSummary.actionable.surfacedTop.map((slot) => ({
            slotKey: slot.slotKey,
            questId: slot.questId,
            lifecycle: slot.lifecycle,
            urgencyBand: slot.urgencyBand,
            text: slot.llmShortText ?? slot.defaultText,
          })),
        },
        worldPulse: {
          text: questSummary.worldPulse.text,
          trend: questSummary.worldPulse.topPressure?.trend ?? null,
        },
        recentOutcomes: questSummary.recentOutcomes.items.map((entry) => entry.text),
      };

  const preparedSession = appendTraceEvent(
    {
      ...params.session,
      panelDispatch: {
        pending: {
          dispatchId,
          preparedAtIso: params.nowIso,
          expiresAtIso,
          uiVersion: params.session.uiVersion,
          sceneId: params.session.sceneId,
          mode,
          status: "prepared",
          messageId: params.session.panels.main.messageId,
        },
        committedDispatchIds: params.session.panelDispatch.committedDispatchIds.slice(-32),
      },
    },
    createTraceEvent({
      lane: "adapter",
      type: "panel.dispatch.prepared",
      tsIso: params.nowIso,
      data: {
        dispatchId,
        mode,
        uiVersion: params.session.uiVersion,
        sceneId: params.session.sceneId,
      },
    }),
  );

  const payload = {
    sourceOfTruth: "state-store",
    panel: {
      fixed: {
        sessionId: params.session.sessionId,
        ownerId: params.session.ownerId,
        sceneId: params.session.sceneId,
        locationId: loop.scene.locationId,
        uiVersion: params.session.uiVersion,
        status: params.session.status,
        worldNowIso: loop.time.worldNowIso,
        worldElapsedSec: loop.time.worldElapsedSec,
      },
      main: {
        actionSeq: params.session.actionSeq,
        legacyTurnIndex: params.session.turnIndex,
        lastActionSummary: params.session.lastActionSummary,
        beatId: loop.beat.beatId,
        exchangeId: loop.exchange?.exchangeId ?? null,
        deltaTimeSec: loop.time.lastDeltaSec,
        temporalSummary: temporalSummaryPayload,
        questSummary: questSummaryPayload,
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
      dispatchId,
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
        dispatchId,
        messageId: "<discord_message_id>",
      },
    },
  };

  return {
    session: preparedSession,
    payload,
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

          const runtime = createRuntimeContext(gate.worldRoot, cfg);
          const seedBootstrap = await loadRuntimeBootstrapFromWorldSeed({
            worldRoot: gate.worldRoot,
            cfg,
          });
          const result = await runtime.engine.startNewSession({
            channelKey,
            ownerId,
            initialSceneId: sceneId || undefined,
            runtimeBootstrap: seedBootstrap.bootstrap,
            runtimeBootstrapDiagnostics: seedBootstrap.diagnostics,
          });
          const session = normalizeSession(result.session);
          const nowIso = new Date().toISOString();
          const prepared = preparePanelDispatch({
            session,
            routes: result.routes,
            mode: "send",
            nowIso,
            dispatchTtlSec: cfg.panelDispatchTtlSec,
            debugRuntimeSignals: cfg.debugRuntimeSignals,
          });
          await runtime.store.upsertSession(prepared.session);

          const payload = {
            ok: true,
            command: "/trpg new",
            storeRoot: runtime.storeRoot,
            session: prepared.session,
            routes: result.routes,
            seedBootstrap: {
              status: seedBootstrap.status,
              sourcePath: seedBootstrap.sourcePath,
              used: seedBootstrap.status === "used",
              diagnostics: seedBootstrap.diagnostics,
            },
            ...prepared.payload,
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
          const runtime = createRuntimeContext(gate.worldRoot, cfg);
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
          const nowIso = new Date().toISOString();
          const prepared = preparePanelDispatch({
            session,
            routes: resumed.routes,
            mode: session.panels.main.messageId ? "edit" : "send",
            errorHint: forceRecreate ? "강제 재생성 모드: 새 메시지로 패널을 다시 올려야 한다." : undefined,
            nowIso,
            dispatchTtlSec: cfg.panelDispatchTtlSec,
            debugRuntimeSignals: cfg.debugRuntimeSignals,
          });
          await runtime.store.upsertSession(prepared.session);

          const payload = {
            ok: true,
            command: "/trpg resume",
            storeRoot: runtime.storeRoot,
            session: prepared.session,
            recoveryPlan: resumed.recoveryPlan,
            routes: resumed.routes,
            ...prepared.payload,
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
          const runtime = createRuntimeContext(gate.worldRoot, cfg);
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
          const nowIso = new Date().toISOString();
          const prepared = preparePanelDispatch({
            session,
            routes: [],
            mode: session.panels.main.messageId ? "edit" : "send",
            nowIso,
            dispatchTtlSec: cfg.panelDispatchTtlSec,
            debugRuntimeSignals: cfg.debugRuntimeSignals,
          });
          await runtime.store.upsertSession(prepared.session);

          const payload = {
            ok: true,
            command: "/trpg end",
            storeRoot: runtime.storeRoot,
            session: prepared.session,
            removedRouteCount: result.removedRouteCount,
            ...prepared.payload,
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
          let routeKey: { sessionId: string; uiVersion: number; sceneId: string; actionId: string };
          try {
            routeKey = resolveRouteInput(input);
          } catch {
            return jsonToolResult(
              runtimeError({
                command: "panel-interaction",
                errorCode: "invalid_custom_id",
                message: "Invalid interaction routing key.",
                recoverable: true,
                recoveryHint: "Run /trpg resume to regenerate interaction routes.",
              }),
            );
          }
          const freeInput = readString(input.freeInput) || undefined;
          const runtime = createRuntimeContext(gate.worldRoot, cfg);

          const routePreview = await runtime.engine.resolveInteractionRoute({
            ...routeKey,
            consume: false,
          });

          if (!routePreview) {
            return jsonToolResult(
              runtimeError({
                command: "panel-interaction",
                errorCode: "route_expired",
                message: "Expired or invalid interaction route.",
                recoverable: true,
                recoveryHint: "Run /trpg resume to regenerate panel routes.",
              }),
            );
          }

          const loadedSession = await runtime.store.readSession(routePreview.sessionId);
          if (!loadedSession) {
            return jsonToolResult(
              runtimeError({
                command: "panel-interaction",
                errorCode: "session_missing",
                message: "Session not found for route key.",
                recoverable: true,
                recoveryHint: "Run /trpg resume to recreate panel state.",
              }),
            );
          }

          let session = normalizeSession(loadedSession);
          const nowIso = new Date().toISOString();
          session = appendTraceEvent(
            session,
            createTraceEvent({
              lane: "adapter",
              type: "interaction.received",
              tsIso: nowIso,
              data: {
                routeKey,
                actorId,
              },
            }),
          );

          if (isPendingDispatchExpired(session, nowIso)) {
            session = markDispatchExpired(session, nowIso);
            await runtime.store.upsertSession(session);
          }

          if (routePreview.uiVersion !== session.uiVersion) {
            session = appendTraceEvent(
              session,
              createTraceEvent({
                lane: "adapter",
                type: "interaction.rejected",
                tsIso: nowIso,
                severity: "warn",
                code: "stale_ui_version",
                recoverable: true,
                data: {
                  routeUiVersion: routePreview.uiVersion,
                  sessionUiVersion: session.uiVersion,
                },
              }),
            );
            await runtime.store.upsertSession(session);
            return jsonToolResult(
              runtimeError({
                command: "panel-interaction",
                errorCode: "stale_ui_version",
                message: "Interaction is stale because uiVersion no longer matches session state.",
                recoverable: true,
                recoveryHint: "Run /trpg resume to refresh panel buttons.",
              }),
            );
          }

          if (routePreview.sceneId !== session.sceneId) {
            session = appendTraceEvent(
              session,
              createTraceEvent({
                lane: "adapter",
                type: "interaction.rejected",
                tsIso: nowIso,
                severity: "warn",
                code: "stale_scene",
                recoverable: true,
                data: {
                  routeSceneId: routePreview.sceneId,
                  sessionSceneId: session.sceneId,
                },
              }),
            );
            await runtime.store.upsertSession(session);
            return jsonToolResult(
              runtimeError({
                command: "panel-interaction",
                errorCode: "stale_scene",
                message: "Interaction scene key is stale.",
                recoverable: true,
                recoveryHint: "Run /trpg resume to regenerate action routes.",
              }),
            );
          }

          const ownerCheck = assertOwner(session, actorId);
          if (!ownerCheck.ok) {
            session = appendTraceEvent(
              session,
              createTraceEvent({
                lane: "adapter",
                type: "interaction.rejected",
                tsIso: nowIso,
                severity: "warn",
                code: "owner_mismatch",
                recoverable: false,
                data: {
                  actorId,
                  ownerId: session.ownerId,
                },
              }),
            );
            await runtime.store.upsertSession(session);
            return jsonToolResult(
              runtimeError({
                command: "panel-interaction",
                errorCode: "owner_mismatch",
                message: ownerCheck.error,
                recoverable: false,
              }),
            );
          }

          if (session.status !== "active") {
            session = appendTraceEvent(
              session,
              createTraceEvent({
                lane: "adapter",
                type: "interaction.rejected",
                tsIso: nowIso,
                severity: "warn",
                code: "session_ended",
                recoverable: true,
                data: {
                  status: session.status,
                },
              }),
            );
            await runtime.store.upsertSession(session);
            return jsonToolResult(
              runtimeError({
                command: "panel-interaction",
                errorCode: "session_ended",
                message: "Session is not active.",
                recoverable: true,
                recoveryHint: "Run /trpg new to start another session.",
              }),
            );
          }

          const route = await runtime.engine.resolveInteractionRoute({
            ...routeKey,
            consume: true,
          });
          if (!route) {
            session = appendTraceEvent(
              session,
              createTraceEvent({
                lane: "adapter",
                type: "interaction.rejected",
                tsIso: nowIso,
                severity: "warn",
                code: "route_consumed",
                recoverable: true,
                data: {
                  routeKey,
                },
              }),
            );
            await runtime.store.upsertSession(session);
            return jsonToolResult(
              runtimeError({
                command: "panel-interaction",
                errorCode: "route_consumed",
                message: "Interaction route was already consumed.",
                recoverable: true,
                recoveryHint: "Run /trpg resume to refresh panel buttons.",
              }),
            );
          }

          session = appendTraceEvent(
            session,
            createTraceEvent({
              lane: "adapter",
              type: "interaction.consumed",
              tsIso: nowIso,
              data: {
                actionId: route.actionId,
                uiVersion: route.uiVersion,
                sceneId: route.sceneId,
              },
            }),
          );

          const processed = await runtime.engine.processSceneAction({
            session,
            routeActionId: routePreview.actionId,
            freeInput,
          });
          const updated = normalizeSession(processed.session);
          await runtime.store.upsertSession(updated);

          const resumed = await runtime.engine.resumeSession({ sessionId: updated.sessionId });
          if (!resumed) {
            return jsonToolResult(
              runtimeError({
                command: "panel-interaction",
                errorCode: "panel_refresh_failed",
                message: "Interaction succeeded but panel refresh failed.",
                recoverable: true,
                recoveryHint: "Run /trpg resume.",
              }),
            );
          }

          const nextSession = normalizeSession(resumed.session);
          const mode: PanelMessageMode = nextSession.panels.main.messageId ? "edit" : "send";
          const prepared = preparePanelDispatch({
            session: nextSession,
            routes: resumed.routes,
            mode,
            errorHint:
              mode === "send"
                ? "기존 messageId가 없어서 새 패널 전송이 필요하다. 이후 trpg_panel_message_commit을 호출하라."
                : undefined,
            nowIso,
            dispatchTtlSec: cfg.panelDispatchTtlSec,
            debugRuntimeSignals: cfg.debugRuntimeSignals,
          });
          await runtime.store.upsertSession(prepared.session);

          return jsonToolResult({
            ok: true,
            command: "panel-interaction",
            consumedRoute: route,
            storeRoot: runtime.storeRoot,
            session: prepared.session,
            resolution: processed.resolution,
            routes: resumed.routes,
            ...prepared.payload,
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
          const runtime = createRuntimeContext(gate.worldRoot, cfg);
          const sessionId = readString(input.sessionId);
          const actorId = resolveActorId(input, ctx);
          const dispatchId = readString(input.dispatchId);
          const clear = readBoolean(input.clear, false);
          const messageId = clear ? null : readString(input.messageId);
          const channelMessageRef = readString(input.channelMessageRef) || undefined;
          const uiVersion = readInteger(input.uiVersion) ?? undefined;
          const sceneId = readString(input.sceneId) || undefined;
          const nowIso = new Date().toISOString();

          if (!sessionId) {
            return jsonToolResult(
              runtimeError({
                command: "panel-message-commit",
                errorCode: "invalid_request",
                message: "sessionId is required.",
                recoverable: false,
              }),
            );
          }

          if (!clear && !messageId) {
            return jsonToolResult(
              runtimeError({
                command: "panel-message-commit",
                errorCode: "invalid_request",
                message: "messageId is required unless clear=true.",
                recoverable: false,
              }),
            );
          }

          const existing = await runtime.store.readSession(sessionId);
          if (!existing) {
            return jsonToolResult(
              runtimeError({
                command: "panel-message-commit",
                errorCode: "session_missing",
                message: "Session not found.",
                recoverable: true,
                recoveryHint: "Run /trpg resume or /trpg new.",
              }),
            );
          }

          let session = normalizeSession(existing);
          const ownerCheck = assertOwner(session, actorId);
          if (!ownerCheck.ok) {
            session = appendTraceEvent(
              session,
              createTraceEvent({
                lane: "adapter",
                type: "panel.commit.failed",
                tsIso: nowIso,
                severity: "warn",
                code: "owner_mismatch",
                recoverable: false,
                data: {
                  actorId,
                  ownerId: session.ownerId,
                },
              }),
            );
            await runtime.store.upsertSession(session);
            return jsonToolResult(
              runtimeError({
                command: "panel-message-commit",
                errorCode: "owner_mismatch",
                message: ownerCheck.error,
                recoverable: false,
              }),
            );
          }

          if (dispatchId && hasCommittedDispatch(session, dispatchId)) {
            return jsonToolResult({
              ok: true,
              command: "panel-message-commit",
              idempotent: true,
              dispatchId,
              storeRoot: runtime.storeRoot,
              sourceOfTruth: "state-store",
              session,
            });
          }

          if (isPendingDispatchExpired(session, nowIso)) {
            session = markDispatchExpired(session, nowIso);
            await runtime.store.upsertSession(session);
          }

          const pending = session.panelDispatch.pending;
          if (pending && pending.status === "expired") {
            return jsonToolResult(
              runtimeError({
                command: "panel-message-commit",
                errorCode: "dispatch_expired",
                message: "Pending panel dispatch is expired.",
                recoverable: true,
                recoveryHint: "Run /trpg resume to prepare fresh dispatch.",
              }),
            );
          }

          if (pending && !dispatchId) {
            session = appendTraceEvent(
              session,
              createTraceEvent({
                lane: "adapter",
                type: "panel.commit.failed",
                tsIso: nowIso,
                severity: "warn",
                code: "dispatch_required",
                recoverable: true,
                data: {
                  pendingDispatchId: pending.dispatchId,
                },
              }),
            );
            await runtime.store.upsertSession(session);
            return jsonToolResult(
              runtimeError({
                command: "panel-message-commit",
                errorCode: "dispatch_required",
                message: "dispatchId is required while a pending panel dispatch exists.",
                recoverable: true,
                recoveryHint: "Use panelCommitTemplate params from latest dispatch payload.",
              }),
            );
          }

          if (dispatchId && pending && pending.dispatchId !== dispatchId) {
            session = appendTraceEvent(
              session,
              createTraceEvent({
                lane: "adapter",
                type: "panel.commit.failed",
                tsIso: nowIso,
                severity: "warn",
                code: "dispatch_mismatch",
                recoverable: true,
                data: {
                  dispatchId,
                  pendingDispatchId: pending.dispatchId,
                },
              }),
            );
            await runtime.store.upsertSession(session);
            return jsonToolResult(
              runtimeError({
                command: "panel-message-commit",
                errorCode: "dispatch_mismatch",
                message: "dispatchId does not match pending panel dispatch.",
                recoverable: true,
                recoveryHint: "Use latest dispatch payload or run /trpg resume.",
              }),
            );
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
            return jsonToolResult(
              runtimeError({
                command: "panel-message-commit",
                errorCode: "session_missing",
                message: "Session disappeared while syncing metadata.",
                recoverable: true,
                recoveryHint: "Run /trpg resume.",
              }),
            );
          }

          const committed = dispatchId
            ? markDispatchCommitted({
                session: normalizeSession(synced),
                dispatchId,
                messageId,
                nowIso,
              })
            : appendTraceEvent(
                normalizeSession(synced),
                createTraceEvent({
                  lane: "adapter",
                  type: "panel.commit.success",
                  tsIso: nowIso,
                  data: {
                    dispatchId: null,
                    messageId,
                  },
                }),
              );

          await runtime.store.upsertSession(committed);

          return jsonToolResult({
            ok: true,
            command: "panel-message-commit",
            dispatchId: dispatchId || null,
            storeRoot: runtime.storeRoot,
            sourceOfTruth: "state-store",
            session: committed,
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
