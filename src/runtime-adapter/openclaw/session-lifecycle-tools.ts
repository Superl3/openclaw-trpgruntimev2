import path from "node:path";
import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import {
  assertAgentAllowed,
  parseTrpgRuntimeConfig,
  resolveWorldRootForContext,
  type TrpgRuntimeConfig,
} from "../../config.js";
import { createCheckpoint0RuntimeEngine } from "../../runtime-core/runtime-engine.js";
import { RuleBasedIntentAnalyzer, RuleBasedPersonaDriftAnalyzer } from "../../runtime-core/analyzer-lane.js";
import { RuleBasedQuestHookTextRenderer } from "../../runtime-core/hook-lane.js";
import { NoopQuestHookTextRenderer, NoopSceneRenderer } from "../../runtime-core/noop-lane.js";
import {
  buildCheckpoint1Panel,
  collectPanelRouteActionIds,
  type PanelMessageMode,
} from "../../runtime-core/panel-mvp.js";
import { buildQuestEconomyQualitativeSummary } from "../../runtime-core/quest-economy.js";
import { buildTemporalQualitativeSummary } from "../../runtime-core/temporal-systems.js";
import { ensureDeterministicSceneLoopState } from "../../runtime-core/scene-loop.js";
import { createRuntimeCanonicalProvenance } from "../../runtime-core/sync-meta.js";
import { appendTraceEvent, createTraceEvent, ensureTraceState } from "../../runtime-core/trace.js";
import { JsonFileStateStore } from "../../runtime-store/file-state-store.js";
import {
  ensureSessionPresentationState,
  ensureRuntimeMetadata,
  type InteractionRouteRecord,
  type SessionState,
} from "../../runtime-core/types.js";
import {
  SESSION_DATA_SECTIONS,
  consumeSessionResetConfirmation,
  copySectionData,
  deleteSectionDataFromWorkspace,
  ensureSessionWorkspace,
  issueSessionResetConfirmation,
  readSessionWorkspaceRecord,
  wipeSessionWorkspace,
} from "../../runtime-core/session-workspaces.js";
import {
  PANEL_INTERACT_PARAMETERS,
  PANEL_MESSAGE_COMMIT_PARAMETERS,
  SESSION_END_PARAMETERS,
  SESSION_HELP_PARAMETERS,
  SESSION_NEW_PARAMETERS,
  SESSION_RESUME_PARAMETERS,
  SESSION_SECTION_TOOL_PARAMETERS,
  SESSION_VERBOSE_PARAMETERS,
} from "./session-lifecycle-tool-schemas.js";
import {
  buildNewConfirmationActionHints,
  buildSessionResumeActionComponents,
  buildSessionStartActionComponents,
  buildVisibleCommandHints,
  resolveActorId,
  resolveChannelKey,
  resolveOwnerId,
  resolveSectionList,
  resolveSessionContextId,
} from "./lifecycle-tool-helpers.js";
import { jsonToolResult, runtimeError } from "./lifecycle-response-helpers.js";
import {
  clampTraceTailCount,
  readBoolean,
  readInteger,
  readString,
  sanitizeLegacyBootstrapTemplateText,
  toObject,
  traceTailPayload,
} from "./session-lifecycle-local-helpers.js";
import {
  loadRuntimeBootstrapFromWorldSeed,
  loadRuntimeCanonicalProvenance,
} from "./session-lifecycle-bootstrap-loaders.js";
import {
  parsePanelMessageCommitInput,
  resolvePanelRouteInput,
  type PanelRouteKey,
  validatePanelMessageCommitInput,
} from "./session-lifecycle-panel-helpers.js";

const CHECKPOINT0_STORE_RELATIVE_PATH = "state/runtime-core";
const NEW_CONFIRM_TOKEN_TTL_MS = 5 * 60 * 1000;

function normalizeSession(session: SessionState): SessionState {
  const nowIso = readString((session as Record<string, unknown>).updatedAt) || new Date().toISOString();
  const deterministicLoop = ensureDeterministicSceneLoopState((session as Record<string, unknown>).deterministicLoop, {
    sceneId: readString((session as Record<string, unknown>).sceneId) || "scene-bootstrap",
    nowIso,
  });
  const runtimeMetadata = ensureRuntimeMetadata((session as Record<string, unknown>).runtimeMetadata);
  const presentation = ensureSessionPresentationState((session as Record<string, unknown>).presentation);
  const sceneId = deterministicLoop.scene.sceneId;
  const ownerId = readString((session as Record<string, unknown>).ownerId) || "owner:unknown";
  const actionSeq = Math.max(
    0,
    readInteger((session as Record<string, unknown>).actionSeq) ?? 0,
    readInteger((session as Record<string, unknown>).turnIndex) ?? 0,
  );
  const turnIndex = readInteger((session as Record<string, unknown>).turnIndex) ?? 0;
  const lastActionId = readString((session as Record<string, unknown>).lastActionId) || null;
  const lastActionSummary =
    sanitizeLegacyBootstrapTemplateText(readString((session as Record<string, unknown>).lastActionSummary)) || null;
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
    presentation,
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
  const runtimeSafetyFlags = cfg.runtimeSafetyFlags;
  const richHookTextEnabled = runtimeSafetyFlags.richHookActionableEnabled || runtimeSafetyFlags.richHookWorldPulseEnabled;
  const questHookTextRenderer = richHookTextEnabled
    ? new RuleBasedQuestHookTextRenderer()
    : new NoopQuestHookTextRenderer();
  const engine = createCheckpoint0RuntimeEngine({
    store,
    intentAnalyzer: new RuleBasedIntentAnalyzer(),
    personaDriftAnalyzer: new RuleBasedPersonaDriftAnalyzer(),
    sceneRenderer: new NoopSceneRenderer(),
    questHookTextRenderer,
    richHookTextEnabled,
    hookTextTimeoutMs: cfg.hookTextTimeoutMs,
    hookTextCacheTtlSec: cfg.hookTextCacheTtlSec,
    traceMaxEvents: cfg.traceMaxEvents,
    analyzerMemoryTtlSec: cfg.analyzerMemoryTtlSec,
    runtimeSafetyFlags,
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

async function resolveSessionWorkspaceGuard(params: {
  canonicalWorldRoot: string;
  sessionContextId: string;
  runtime: ReturnType<typeof createRuntimeContext>;
  actorId: string;
  command: string;
  sessionId?: string;
  channelKey?: string;
}): Promise<
  | {
      ok: true;
      current: SessionState;
      workspaceRoot: string;
    }
  | {
      ok: false;
      payload: Record<string, unknown>;
    }
> {
  const current = await resolveSessionTarget({
    store: params.runtime.store,
    sessionId: params.sessionId,
    channelKey: params.channelKey,
  });

  if (!current || current.status !== "active") {
    return {
      ok: false,
      payload: runtimeError({
        command: params.command,
        errorCode: "session_missing",
        message: "No active session found for the given session/channel key.",
        recoverable: true,
        recoveryHint: "Run /trpg new to create a fresh session.",
      }),
    };
  }

  const ownerCheck = assertOwner(current, params.actorId);
  if (!ownerCheck.ok) {
    return {
      ok: false,
      payload: runtimeError({
        command: params.command,
        errorCode: "owner_mismatch",
        message: ownerCheck.error,
        recoverable: false,
      }),
    };
  }

  const workspace = await readSessionWorkspaceRecord({
    canonicalWorldRoot: params.canonicalWorldRoot,
    sessionContextId: params.sessionContextId,
  });
  if (!workspace?.workspaceRoot) {
    return {
      ok: false,
      payload: runtimeError({
        command: params.command,
        errorCode: "workspace_missing",
        message: "No temp workspace is mapped for this session context.",
        recoverable: true,
        recoveryHint: "Run /trpg new to initialize temp workspace first.",
      }),
    };
  }

  return {
    ok: true,
    current,
    workspaceRoot: workspace.workspaceRoot,
  };
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
  runtimeSafetyFlags: TrpgRuntimeConfig["runtimeSafetyFlags"];
}): PreparedPanelDispatch {
  const mode: PanelMessageMode =
    params.mode ?? (params.session.panels.main.messageId ? "edit" : "send");
  const loop = params.session.deterministicLoop;
  const verboseMode = params.session.presentation.verboseMode === true || params.runtimeSafetyFlags.traceVerbose;
  const debugRuntimeSignals = params.runtimeSafetyFlags.debugRuntimeSignals && verboseMode;
  const telemetryExtended = params.runtimeSafetyFlags.telemetryExtended;
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
    debugRuntimeSignals,
    behavioralDriftEnabled: params.runtimeSafetyFlags.behavioralDriftEnabled,
    anchorLifecycleEnabled: params.runtimeSafetyFlags.anchorLifecycleEnabled,
    anchorSummaryOnly: params.runtimeSafetyFlags.anchorSummaryOnly,
    telemetryExtended,
    canonicalSyncEnabled: params.runtimeSafetyFlags.canonicalSyncEnabled,
    recommendationWhimEnabled: params.runtimeSafetyFlags.recommendationWhimEnabled,
    verboseMode,
  });
  const temporalSummary = buildTemporalQualitativeSummary({
    temporal: loop.temporal,
    locationId: loop.scene.locationId,
  });
  const questSummary = buildQuestEconomyQualitativeSummary({
    economy: loop.questEconomy,
    locationId: loop.scene.locationId,
  });
  const temporalSummaryPayload = debugRuntimeSignals
    ? temporalSummary
    : {
        memory: temporalSummary.memory,
        traces: temporalSummary.traces,
        freshness: temporalSummary.freshness,
        location: temporalSummary.location,
      };
  const questSummaryPayload = debugRuntimeSignals && telemetryExtended
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

  const panelDispatchMessage = panel.message;

  const panelInternal = {
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
      dataManagementGuide: {
        text: "데이터 관리 명령 안내: /trpg save · /trpg load · /trpg data-delete",
        helpCommand: "/trpg help",
      },
      blockedActions: loop.actionPalette
        .filter((entry) => entry.availability === "currently_impossible" || entry.availability === "impossible")
        .map((entry) => ({ actionId: entry.actionId, reason: entry.reason })),
    },
  };

  const playerView = {
    knowledgeScope: "player_known",
    message: panelDispatchMessage,
    components: panel.components,
  };

  const payload = {
    sourceOfTruth: "state-store",
    visibilityContract: {
      internalContextKey: "panelInternal",
      displayContextKey: "playerView",
      displayPolicy: "player_known",
      rules: [
        "Only playerView.message/components are player-visible output.",
        "panelInternal/verbose are internal runtime context and must not be shown verbatim.",
      ],
    },
    panel: panelInternal,
    panelInternal,
    playerView,
    panelDispatch: {
      action: panel.mode,
      dispatchId,
      message: panelDispatchMessage,
      messageId: panel.messageId,
      components: panel.components,
    },
    panelMessageTemplate: {
      tool: "message",
      params: {
        action: panel.mode,
        message: panelDispatchMessage,
        ...(panel.messageId ? { messageId: panel.messageId } : {}),
        components: panel.components,
      },
      guidance: [
        "To provide a rich narrative scene with dynamic colors, use the 'trpg_scene_components' tool instead of this fallback.",
        "If you use this template, send panelMessageTemplate.params as-is without adding markdown text.",
        "Do not rewrite components.modal.fields[*].type.",
      ],
    },
    verbose: {
      enabled: verboseMode,
      source: params.session.presentation.verboseMode ? "session" : "global",
      traceTail: verboseMode ? traceTailPayload(preparedSession, 6, true) : [],
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

function registerSessionHelpTool(api: OpenClawPluginApi): void {
  api.registerTool(
    (_ctx) => ({
      name: "trpg_session_help",
      description: "Checkpoint 1 command guide for /trpg help. Returns visible command list and minimal usage examples.",
      parameters: SESSION_HELP_PARAMETERS,
      async execute() {
        return jsonToolResult({
          ok: true,
          command: "/trpg help",
          commandHints: buildVisibleCommandHints(),
        });
      },
    }),
    { name: "trpg_session_help" },
  );
}

function registerSessionNewTool(params: {
  api: OpenClawPluginApi;
  cfg: TrpgRuntimeConfig;
}): void {
  const { api, cfg } = params;

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
          const sessionContextId = resolveSessionContextId(input, ctx, channelKey);
          const confirmReset = readBoolean(input.confirmReset, false);
          const confirmToken = readString(input.confirmToken);
          const wipeMode = readString(input.wipeMode) === "force" ? "force" : "ask";

          const runtime = createRuntimeContext(gate.worldRoot, cfg);
          const currentActive = await runtime.store.readActiveSessionByChannel(channelKey);
          const workspaceRecord = await readSessionWorkspaceRecord({
            canonicalWorldRoot: gate.worldRoot,
            sessionContextId,
          });
          const contaminationDetected = Boolean(currentActive) || Boolean(workspaceRecord);
          const autoResetRequested = wipeMode === "force" && !confirmReset;
          const canAutoReset = autoResetRequested && (!currentActive || currentActive.ownerId === ownerId);

          if (contaminationDetected) {
            if (!canAutoReset && !confirmReset) {
              const confirmation = await issueSessionResetConfirmation({
                canonicalWorldRoot: gate.worldRoot,
                sessionContextId,
                channelKey,
                ownerId,
                ttlMs: NEW_CONFIRM_TOKEN_TTL_MS,
              });
              return jsonToolResult({
                ok: false,
                command: "/trpg new",
                errorCode: "confirmation_required",
                confirmationRequired: true,
                wipeMode,
                commandHints: buildVisibleCommandHints(),
                contamination: {
                  activeSession: Boolean(currentActive),
                  existingTempWorkspace: Boolean(workspaceRecord),
                },
                confirmToken: confirmation.token,
                confirmExpiresAt: confirmation.expiresAt,
                nextActions: buildNewConfirmationActionHints(confirmation.token),
                actionableComponents: {
                  type: "actions",
                  title: "기존 세션이 있어 확인이 필요합니다.",
                  token: confirmation.token,
                  buttons: [
                    {
                      id: "trpg_new_confirm_yes",
                      label: "YES",
                      style: "danger",
                      tool: "trpg_session_new",
                      params: {
                        confirmReset: true,
                        confirmToken: confirmation.token,
                        wipeMode: "force",
                      },
                    },
                    {
                      id: "trpg_new_confirm_no",
                      label: "NO",
                      style: "secondary",
                      tool: "trpg_session_new",
                      params: {
                        confirmReset: false,
                        wipeMode: "ask",
                      },
                    },
                  ],
                },
                components: {
                  text: "기존 세션이 있어 확인이 필요합니다.",
                  buttons: [
                    {
                      id: "trpg_new_confirm_yes",
                      label: "YES",
                      style: "danger",
                      tool: "trpg_session_new",
                      params: {
                        confirmReset: true,
                        confirmToken: confirmation.token,
                        wipeMode: "force",
                      },
                    },
                    {
                      id: "trpg_new_confirm_no",
                      label: "NO",
                      style: "secondary",
                      tool: "trpg_session_new",
                      params: {
                        confirmReset: false,
                        wipeMode: "ask",
                      },
                    },
                  ],
                },
              });
            }

            if (!canAutoReset) {
              const verified = await consumeSessionResetConfirmation({
                canonicalWorldRoot: gate.worldRoot,
                token: confirmToken,
                sessionContextId,
                channelKey,
                ownerId,
              });
              if (!verified.ok) {
                const refresh = await issueSessionResetConfirmation({
                  canonicalWorldRoot: gate.worldRoot,
                  sessionContextId,
                  channelKey,
                  ownerId,
                  ttlMs: NEW_CONFIRM_TOKEN_TTL_MS,
                });
                return jsonToolResult({
                  ok: false,
                  command: "/trpg new",
                  errorCode: "invalid_confirm_token",
                  error: "confirmToken is invalid, expired, or mismatched with current context.",
                  recoverable: true,
                  recoveryHint: "Use the refreshed YES token from nextActions.",
                  confirmToken: refresh.token,
                  confirmExpiresAt: refresh.expiresAt,
                  nextActions: buildNewConfirmationActionHints(refresh.token),
                  actionableComponents: {
                    type: "actions",
                    title: "토큰이 갱신되었습니다. 아래 버튼으로 다시 확인하세요.",
                    token: refresh.token,
                    buttons: [
                      {
                        id: "trpg_new_confirm_yes",
                        label: "YES",
                        style: "danger",
                        tool: "trpg_session_new",
                        params: {
                          confirmReset: true,
                          confirmToken: refresh.token,
                          wipeMode: "force",
                        },
                      },
                      {
                        id: "trpg_new_confirm_no",
                        label: "NO",
                        style: "secondary",
                        tool: "trpg_session_new",
                        params: {
                          confirmReset: false,
                          wipeMode: "ask",
                        },
                      },
                    ],
                  },
                  components: {
                    text: "토큰이 만료/불일치하여 새 토큰을 발급했습니다.",
                    buttons: [
                      {
                        id: "trpg_new_confirm_yes",
                        label: "YES",
                        style: "danger",
                        tool: "trpg_session_new",
                        params: {
                          confirmReset: true,
                          confirmToken: refresh.token,
                          wipeMode: "force",
                        },
                      },
                      {
                        id: "trpg_new_confirm_no",
                        label: "NO",
                        style: "secondary",
                        tool: "trpg_session_new",
                        params: {
                          confirmReset: false,
                          wipeMode: "ask",
                        },
                      },
                    ],
                  },
                  commandHints: buildVisibleCommandHints(),
                });
              }
            }

            if (currentActive) {
              await runtime.engine.endSession({
                sessionId: currentActive.sessionId,
                channelKey,
                reason: "reset_by_new_confirm",
              });
            }

            await wipeSessionWorkspace({
              canonicalWorldRoot: gate.worldRoot,
              sessionContextId,
            });
          }

          const seedBootstrap = await loadRuntimeBootstrapFromWorldSeed({
            worldRoot: gate.worldRoot,
            cfg,
          });
          const canonicalProvenance = cfg.runtimeSafetyFlags.canonicalSyncEnabled
            ? await loadRuntimeCanonicalProvenance({
                worldRoot: gate.worldRoot,
                cfg,
                seedBootstrap,
              })
            : createRuntimeCanonicalProvenance({
                sourcePolicy: "seed_bootstrap_only",
                worldId: seedBootstrap.bootstrap?.worldId ?? null,
                schemaVersion: seedBootstrap.bootstrap?.schemaVersion ?? null,
                seedSourcePath: seedBootstrap.sourcePath,
                seedFingerprint: seedBootstrap.bootstrap?.seedFingerprint ?? null,
                canonSourcePath: null,
                canonFingerprint: null,
                generatedAtIso: null,
                validatedAtIso: new Date().toISOString(),
                driftStatus: "unknown",
                driftCounts: {
                  addedInSeed: 0,
                  missingInSeed: 0,
                  changedScaffold: 0,
                  incompatible: 0,
                },
              });
          const result = await runtime.engine.startNewSession({
            channelKey,
            ownerId,
            initialSceneId: sceneId || undefined,
            runtimeBootstrap: seedBootstrap.bootstrap,
            runtimeBootstrapDiagnostics: seedBootstrap.diagnostics,
            runtimeCanonicalProvenance: canonicalProvenance,
          });
          const session = normalizeSession(result.session);
          const nowIso = new Date().toISOString();
          const prepared = preparePanelDispatch({
            session,
            routes: result.routes,
            mode: "send",
            nowIso,
            dispatchTtlSec: cfg.panelDispatchTtlSec,
            runtimeSafetyFlags: cfg.runtimeSafetyFlags,
          });
          await runtime.store.upsertSession(prepared.session);
          const workspace = await ensureSessionWorkspace({
            canonicalWorldRoot: gate.worldRoot,
            sessionContextId,
            sessionId: prepared.session.sessionId,
          });

          const payload = {
            ok: true,
            command: "/trpg new",
            commandHints: buildVisibleCommandHints(),
            actionableComponents: buildSessionStartActionComponents(prepared.session.sessionId, ownerId),
            canonicalWorldRoot: gate.worldRoot,
            effectiveWorldRoot: workspace.workspaceRoot,
            storeRoot: runtime.storeRoot,
            workspace: {
              sessionContextId,
              workspaceRoot: workspace.workspaceRoot,
              createdAt: workspace.createdAt,
              updatedAt: workspace.updatedAt,
            },
            session: prepared.session,
            routes: result.routes,
            seedBootstrap: {
              status: seedBootstrap.status,
              sourcePath: seedBootstrap.sourcePath,
              used: seedBootstrap.status === "used",
              diagnostics: seedBootstrap.diagnostics,
            },
            canonicalProvenance,
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
}

function registerSessionVerboseTool(params: {
  api: OpenClawPluginApi;
  cfg: TrpgRuntimeConfig;
}): void {
  const { api, cfg } = params;

  api.registerTool(
    (ctx) => ({
      name: "trpg_session_verbose",
      description:
        "Owner-only verbose toggle for active session. Applies immediately and returns compact trace tail for Discord diagnostics.",
      parameters: SESSION_VERBOSE_PARAMETERS,
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
          const tailCount = clampTraceTailCount(input.tailCount, 6);

          const current = await resolveSessionTarget({
            store: runtime.store,
            sessionId,
            channelKey,
          });

          if (!current || current.status !== "active") {
            return jsonToolResult({
              ok: false,
              command: "/trpg verbose",
              error: "No active session found for the given session/channel key.",
            });
          }

          const ownerCheck = assertOwner(current, actorId);
          if (!ownerCheck.ok) {
            return jsonToolResult({
              ok: false,
              command: "/trpg verbose",
              error: ownerCheck.error,
            });
          }

          const beforeEnabled = current.presentation.verboseMode === true;
          const nextEnabled = typeof input.enabled === "boolean" ? input.enabled : beforeEnabled;
          const nowIso = new Date().toISOString();

          let nextSession: SessionState = current;
          if (beforeEnabled !== nextEnabled) {
            nextSession = appendTraceEvent(
              {
                ...current,
                presentation: {
                  ...current.presentation,
                  verboseMode: nextEnabled,
                },
                updatedAt: nowIso,
              },
              createTraceEvent({
                lane: "adapter",
                type: "session.verbose.updated",
                tsIso: nowIso,
                data: {
                  previous: beforeEnabled,
                  current: nextEnabled,
                },
              }),
            );
            await runtime.store.upsertSession(nextSession);
          }

          const effectiveVerbose = nextSession.presentation.verboseMode === true || cfg.runtimeSafetyFlags.traceVerbose;
          return jsonToolResult({
            ok: true,
            command: "/trpg verbose",
            sessionId: nextSession.sessionId,
            changed: beforeEnabled !== nextEnabled,
            verbose: {
              enabled: nextEnabled,
              effectiveVerbose,
              source: nextSession.presentation.verboseMode ? "session" : "global",
            },
            traceTail: traceTailPayload(nextSession, tailCount, effectiveVerbose),
            note: "변경 내용은 동일 세션의 다음 /trpg resume 또는 다음 인터랙션 렌더부터 즉시 반영된다.",
          });
        } catch (error) {
          return jsonToolResult({
            ok: false,
            command: "/trpg verbose",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }),
    { name: "trpg_session_verbose" },
  );
}

function registerSessionEndTool(params: {
  api: OpenClawPluginApi;
  cfg: TrpgRuntimeConfig;
}): void {
  const { api, cfg } = params;

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
            runtimeSafetyFlags: cfg.runtimeSafetyFlags,
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
}

function registerSessionResumeTool(params: {
  api: OpenClawPluginApi;
  cfg: TrpgRuntimeConfig;
}): void {
  const { api, cfg } = params;

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
            runtimeSafetyFlags: cfg.runtimeSafetyFlags,
          });
          await runtime.store.upsertSession(prepared.session);

          const payload = {
            ok: true,
            command: "/trpg resume",
            commandHints: buildVisibleCommandHints(),
            actionableComponents: buildSessionResumeActionComponents(prepared.session.sessionId, actorId),
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
}

function registerSessionSectionDataTools(params: {
  api: OpenClawPluginApi;
  cfg: TrpgRuntimeConfig;
}): void {
  const { api, cfg } = params;

  api.registerTool(
    (ctx) => ({
      name: "trpg_session_save",
      description:
        "Checkpoint 1 utility for /trpg save. Copies selected data sections from temp workspace into canonical world root.",
      parameters: SESSION_SECTION_TOOL_PARAMETERS,
      async execute(_toolCallId, params) {
        const gate = createGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        try {
          const input = toObject(params);
          const runtime = createRuntimeContext(gate.worldRoot, cfg);
          const actorId = resolveActorId(input, ctx);
          const channelKey = resolveChannelKey(input, ctx);
          const sessionId = readString(input.sessionId) || undefined;
          const sessionContextId = resolveSessionContextId(input, ctx, channelKey);
          const sections = resolveSectionList(input.sections);

          const guard = await resolveSessionWorkspaceGuard({
            canonicalWorldRoot: gate.worldRoot,
            sessionContextId,
            runtime,
            actorId,
            command: "/trpg save",
            sessionId,
            channelKey,
          });
          if (!guard.ok) {
            return jsonToolResult(guard.payload);
          }

          const sectionResults = await copySectionData({
            fromWorldRoot: guard.workspaceRoot,
            toWorldRoot: gate.worldRoot,
            sections,
          });

          return jsonToolResult({
            ok: true,
            command: "/trpg save",
            sessionId: guard.current.sessionId,
            sessionContextId,
            canonicalWorldRoot: gate.worldRoot,
            workspaceRoot: guard.workspaceRoot,
            sections,
            sectionResults,
          });
        } catch (error) {
          return jsonToolResult({
            ok: false,
            command: "/trpg save",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }),
    { name: "trpg_session_save" },
  );

  api.registerTool(
    (ctx) => ({
      name: "trpg_session_load",
      description:
        "Checkpoint 1 utility for /trpg load. Copies selected sections from canonical world root back into temp workspace.",
      parameters: SESSION_SECTION_TOOL_PARAMETERS,
      async execute(_toolCallId, params) {
        const gate = createGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        try {
          const input = toObject(params);
          const runtime = createRuntimeContext(gate.worldRoot, cfg);
          const actorId = resolveActorId(input, ctx);
          const channelKey = resolveChannelKey(input, ctx);
          const sessionId = readString(input.sessionId) || undefined;
          const sessionContextId = resolveSessionContextId(input, ctx, channelKey);
          const sections = resolveSectionList(input.sections);

          const guard = await resolveSessionWorkspaceGuard({
            canonicalWorldRoot: gate.worldRoot,
            sessionContextId,
            runtime,
            actorId,
            command: "/trpg load",
            sessionId,
            channelKey,
          });
          if (!guard.ok) {
            return jsonToolResult(guard.payload);
          }

          const sectionResults = await copySectionData({
            fromWorldRoot: gate.worldRoot,
            toWorldRoot: guard.workspaceRoot,
            sections,
          });

          return jsonToolResult({
            ok: true,
            command: "/trpg load",
            sessionId: guard.current.sessionId,
            sessionContextId,
            canonicalWorldRoot: gate.worldRoot,
            workspaceRoot: guard.workspaceRoot,
            sections,
            sectionResults,
          });
        } catch (error) {
          return jsonToolResult({
            ok: false,
            command: "/trpg load",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }),
    { name: "trpg_session_load" },
  );

  api.registerTool(
    (ctx) => ({
      name: "trpg_session_data_delete",
      description:
        "Checkpoint 1 utility for /trpg data-delete. Deletes selected sections from temp workspace without touching canonical files.",
      parameters: SESSION_SECTION_TOOL_PARAMETERS,
      async execute(_toolCallId, params) {
        const gate = createGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        try {
          const input = toObject(params);
          const runtime = createRuntimeContext(gate.worldRoot, cfg);
          const actorId = resolveActorId(input, ctx);
          const channelKey = resolveChannelKey(input, ctx);
          const sessionId = readString(input.sessionId) || undefined;
          const sessionContextId = resolveSessionContextId(input, ctx, channelKey);
          const sections = resolveSectionList(input.sections);

          const guard = await resolveSessionWorkspaceGuard({
            canonicalWorldRoot: gate.worldRoot,
            sessionContextId,
            runtime,
            actorId,
            command: "/trpg data-delete",
            sessionId,
            channelKey,
          });
          if (!guard.ok) {
            return jsonToolResult(guard.payload);
          }

          const sectionResults = await deleteSectionDataFromWorkspace({
            workspaceRoot: guard.workspaceRoot,
            sections,
          });

          return jsonToolResult({
            ok: true,
            command: "/trpg data-delete",
            sessionId: guard.current.sessionId,
            sessionContextId,
            canonicalWorldRoot: gate.worldRoot,
            workspaceRoot: guard.workspaceRoot,
            sections,
            sectionResults,
          });
        } catch (error) {
          return jsonToolResult({
            ok: false,
            command: "/trpg data-delete",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }),
    { name: "trpg_session_data_delete" },
  );
}

function registerPanelInteractionTools(params: {
  api: OpenClawPluginApi;
  cfg: TrpgRuntimeConfig;
}): void {
  const { api, cfg } = params;

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
          let routeKey: PanelRouteKey;
          try {
            routeKey = resolvePanelRouteInput(input);
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
          const actionInput = readString(input.action);
          const speechInput = readString(input.speech);
          const toneInput = readString(input.tone);
          let rawFreeInput = readString(input.freeInput);
          if (!rawFreeInput && (actionInput || speechInput || toneInput)) {
            rawFreeInput = [
              actionInput ? `행동: ${actionInput}` : "",
              speechInput ? `대사: "${speechInput}"` : "",
              toneInput ? `태도: ${toneInput}` : ""
            ].filter(Boolean).join(" | ");
          }
          const freeInput = rawFreeInput || undefined;
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
            runtimeSafetyFlags: cfg.runtimeSafetyFlags,
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
          const actorId = resolveActorId(input, ctx);
          const parsedInput = parsePanelMessageCommitInput(input);
          const { sessionId, dispatchId, clear, messageId, channelMessageRef, uiVersion, sceneId } = parsedInput;
          const nowIso = new Date().toISOString();

          const validation = validatePanelMessageCommitInput(parsedInput);
          if (!validation.ok) {
            return jsonToolResult(
              runtimeError({
                command: "panel-message-commit",
                errorCode: validation.errorCode,
                message: validation.message,
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
}

export function registerSessionLifecycleTools(api: OpenClawPluginApi): void {
  const cfg = parseTrpgRuntimeConfig(api.pluginConfig);

  registerSessionHelpTool(api);
  registerSessionNewTool({ api, cfg });

  registerSessionResumeTool({ api, cfg });

  registerSessionEndTool({ api, cfg });

  registerSessionVerboseTool({ api, cfg });

  registerSessionSectionDataTools({ api, cfg });
  registerPanelInteractionTools({ api, cfg });

  api.logger.info(
    "[trpg-runtime] checkpoint1 lifecycle tools registered: trpg_session_help, trpg_session_new, trpg_session_resume, trpg_session_end, trpg_session_verbose, trpg_session_save, trpg_session_load, trpg_session_data_delete, trpg_panel_interact, trpg_panel_message_commit",
  );
}

export const registerCheckpoint0LifecycleTools = registerSessionLifecycleTools;
