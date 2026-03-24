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
  ResolveInteractionRouteInput,
  ResumeSessionInput,
  RuntimeEngine,
  SceneRenderer,
  StartNewSessionInput,
  StateStore,
} from "./contracts.js";
import type {
  IntentAnalyzerInput,
  IntentAnalyzerOutput,
  PersonaDriftAnalyzerInput,
  PersonaDriftAnalyzerOutput,
  SceneRendererInput,
  SceneRendererOutput,
} from "./llm-contracts.js";
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
  RUNTIME_SCHEMA_VERSION,
  type EndSessionResult,
  type InteractionRouteRecord,
  type NewSessionResult,
  type PanelId,
  type PanelRecoveryInstruction,
  type ResumeSessionResult,
  type SessionState,
} from "./types.js";

const DEFAULT_SCENE_ID = "scene-bootstrap";

const PANEL_IDS: PanelId[] = ["fixed", "main", "sub"];

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

class Checkpoint0RuntimeEngine implements RuntimeEngine {
  private readonly store: StateStore;
  private readonly intentAnalyzer: IntentAnalyzer;
  private readonly personaDriftAnalyzer: PersonaDriftAnalyzer;
  private readonly sceneRenderer: SceneRenderer;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly traceMaxEvents: number;
  private readonly analyzerMemoryTtlSec: number;

  constructor(deps: RuntimeEngineDependencies) {
    this.store = deps.store;
    this.intentAnalyzer = deps.intentAnalyzer;
    this.personaDriftAnalyzer = deps.personaDriftAnalyzer;
    this.sceneRenderer = deps.sceneRenderer;
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
    const normalized: SessionState = {
      ...session,
      sceneId,
      actionSeq,
      turnIndex: actionSeq,
      deterministicLoop: loop,
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

  private createSessionSkeleton(input: {
    sessionId: string;
    channelKey: string;
    ownerId: string;
    sceneId: string;
    nowIso: string;
  }): SessionState {
    const deterministicLoop = createInitialDeterministicSceneLoop({
      sceneId: input.sceneId,
      nowIso: input.nowIso,
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

  async renderScene(input: SceneRendererInput): Promise<SceneRendererOutput> {
    return this.sceneRenderer.render(input);
  }
}

export function createCheckpoint0RuntimeEngine(deps: RuntimeEngineDependencies): RuntimeEngine {
  return new Checkpoint0RuntimeEngine(deps);
}
