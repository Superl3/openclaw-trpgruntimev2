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
import {
  buildFactionCanonFingerprint,
  buildFactionCanonReferenceIndexFromWorldSeed,
  detectFactionCanonScaffoldDrift,
  validateFactionCanon,
} from "../../faction-canon.js";
import {
  createRuntimeCanonicalProvenance,
  driftStatusFromLoadStatus,
  type CanonicalLoadStatus,
} from "../../runtime-core/sync-meta.js";
import { appendTraceEvent, createTraceEvent, ensureTraceState } from "../../runtime-core/trace.js";
import { JsonFileStateStore } from "../../runtime-store/file-state-store.js";
import {
  ensureSessionPresentationState,
  ensureRuntimeMetadata,
  type InteractionRouteRecord,
  type RuntimeCanonicalProvenance,
  type SessionState,
} from "../../runtime-core/types.js";
import { loadStructuredWorldFile } from "../../world-store.js";
import {
  SESSION_DATA_SECTIONS,
  consumeSessionResetConfirmation,
  copySectionData,
  deleteSectionDataFromWorkspace,
  ensureSessionWorkspace,
  issueSessionResetConfirmation,
  readSessionWorkspaceRecord,
  wipeSessionWorkspace,
  type SessionDataSection,
} from "../../runtime-core/session-workspaces.js";

const CHECKPOINT0_STORE_RELATIVE_PATH = "state/runtime-core";
const FACTION_CANON_PATH = "canon/factions.yaml";
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
const NEW_CONFIRM_TOKEN_TTL_MS = 5 * 60 * 1000;

const SESSION_NEW_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    channelKey: { type: "string" },
    ownerId: { type: "string" },
    actorId: { type: "string" },
    sceneId: { type: "string" },
    confirmReset: { type: "boolean" },
    confirmToken: { type: "string" },
    wipeMode: { type: "string", enum: ["ask", "force"] },
  },
} as const;

const SECTION_ITEMS_SCHEMA = {
  type: "string",
  enum: SESSION_DATA_SECTIONS,
} as const;

const SESSION_SECTION_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    sessionId: { type: "string" },
    channelKey: { type: "string" },
    actorId: { type: "string" },
    sections: { type: "array", items: SECTION_ITEMS_SCHEMA, minItems: 1 },
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

const SESSION_HELP_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const SESSION_VERBOSE_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    sessionId: { type: "string" },
    channelKey: { type: "string" },
    actorId: { type: "string" },
    enabled: { type: "boolean" },
    tailCount: { type: "integer", minimum: 1, maximum: 12 },
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

type TrpgCommandHint = {
  command: string;
  tool: string;
  summary: string;
  example: string;
};

const TRPG_COMMAND_HINTS: TrpgCommandHint[] = [
  {
    command: "/trpg help",
    tool: "trpg_session_help",
    summary: "사용 가능한 TRPG 명령과 예시를 확인한다.",
    example: "/trpg help",
  },
  {
    command: "/trpg new",
    tool: "trpg_session_new",
    summary: "새 세션과 임시 워크스페이스를 시작한다.",
    example: "/trpg new",
  },
  {
    command: "/trpg resume",
    tool: "trpg_session_resume",
    summary: "현재 채널의 활성 세션 패널을 복구/재생성한다.",
    example: "/trpg resume",
  },
  {
    command: "/trpg save",
    tool: "trpg_session_save",
    summary: "임시 워크스페이스 변경을 canonical 파일로 저장한다.",
    example: "/trpg save sections=[\"status\",\"inventory\"]",
  },
  {
    command: "/trpg load",
    tool: "trpg_session_load",
    summary: "canonical 파일 내용을 임시 워크스페이스로 다시 불러온다.",
    example: "/trpg load sections=[\"player\",\"scene\"]",
  },
  {
    command: "/trpg data-delete",
    tool: "trpg_session_data_delete",
    summary: "임시 워크스페이스의 선택 섹션만 삭제한다.",
    example: "/trpg data-delete sections=[\"scene\"]",
  },
  {
    command: "/trpg verbose",
    tool: "trpg_session_verbose",
    summary: "디버그 추적 표시를 토글한다.",
    example: "/trpg verbose enabled=true",
  },
  {
    command: "/trpg end",
    tool: "trpg_session_end",
    summary: "세션을 종료하고 패널을 마감한다.",
    example: "/trpg end",
  },
];

function buildVisibleCommandHints() {
  return {
    title: "TRPG 명령 안내",
    dataManagementNote: "데이터 관리 명령 안내: /trpg save · /trpg load · /trpg data-delete (자세한 예시는 /trpg help)",
    commands: TRPG_COMMAND_HINTS,
  };
}

function buildNewConfirmationActionHints(confirmToken: string) {
  return {
    yes: {
      label: "YES",
      intent: "기존 세션/임시데이터를 정리하고 /trpg new를 강행한다.",
      tool: "trpg_session_new",
      params: {
        confirmReset: true,
        confirmToken,
        wipeMode: "force",
      },
      manualExample: `/trpg new confirmReset=true confirmToken=${confirmToken} wipeMode=force`,
    },
    no: {
      label: "NO",
      intent: "리셋을 취소하고 현재 상태를 유지한다.",
      tool: "trpg_session_new",
      params: {
        confirmReset: false,
        wipeMode: "ask",
      },
      manualExample: "/trpg new confirmReset=false wipeMode=ask",
    },
  };
}

function buildSessionStartActionComponents(sessionId: string, actorId: string) {
  return {
    type: "actions",
    buttons: [
      {
        id: "trpg_start_resume",
        label: "▶️ 패널 시작/갱신",
        style: "primary",
        tool: "trpg_session_resume",
        params: {
          sessionId,
          actorId,
        },
      },
      {
        id: "trpg_start_help",
        label: "❓ 명령 보기",
        style: "secondary",
        tool: "trpg_session_help",
        params: {},
      },
    ],
  };
}

function buildSessionResumeActionComponents(sessionId: string, actorId: string) {
  return {
    type: "actions",
    buttons: [
      {
        id: "trpg_resume_refresh",
        label: "🔄 패널 새로고침",
        style: "primary",
        tool: "trpg_session_resume",
        params: {
          sessionId,
          actorId,
        },
      },
      {
        id: "trpg_resume_end",
        label: "⏹️ 세션 종료",
        style: "secondary",
        tool: "trpg_session_end",
        params: {
          sessionId,
          actorId,
        },
      },
    ],
  };
}

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

function sanitizeLegacyBootstrapTemplateText(value: string): string {
  const normalized = readString(value);
  if (!normalized) {
    return "";
  }

  const hasForbidden =
    /\bpart\s*a\b|\bpart\s*b\b/i.test(normalized) ||
    /좋아요\s*,?\s*새\s*캐릭터\s*생성을\s*시작할게요/i.test(normalized) ||
    /숨기고\s*있는\s*비밀/i.test(normalized) ||
    (normalized.match(/(?:^|\n)\s*[1-6]\s*[\).:：-]\s+/g)?.length ?? 0) >= 4;

  if (hasForbidden) {
    return "캐릭터 준비를 이어갈게요.";
  }

  return normalized;
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

function clampTraceTailCount(value: unknown, fallback: number): number {
  const parsed = readInteger(value);
  if (!parsed) {
    return fallback;
  }
  return Math.max(1, Math.min(12, parsed));
}

function summarizeTraceData(value: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const allowedKeys = new Set([
    "routeActionId",
    "inputActionId",
    "resolvedActionId",
    "selectedActionId",
    "selectedSource",
    "selectedConfidence",
    "classification",
    "deltaTimeSec",
    "sceneId",
    "uiVersion",
    "result",
    "reason",
    "transitionCount",
    "surfacedNow",
    "expiredDeleted",
    "failedNow",
    "mutatedNow",
    "archivedNow",
    "generationAttempted",
    "updatedCount",
    "slotCount",
    "locationId",
    "locationShifted",
    "memoryTouched",
    "tracesCreated",
    "tracesExpired",
    "dispatchId",
    "mode",
    "actionId",
  ]);
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!allowedKeys.has(key)) {
      continue;
    }
    if (typeof raw === "string") {
      out[key] = raw.length <= 72 ? raw : `${raw.slice(0, 69)}...`;
      continue;
    }
    if (typeof raw === "number" || typeof raw === "boolean" || raw === null) {
      out[key] = raw;
    }
  }
  return out;
}

function traceTailPayload(session: SessionState, tailCount: number, includeData: boolean): Array<Record<string, unknown>> {
  return session.trace.events.slice(-tailCount).map((event) => {
    const base: Record<string, unknown> = {
      tsIso: event.tsIso,
      lane: event.lane,
      type: event.type,
      severity: event.severity,
    };
    if (event.code) {
      base.code = event.code;
    }
    if (includeData) {
      base.data = summarizeTraceData(event.data);
    }
    return base;
  });
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
        validatedSeed: null,
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
        validatedSeed: null,
        diagnostics: toSeedDiagnostics(validated.issues, candidatePath),
      };
    }

    return {
      status: "used",
      sourcePath: candidatePath,
      bootstrap: buildRuntimeBootstrapInput(validated.seed),
      validatedSeed: validated.seed,
      diagnostics: toSeedDiagnostics(validated.issues, candidatePath),
    };
  }

  return {
    status: "missing",
    sourcePath: null,
    bootstrap: null,
    validatedSeed: null,
    diagnostics: [],
  };
}

async function loadRuntimeCanonicalProvenance(params: {
  worldRoot: string;
  cfg: TrpgRuntimeConfig;
  seedBootstrap: RuntimeBootstrapLoadResult;
}): Promise<RuntimeCanonicalProvenance> {
  const nowIso = new Date().toISOString();
  const seedStatus = params.seedBootstrap.status as CanonicalLoadStatus;
  const seed = params.seedBootstrap.validatedSeed;

  let canonStatus: CanonicalLoadStatus = "missing";
  let canonSourcePath: string | null = null;
  let canonFingerprint: string | null = null;
  let canonWorldId: string | null = null;
  let driftCounts = {
    addedInSeed: 0,
    missingInSeed: 0,
    changedScaffold: 0,
    incompatible: 0,
  };
  let hasDrift = false;
  let hasIncompatible = false;

  try {
    const loadedCanon = await loadStructuredWorldFile(params.worldRoot, FACTION_CANON_PATH, {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    });

    if (!loadedCanon.exists) {
      canonStatus = "missing";
    } else {
      canonSourcePath = FACTION_CANON_PATH;
      const referenceIndex = seed ? buildFactionCanonReferenceIndexFromWorldSeed(seed) : null;
      const validatedCanon = validateFactionCanon(loadedCanon.parsed, {
        references: referenceIndex
          ? {
              worldId: referenceIndex.worldId,
              locationIds: referenceIndex.locationIds,
              pressureIds: referenceIndex.pressureIds,
            }
          : undefined,
      });

      if (!validatedCanon.ok) {
        canonStatus = "invalid";
      } else {
        canonStatus = "used";
        canonWorldId = validatedCanon.canon.worldId;
        canonFingerprint = buildFactionCanonFingerprint(validatedCanon.canon);
        if (seed) {
          const drift = detectFactionCanonScaffoldDrift({
            seed,
            canon: validatedCanon.canon,
          });
          driftCounts = {
            addedInSeed: drift.summary.addedInSeed,
            missingInSeed: drift.summary.missingInSeed,
            changedScaffold: drift.summary.changedScaffold,
            incompatible: drift.summary.incompatible,
          };
          hasDrift =
            drift.summary.addedInSeed > 0 ||
            drift.summary.missingInSeed > 0 ||
            drift.summary.changedScaffold > 0 ||
            drift.summary.incompatible > 0;
          hasIncompatible = drift.status === "incompatible";
        }
      }
    }
  } catch {
    canonStatus = "error";
  }

  const driftStatus = driftStatusFromLoadStatus({
    seedStatus,
    canonStatus,
    hasDrift,
    hasIncompatible,
  });

  return createRuntimeCanonicalProvenance({
    sourcePolicy: "canon_authoritative",
    worldId: seed?.worldId ?? canonWorldId ?? null,
    schemaVersion: seed?.schemaVersion ?? null,
    seedSourcePath: params.seedBootstrap.sourcePath,
    seedFingerprint: params.seedBootstrap.bootstrap?.seedFingerprint ?? null,
    canonSourcePath,
    canonFingerprint,
    generatedAtIso: seed?.createdAtIso ?? null,
    validatedAtIso: nowIso,
    driftStatus,
    driftCounts,
  });
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

function resolveSessionContextId(params: Record<string, unknown>, ctx: OpenClawPluginToolContext, channelKey: string): string {
  const fromContext = readString(ctx.sessionId);
  if (fromContext) {
    return fromContext;
  }
  const fromParam = readString(params.sessionId);
  if (fromParam) {
    return fromParam;
  }
  return channelKey;
}

function resolveSectionList(value: unknown): SessionDataSection[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [...SESSION_DATA_SECTIONS];
  }

  const allowed = new Set<SessionDataSection>(SESSION_DATA_SECTIONS);
  const selected: SessionDataSection[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") {
      continue;
    }
    if (!allowed.has(raw as SessionDataSection)) {
      continue;
    }
    const typed = raw as SessionDataSection;
    if (!selected.includes(typed)) {
      selected.push(typed);
    }
  }

  return selected.length > 0 ? selected : [...SESSION_DATA_SECTIONS];
}

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

  const panelDispatchMessage =
    params.session.status === "active" ? `${panel.message} · 데이터 관리 명령: /trpg help` : panel.message;

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
        dataManagementGuide: {
          text: "데이터 관리 명령 안내: /trpg save · /trpg load · /trpg data-delete",
          helpCommand: "/trpg help",
        },
        blockedActions: loop.actionPalette
          .filter((entry) => entry.availability === "currently_impossible" || entry.availability === "impossible")
          .map((entry) => ({ actionId: entry.actionId, reason: entry.reason })),
      },
    },
    panelDispatch: {
      action: panel.mode,
      dispatchId,
      message: panelDispatchMessage,
      messageId: panel.messageId,
      components: panel.components,
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

          if (contaminationDetected) {
            if (!confirmReset) {
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
                components: {
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
              });
            }

            const verified = await consumeSessionResetConfirmation({
              canonicalWorldRoot: gate.worldRoot,
              token: confirmToken,
              sessionContextId,
              channelKey,
              ownerId,
            });
            if (!verified.ok) {
              return jsonToolResult(
                runtimeError({
                  command: "/trpg new",
                  errorCode: "invalid_confirm_token",
                  message: "confirmToken is invalid, expired, or mismatched with current context.",
                  recoverable: true,
                  recoveryHint: "Run /trpg new again and use the latest YES token.",
                }),
              );
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
    "[trpg-runtime] checkpoint1 lifecycle tools registered: trpg_session_help, trpg_session_new, trpg_session_resume, trpg_session_end, trpg_session_verbose, trpg_session_save, trpg_session_load, trpg_session_data_delete, trpg_panel_interact, trpg_panel_message_commit",
  );
}
