import { randomUUID } from "node:crypto";
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
  QuestHookTextSlotType,
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
} from "./scene-loop.js";
import { appendTraceEvent, createTraceEvent, ensureTraceState } from "./trace.js";
import {
  applyQuestHookTextOverrides,
  buildQuestHookSlotSourceHash,
  isQuestHookTextCacheValid,
  setQuestHookTextDebugState,
  WORLD_PULSE_HOOK_SLOT_KEY,
} from "./quest-economy.js";
import type { AnchorTickEvent } from "./anchor-layer.js";
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
  type RuntimeMetadata,
  type ResumeSessionResult,
  type SessionState,
  ensureRuntimeMetadata,
} from "./types.js";

const DEFAULT_SCENE_ID = "scene-bootstrap";

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

class SystemClock implements Clock {
  nowIso(): string {
    return new Date().toISOString();
  }
}

class RuntimeIdGenerator implements IdGenerator {
  newSessionId(): string {
    return `sess-${randomUUID()}`;
  }

  newActionId(): string {
    return `act-${randomUUID()}`;
  }
}

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
  clock?: Clock;
  idGenerator?: IdGenerator;
};

function readNonEmptyString(value: string | undefined, fallback: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
}

function nextUiVersion(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.trunc(value) + 1;
}

function nextActionSeq(currentActionSeq: number, legacyTurnIndex: number): number {
  const canonical = Number.isFinite(currentActionSeq) ? Math.trunc(currentActionSeq) : 0;
  const legacy = Number.isFinite(legacyTurnIndex) ? Math.trunc(legacyTurnIndex) : 0;
  return Math.max(canonical, legacy) + 1;
}

function normalizeBootstrapDiagnostics(value: RuntimeBootstrapDiagnostic[] | undefined): RuntimeBootstrapDiagnostic[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const diagnostics: RuntimeBootstrapDiagnostic[] = [];
  for (const entry of value) {
    const code = typeof entry?.code === "string" ? entry.code.trim() : "";
    const message = typeof entry?.message === "string" ? entry.message.trim() : "";
    if (!code || !message) {
      continue;
    }
    diagnostics.push({
      code,
      message,
      path: typeof entry.path === "string" && entry.path.trim() ? entry.path.trim() : null,
      severity: entry.severity === "info" || entry.severity === "warn" || entry.severity === "error" ? entry.severity : "warn",
    });
    if (diagnostics.length >= 24) {
      break;
    }
  }
  return diagnostics;
}

function buildRuntimeMetadata(params: {
  runtimeBootstrap?: RuntimeBootstrapInput | null;
  runtimeBootstrapDiagnostics?: RuntimeBootstrapDiagnostic[];
  runtimeCanonicalProvenance?: RuntimeCanonicalProvenance | null;
}): RuntimeMetadata {
  const diagnostics = normalizeBootstrapDiagnostics(params.runtimeBootstrapDiagnostics);
  if (!params.runtimeBootstrap) {
    return ensureRuntimeMetadata({
      bootstrap: {
        source: "default",
        seed: null,
        diagnostics,
      },
      canonicalSync: params.runtimeCanonicalProvenance ?? undefined,
    });
  }
  return ensureRuntimeMetadata({
    bootstrap: {
      source: "worldSeed",
      seed: {
        worldId: params.runtimeBootstrap.worldId,
        schemaVersion: params.runtimeBootstrap.schemaVersion,
        seedValue: params.runtimeBootstrap.seedValue,
        seedFingerprint: params.runtimeBootstrap.seedFingerprint,
      },
      diagnostics,
    },
    canonicalSync: params.runtimeCanonicalProvenance ?? undefined,
  });
}

function pressureIntensityBand(value: number): "low" | "moderate" | "high" | "critical" {
  if (!Number.isFinite(value) || value < 35) {
    return "low";
  }
  if (value < 60) {
    return "moderate";
  }
  if (value < 80) {
    return "high";
  }
  return "critical";
}

function anchorEventTypeToTraceType(eventType: AnchorTickEvent["eventType"]):
  | "engine.anchor.formed"
  | "engine.anchor.advanced"
  | "engine.anchor.escalated"
  | "engine.anchor.resolved"
  | "engine.anchor.failed"
  | "engine.anchor.archived" {
  switch (eventType) {
    case "formed":
      return "engine.anchor.formed";
    case "advanced":
      return "engine.anchor.advanced";
    case "escalated":
      return "engine.anchor.escalated";
    case "resolved":
      return "engine.anchor.resolved";
    case "failed":
      return "engine.anchor.failed";
    case "archived":
      return "engine.anchor.archived";
    default:
      return "engine.anchor.advanced";
  }
}

class Checkpoint0RuntimeEngine implements RuntimeEngine {
  private readonly store: StateStore;
  private readonly intentAnalyzer: IntentAnalyzer;
  private readonly personaDriftAnalyzer: PersonaDriftAnalyzer;
  private readonly sceneRenderer: SceneRenderer;
  private readonly questHookTextRenderer: QuestHookTextRenderer;
  private readonly richHookTextEnabled: boolean;
  private readonly hookTextTimeoutMs: number;
  private readonly hookTextCacheTtlSec: number;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly traceMaxEvents: number;
  private readonly analyzerMemoryTtlSec: number;

  constructor(deps: RuntimeEngineDependencies) {
    this.store = deps.store;
    this.intentAnalyzer = deps.intentAnalyzer;
    this.personaDriftAnalyzer = deps.personaDriftAnalyzer;
    this.sceneRenderer = deps.sceneRenderer;
    this.questHookTextRenderer = deps.questHookTextRenderer ?? NOOP_HOOK_TEXT_RENDERER;
    this.richHookTextEnabled = deps.richHookTextEnabled === true;
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
    const normalized: SessionState = {
      ...session,
      sceneId,
      actionSeq,
      turnIndex: actionSeq,
      deterministicLoop: loop,
      runtimeMetadata,
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

  async processSceneAction(input: ProcessSceneActionInput): Promise<ProcessSceneActionResult> {
    const nowIso = this.clock.nowIso();
    const sessionBase = this.normalizeSessionLoop(input.session, nowIso);
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

    let selectedActionId: DeterministicActionId = "action.unknown";
    let selectedSource: "deterministic" | "analyzer" = "deterministic";
    let selectedConfidence = 1;
    let intentSignals: string[] = [];
    let selectedAnalyzerWeight = 0;
    let selectedFallbackStrategy: "none" | "keep_previous" | "scene_safe_default" | "abstain" = "none";
    let preResolvedClaimUntrusted = false;

    if (isFreeSentenceInput) {
      const deterministicActionId = deterministicActionFromFreeInput(freeInput);
      const availableActions = session.deterministicLoop.actionPalette.map((entry) => entry.actionId);
      const intentInput = buildIntentAnalyzerInput({
        session,
        freeInput,
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
            tsIso: nowIso,
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

      selectedActionId = readNonEmptyString(selected.actionId, "action.unknown") as DeterministicActionId;
      selectedSource = selected.source;
      selectedConfidence = selected.confidence;
      selectedAnalyzerWeight = selected.analyzerWeight;
      selectedFallbackStrategy = selected.fallbackStrategy;
      preResolvedClaimUntrusted = selected.preResolvedClaimUntrusted;
      intentSignals = selected.analyzerOutput?.extractedSignals ?? [];

      session = appendTraceEvent(
        session,
        createTraceEvent({
          lane: "analyzer",
          type:
            selectedSource === "analyzer"
              ? "analyzer.intent.used"
              : selectedFallbackStrategy === "none"
                ? "analyzer.intent.used"
                : "analyzer.intent.fallback",
          tsIso: nowIso,
          severity: preResolvedClaimUntrusted ? "warn" : "info",
          code: preResolvedClaimUntrusted ? "pre_resolved_claim_untrusted" : undefined,
          recoverable: true,
          data: {
            selectedActionId,
            selectedSource,
            selectedConfidence,
            analyzerWeight: selectedAnalyzerWeight,
            fallbackStrategy: selectedFallbackStrategy,
            preResolvedClaimUntrusted,
          },
        }),
      );
    }

    const resolution = resolveDeterministicSceneAction({
      loop: session.deterministicLoop,
      routeActionId,
      freeInput: freeInput || undefined,
      resolvedActionOverride: isFreeSentenceInput ? selectedActionId : undefined,
      nowIso,
    });

    const nextLoop = {
      ...resolution.nextLoop,
    };

    if (isFreeSentenceInput) {
      nextLoop.intentInertia = updateIntentInertia({
        current: nextLoop.intentInertia,
        selectedActionId: resolution.resolvedActionId,
        selectedConfidence,
        source: selectedSource,
      });

      nextLoop.analyzerMemory = rememberFreeInputTrace({
        current: nextLoop.analyzerMemory,
        freeInput,
        resolvedActionId: resolution.resolvedActionId,
        classification: resolution.classification,
        intentSignals,
        nowIso,
        ttlSec: this.analyzerMemoryTtlSec,
      });

      const driftInput = buildPersonaDriftAnalyzerInput({
        session: {
          ...session,
          sceneId: nextLoop.scene.sceneId,
          deterministicLoop: nextLoop,
        },
        nowIso,
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
          tsIso: nowIso,
          severity: driftOutput ? "info" : "warn",
          code: driftOutput ? undefined : "drift_output_invalid",
          recoverable: true,
          data: {
            confidence: driftOutput?.confidence ?? 0,
            dominantSignals: driftOutput?.dominantSignals ?? [],
          },
        }),
      );

      nextLoop.behavioralDrift = accumulateBehavioralDrift({
        current: nextLoop.behavioralDrift,
        analyzerOutput: driftOutput,
        nowIso,
      });
    } else {
      nextLoop.intentInertia = updateIntentInertia({
        current: nextLoop.intentInertia,
        selectedActionId: resolution.resolvedActionId,
        selectedConfidence: 1,
        source: "deterministic",
      });
    }

    let hookTextGenerationAttempted = false;
    let hookTextResult: "applied" | "fallback" | "skipped" = "skipped";
    let hookTextReason: string | null = null;
    let hookTextCacheHitCount = 0;
    let hookTextCacheMissCount = 0;
    let hookTextUpdatedCount = 0;
    let hookTextSkippedByPolicy = false;
    let hookTextSkippedByBudget = false;
    let hookTextSlotMeta: Array<{
      slotKey: string;
      slotType: QuestHookTextSlotType;
      source: "default" | "llm";
      cacheHit: boolean;
      skipReason: string | null;
    }> = [];

    const worldPulseSnapshot = resolution.questSummary.panelSummary.worldPulse;

    const stripExpiredHookSlotCache = <T extends {
      llmShortText: string | null;
      llmSourceHash: string | null;
      llmExpiresAtIso: string | null;
    }>(slot: T): T => ({
      ...slot,
      llmShortText: null,
      llmSourceHash: null,
      llmExpiresAtIso: null,
    });

    const hookSlotsPruned = nextLoop.questEconomy.presentation.hookSlots.map((slot) => {
      if (!slot.llmShortText && !slot.llmSourceHash && !slot.llmExpiresAtIso) {
        return slot;
      }
      if (isQuestHookTextCacheValid(slot, nowIso)) {
        return slot;
      }
      return stripExpiredHookSlotCache(slot);
    });
    const worldPulseSlotRaw = nextLoop.questEconomy.presentation.worldPulseSlot;
    const worldPulseSlotPruned = worldPulseSlotRaw
      ? !worldPulseSlotRaw.llmShortText && !worldPulseSlotRaw.llmSourceHash && !worldPulseSlotRaw.llmExpiresAtIso
        ? worldPulseSlotRaw
        : isQuestHookTextCacheValid(worldPulseSlotRaw, nowIso)
          ? worldPulseSlotRaw
          : stripExpiredHookSlotCache(worldPulseSlotRaw)
      : null;
    const hadPrunedSlots = hookSlotsPruned.some((slot, index) => slot !== nextLoop.questEconomy.presentation.hookSlots[index]);
    const worldPulseSlotChanged = worldPulseSlotPruned !== worldPulseSlotRaw;
    if (hadPrunedSlots || worldPulseSlotChanged) {
      nextLoop.questEconomy = {
        ...nextLoop.questEconomy,
        presentation: {
          ...nextLoop.questEconomy.presentation,
          hookSlots: hookSlotsPruned,
          worldPulseSlot: worldPulseSlotPruned,
        },
      };
    }

    const actionableHookSlots = nextLoop.questEconomy.presentation.hookSlots.slice(0, 3);
    const worldPulseSlot = nextLoop.questEconomy.presentation.worldPulseSlot;
    const cacheStates: Array<{
      slot: (typeof actionableHookSlots)[number];
      slotType: QuestHookTextSlotType;
      cacheHit: boolean;
    }> = actionableHookSlots.map((slot) => ({
      slot,
      slotType: "actionable",
      cacheHit: isQuestHookTextCacheValid(slot, nowIso),
    }));
    if (worldPulseSlot) {
      cacheStates.push({
        slot: worldPulseSlot,
        slotType: "worldPulse",
        cacheHit: isQuestHookTextCacheValid(worldPulseSlot, nowIso),
      });
    }

    const cacheHitBySlotKey = new Map(
      cacheStates.filter((entry) => entry.cacheHit).map((entry) => [entry.slot.slotKey, true]),
    );
    const actionableMissSlots = cacheStates.filter((entry) => entry.slotType === "actionable" && !entry.cacheHit);
    const worldPulseMissSlot = cacheStates.find((entry) => entry.slotType === "worldPulse" && !entry.cacheHit) ?? null;

    const cacheMissCandidates: Array<{ slot: (typeof cacheStates)[number]["slot"]; slotType: QuestHookTextSlotType }> = [];
    if (worldPulseMissSlot) {
      cacheMissCandidates.push({
        slot: worldPulseMissSlot.slot,
        slotType: "worldPulse",
      });
    }
    for (const miss of actionableMissSlots) {
      if (cacheMissCandidates.length >= 3) {
        break;
      }
      cacheMissCandidates.push({
        slot: miss.slot,
        slotType: "actionable",
      });
    }
    const missedTotalCount = actionableMissSlots.length + (worldPulseMissSlot ? 1 : 0);
    if (missedTotalCount > cacheMissCandidates.length) {
      hookTextSkippedByBudget = true;
    }
    const cacheMissSlotKeys = new Set(cacheMissCandidates.map((entry) => entry.slot.slotKey));

    hookTextCacheHitCount = cacheHitBySlotKey.size;
    hookTextCacheMissCount = cacheMissCandidates.length;

    let appliedSlotKeySet = new Set<string>();
    if (!this.richHookTextEnabled) {
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
        const hookTextInput: QuestHookTextInput = {
          contractVersion: LLM_CONTRACT_VERSION,
          sessionId: session.sessionId,
          sceneId: nextLoop.scene.sceneId,
          nowIso,
          slots: cacheMissCandidates.map((entry) => {
            if (entry.slotType === "worldPulse") {
              return {
                slotKey: entry.slot.slotKey,
                slotType: "worldPulse" as const,
                archetype: worldPulseSnapshot.topPressure?.archetype ?? "public_order",
                trend: worldPulseSnapshot.topPressure?.trend ?? "steady",
                intensityBand: pressureIntensityBand(worldPulseSnapshot.topPressure?.intensity ?? 0),
                locationHint: nextLoop.scene.locationId,
                defaultText: entry.slot.defaultText,
                sourceHash: buildQuestHookSlotSourceHash(entry.slot),
              };
            }

            return {
              slotKey: entry.slot.slotKey,
              slotType: "actionable" as const,
              questId: entry.slot.questId,
              lifecycle: entry.slot.lifecycle,
              urgencyBand: entry.slot.urgencyBand,
              hookType: entry.slot.hookType,
              locationId: entry.slot.locationId,
              defaultText: entry.slot.defaultText,
              sourceHash: buildQuestHookSlotSourceHash(entry.slot),
            };
          }),
        };

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
              nowIso,
              cacheTtlSec: this.hookTextCacheTtlSec,
            });
            nextLoop.questEconomy = applied.nextEconomy;
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
          hookTextReason = error instanceof Error && error.message === "hook_text_timeout" ? "renderer_timeout" : "renderer_error";
        }
      }
    }

    const finalHookSlots = nextLoop.questEconomy.presentation.hookSlots.slice(0, 3);
    const finalSlotRows: Array<{ slot: (typeof finalHookSlots)[number]; slotType: QuestHookTextSlotType }> = finalHookSlots.map((slot) => ({
      slot,
      slotType: "actionable",
    }));
    if (nextLoop.questEconomy.presentation.worldPulseSlot) {
      finalSlotRows.push({
        slot: nextLoop.questEconomy.presentation.worldPulseSlot,
        slotType: "worldPulse",
      });
    }

    hookTextSlotMeta = finalSlotRows.map((row) => {
      const cacheHit = cacheHitBySlotKey.get(row.slot.slotKey) === true;
      const applied = appliedSlotKeySet.has(row.slot.slotKey);
      return {
        slotKey: row.slot.slotKey,
        slotType: row.slotType,
        source: row.slot.llmShortText ? "llm" : "default",
        cacheHit,
        skipReason:
          cacheHit || applied
            ? null
            : !cacheMissSlotKeys.has(row.slot.slotKey)
              ? "skippedByBudget"
              : hookTextReason ?? (hookTextResult === "skipped" ? "skipped" : null),
      };
    });

    nextLoop.questEconomy = setQuestHookTextDebugState({
      economy: nextLoop.questEconomy,
      nowIso,
      generationAttempted: hookTextGenerationAttempted,
      result: hookTextResult,
      reason: hookTextReason,
      cacheHitCount: hookTextCacheHitCount,
      cacheMissCount: hookTextCacheMissCount,
      slotMeta: hookTextSlotMeta,
    });

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

    for (const anchorEvent of resolution.anchorSummary.events) {
      session = appendTraceEvent(
        session,
        createTraceEvent({
          lane: "engine",
          type: anchorEventTypeToTraceType(anchorEvent.eventType),
          tsIso: nowIso,
          data: {
            anchorId: anchorEvent.anchorId,
            pressureId: anchorEvent.pressureId,
            archetype: anchorEvent.archetype,
            from: anchorEvent.from,
            to: anchorEvent.to,
            reason: anchorEvent.reason,
            intensity: anchorEvent.intensity,
            signalMode: resolution.anchorSummary.debug.signalMode,
          },
        }),
      );
    }

    session = appendTraceEvent(
      session,
      createTraceEvent({
        lane: "engine",
        type: "engine.temporal.updated",
        tsIso: nowIso,
        data: {
          locationId: resolution.temporalSummary.locationId,
          memoryTouched: resolution.temporalSummary.memoryTouched,
          memoryDecayed: resolution.temporalSummary.memoryDecayed,
          freshnessUpdated: resolution.temporalSummary.freshnessUpdated,
          freshnessDecayed: resolution.temporalSummary.freshnessDecayed,
          tracesCreated: resolution.temporalSummary.tracesCreated,
          tracesUpdated: resolution.temporalSummary.tracesUpdated,
          tracesDecayed: resolution.temporalSummary.tracesDecayed,
          tracesExpired: resolution.temporalSummary.tracesExpired,
          locationShifted: resolution.temporalSummary.locationShifted,
          locationSnapshot: resolution.temporalSummary.locationSnapshot,
          qualitative: resolution.temporalSummary.qualitative,
        },
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

    session = appendTraceEvent(
      session,
      createTraceEvent({
        lane: "engine",
        type: "engine.quest.lifecycle",
        tsIso: nowIso,
        data: {
          transitionCount: resolution.questSummary.transitionCount,
          transitions: resolution.questSummary.transitions.slice(0, 6),
          surfacedNow: resolution.questSummary.surfacedNow,
          expiredDeleted: resolution.questSummary.expiredDeleted,
          failedNow: resolution.questSummary.failedNow,
          mutatedNow: resolution.questSummary.mutatedNow,
          archivedNow: resolution.questSummary.archivedNow,
          budgetUsed: resolution.questSummary.budget.used,
          budgetCaps: resolution.questSummary.budget.caps,
          softQuotaCaps: resolution.questSummary.softQuota.caps,
          topQuotaUsage: {
            location: resolution.questSummary.softQuota.usageByLocation[0] ?? null,
            pressure: resolution.questSummary.softQuota.usageByPressure[0] ?? null,
            archetype: resolution.questSummary.softQuota.usageByArchetype[0] ?? null,
          },
          panelSummary: {
            actionable: {
              activeCount: resolution.questSummary.panelSummary.actionable.activeCount,
              surfacedCount: resolution.questSummary.panelSummary.actionable.surfacedCount,
              activeTop: resolution.questSummary.panelSummary.actionable.activeTop,
              surfacedTop: resolution.questSummary.panelSummary.actionable.surfacedTop,
            },
            worldPulse: resolution.questSummary.panelSummary.worldPulse,
            recentOutcomes: resolution.questSummary.panelSummary.recentOutcomes.items,
          },
          tuningSnapshot: {
            surfacingRate: resolution.questSummary.tuningSnapshot.surfacingRate,
            expirationRate: resolution.questSummary.tuningSnapshot.expirationRate,
            mutationRate: resolution.questSummary.tuningSnapshot.mutationRate,
            successorRate: resolution.questSummary.tuningSnapshot.successorRate,
            budgetUtilization: resolution.questSummary.tuningSnapshot.budgetUtilization,
            quotaSaturation: resolution.questSummary.tuningSnapshot.quotaSaturation,
            averageUrgency: resolution.questSummary.tuningSnapshot.averageUrgency,
            activeVsSurfacedRatio: resolution.questSummary.tuningSnapshot.activeVsSurfacedRatio,
          },
        },
      }),
    );

    session = appendTraceEvent(
      session,
      createTraceEvent({
        lane: "engine",
        type: "engine.quest.hook_text",
        tsIso: nowIso,
        severity: hookTextResult === "fallback" ? "warn" : "info",
        code: hookTextReason ?? undefined,
        recoverable: true,
        data: {
          generationAttempted: hookTextGenerationAttempted,
          result: hookTextResult,
          reason: hookTextReason,
          slotCount: cacheStates.length,
          cacheHitCount: hookTextCacheHitCount,
          cacheMissCount: hookTextCacheMissCount,
          updatedCount: hookTextUpdatedCount,
          skippedByPolicy: hookTextSkippedByPolicy,
          skippedByBudget: hookTextSkippedByBudget,
          slotMeta: hookTextSlotMeta,
        },
      }),
    );

    session = appendTraceEvent(
      session,
      createTraceEvent({
        lane: "engine",
        type: "engine.action.resolved",
        tsIso: nowIso,
        data: {
          inputActionId: routeActionId,
          resolvedActionId: resolution.resolvedActionId,
          classification: resolution.classification,
          deltaTimeSec: resolution.deltaTimeSec,
          selectedSource,
          selectedConfidence,
          analyzerWeight: selectedAnalyzerWeight,
          fallbackStrategy: selectedFallbackStrategy,
          preResolvedClaimUntrusted,
          locationId: nextLoop.scene.locationId,
          temporalLocationShifted: resolution.temporalSummary.locationShifted,
          questTransitionCount: resolution.questSummary.transitionCount,
          questSpawnedSeeds: resolution.questSummary.spawnedSeeds,
          sceneTransitioned,
        },
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
