import type { DeterministicSceneLoopState } from "./scene-loop.js";

export const RUNTIME_SCHEMA_VERSION = 1 as const;
export const WORLD_SEED_SCHEMA_VERSION = 1 as const;

export type SessionStatus = "active" | "ended";

export type SeedPressureArchetype = "smuggling" | "outbreak" | "power_struggle" | "artifact_race" | "public_order";

export type GenerationProfile = {
  profileId: string;
  pressureScalePercent: number;
  locationVolatility: "stable" | "mixed" | "volatile";
};

export type LocationSeed = {
  locationId: string;
  tags: string[];
  baseline: {
    tension: number;
    alertness: number;
    accessibility: number;
  };
  pressureAffinityIds: string[];
};

export type PressureSeed = {
  pressureId: string;
  archetype: SeedPressureArchetype;
  intensity: number;
  momentum: number;
  cadenceSec: number;
  targetLocationIds: string[];
};

export type FactionSeed = {
  factionId: string;
  homeLocationId: string;
  agendaTags: string[];
  pressureBiasRefs: string[];
};

export type NpcArchetypePool = {
  npcArchetypeId: string;
  factionId: string | null;
  locationAffinityIds: string[];
  roleTags: string[];
};

export type WorldSeed = {
  schemaVersion: typeof WORLD_SEED_SCHEMA_VERSION;
  worldId: string;
  seedValue: string;
  createdAtIso: string;
  generationProfile: GenerationProfile;
  locations: LocationSeed[];
  pressures: PressureSeed[];
  factions: FactionSeed[];
  npcPool: NpcArchetypePool[];
};

export type RuntimeBootstrapInput = {
  source: "worldSeed";
  worldId: string;
  schemaVersion: number;
  seedValue: string;
  seedFingerprint: string;
  determinismKey: string;
  generationProfile: GenerationProfile;
  questEconomy: {
    worldPressures: Array<{
      pressureId: string;
      archetype: SeedPressureArchetype;
      intensity: number;
      momentum: number;
      cadenceSec: number;
      targetLocations: string[];
      anchorCandidate: boolean;
    }>;
  };
  temporal: {
    locationBaselines: Array<{
      locationId: string;
      tension: number;
      alertness: number;
      accessibility: number;
      recentIncidents: string[];
    }>;
  };
  scaffold: {
    factionIds: string[];
    npcArchetypeIds: string[];
  };
};

export type RuntimeBootstrapDiagnosticSeverity = "info" | "warn" | "error";

export type RuntimeBootstrapDiagnostic = {
  code: string;
  message: string;
  path: string | null;
  severity: RuntimeBootstrapDiagnosticSeverity;
};

export type RuntimeSeedProvenance = {
  worldId: string;
  schemaVersion: number;
  seedValue: string;
  seedFingerprint: string;
};

export type RuntimeBootstrapMetadata = {
  source: "default" | "worldSeed";
  seed: RuntimeSeedProvenance | null;
  diagnostics: RuntimeBootstrapDiagnostic[];
};

export type RuntimeMetadata = {
  bootstrap: RuntimeBootstrapMetadata;
};

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
  | "engine.quest.hook_text"
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
  runtimeMetadata: RuntimeMetadata;
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

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDiagnosticSeverity(value: unknown): RuntimeBootstrapDiagnosticSeverity {
  const normalized = readString(value);
  if (normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized;
  }
  return "warn";
}

function normalizeRuntimeSeedProvenance(value: unknown): RuntimeSeedProvenance | null {
  const node = toRecord(value);
  const worldId = readString(node.worldId);
  const seedValue = readString(node.seedValue);
  const seedFingerprint = readString(node.seedFingerprint);
  const schemaVersionRaw = Number(node.schemaVersion);
  const schemaVersion = Number.isFinite(schemaVersionRaw) ? Math.max(1, Math.trunc(schemaVersionRaw)) : 1;
  if (!worldId || !seedValue || !seedFingerprint) {
    return null;
  }
  return {
    worldId,
    seedValue,
    seedFingerprint,
    schemaVersion,
  };
}

function normalizeRuntimeBootstrapDiagnostics(value: unknown): RuntimeBootstrapDiagnostic[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const diagnostics: RuntimeBootstrapDiagnostic[] = [];
  for (const entry of value) {
    const node = toRecord(entry);
    const code = readString(node.code);
    const message = readString(node.message);
    if (!code || !message) {
      continue;
    }
    diagnostics.push({
      code,
      message,
      path: readString(node.path) || null,
      severity: normalizeDiagnosticSeverity(node.severity),
    });
    if (diagnostics.length >= 24) {
      break;
    }
  }
  return diagnostics;
}

export function ensureRuntimeMetadata(value: unknown): RuntimeMetadata {
  const root = toRecord(value);
  const bootstrapNode = toRecord(root.bootstrap);
  const sourceRaw = readString(bootstrapNode.source);
  const source: RuntimeBootstrapMetadata["source"] = sourceRaw === "worldSeed" ? "worldSeed" : "default";

  return {
    bootstrap: {
      source,
      seed: normalizeRuntimeSeedProvenance(bootstrapNode.seed),
      diagnostics: normalizeRuntimeBootstrapDiagnostics(bootstrapNode.diagnostics),
    },
  };
}
