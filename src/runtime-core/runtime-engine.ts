import type {
  BindInteractionRouteInput,
  Clock,
  EndSessionInput,
  IdGenerator,
  IntentAnalyzer,
  ProcessSceneActionInput,
  ProcessSceneActionResult,
  PersonaDriftAnalyzer,
  QuestHookTextRenderer,
  ResolveInteractionRouteInput,
  ResumeSessionInput,
  RuntimeEngine,
  SceneRenderer,
  StartNewSessionInput,
  StateStore,
} from "./contracts.js";
import type {
  QuestHookTextInput,
  QuestHookTextOutput,
  IntentAnalyzerInput,
  IntentAnalyzerOutput,
  PersonaDriftAnalyzerInput,
  PersonaDriftAnalyzerOutput,
  SceneRendererInput,
  SceneRendererOutput,
} from "./llm-contracts.js";
import { LLM_CONTRACT_VERSION, isQuestHookTextOutput } from "./llm-contracts.js";
import {
  accumulateBehavioralDrift,
  buildIntentAnalyzerInput,
  buildPersonaDriftAnalyzerInput,
  deterministicActionFromFreeInput,
  rememberFreeInputTrace,
  selectStructuredActionIntent,
  updateIntentInertia,
  validateIntentAnalyzerOutput,
  validatePersonaDriftAnalyzerOutput,
} from "./analyzer-lane.js";
import { PANEL_MODAL_SUBMIT_ACTION_ID, collectPanelRouteActionIds } from "./panel-mvp.js";
import {
  createInitialDeterministicSceneLoop,
  ensureDeterministicSceneLoopState,
  feasibilityLabel,
  type DeterministicActionId,
  resolveDeterministicSceneAction,
  zeroBehavioralAxisVector,
} from "./scene-loop.js";
import { appendTraceEvent, createTraceEvent, ensureTraceState } from "./trace.js";
import {
  applyQuestHookTextOverrides,
  setQuestHookTextDebugState,
} from "./quest-economy.js";
import {
  RUNTIME_SCHEMA_VERSION,
  type EndSessionResult,
  type InteractionRouteRecord,
  type NewSessionResult,
  type PanelId,
  type PanelRecoveryInstruction,
  type RuntimeBootstrapDiagnostic,
  type RuntimeBootstrapInput,
  type RuntimeCanonicalProvenance,
  type ResumeSessionResult,
  type SessionState,
  ensureSessionPresentationState,
  ensureRuntimeMetadata,
} from "./types.js";
import {
  normalizeRuntimeSafetyFlags,
  type RuntimeSafetyFlags,
} from "./safety-flags.js";
import {
  DEFAULT_SCENE_ID,
  RuntimeIdGenerator,
  SystemClock,
  anchorEventTypeToTraceType,
  buildRuntimeMetadata,
  nextActionSeq,
  nextUiVersion,
  prepareQuestHookCacheState,
  readNonEmptyString,
} from "./runtime-engine-helpers.js";
import {
  buildActionResolvedTraceData,
  buildHookTextInput,
  buildHookTextSlotMeta,
  buildHookTraceData,
  buildQuestLifecycleTraceData,
  buildTemporalTraceData,
  type HookTextSlotMeta,
} from "./runtime-engine-process-helpers.js";

const PANEL_IDS: PanelId[] = ["fixed", "main", "sub"];
const DEFAULT_HOOK_TEXT_TIMEOUT_MS = 350;
const DEFAULT_HOOK_TEXT_CACHE_TTL_SEC = 900;

const NOOP_HOOK_TEXT_RENDERER: QuestHookTextRenderer = {
  async render(): Promise<QuestHookTextOutput> {
    return {
      contractVersion: LLM_CONTRACT_VERSION,
      overrides: [],
    };
  },
};

type RuntimeEngineDependencies = {
  store: StateStore;
  intentAnalyzer: IntentAnalyzer;
  personaDriftAnalyzer: PersonaDriftAnalyzer;
  sceneRenderer: SceneRenderer;
  questHookTextRenderer?: QuestHookTextRenderer;
  richHookTextEnabled?: boolean;
  hookTextTimeoutMs?: number;
  hookTextCacheTtlSec?: number;
  traceMaxEvents?: number;
  analyzerMemoryTtlSec?: number;
  runtimeSafetyFlags?: Partial<RuntimeSafetyFlags>;
  clock?: Clock;
  idGenerator?: IdGenerator;
};

type IntentSelectionSource = "deterministic" | "analyzer";
type IntentFallbackStrategy = "none" | "keep_previous" | "scene_safe_default" | "abstain";

type ActionSelectionState = {
  selectedActionId: DeterministicActionId;
  selectedSource: IntentSelectionSource;
  selectedConfidence: number;
  intentSignals: string[];
  selectedAnalyzerWeight: number;
  selectedFallbackStrategy: IntentFallbackStrategy;
  preResolvedClaimUntrusted: boolean;
};

type HookTextLaneState = {
  nextLoop: SessionState["deterministicLoop"];
  hookTextGenerationAttempted: boolean;
  hookTextResult: "applied" | "fallback" | "skipped";
  hookTextReason: string | null;
  hookTextSlotCount: number;
  hookTextCacheHitCount: number;
  hookTextCacheMissCount: number;
  hookTextUpdatedCount: number;
  hookTextSkippedByPolicy: boolean;
  hookTextSkippedByBudget: boolean;
  hookTextSlotMeta: HookTextSlotMeta[];
  recentOutcomesRichRequested: boolean;
  recentOutcomesRichApplied: boolean;
};

class Checkpoint0RuntimeEngine implements RuntimeEngine {
  private readonly store: StateStore;
  private readonly intentAnalyzer: IntentAnalyzer;
  private readonly personaDriftAnalyzer: PersonaDriftAnalyzer;
  private readonly sceneRenderer: SceneRenderer;
  private readonly questHookTextRenderer: QuestHookTextRenderer;
  private readonly hookTextTimeoutMs: number;
  private readonly hookTextCacheTtlSec: number;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly traceMaxEvents: number;
  private readonly analyzerMemoryTtlSec: number;
  private readonly runtimeSafetyFlags: RuntimeSafetyFlags;

  constructor(deps: RuntimeEngineDependencies) {
    this.store = deps.store;
    this.intentAnalyzer = deps.intentAnalyzer;
    this.personaDriftAnalyzer = deps.personaDriftAnalyzer;
    this.sceneRenderer = deps.sceneRenderer;
    this.questHookTextRenderer = deps.questHookTextRenderer ?? NOOP_HOOK_TEXT_RENDERER;
    const hasLegacyRichHookTextEnabled = typeof deps.richHookTextEnabled === "boolean";
    const legacyRichHookTextEnabled = deps.richHookTextEnabled === true;
    this.runtimeSafetyFlags = normalizeRuntimeSafetyFlags({
      ...(deps.runtimeSafetyFlags ?? {}),
      richHookActionableEnabled:
        typeof deps.runtimeSafetyFlags?.richHookActionableEnabled === "boolean"
          ? deps.runtimeSafetyFlags.richHookActionableEnabled
          : hasLegacyRichHookTextEnabled
            ? legacyRichHookTextEnabled
            : undefined,
      richHookWorldPulseEnabled:
        typeof deps.runtimeSafetyFlags?.richHookWorldPulseEnabled === "boolean"
          ? deps.runtimeSafetyFlags.richHookWorldPulseEnabled
          : hasLegacyRichHookTextEnabled
            ? legacyRichHookTextEnabled
            : undefined,
    });
    this.hookTextTimeoutMs = Number.isFinite(deps.hookTextTimeoutMs as number)
      ? Math.max(80, Math.min(2_000, Math.trunc(deps.hookTextTimeoutMs as number)))
      : DEFAULT_HOOK_TEXT_TIMEOUT_MS;
    this.hookTextCacheTtlSec = Number.isFinite(deps.hookTextCacheTtlSec as number)
      ? Math.max(60, Math.min(7_200, Math.trunc(deps.hookTextCacheTtlSec as number)))
      : DEFAULT_HOOK_TEXT_CACHE_TTL_SEC;
    this.traceMaxEvents = Number.isFinite(deps.traceMaxEvents as number)
      ? Math.max(20, Math.min(500, Math.trunc(deps.traceMaxEvents as number)))
      : 120;
    this.analyzerMemoryTtlSec = Number.isFinite(deps.analyzerMemoryTtlSec as number)
      ? Math.max(60, Math.min(86_400, Math.trunc(deps.analyzerMemoryTtlSec as number)))
      : 900;
    this.clock = deps.clock ?? new SystemClock();
    this.idGenerator = deps.idGenerator ?? new RuntimeIdGenerator();
  }

  private normalizeSessionLoop(session: SessionState, nowIso: string): SessionState {
    const loop = ensureDeterministicSceneLoopState((session as Record<string, unknown>).deterministicLoop, {
      sceneId: session.sceneId,
      nowIso,
    });

    const actionSeq = Math.max(
      0,
      Number.isFinite((session as Record<string, unknown>).actionSeq as number)
        ? Math.trunc((session as Record<string, unknown>).actionSeq as number)
        : 0,
      Number.isFinite((session as Record<string, unknown>).turnIndex as number)
        ? Math.trunc((session as Record<string, unknown>).turnIndex as number)
        : 0,
    );

    const committedDispatchIds =
      session.panelDispatch && Array.isArray(session.panelDispatch.committedDispatchIds)
        ? session.panelDispatch.committedDispatchIds.filter((entry): entry is string => typeof entry === "string").slice(-32)
        : [];

    const pending = session.panelDispatch?.pending ?? null;

    const sceneId = loop.scene.sceneId;
    const runtimeMetadata = ensureRuntimeMetadata((session as Record<string, unknown>).runtimeMetadata);
    const presentation = ensureSessionPresentationState((session as Record<string, unknown>).presentation);
    const normalized: SessionState = {
      ...session,
      sceneId,
      actionSeq,
      turnIndex: actionSeq,
      deterministicLoop: loop,
      runtimeMetadata,
      presentation,
      panelDispatch: {
        pending,
        committedDispatchIds,
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

  private async renderQuestHookTextWithTimeout(input: QuestHookTextInput): Promise<QuestHookTextOutput> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("hook_text_timeout")), this.hookTextTimeoutMs);
    });

    try {
      return await Promise.race([this.renderQuestHookText(input), timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private createSessionSkeleton(input: {
    sessionId: string;
    channelKey: string;
    ownerId: string;
    sceneId: string;
    nowIso: string;
    runtimeBootstrap?: RuntimeBootstrapInput | null;
    runtimeBootstrapDiagnostics?: RuntimeBootstrapDiagnostic[];
    runtimeCanonicalProvenance?: RuntimeCanonicalProvenance | null;
  }): SessionState {
    const deterministicLoop = createInitialDeterministicSceneLoop({
      sceneId: input.sceneId,
      nowIso: input.nowIso,
      bootstrap: input.runtimeBootstrap,
    });
    const runtimeMetadata = buildRuntimeMetadata({
      runtimeBootstrap: input.runtimeBootstrap,
      runtimeBootstrapDiagnostics: input.runtimeBootstrapDiagnostics,
      runtimeCanonicalProvenance: input.runtimeCanonicalProvenance,
    });

    return {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      sessionId: input.sessionId,
      channelKey: input.channelKey,
      ownerId: input.ownerId,
      status: "active",
      sceneId: deterministicLoop.scene.sceneId,
      uiVersion: 1,
      actionSeq: 0,
      turnIndex: 0,
      lastActionId: null,
      lastActionSummary: null,
      deterministicLoop,
      runtimeMetadata,
      presentation: {
        verboseMode: false,
      },
      panelDispatch: {
        pending: null,
        committedDispatchIds: [],
      },
      trace: {
        maxEvents: this.traceMaxEvents,
        events: [],
      },
      panels: {
        fixed: {
          panelId: "fixed",
          uiVersion: 1,
          sceneId: deterministicLoop.scene.sceneId,
          messageId: null,
          channelMessageRef: null,
          lastRenderedAt: null,
        },
        main: {
          panelId: "main",
          uiVersion: 1,
          sceneId: deterministicLoop.scene.sceneId,
          messageId: null,
          channelMessageRef: null,
          lastRenderedAt: null,
        },
        sub: {
          panelId: "sub",
          uiVersion: 1,
          sceneId: deterministicLoop.scene.sceneId,
          messageId: null,
          channelMessageRef: null,
          lastRenderedAt: null,
        },
      },
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
      endedAt: null,
    };
  }

  private async registerDefaultPanelRoutes(session: SessionState): Promise<InteractionRouteRecord[]> {
    const out: InteractionRouteRecord[] = [];
    const routeActionIds = collectPanelRouteActionIds(session);
    const availabilityByAction = new Map(
      session.deterministicLoop.actionPalette.map((entry) => [entry.actionId, entry.availability]),
    );

    for (const actionId of routeActionIds) {
      out.push(
        await this.bindInteractionRoute({
          sessionId: session.sessionId,
          uiVersion: session.uiVersion,
          sceneId: session.sceneId,
          actionId,
          payload: {
            source: "checkpoint2-panel",
            availability: availabilityByAction.get(actionId) ?? "possible",
          },
        }),
      );
    }
    return out;
  }

  async startNewSession(input: StartNewSessionInput): Promise<NewSessionResult> {
    const nowIso = this.clock.nowIso();
    const channelKey = readNonEmptyString(input.channelKey, "channel:unknown");

    const existingSession = await this.store.readActiveSessionByChannel(channelKey);
    if (existingSession) {
      const normalizedExisting = this.normalizeSessionLoop(existingSession, nowIso);
      const endedSessionBase: SessionState = {
        ...normalizedExisting,
        status: "ended",
        updatedAt: nowIso,
        endedAt: nowIso,
      };
      const endedSession = appendTraceEvent(
        endedSessionBase,
        createTraceEvent({
          lane: "engine",
          type: "session.end",
          tsIso: nowIso,
          data: {
            reason: "new-session-replaced-active",
          },
        }),
      );
      await this.store.upsertSession(endedSession);
      await this.store.deleteRoutesForSession(normalizedExisting.sessionId);
    }

    const sessionBase = this.createSessionSkeleton({
      sessionId: this.idGenerator.newSessionId(),
      channelKey,
      ownerId: readNonEmptyString(input.ownerId, "owner:unknown"),
      sceneId: readNonEmptyString(input.initialSceneId, DEFAULT_SCENE_ID),
      nowIso,
      runtimeBootstrap: input.runtimeBootstrap,
      runtimeBootstrapDiagnostics: input.runtimeBootstrapDiagnostics,
      runtimeCanonicalProvenance: input.runtimeCanonicalProvenance,
    });

    const session = appendTraceEvent(
      sessionBase,
      createTraceEvent({
        lane: "engine",
        type: "session.new",
        tsIso: nowIso,
        data: {
          sceneId: sessionBase.sceneId,
          ownerId: sessionBase.ownerId,
          bootstrapSource: sessionBase.runtimeMetadata.bootstrap.source,
          bootstrapSeedWorldId: sessionBase.runtimeMetadata.bootstrap.seed?.worldId ?? null,
          bootstrapSeedVersion: sessionBase.runtimeMetadata.bootstrap.seed?.schemaVersion ?? null,
          bootstrapSeedFingerprint: sessionBase.runtimeMetadata.bootstrap.seed?.seedFingerprint ?? null,
          bootstrapDiagnosticsCount: sessionBase.runtimeMetadata.bootstrap.diagnostics.length,
        },
      }),
    );

    await this.store.upsertSession(session);
    const routes = await this.registerDefaultPanelRoutes(session);

    return {
      session,
      routes,
    };
  }

  async resumeSession(input: ResumeSessionInput): Promise<ResumeSessionResult | null> {
    const targetById = readNonEmptyString(input.sessionId, "");
    const byId = targetById ? await this.store.readSession(targetById) : null;
    const byChannel =
      !byId && input.channelKey ? await this.store.readActiveSessionByChannel(readNonEmptyString(input.channelKey, "")) : null;
    const rawSession = byId ?? byChannel;

    if (!rawSession || rawSession.status !== "active") {
      return null;
    }

    const nowIso = this.clock.nowIso();
    const session = this.normalizeSessionLoop(rawSession, nowIso);
    const uiVersion = nextUiVersion(session.uiVersion);

    const nextSessionBase: SessionState = {
      ...session,
      uiVersion,
      updatedAt: nowIso,
      panels: {
        fixed: {
          ...session.panels.fixed,
          uiVersion,
        },
        main: {
          ...session.panels.main,
          uiVersion,
        },
        sub: {
          ...session.panels.sub,
          uiVersion,
        },
      },
    };

    const nextSession = appendTraceEvent(
      nextSessionBase,
      createTraceEvent({
        lane: "engine",
        type: "session.resume",
        tsIso: nowIso,
        data: {
          previousUiVersion: session.uiVersion,
          nextUiVersion: uiVersion,
        },
      }),
    );

    await this.store.upsertSession(nextSession);
    await this.store.deleteRoutesForSession(nextSession.sessionId);
    const routes = await this.registerDefaultPanelRoutes(nextSession);

    const fallbackRoute = routes[0] ?? {
      sessionId: nextSession.sessionId,
      uiVersion: nextSession.uiVersion,
      sceneId: nextSession.sceneId,
      actionId: PANEL_MODAL_SUBMIT_ACTION_ID,
      createdAt: nowIso,
      consumedAt: null,
      payload: {},
    };
    const recoveryPlan: PanelRecoveryInstruction[] = PANEL_IDS.map((panelId) => {
      const panel = nextSession.panels[panelId];
      return {
        panelId,
        mode: panel.messageId ? "refresh" : "recreate",
        messageId: panel.messageId,
        uiVersion: panel.uiVersion,
        sceneId: panel.sceneId,
        routeKey: {
          sessionId: fallbackRoute.sessionId,
          uiVersion: fallbackRoute.uiVersion,
          sceneId: fallbackRoute.sceneId,
          actionId: fallbackRoute.actionId,
        },
      };
    });

    return {
      session: nextSession,
      recoveryPlan,
      routes,
    };
  }

  async endSession(input: EndSessionInput): Promise<EndSessionResult> {
    const targetById = readNonEmptyString(input.sessionId, "");
    const byId = targetById ? await this.store.readSession(targetById) : null;
    const byChannel =
      !byId && input.channelKey ? await this.store.readActiveSessionByChannel(readNonEmptyString(input.channelKey, "")) : null;
    const rawSession = byId ?? byChannel;

    if (!rawSession) {
      return {
        session: null,
        removedRouteCount: 0,
      };
    }

    const nowIso = this.clock.nowIso();
    const session = this.normalizeSessionLoop(rawSession, nowIso);
    const endedSessionBase: SessionState = {
      ...session,
      status: "ended",
      updatedAt: nowIso,
      endedAt: nowIso,
    };

    const endedSession = appendTraceEvent(
      endedSessionBase,
      createTraceEvent({
        lane: "engine",
        type: "session.end",
        tsIso: nowIso,
        data: {
          reason: readNonEmptyString(input.reason, "session-end-command"),
        },
      }),
    );

    await this.store.upsertSession(endedSession);
    const removedRouteCount = await this.store.deleteRoutesForSession(session.sessionId);

    return {
      session: endedSession,
      removedRouteCount,
    };
  }

  async bindInteractionRoute(input: BindInteractionRouteInput): Promise<InteractionRouteRecord> {
    const nowIso = this.clock.nowIso();
    const actionId = readNonEmptyString(input.actionId, this.idGenerator.newActionId());
    const route: InteractionRouteRecord = {
      sessionId: readNonEmptyString(input.sessionId, ""),
      uiVersion: Math.max(1, Math.trunc(input.uiVersion)),
      sceneId: readNonEmptyString(input.sceneId, DEFAULT_SCENE_ID),
      actionId,
      createdAt: nowIso,
      consumedAt: null,
      payload: input.payload ?? {},
    };

    await this.store.upsertInteractionRoute(route);
    return route;
  }

  async resolveInteractionRoute(input: ResolveInteractionRouteInput): Promise<InteractionRouteRecord | null> {
    const routeKey = {
      sessionId: readNonEmptyString(input.sessionId, ""),
      uiVersion: Math.max(1, Math.trunc(input.uiVersion)),
      sceneId: readNonEmptyString(input.sceneId, DEFAULT_SCENE_ID),
      actionId: readNonEmptyString(input.actionId, ""),
    };

    if (input.consume === false) {
      return this.store.readInteractionRoute(routeKey);
    }

    return this.store.consumeInteractionRoute(routeKey, this.clock.nowIso());
  }

  private async resolveActionSelection(params: {
    session: SessionState;
    freeInput: string;
    isFreeSentenceInput: boolean;
    nowIso: string;
  }): Promise<{ session: SessionState; selection: ActionSelectionState }> {
    let session = params.session;
    const selection: ActionSelectionState = {
      selectedActionId: "action.unknown",
      selectedSource: "deterministic",
      selectedConfidence: 1,
      intentSignals: [],
      selectedAnalyzerWeight: 0,
      selectedFallbackStrategy: "none",
      preResolvedClaimUntrusted: false,
    };

    if (!params.isFreeSentenceInput) {
      return {
        session,
        selection,
      };
    }

    const deterministicActionId = deterministicActionFromFreeInput(params.freeInput);
    const availableActions = session.deterministicLoop.actionPalette.map((entry) => entry.actionId);
    const intentInput = buildIntentAnalyzerInput({
      session,
      freeInput: params.freeInput,
    });

    let intentOutput: IntentAnalyzerOutput | null = null;
    try {
      const analyzed = await this.analyzeIntent(intentInput);
      intentOutput = validateIntentAnalyzerOutput(analyzed);
    } catch {
      intentOutput = null;
    }

    if (!intentOutput) {
      session = appendTraceEvent(
        session,
        createTraceEvent({
          lane: "analyzer",
          type: "analyzer.intent.fallback",
          tsIso: params.nowIso,
          severity: "warn",
          code: "intent_output_invalid",
          recoverable: true,
          data: {
            deterministicActionId,
          },
        }),
      );
    }

    const selected = selectStructuredActionIntent({
      deterministicActionId,
      availableActions,
      analyzerOutput: intentOutput,
      inertia: session.deterministicLoop.intentInertia,
    });

    selection.selectedActionId = readNonEmptyString(selected.actionId, "action.unknown") as DeterministicActionId;
    selection.selectedSource = selected.source;
    selection.selectedConfidence = selected.confidence;
    selection.selectedAnalyzerWeight = selected.analyzerWeight;
    selection.selectedFallbackStrategy = selected.fallbackStrategy;
    selection.preResolvedClaimUntrusted = selected.preResolvedClaimUntrusted;
    selection.intentSignals = selected.analyzerOutput?.extractedSignals ?? [];

    session = appendTraceEvent(
      session,
      createTraceEvent({
        lane: "analyzer",
        type:
          selection.selectedSource === "analyzer"
            ? "analyzer.intent.used"
            : selection.selectedFallbackStrategy === "none"
              ? "analyzer.intent.used"
              : "analyzer.intent.fallback",
        tsIso: params.nowIso,
        severity: selection.preResolvedClaimUntrusted ? "warn" : "info",
        code: selection.preResolvedClaimUntrusted ? "pre_resolved_claim_untrusted" : undefined,
        recoverable: true,
        data: {
          selectedActionId: selection.selectedActionId,
          selectedSource: selection.selectedSource,
          selectedConfidence: selection.selectedConfidence,
          analyzerWeight: selection.selectedAnalyzerWeight,
          fallbackStrategy: selection.selectedFallbackStrategy,
          preResolvedClaimUntrusted: selection.preResolvedClaimUntrusted,
        },
      }),
    );

    return {
      session,
      selection,
    };
  }

  private async applyIntentAndDriftState(params: {
    session: SessionState;
    nextLoop: SessionState["deterministicLoop"];
    nowIso: string;
    isFreeSentenceInput: boolean;
    freeInput: string;
    resolution: ProcessSceneActionResult["resolution"];
    selection: ActionSelectionState;
  }): Promise<{ session: SessionState; nextLoop: SessionState["deterministicLoop"] }> {
    let session = params.session;
    const nextLoop = {
      ...params.nextLoop,
    };

    if (params.isFreeSentenceInput) {
      nextLoop.intentInertia = updateIntentInertia({
        current: nextLoop.intentInertia,
        selectedActionId: params.resolution.resolvedActionId,
        selectedConfidence: params.selection.selectedConfidence,
        source: params.selection.selectedSource,
      });

      nextLoop.analyzerMemory = rememberFreeInputTrace({
        current: nextLoop.analyzerMemory,
        freeInput: params.freeInput,
        resolvedActionId: params.resolution.resolvedActionId,
        classification: params.resolution.classification,
        intentSignals: params.selection.intentSignals,
        nowIso: params.nowIso,
        ttlSec: this.analyzerMemoryTtlSec,
      });

      if (!this.runtimeSafetyFlags.behavioralDriftEnabled) {
        nextLoop.behavioralDrift = {
          coreIdentity: nextLoop.behavioralDrift.coreIdentity,
          drift: zeroBehavioralAxisVector(),
          lastUpdatedAtIso: params.nowIso,
        };
        session = appendTraceEvent(
          session,
          createTraceEvent({
            lane: "analyzer",
            type: "analyzer.drift.rejected",
            tsIso: params.nowIso,
            severity: "info",
            code: "behavioral_drift_disabled",
            recoverable: true,
            data: {
              ruleImpact: "none",
            },
          }),
        );
      } else {
        const driftInput = buildPersonaDriftAnalyzerInput({
          session: {
            ...session,
            sceneId: nextLoop.scene.sceneId,
            deterministicLoop: nextLoop,
          },
          nowIso: params.nowIso,
        });

        let driftOutput: PersonaDriftAnalyzerOutput | null = null;
        try {
          const analyzedDrift = await this.analyzePersonaDrift(driftInput);
          driftOutput = validatePersonaDriftAnalyzerOutput(analyzedDrift);
        } catch {
          driftOutput = null;
        }

        session = appendTraceEvent(
          session,
          createTraceEvent({
            lane: "analyzer",
            type: driftOutput ? "analyzer.drift.used" : "analyzer.drift.fallback",
            tsIso: params.nowIso,
            severity: driftOutput ? "info" : "warn",
            code: driftOutput ? undefined : "drift_output_invalid",
            recoverable: true,
            data: {
              confidence: driftOutput?.confidence ?? 0,
              dominantSignals: driftOutput?.dominantSignals ?? [],
              ruleImpact: "none",
            },
          }),
        );

        nextLoop.behavioralDrift = accumulateBehavioralDrift({
          current: nextLoop.behavioralDrift,
          analyzerOutput: driftOutput,
          nowIso: params.nowIso,
        });
      }

      return {
        session,
        nextLoop,
      };
    }

    nextLoop.intentInertia = updateIntentInertia({
      current: nextLoop.intentInertia,
      selectedActionId: params.resolution.resolvedActionId,
      selectedConfidence: 1,
      source: "deterministic",
    });
    if (!this.runtimeSafetyFlags.behavioralDriftEnabled) {
      nextLoop.behavioralDrift = {
        coreIdentity: nextLoop.behavioralDrift.coreIdentity,
        drift: zeroBehavioralAxisVector(),
        lastUpdatedAtIso: params.nowIso,
      };
    }

    return {
      session,
      nextLoop,
    };
  }

  private async applyHookTextLane(params: {
    session: SessionState;
    nextLoop: SessionState["deterministicLoop"];
    resolution: ProcessSceneActionResult["resolution"];
    nowIso: string;
  }): Promise<HookTextLaneState> {
    let nextLoop = params.nextLoop;
    let hookTextGenerationAttempted = false;
    let hookTextResult: "applied" | "fallback" | "skipped" = "skipped";
    let hookTextReason: string | null = null;
    let hookTextCacheHitCount = 0;
    let hookTextCacheMissCount = 0;
    let hookTextUpdatedCount = 0;
    let hookTextSkippedByPolicy = false;
    let hookTextSkippedByBudget = false;
    let hookTextSlotMeta: HookTextSlotMeta[] = [];

    const actionableRichEnabled = this.runtimeSafetyFlags.richHookActionableEnabled;
    const worldPulseRichEnabled = this.runtimeSafetyFlags.richHookWorldPulseEnabled;
    const recentOutcomesRichRequested = this.runtimeSafetyFlags.richHookRecentOutcomesEnabled;
    const recentOutcomesRichApplied = false;
    const richHookTextEnabled = actionableRichEnabled || worldPulseRichEnabled;

    const hookCache = prepareQuestHookCacheState({
      economy: nextLoop.questEconomy,
      nowIso: params.nowIso,
      actionableRichEnabled,
      worldPulseRichEnabled,
    });
    nextLoop = hookCache.nextEconomy === nextLoop.questEconomy
      ? nextLoop
      : {
          ...nextLoop,
          questEconomy: hookCache.nextEconomy,
        };

    const cacheStates = hookCache.cacheStates;
    const cacheHitBySlotKey = hookCache.cacheHitBySlotKey;
    const cacheMissCandidates = hookCache.cacheMissCandidates;
    const cacheMissSlotKeys = hookCache.cacheMissSlotKeys;

    hookTextCacheHitCount = hookCache.cacheHitCount;
    hookTextCacheMissCount = hookCache.cacheMissCount;
    hookTextSkippedByBudget = hookCache.skippedByBudget;

    let appliedSlotKeySet = new Set<string>();
    if (!richHookTextEnabled) {
      hookTextResult = "skipped";
      hookTextReason = "skippedByPolicy";
      hookTextSkippedByPolicy = true;
      hookTextSkippedByBudget = false;
    } else if (cacheStates.length === 0) {
      hookTextResult = "skipped";
      hookTextReason = "no_hook_slots";
      hookTextSkippedByBudget = false;
    } else if (cacheMissCandidates.length === 0) {
      hookTextResult = "skipped";
      hookTextReason = "cache_hit_only";
      hookTextSkippedByBudget = false;
    } else {
      let remainingGenerationBudget = 1;
      if (remainingGenerationBudget < 1) {
        hookTextResult = "skipped";
        hookTextReason = "skippedByBudget";
        hookTextSkippedByBudget = true;
      } else {
        remainingGenerationBudget -= 1;
        hookTextGenerationAttempted = true;
        const hookTextInput: QuestHookTextInput = buildHookTextInput({
          contractVersion: LLM_CONTRACT_VERSION,
          sessionId: params.session.sessionId,
          nowIso: params.nowIso,
          nextLoop,
          resolution: params.resolution,
          cacheMissCandidates,
        });

        try {
          const rendered = await this.renderQuestHookTextWithTimeout(hookTextInput);
          const validated = isQuestHookTextOutput(rendered) ? rendered : null;
          if (!validated) {
            hookTextResult = "fallback";
            hookTextReason = "renderer_invalid";
          } else {
            const applied = applyQuestHookTextOverrides({
              economy: nextLoop.questEconomy,
              overrides: validated.overrides,
              nowIso: params.nowIso,
              cacheTtlSec: this.hookTextCacheTtlSec,
            });
            nextLoop = {
              ...nextLoop,
              questEconomy: applied.nextEconomy,
            };
            hookTextUpdatedCount = applied.appliedSlotKeys.length;
            appliedSlotKeySet = new Set(applied.appliedSlotKeys);

            if (hookTextUpdatedCount > 0) {
              hookTextResult = "applied";
              hookTextReason = applied.ignoredSlotKeys.length > 0 ? "partial_ignored" : null;
            } else {
              hookTextResult = "fallback";
              hookTextReason = validated.overrides.length === 0 ? "renderer_empty" : "no_matching_override";
            }
          }
        } catch (error) {
          hookTextResult = "fallback";
          hookTextReason =
            error instanceof Error && error.message === "hook_text_timeout" ? "renderer_timeout" : "renderer_error";
        }
      }
    }

    hookTextSlotMeta = buildHookTextSlotMeta({
      nextLoop,
      cacheHitBySlotKey,
      appliedSlotKeySet,
      cacheMissSlotKeys,
      actionableRichEnabled,
      worldPulseRichEnabled,
      hookTextResult,
      hookTextReason,
    });

    const debugEconomy = setQuestHookTextDebugState({
      economy: nextLoop.questEconomy,
      nowIso: params.nowIso,
      generationAttempted: hookTextGenerationAttempted,
      result: hookTextResult,
      reason: hookTextReason,
      cacheHitCount: hookTextCacheHitCount,
      cacheMissCount: hookTextCacheMissCount,
      slotMeta: hookTextSlotMeta,
    });

    nextLoop = {
      ...nextLoop,
      questEconomy: debugEconomy,
    };

    return {
      nextLoop,
      hookTextGenerationAttempted,
      hookTextResult,
      hookTextReason,
      hookTextSlotCount: cacheStates.length,
      hookTextCacheHitCount,
      hookTextCacheMissCount,
      hookTextUpdatedCount,
      hookTextSkippedByPolicy,
      hookTextSkippedByBudget,
      hookTextSlotMeta,
      recentOutcomesRichRequested,
      recentOutcomesRichApplied,
    };
  }

  async processSceneAction(input: ProcessSceneActionInput): Promise<ProcessSceneActionResult> {
    const nowIso = this.clock.nowIso();
    const sessionBase = this.normalizeSessionLoop(input.session, nowIso);
    const traceVerbose = this.runtimeSafetyFlags.traceVerbose || sessionBase.presentation.verboseMode;
    const routeActionId = readNonEmptyString(input.routeActionId, "action.unknown");
    const freeInput = readNonEmptyString(input.freeInput, "");
    const isFreeSentenceInput = routeActionId === PANEL_MODAL_SUBMIT_ACTION_ID && freeInput.length > 0;

    let session = appendTraceEvent(
      sessionBase,
      createTraceEvent({
        lane: "engine",
        type: "interaction.received",
        tsIso: nowIso,
        data: {
          routeActionId,
          hasFreeInput: isFreeSentenceInput,
          uiVersion: sessionBase.uiVersion,
          sceneId: sessionBase.sceneId,
        },
      }),
    );

    const selectionResult = await this.resolveActionSelection({
      session,
      freeInput,
      isFreeSentenceInput,
      nowIso,
    });
    session = selectionResult.session;
    const selection = selectionResult.selection;

    const resolution = resolveDeterministicSceneAction({
      loop: session.deterministicLoop,
      routeActionId,
      freeInput: freeInput || undefined,
      resolvedActionOverride: isFreeSentenceInput ? selection.selectedActionId : undefined,
      nowIso,
      runtimeSafety: {
        anchorLifecycleEnabled: this.runtimeSafetyFlags.anchorLifecycleEnabled,
        anchorSummaryOnly: this.runtimeSafetyFlags.anchorSummaryOnly,
        // v1 safety policy: deterministic rule adjudication does not read behavioral drift.
        behavioralDriftAffectsRules: false,
      },
    });

    let nextLoop = {
      ...resolution.nextLoop,
    };

    const driftState = await this.applyIntentAndDriftState({
      session,
      nextLoop,
      nowIso,
      isFreeSentenceInput,
      freeInput,
      resolution,
      selection,
    });
    session = driftState.session;
    nextLoop = driftState.nextLoop;

    const hookTextState = await this.applyHookTextLane({
      session,
      nextLoop,
      resolution,
      nowIso,
    });
    nextLoop = hookTextState.nextLoop;

    const {
      hookTextGenerationAttempted,
      hookTextResult,
      hookTextReason,
      hookTextSlotCount,
      hookTextCacheHitCount,
      hookTextCacheMissCount,
      hookTextUpdatedCount,
      hookTextSkippedByPolicy,
      hookTextSkippedByBudget,
      hookTextSlotMeta,
      recentOutcomesRichRequested,
      recentOutcomesRichApplied,
    } = hookTextState;

    const {
      selectedSource,
      selectedConfidence,
      selectedAnalyzerWeight,
      selectedFallbackStrategy,
      preResolvedClaimUntrusted,
    } = selection;

    const sceneId = nextLoop.scene.sceneId;
    const sceneTransitioned = session.sceneId !== sceneId;
    const confidenceSuffix = isFreeSentenceInput
      ? ` · intent_conf=${selectedConfidence.toFixed(2)} · source=${selectedSource}`
      : "";
    const summary = `${feasibilityLabel(resolution.classification)} · +${String(resolution.deltaTimeSec)}s · ${resolution.resultSummary}${confidenceSuffix}`;

    session = appendTraceEvent(
      session,
      createTraceEvent({
        lane: "engine",
        type: "engine.time.advanced",
        tsIso: nowIso,
        data: {
          fromWorldNowIso: session.deterministicLoop.time.worldNowIso,
          toWorldNowIso: nextLoop.time.worldNowIso,
          deltaTimeSec: resolution.deltaTimeSec,
          worldElapsedSec: nextLoop.time.worldElapsedSec,
        },
      }),
    );

    if (this.runtimeSafetyFlags.anchorLifecycleEnabled) {
      for (const anchorEvent of resolution.anchorSummary.events) {
        session = appendTraceEvent(
          session,
          createTraceEvent({
            lane: "engine",
            type: anchorEventTypeToTraceType(anchorEvent.eventType),
            tsIso: nowIso,
            data: traceVerbose
              ? {
                  anchorId: anchorEvent.anchorId,
                  pressureId: anchorEvent.pressureId,
                  archetype: anchorEvent.archetype,
                  from: anchorEvent.from,
                  to: anchorEvent.to,
                  reason: anchorEvent.reason,
                  intensity: anchorEvent.intensity,
                  signalMode: resolution.anchorSummary.debug.signalMode,
                }
              : {
                  anchorId: anchorEvent.anchorId,
                  to: anchorEvent.to,
                  intensity: anchorEvent.intensity,
                },
          }),
        );
      }
    }

    const temporalTraceData = buildTemporalTraceData({
      resolution,
      traceVerbose,
    });

    session = appendTraceEvent(
      session,
      createTraceEvent({
        lane: "engine",
        type: "engine.temporal.updated",
        tsIso: nowIso,
        data: temporalTraceData,
      }),
    );

    session = appendTraceEvent(
      session,
      createTraceEvent({
        lane: "engine",
        type: "engine.pressure.advanced",
        tsIso: nowIso,
        data: {
          advancedCount: resolution.questSummary.pressureAdvancedCount,
          topPressure: resolution.questSummary.pressureTop,
          spawnedSeeds: resolution.questSummary.spawnedSeeds,
        },
      }),
    );

    const questLifecycleTraceData = buildQuestLifecycleTraceData({
      resolution,
      traceVerbose,
      telemetryExtended: this.runtimeSafetyFlags.telemetryExtended,
    });

    session = appendTraceEvent(
      session,
      createTraceEvent({
        lane: "engine",
        type: "engine.quest.lifecycle",
        tsIso: nowIso,
        data: questLifecycleTraceData,
      }),
    );

    const hookTraceData = buildHookTraceData({
      hookTextGenerationAttempted,
      hookTextResult,
      hookTextReason,
      hookTextSlotCount,
      hookTextUpdatedCount,
      hookTextSkippedByPolicy,
      hookTextSkippedByBudget,
      recentOutcomesRichRequested,
      recentOutcomesRichApplied,
      hookTextCacheHitCount,
      hookTextCacheMissCount,
      hookTextSlotMeta,
      traceVerbose,
      telemetryExtended: this.runtimeSafetyFlags.telemetryExtended,
    });

    session = appendTraceEvent(
      session,
      createTraceEvent({
        lane: "engine",
        type: "engine.quest.hook_text",
        tsIso: nowIso,
        severity: hookTextResult === "fallback" ? "warn" : "info",
        code: hookTextReason ?? undefined,
        recoverable: true,
        data: hookTraceData,
      }),
    );

    session = appendTraceEvent(
      session,
      createTraceEvent({
        lane: "engine",
        type: "engine.action.resolved",
        tsIso: nowIso,
        data: buildActionResolvedTraceData({
          routeActionId,
          resolution,
          selectedSource,
          selectedConfidence,
          selectedAnalyzerWeight,
          selectedFallbackStrategy,
          preResolvedClaimUntrusted,
          nextLoop,
          sceneTransitioned,
        }),
      }),
    );

    const actionSeq = nextActionSeq(session.actionSeq, session.turnIndex);

    const nextSession: SessionState = {
      ...session,
      sceneId,
      actionSeq,
      turnIndex: actionSeq,
      lastActionId: resolution.resolvedActionId,
      lastActionSummary: summary,
      deterministicLoop: nextLoop,
      updatedAt: nowIso,
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

    return {
      session: nextSession,
      resolution,
    };
  }

  async analyzeIntent(input: IntentAnalyzerInput): Promise<IntentAnalyzerOutput> {
    return this.intentAnalyzer.analyze(input);
  }

  async analyzePersonaDrift(input: PersonaDriftAnalyzerInput): Promise<PersonaDriftAnalyzerOutput> {
    return this.personaDriftAnalyzer.analyze(input);
  }

  async renderQuestHookText(input: QuestHookTextInput): Promise<QuestHookTextOutput> {
    return this.questHookTextRenderer.render(input);
  }

  async renderScene(input: SceneRendererInput): Promise<SceneRendererOutput> {
    return this.sceneRenderer.render(input);
  }
}

export function createCheckpoint0RuntimeEngine(deps: RuntimeEngineDependencies): RuntimeEngine {
  return new Checkpoint0RuntimeEngine(deps);
}
