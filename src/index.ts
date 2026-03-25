import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import {
  assertAgentAllowed,
  parseTrpgRuntimeConfig,
  resolveWorldRootForContext,
  trpgRuntimeConfigSchema,
  type TrpgRuntimeConfig,
} from "./config.js";
import { runDiceRoll, type DiceRollInput } from "./dice.js";
import {
  createPatchCache,
  runPatchApply,
  runPatchDryRun,
  type PatchApplyInput,
  type PatchDryRunInput,
} from "./patch-engine.js";
import {
  formatFactionPromptSummary,
  runFactionEngineTick,
  type FactionTickInput,
} from "./faction-engine.js";
import {
  loadStructuredWorldFile,
  renderStructuredContent,
  resolveWorldAbsolutePath,
  runHooksQuery,
  runStoreGet,
  type HooksQueryInput,
  type StoreGetInput,
} from "./world-store.js";
import {
  buildLifecycleCompactionPreview,
  runStateCompactionTool,
  type StateCompactInput,
} from "./lifecycle-compact.js";
import {
  buildSceneComponents,
  COMPONENT_USAGE_GUIDE,
  type SceneComponentInput,
} from "./discord-components.js";

const STORE_GET_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    entityIds: { type: "array", items: { type: "string" } },
    paths: { type: "array", items: { type: "string" } },
    scope: { type: "string", enum: ["all", "canon", "state", "secrets", "logs"] },
    viewMode: {
      type: "string",
      enum: ["raw", "truth", "player_known", "public_rumor", "npc_beliefs"],
    },
    maxFiles: { type: "integer", minimum: 1, maximum: 200 },
    includeRaw: { type: "boolean" },
  },
} as const;

const PATCH_OPERATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    op: { type: "string", enum: ["set", "delete", "append_list"] },
    file: { type: "string" },
    pointer: { type: "string" },
    value: {},
    expectedSha256: { type: "string" },
  },
  required: ["op", "file", "pointer"],
} as const;

const PATCH_DRY_RUN_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    patchId: { type: "string" },
    title: { type: "string" },
    allowNewFiles: { type: "boolean" },
    operations: { type: "array", items: PATCH_OPERATION_SCHEMA, minItems: 1 },
  },
  required: ["operations"],
} as const;

const PATCH_APPLY_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    validatedPatchId: { type: "string" },
    patchPayload: PATCH_DRY_RUN_PARAMETERS,
    audit: {
      type: "object",
      additionalProperties: false,
      properties: {
        approved: { type: "boolean" },
        approvedBy: { type: "string", enum: ["canon-auditor"] },
        verdict: { type: "string", enum: ["pass", "fail"] },
        conflictStatus: { type: "string", enum: ["non-conflicting", "conflicting"] },
        canonAbsorptionVerdict: {
          type: "string",
          enum: ["accept", "reconcile", "reject-hard-conflict"],
        },
        note: { type: "string" },
      },
      required: ["approved", "approvedBy", "verdict", "conflictStatus"],
    },
  },
  required: ["audit"],
} as const;

const HOOKS_QUERY_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    currentSceneTags: { type: "array", items: { type: "string" } },
    actorIds: { type: "array", items: { type: "string" } },
    pacingTarget: { type: "string", enum: ["slow-burn", "steady", "escalate", "cooldown"] },
    revealBudget: { type: "integer", minimum: 0, maximum: 20 },
  },
} as const;

const DICE_ROLL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    notation: { type: "string" },
    modifier: { type: "number" },
    seedPolicy: { type: "string", enum: ["session", "fixed", "random"] },
    seed: { type: "string" },
    repeat: { type: "integer", minimum: 1, maximum: 20 },
  },
} as const;

const FACTION_TICK_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    trigger: { type: "string", enum: ["turn", "scene_transition", "session", "downtime"] },
    mode: { type: "string", enum: ["read-only", "dry-run"] },
    maxEvents: { type: "integer", minimum: 1, maximum: 8 },
    includeUndropped: { type: "boolean" },
    forceAdvance: { type: "boolean" },
  },
} as const;

const STATE_COMPACT_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: ["dry-run", "audited-apply"] },
    trigger: {
      type: "string",
      enum: ["manual", "scene_transition", "fast_wait", "downtime", "zone_generation", "interval"],
    },
    maxCandidates: { type: "integer", minimum: 1, maximum: 80 },
    includeProtected: { type: "boolean" },
    applyEvenWhenNoCandidates: { type: "boolean" },
    audit: {
      type: "object",
      additionalProperties: false,
      properties: {
        approved: { type: "boolean" },
        approvedBy: { type: "string", enum: ["canon-auditor"] },
        verdict: { type: "string", enum: ["pass", "fail"] },
        conflictStatus: { type: "string", enum: ["non-conflicting", "conflicting"] },
        canonAbsorptionVerdict: {
          type: "string",
          enum: ["accept", "reconcile", "reject-hard-conflict"],
        },
        note: { type: "string" },
      },
      required: ["approved", "approvedBy", "verdict", "conflictStatus"],
    },
  },
} as const;


function readSceneId(scene: Record<string, unknown>): string {
  return readString(scene.scene_id) || readString(scene.id) || "unknown-scene";
}

function parseSceneIdFromTick(lastAdvancedTick: string): string {
  const marker = ":scene-";
  const markerIndex = lastAdvancedTick.indexOf(marker);
  if (markerIndex < 0) {
    return "";
  }

  const afterMarker = lastAdvancedTick.slice(markerIndex + marker.length);
  const nextDelimiter = afterMarker.indexOf(":");
  return (nextDelimiter >= 0 ? afterMarker.slice(0, nextDelimiter) : afterMarker).trim();
}

type TravelMode = "none" | "walking" | "mounted" | "caravan" | "ship";

type ZoneGraphNode = {
  id: string;
  name: string;
  type: string;
  parentRegion: string;
  tags: string[];
  connections: string[];
  aliases: string[];
  pressure: number | null;
};

type TravelTransitionResult = {
  movementIntent: boolean;
  occurred: boolean;
  reason: string;
  contextChunk?: string;
  generatedZone?: boolean;
};

type BootstrapFieldKey = "name" | "background" | "motive" | "secret" | "fear" | "goal";

type BootstrapUpdate = Partial<Record<BootstrapFieldKey, string>>;

type BootstrapGateResult = {
  bootstrapComplete: boolean;
  justCompleted: boolean;
  contextChunk?: string;
};

type StatusPanelData = {
  hpCurrent: number | null;
  hpMax: number | null;
  staminaCurrent: number | null;
  staminaMax: number | null;
  stressCurrent: number | null;
  stressMax: number | null;
  money: number | null;
  staminaState: string;
  conditionState: string;
  tags: string[];
  fundsText: string;
  inventoryHighlights: string[];
  carriedItems: string[];
  equippedItems: string[];
  inventoryNotes: string[];
};

type NpcMemorySummary = {
  npcId: string;
  displayName: string;
  notes: string[];
  lastPlayerFocus: string;
};

type FastWaitContext = {
  waitApplied: boolean;
  durationLabel: string;
  contextChunk?: string;
};


type LifecycleState = "active" | "dormant" | "archived";
type CompactionMode = "dry-run" | "audited-apply";
type CompactionTrigger = "manual" | "scene_transition" | "fast_wait" | "downtime" | "zone_generation" | "interval";

type ZoneLifecycleMeta = {
  lifecycle_state: LifecycleState;
  last_active_turn_or_tick: string;
  last_player_presence: string;
  last_meaningful_change: string;
  significance_score: number;
  retention_weight: number;
  active_threads_count: number;
  archived_summary_ref?: string;
  reactivation_conditions: string[];
};

type CompactionCandidate = {
  candidate_id: string;
  source_type: string;
  source_ref: string;
  planned_move: "active_to_dormant" | "dormant_to_archived" | "signal_compact" | "memory_compact" | "rumor_compact" | "noise_remove";
  probability: number;
  sampled: number;
  selected: boolean;
  reasons: string[];
  protected: boolean;
};

type LifecycleCompactionPlan = {
  trigger: CompactionTrigger;
  maxCandidates: number;
  operations: Array<Record<string, unknown>>;
  candidates: CompactionCandidate[];
  protectedRefs: string[];
  skippedRefs: string[];
  summary: {
    considered: number;
    selected: number;
    activeToDormant: number;
    dormantToArchived: number;
    signalCompacted: number;
    memoryCompacted: number;
    rumorCompacted: number;
    noiseRemoved: number;
  };
};

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeZoneId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  return trimmed
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function normalizeAlias(value: string): string {
  return value.trim().toLowerCase();
}

function joinLines(lines: string[]): string {
  return lines.join(String.fromCharCode(10));
}

type PromptSurfaceChunk = {
  text: string;
  tag: string;
  mandatory: boolean;
  priority: number;
  maxLines: number;
  maxChars: number;
  order: number;
};

function extractChunkTag(chunk: string): string {
  const firstLine = chunk.split(String.fromCharCode(10), 1)[0] || "";
  const match = firstLine.match(/^\s*\[([A-Z0-9_]+)\]/);
  return match?.[1] || "UNTAGGED";
}

function clipChunkByBudget(chunk: string, maxLines: number, maxChars: number): string {
  const lines = chunk
    .split(String.fromCharCode(10))
    .map((line) => line.replaceAll(String.fromCharCode(13), ""));
  if (lines.length === 0) {
    return "";
  }

  const clippedLines = lines.slice(0, Math.max(1, maxLines));
  let clipped = clippedLines.join(String.fromCharCode(10));
  if (chunk.length > clipped.length || lines.length > clippedLines.length) {
    clipped = clipped + String.fromCharCode(10) + "...";
  }

  if (clipped.length <= maxChars) {
    return clipped;
  }

  const hardClipped = clipped.slice(0, Math.max(0, maxChars - 3)).trimEnd();
  return hardClipped + "...";
}

function buildPromptSurfaceChunk(params: {
  text: string;
  order: number;
  latestAction: string;
  bootstrapIncomplete: boolean;
}): PromptSurfaceChunk {
  const tag = extractChunkTag(params.text);
  const npcMemoryHot = isNpcMemoryRelevantAction(params.latestAction);

  const profileByTag: Record<
    string,
    { mandatory: boolean; priority: number; maxLines: number; maxChars: number }
  > = {
    TRPG_RUNTIME_CHARACTER_BOOTSTRAP: { mandatory: true, priority: 100, maxLines: 22, maxChars: 1800 },
    TRPG_RUNTIME_BOOTSTRAP_COMPLETED: { mandatory: true, priority: 96, maxLines: 12, maxChars: 1200 },
    TRPG_RUNTIME_INTRO_GUARD: { mandatory: true, priority: 94, maxLines: 16, maxChars: 1700 },
    TRPG_RUNTIME_SCENE_PERSISTENCE_GUARD: { mandatory: true, priority: 92, maxLines: 11, maxChars: 1300 },
    TRPG_RUNTIME_NPC_VISIBILITY_GUARD: { mandatory: true, priority: 90, maxLines: 9, maxChars: 900 },
    TRPG_RUNTIME_ACTION_FEASIBILITY_GUARD: { mandatory: true, priority: 88, maxLines: 14, maxChars: 1800 },
    TRPG_RUNTIME_FREEFORM_RULE: { mandatory: true, priority: 86, maxLines: 10, maxChars: 1200 },
    TRPG_DISCORD_COMPONENTS: { mandatory: true, priority: 84, maxLines: 20, maxChars: 2500 },
    TRPG_RUNTIME_STATUS_PANEL_V1: { mandatory: true, priority: 82, maxLines: 8, maxChars: 950 },
    TRPG_RUNTIME_TRAVEL_TRANSITION: { mandatory: false, priority: 76, maxLines: 9, maxChars: 1000 },
    TRPG_RUNTIME_FAST_WAIT_V1: { mandatory: false, priority: 74, maxLines: 8, maxChars: 900 },
    TRPG_RUNTIME_ECONOMY_LITE_V1: { mandatory: false, priority: 70, maxLines: 7, maxChars: 900 },
    TRPG_RUNTIME_NPC_MEMORY_V1: {
      mandatory: false,
      priority: npcMemoryHot ? 72 : 52,
      maxLines: npcMemoryHot ? 8 : 5,
      maxChars: npcMemoryHot ? 900 : 620,
    },
    FACTION_ENGINE_WORLD_MOTION: { mandatory: false, priority: 68, maxLines: 10, maxChars: 1200 },
  };

  const fallbackProfile = {
    mandatory: params.bootstrapIncomplete,
    priority: params.bootstrapIncomplete ? 84 : 45,
    maxLines: params.bootstrapIncomplete ? 14 : 8,
    maxChars: params.bootstrapIncomplete ? 1200 : 800,
  };

  const profile = profileByTag[tag] || fallbackProfile;
  return {
    text: clipChunkByBudget(params.text, profile.maxLines, profile.maxChars),
    tag,
    mandatory: profile.mandatory,
    priority: profile.priority,
    maxLines: profile.maxLines,
    maxChars: profile.maxChars,
    order: params.order,
  };
}

function applyPromptInjectionBudget(params: {
  chunks: string[];
  latestAction: string;
  bootstrapIncomplete: boolean;
}): { selected: string[]; droppedTags: string[] } {
  if (params.chunks.length === 0) {
    return { selected: [], droppedTags: [] };
  }

  const budgetMaxChunks = params.bootstrapIncomplete ? 3 : 10;
  const budgetMaxChars = params.bootstrapIncomplete ? 3200 : 7600;

  const surfaces = params.chunks
    .map((chunk, index) =>
      buildPromptSurfaceChunk({
        text: chunk,
        order: index,
        latestAction: params.latestAction,
        bootstrapIncomplete: params.bootstrapIncomplete,
      }),
    )
    .filter((chunk) => Boolean(chunk.text));

  const mandatory = surfaces
    .filter((chunk) => chunk.mandatory)
    .sort((a, b) => a.order - b.order);
  const optional = surfaces
    .filter((chunk) => !chunk.mandatory)
    .sort((a, b) => (a.priority === b.priority ? a.order - b.order : b.priority - a.priority));

  const selected: PromptSurfaceChunk[] = [];
  let usedChars = 0;

  for (const chunk of mandatory) {
    selected.push(chunk);
    usedChars += chunk.text.length;
  }

  const droppedTags: string[] = [];
  for (const chunk of optional) {
    const nextCount = selected.length + 1;
    const nextChars = usedChars + chunk.text.length;
    if (nextCount > budgetMaxChunks || nextChars > budgetMaxChars) {
      droppedTags.push(chunk.tag);
      continue;
    }
    selected.push(chunk);
    usedChars = nextChars;
  }

  selected.sort((a, b) => a.order - b.order);
  return {
    selected: selected.map((chunk) => chunk.text),
    droppedTags,
  };
}


function clampProbability(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.01;
  }
  return Math.max(0.01, Math.min(0.97, value));
}

function deterministicSample(seed: string): number {
  const digest = createHash("sha256").update(seed, "utf8").digest("hex");
  const token = digest.slice(0, 8);
  const parsed = Number.parseInt(token, 16);
  if (!Number.isFinite(parsed)) {
    return 0.5;
  }
  return parsed / 0xffffffff;
}

function readIsoMillis(value: unknown): number | null {
  const asString = readString(value);
  if (!asString) {
    return null;
  }
  const parsed = Date.parse(asString);
  return Number.isFinite(parsed) ? parsed : null;
}

function daysSinceIso(value: unknown, nowMs: number): number {
  const millis = readIsoMillis(value);
  if (millis === null) {
    return 999;
  }
  return Math.max(0, (nowMs - millis) / (1000 * 60 * 60 * 24));
}

function zoneTypeSignificance(type: string): number {
  const lower = type.toLowerCase();
  if (lower.includes("settlement") || lower.includes("city") || lower.includes("district")) {
    return 58;
  }
  if (lower.includes("road") || lower.includes("frontier")) {
    return 49;
  }
  if (lower.includes("port") || lower.includes("sea")) {
    return 53;
  }
  if (lower.includes("ruin") || lower.includes("dungeon") || lower.includes("shrine")) {
    return 52;
  }
  if (lower.includes("wilderness") || lower.includes("forest")) {
    return 44;
  }
  return 46;
}

function toLifecycleState(value: unknown): LifecycleState {
  const normalized = readString(value).toLowerCase();
  if (normalized === "active" || normalized === "dormant" || normalized === "archived") {
    return normalized;
  }
  return "active";
}

function coerceFiniteInteger(value: unknown, fallback: number): number {
  const parsed = readFiniteNumber(value);
  if (parsed === null) {
    return fallback;
  }
  return Math.max(0, Math.trunc(parsed));
}

function parseCompactionTrigger(value: unknown): CompactionTrigger {
  const normalized = readString(value);
  if (
    normalized === "manual" ||
    normalized === "scene_transition" ||
    normalized === "fast_wait" ||
    normalized === "downtime" ||
    normalized === "zone_generation" ||
    normalized === "interval"
  ) {
    return normalized;
  }
  return "manual";
}

function parseCompactionMode(value: unknown): CompactionMode {
  const normalized = readString(value);
  if (normalized === "audited-apply") {
    return "audited-apply";
  }
  return "dry-run";
}

type LifecycleFallbackTrigger = "scene_transition" | "fast_wait" | "zone_generation" | "downtime_tick";

function hasExplicitLifecycleToolInvocationIntent(latestAction: string): boolean {
  const lower = latestAction.trim().toLowerCase();
  if (!lower) {
    return false;
  }
  return (
    lower.includes("trpg_state_compact") ||
    lower.includes("state_compact") ||
    lower.includes("state compact") ||
    lower.includes("lifecycle compaction")
  );
}

function isDowntimeTickIntent(latestAction: string): boolean {
  const lower = latestAction.trim().toLowerCase();
  if (!lower) {
    return false;
  }
  return (
    lower.includes("downtime_tick") ||
    lower.includes("downtime tick") ||
    lower.includes("/downtime") ||
    lower.includes("downtime")
  );
}

function detectLifecycleFallbackTrigger(params: {
  fastWaitApplied: boolean;
  generatedZone: boolean;
  sceneTransition: boolean;
  latestAction: string;
}): LifecycleFallbackTrigger | "" {
  if (params.fastWaitApplied) {
    return "fast_wait";
  }
  if (params.generatedZone) {
    return "zone_generation";
  }
  if (params.sceneTransition) {
    return "scene_transition";
  }
  if (isDowntimeTickIntent(params.latestAction)) {
    return "downtime_tick";
  }
  return "";
}

function mapFallbackTriggerToCompactionTrigger(
  trigger: LifecycleFallbackTrigger,
): "scene_transition" | "fast_wait" | "zone_generation" | "downtime" {
  if (trigger === "downtime_tick") {
    return "downtime";
  }
  return trigger;
}

async function runLifecyclePreviewIfNeeded(params: {
  api: OpenClawPluginApi;
  cfg: TrpgRuntimeConfig;
  worldRoot: string;
  latestAction: string;
  trigger: LifecycleFallbackTrigger | "";
}): Promise<void> {
  if (!params.trigger) {
    return;
  }

  if (hasExplicitLifecycleToolInvocationIntent(params.latestAction)) {
    params.api.logger.info(
      "[trpg-runtime] lifecycle fallback skipped trigger=" +
        params.trigger +
        " reason=explicit tool invocation preferred",
    );
    return;
  }

  const compactionTrigger = mapFallbackTriggerToCompactionTrigger(params.trigger);
  try {
    const preview = await buildLifecycleCompactionPreview({
      cfg: params.cfg,
      worldRoot: params.worldRoot,
      trigger: compactionTrigger,
      maxCandidates: 8,
    });
    const previewRoot = toObject(preview);
    const summaryRoot = toObject(previewRoot.summary);
    params.api.logger.info(
      "[trpg-runtime] lifecycle fallback dry-run trigger=" +
        params.trigger +
        " compaction_trigger=" +
        compactionTrigger +
        " candidates=" +
        String(readFiniteNumber(previewRoot.candidateCount) ?? 0) +
        " selected=" +
        String(readFiniteNumber(summaryRoot.selected) ?? 0) +
        " ops=" +
        String(readFiniteNumber(previewRoot.operationCount) ?? 0),
    );
  } catch (error) {
    params.api.logger.warn(
      "[trpg-runtime] lifecycle fallback preview skipped: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}


function scoreZoneSignificance(params: {
  zone: ZoneGraphNode;
  isProtected: boolean;
  activeThreads: number;
  hasFactionLink: boolean;
  hasLongTailSeed: boolean;
}): number {
  const base = zoneTypeSignificance(params.zone.type);
  const tagBonus = Math.min(12, params.zone.tags.length * 2);
  const protectedBonus = params.isProtected ? 20 : 0;
  const threadBonus = Math.min(18, params.activeThreads * 4);
  const factionBonus = params.hasFactionLink ? 8 : 0;
  const seedBonus = params.hasLongTailSeed ? 10 : 0;
  const pressureBonus = Math.max(0, Math.min(12, Math.round((params.zone.pressure ?? 45) / 10)));
  return Math.max(8, Math.min(100, base + tagBonus + protectedBonus + threadBonus + factionBonus + seedBonus + pressureBonus));
}

function scoreRetentionWeight(params: {
  significanceScore: number;
  isProtected: boolean;
  playerWitnessed: boolean;
  hasLongTailSeed: boolean;
}): number {
  let weight = params.significanceScore / 100;
  if (params.isProtected) {
    weight += 0.25;
  }
  if (params.playerWitnessed) {
    weight += 0.16;
  }
  if (params.hasLongTailSeed) {
    weight += 0.14;
  }
  return Math.max(0.05, Math.min(0.99, Number(weight.toFixed(3))));
}

function countSeedThreadsByZone(worldSeedsRoot: Record<string, unknown>): Record<string, { total: number; longTail: number }> {
  const result: Record<string, { total: number; longTail: number }> = {};
  const zoneSeeds = Array.isArray(worldSeedsRoot.zone_seeds) ? worldSeedsRoot.zone_seeds : [];
  for (const entry of zoneSeeds) {
    const node = toObject(entry);
    const zoneId = normalizeZoneId(readString(node.zone_id));
    if (!zoneId) {
      continue;
    }
    const state = readString(node.state).toLowerCase() || "pending";
    if (state === "resolved" || state === "closed") {
      continue;
    }
    const tension = coerceFiniteInteger(node.tension_weight, 1);
    if (!result[zoneId]) {
      result[zoneId] = { total: 0, longTail: 0 };
    }
    result[zoneId].total += 1;
    if (tension >= 3 || readString(node.type) !== "rumor") {
      result[zoneId].longTail += 1;
    }
  }
  return result;
}

function collectFactionLinkedZones(factionRoot: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const focus = toObject(factionRoot.faction_zone_focus);
  for (const value of Object.values(focus)) {
    const node = toObject(value);
    const primary = normalizeZoneId(readString(node.primary_zone));
    if (primary) {
      out.add(primary);
    }
    for (const zone of toStringArray(node.secondary_zones)) {
      const normalized = normalizeZoneId(zone);
      if (normalized) {
        out.add(normalized);
      }
    }
  }
  return out;
}

function collectCurrentNearbyZoneSet(params: {
  sceneRoot: Record<string, unknown>;
  travelRoot: Record<string, unknown>;
  zoneGraph: Record<string, ZoneGraphNode>;
}): Set<string> {
  const out = new Set<string>();
  const sceneLocation = toObject(toObject(params.sceneRoot.scene).location);
  const sceneZone = normalizeZoneId(readString(sceneLocation.zone_id));
  if (sceneZone) {
    out.add(sceneZone);
  }
  const travelState = toObject(params.travelRoot.travel_state);
  const currentZone = normalizeZoneId(readString(travelState.current_zone));
  if (currentZone) {
    out.add(currentZone);
  }
  const destinationZone = normalizeZoneId(readString(travelState.destination_zone));
  if (destinationZone) {
    out.add(destinationZone);
  }

  for (const zone of toStringArray(sceneLocation.nearby_zone_ids)) {
    const normalized = normalizeZoneId(zone);
    if (normalized) {
      out.add(normalized);
    }
  }

  for (const root of Array.from(out)) {
    const neighbors = params.zoneGraph[root]?.connections ?? [];
    for (const neighbor of neighbors.slice(0, 4)) {
      out.add(neighbor);
    }
  }

  return out;
}

function compactionProbability(params: {
  ageSinceReferenceDays: number;
  ageSincePresenceDays: number;
  significanceScore: number;
  liveDependencyCount: number;
  linkedToRevealOrHook: boolean;
  linkedToFactionAgenda: boolean;
  playerWitnessed: boolean;
  replaceableBySummary: boolean;
}): number {
  let probability = 0.05;
  probability += Math.min(1, params.ageSinceReferenceDays / 35) * 0.36;
  probability += Math.min(1, params.ageSincePresenceDays / 60) * 0.12;
  probability += (1 - Math.max(0, Math.min(1, params.significanceScore / 100))) * 0.28;
  probability += params.replaceableBySummary ? 0.17 : 0;
  probability -= Math.min(0.44, params.liveDependencyCount * 0.09);
  probability -= params.linkedToRevealOrHook ? 0.3 : 0;
  probability -= params.linkedToFactionAgenda ? 0.16 : 0;
  probability -= params.playerWitnessed ? 0.22 : 0;
  return clampProbability(probability);
}

function buildArchiveSummaryEntry(params: {
  sourceType: string;
  sourceRefs: string[];
  summary: string;
  retainedTags: string[];
  triggers: string[];
}): Record<string, unknown> {
  return {
    summary_id: `summary-${params.sourceType}-${String(Date.now()).slice(-8)}`,
    source_type: params.sourceType,
    source_refs: uniqStrings(params.sourceRefs),
    compressed_text: params.summary,
    retained_tags: uniqStrings(params.retainedTags).slice(0, 8),
    possible_reactivation_triggers: uniqStrings(params.triggers).slice(0, 8),
    created_at: new Date().toISOString(),
  };
}

function makeDefaultCompactionStateRoot(): Record<string, unknown> {
  return {
    meta: {
      schema_version: 1,
      last_updated: new Date().toISOString(),
    },
    compaction_state: {
      version: 1,
      run_count: 0,
      last_trigger: "bootstrap",
      last_run_at: "",
      zone_lifecycle: {},
    },
  };
}

function makeDefaultArchiveSummaryRoot(): Record<string, unknown> {
  return {
    meta: {
      schema_version: 1,
      last_updated: new Date().toISOString(),
    },
    archive_summaries: [],
  };
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const chunks = content
      .map((entry) => {
        const node = toObject(entry);
        const text = readString(node.text);
        if (text) {
          return text;
        }
        return readString(node.value);
      })
      .filter(Boolean);
    return chunks.join(" ").trim();
  }

  const objectContent = toObject(content);
  const asText = readString(objectContent.text);
  if (asText) {
    return asText;
  }

  return readString(objectContent.value);
}

function extractLatestUserMessage(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = toObject(messages[index]);
    const role = readString(message.role).toLowerCase();
    if (role !== "user" && role !== "human") {
      continue;
    }

    const content = extractMessageText(message.content);
    if (content) {
      return content;
    }
  }
  return "";
}

function extractLatestUserMessageFromPrompt(prompt: string): string {
  if (!prompt) {
    return "";
  }

  const tail = prompt.slice(-6000);
  const lines = tail
    .split(String.fromCharCode(10))
    .map((line) => line.replaceAll(String.fromCharCode(13), "").trim())
    .filter(Boolean);

  const userPattern = new RegExp("^(?:user|human)\\s*[:：]\\s*(.+)$", "i");
  const speakerPattern = new RegExp("^(?:system|assistant|tool|context|user|human)\\s*[:：]", "i");

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string;
    if (!line) {
      continue;
    }

    const userMatch = line.match(userPattern);
    if (!userMatch || !userMatch[1]) {
      continue;
    }

    const chunks: string[] = [userMatch[1].trim()];
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const continuation = lines[nextIndex] as string;
      if (!continuation) {
        break;
      }

      const continuationUserMatch = continuation.match(userPattern);
      if (continuationUserMatch && continuationUserMatch[1]) {
        chunks.push(continuationUserMatch[1].trim());
        continue;
      }

      if (speakerPattern.test(continuation)) {
        break;
      }

      if (continuation.startsWith("[") || continuation.startsWith("###")) {
        break;
      }

      chunks.push(continuation);
    }

    const joined = chunks.join(String.fromCharCode(10)).trim();
    if (joined) {
      return joined;
    }
  }

  const fallbackLines: string[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string;
    const blocked =
      !line ||
      line.length > 220 ||
      line.startsWith("[") ||
      line.startsWith("###") ||
      /^(system|assistant|tool|context)/i.test(line) ||
      /output order is mandatory|optional suggestions|freeform invitation|scene intro seed/i.test(line);

    if (blocked) {
      if (fallbackLines.length > 0) {
        break;
      }
      continue;
    }

    fallbackLines.push(line);
    if (fallbackLines.length >= 8) {
      break;
    }
  }

  if (fallbackLines.length > 0) {
    return fallbackLines.reverse().join(String.fromCharCode(10)).trim();
  }

  return "";
}

function parseLabeledAnswer(message: string, labels: string[]): string {
  const escapedLabels = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(
    "(?:^|\\n)\\s*(?:" + escapedLabels.join("|") + ")\\s*[:：\\-]\\s*(.+)",
    "i",
  );
  const matched = message.match(pattern);
  return matched && matched[1] ? matched[1].trim() : "";
}

function parseNumberedAnswers(message: string): BootstrapUpdate {
  const lines = message
    .split(String.fromCharCode(10))
    .map((line) => line.trim())
    .filter(Boolean);

  const map: BootstrapUpdate = {};
  const numberPattern = /^(1|2|3|4|5|6)(?:\s*번)?[\).:：\-\.\s]+(.+)$/;
  for (const line of lines) {
    const match = line.match(numberPattern);
    if (!match || !match[2]) {
      continue;
    }
    const value = match[2].trim();
    if (!value) {
      continue;
    }

    if (match[1] === "1") map.name = value;
    if (match[1] === "2") map.background = value;
    if (match[1] === "3") map.motive = value;
    if (match[1] === "4") map.secret = value;
    if (match[1] === "5") map.fear = value;
    if (match[1] === "6") map.goal = value;
  }

  return map;
}

function parseBootstrapUpdate(message: string): BootstrapUpdate {
  const update: BootstrapUpdate = {
    ...parseNumberedAnswers(message),
  };

  const labeledCandidates: Record<BootstrapFieldKey, string[]> = {
    name: ["이름", "name", "캐릭터 이름"],
    background: ["출신", "배경", "출신 / 배경", "출신/배경", "origin"],
    motive: ["이유", "동기", "지금 이 세계에 들어온 이유", "motive"],
    secret: ["비밀", "숨기고 있는 비밀", "secret"],
    fear: ["두려워하는 것", "두려움", "fear"],
    goal: ["목표", "지금 당장의 목표", "immediate goal", "goal"],
  };

  for (const [key, labels] of Object.entries(labeledCandidates) as Array<[
    BootstrapFieldKey,
    string[],
  ]>) {
    if (update[key]) {
      continue;
    }
    const value = parseLabeledAnswer(message, labels);
    if (value) {
      update[key] = value;
    }
  }

  if (!update.name) {
    const namePatterns = [
      /(?:내\s*이름은|이름은|name\s*is)\s*([^\n,.!?:;]+)/i,
      /(?:나는|전|저는)\s*([^\n,.!?:;]{1,30})\s*(?:라고\s*해|입니다|이다)/i,
    ];
    for (const pattern of namePatterns) {
      const match = message.match(pattern);
      if (match && match[1]) {
        const candidate = match[1].trim();
        if (candidate && candidate.length <= 40) {
          update.name = candidate;
          break;
        }
      }
    }
  }

  return update;
}

function hasBootstrapReadySignal(message: string): boolean {
  if (!message) {
    return false;
  }
  return /(준비(?:됐|되었습니다|완료|끝)|시작(?:해|하자|하겠습니다)|진행해|이제\s*가자|ready|let'?s\s*go|go\s*ahead)/i.test(
    message,
  );
}

function collectMissingBootstrapFields(player: Record<string, unknown>): string[] {
  const missing: string[] = [];
  if (!readString(player.name)) missing.push("이름");
  if (!readString(player.background)) missing.push("출신 / 배경");
  if (!readString(player.motive)) missing.push("지금 이 세계에 들어온 이유");
  if (!readString(player.secret)) missing.push("숨기고 있는 비밀");
  if (!readString(player.fear)) missing.push("두려워하는 것");
  if (!readString(player.goal)) missing.push("지금 당장의 목표");
  return missing;
}

function hasMinimalBootstrapFields(player: Record<string, unknown>): boolean {
  const keys: BootstrapFieldKey[] = ["name", "background", "motive", "secret", "fear", "goal"];
  let answered = 0;
  for (const key of keys) {
    if (readString(player[key])) {
      answered += 1;
    }
  }
  return Boolean(readString(player.name) && answered >= 3);
}

function extractBootstrapFreeform(message: string): string {
  if (!message) {
    return "";
  }

  const lines = message
    .split(String.fromCharCode(10))
    .map((line) => line.trim())
    .filter(Boolean);

  const numberedPattern = /^(1|2|3|4|5|6)(?:\s*번)?[\).:：\-\.\s]+/;
  const labeledPattern =
    /^(이름|출신|배경|출신\s*\/\s*배경|지금\s*이\s*세계에\s*들어온\s*이유|숨기고\s*있는\s*비밀|두려워하는\s*것|지금\s*당장의\s*목표|name|origin|motive|secret|fear|goal)\s*[:：\-]/i;

  const freeformLines = lines.filter((line) => {
    if (numberedPattern.test(line)) {
      return false;
    }
    if (labeledPattern.test(line)) {
      return false;
    }
    if (hasBootstrapReadySignal(line)) {
      return false;
    }
    if (/^게임\s*시작$/i.test(line)) {
      return false;
    }
    if (line.startsWith("/")) {
      return false;
    }
    return true;
  });

  return freeformLines.join(String.fromCharCode(10)).trim();
}

function mergeFreeformDescription(existingValue: string, incomingValue: string): string {
  const existing = existingValue.trim();
  const incoming = incomingValue.trim();

  if (!incoming) {
    return existing;
  }
  if (!existing) {
    return incoming;
  }

  if (existing.includes(incoming)) {
    return existing;
  }
  if (incoming.includes(existing)) {
    return incoming;
  }

  return `${existing}${String.fromCharCode(10)}${incoming}`;
}

function relationshipKey(value: Record<string, unknown>): string {
  const from = readString(value.from).toLowerCase();
  const to = readString(value.to).toLowerCase();
  const relationType = readString(value.relation_type).toLowerCase();
  const visibility = readString(value.visibility).toLowerCase();
  const source = readString(value.source).toLowerCase();

  if (!from || !to || !relationType) {
    return "";
  }

  return `${from}|${to}|${relationType}|${visibility}|${source}`;
}

async function applyBootstrapAuditedPersistence(params: {
  cfg: ReturnType<typeof parseTrpgRuntimeConfig>;
  worldRoot: string;
  agentId: string;
  patchCache: ReturnType<typeof createPatchCache>;
  title: string;
  operations: Array<Record<string, unknown>>;
}): Promise<{ ok: boolean; error?: string }> {
  if (params.operations.length === 0) {
    return { ok: true };
  }

  const dryRunResult = await runPatchDryRun({
    worldRoot: params.worldRoot,
    cfg: params.cfg,
    agentId: params.agentId,
    cache: params.patchCache,
    input: {
      title: params.title,
      allowNewFiles: true,
      operations: params.operations,
    },
  });
  const dryRunRoot = toObject(dryRunResult);
  if (dryRunRoot.ok !== true) {
    return {
      ok: false,
      error: readString(dryRunRoot.error) || "bootstrap audited dry-run failed",
    };
  }

  const validatedPatchId = readString(dryRunRoot.patchId);
  if (!validatedPatchId) {
    return {
      ok: false,
      error: "bootstrap audited dry-run did not return patchId",
    };
  }

  const applyResult = await runPatchApply({
    worldRoot: params.worldRoot,
    cfg: params.cfg,
    agentId: params.agentId,
    cache: params.patchCache,
    input: {
      validatedPatchId,
      audit: {
        approved: true,
        approvedBy: "canon-auditor",
        verdict: "pass",
        conflictStatus: "non-conflicting",
        canonAbsorptionVerdict: "accept",
        note: "bootstrap-runtime auto persistence (memory-scribe-lite)",
      },
    } as PatchApplyInput,
  });
  const applyRoot = toObject(applyResult);
  if (applyRoot.ok !== true) {
    return {
      ok: false,
      error: readString(applyRoot.error) || "bootstrap audited apply failed",
    };
  }

  return { ok: true };
}

function detectTravelMode(message: string): TravelMode {
  const lower = message.toLowerCase();
  if (/배|선박|항해|sail|ship|vessel/.test(lower)) {
    return "ship";
  }
  if (/말|기마|mounted|horse/.test(lower)) {
    return "mounted";
  }
  if (/대상단|마차|caravan/.test(lower)) {
    return "caravan";
  }
  if (/(이동|간다|향한다|따라|샌다|새다|빠진다|우회|내려간다|go|move|head|travel)/.test(lower)) {
    return "walking";
  }
  return "none";
}

function isMovementIntent(message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.startsWith("/ooc")) {
    return false;
  }

  const travelVerbPattern =
    /(이동|간다|가겠다|향한다|향해|출발|따라|샌다|새다|빠진다|우회|내려간다|go|move|head|travel|sail|ride)/;
  const stationaryPattern =
    /(이동하지\s*않|움직이지\s*않|한\s*발도\s*움직이지|제자리|가만히|멈춘\s*채|멈춰\s*서|그대로|주변만\s*살핀)/;

  if (stationaryPattern.test(lower) && !travelVerbPattern.test(lower)) {
    return false;
  }

  return travelVerbPattern.test(lower);
}

function buildZoneGraph(parsedPressure: unknown): Record<string, ZoneGraphNode> {
  const pressureRoot = toObject(parsedPressure);
  const graph: Record<string, ZoneGraphNode> = {};

  const addNode = (rawNode: Record<string, unknown>, fallbackId = "") => {
    const id = normalizeZoneId(readString(rawNode.id) || readString(rawNode.zone_id) || fallbackId);
    if (!id) {
      return;
    }

    const existing = graph[id];
    const aliases = Array.from(
      new Set(
        [
          ...(existing?.aliases ?? []),
          ...toStringArray(rawNode.aliases),
          readString(rawNode.name),
          readString(rawNode.label),
          readString(rawNode.id),
          readString(rawNode.zone_id),
        ]
          .map((entry) => entry.trim())
          .filter(Boolean),
      ),
    );

    const connections = Array.from(
      new Set(
        [
          ...(existing?.connections ?? []),
          ...toStringArray(rawNode.connections),
          ...toStringArray(rawNode.nearby_zone_ids),
          ...toStringArray(rawNode.nearby_zones),
        ]
          .map((entry) => normalizeZoneId(entry))
          .filter(Boolean)
          .filter((entry) => entry !== id),
      ),
    );

    const parsedPressure =
      readFiniteNumber(rawNode.pressure) ?? readFiniteNumber(rawNode.score) ?? existing?.pressure ?? null;

    graph[id] = {
      id,
      name: readString(rawNode.name) || readString(rawNode.label) || existing?.name || id,
      type: readString(rawNode.type) || readString(rawNode.zone_type) || existing?.type || "settlement",
      parentRegion:
        readString(rawNode.parent_region) ||
        readString(rawNode.region) ||
        existing?.parentRegion ||
        "",
      tags: Array.from(new Set([...(existing?.tags ?? []), ...toStringArray(rawNode.tags)])),
      connections,
      aliases,
      pressure: parsedPressure,
    };
  };

  const zones = pressureRoot.zones;
  if (Array.isArray(zones)) {
    for (const zoneEntry of zones) {
      addNode(toObject(zoneEntry));
    }
  } else {
    const zonesObject = toObject(zones);
    for (const [zoneId, zoneEntry] of Object.entries(zonesObject)) {
      addNode(toObject(zoneEntry), zoneId);
    }
  }

  const zonePressure = toObject(pressureRoot.zone_pressure);
  for (const [zoneId, zoneEntry] of Object.entries(zonePressure)) {
    addNode(toObject(zoneEntry), zoneId);
  }

  const districtTension = toObject(pressureRoot.district_tension);
  for (const [zoneId, zoneEntry] of Object.entries(districtTension)) {
    addNode(toObject(zoneEntry), zoneId);
  }

  const topology = toObject(toObject(pressureRoot.zone_topology).nearby_zones);
  for (const [zoneId, nearbyValue] of Object.entries(topology)) {
    const normalizedZoneId = normalizeZoneId(zoneId);
    if (!normalizedZoneId) {
      continue;
    }
    if (!graph[normalizedZoneId]) {
      addNode({}, normalizedZoneId);
    }
    const nearbyIds = toStringArray(nearbyValue)
      .map((entry) => normalizeZoneId(entry))
      .filter(Boolean)
      .filter((entry) => entry !== normalizedZoneId);
    graph[normalizedZoneId].connections = Array.from(
      new Set([...graph[normalizedZoneId].connections, ...nearbyIds]),
    );
  }

  for (const node of Object.values(graph)) {
    for (const connection of node.connections) {
      if (!graph[connection]) {
        addNode({}, connection);
      }
      const linked = graph[connection];
      linked.connections = Array.from(new Set([...linked.connections, node.id]));
    }
  }

  return graph;
}

function buildZoneAliasMap(zoneGraph: Record<string, ZoneGraphNode>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const node of Object.values(zoneGraph)) {
    out[normalizeAlias(node.id)] = node.id;
    for (const alias of node.aliases) {
      out[normalizeAlias(alias)] = node.id;
      out[normalizeAlias(normalizeZoneId(alias))] = node.id;
    }
  }
  return out;
}

type ZoneMention = {
  zoneId: string;
  firstIndex: number;
  lastIndex: number;
};

type ParsedTravelIntent = {
  pathZoneId: string;
  destinationZoneId: string;
  mentionedZoneIds: string[];
};

function extractZoneMentions(params: {
  message: string;
  aliasMap: Record<string, string>;
}): ZoneMention[] {
  const normalizedMessage = normalizeAlias(params.message);
  const mentions: Record<string, ZoneMention> = {};

  for (const alias of Object.keys(params.aliasMap)) {
    if (!(alias.length >= 2 || /[\p{Script=Hangul}\p{Script=Han}]/u.test(alias))) {
      continue;
    }

    const zoneId = params.aliasMap[alias];
    if (!zoneId) {
      continue;
    }

    let cursor = normalizedMessage.indexOf(alias);
    while (cursor >= 0) {
      const existing = mentions[zoneId];
      if (!existing) {
        mentions[zoneId] = {
          zoneId,
          firstIndex: cursor,
          lastIndex: cursor,
        };
      } else {
        existing.firstIndex = Math.min(existing.firstIndex, cursor);
        existing.lastIndex = Math.max(existing.lastIndex, cursor);
      }

      const step = Math.max(alias.length, 1);
      cursor = normalizedMessage.indexOf(alias, cursor + step);
    }
  }

  return Object.values(mentions).sort((a, b) =>
    a.firstIndex === b.firstIndex ? a.lastIndex - b.lastIndex : a.firstIndex - b.firstIndex,
  );
}

function resolveTravelIntent(params: {
  message: string;
  currentZoneId: string;
  persistedDestinationZoneId: string;
  aliasMap: Record<string, string>;
}): ParsedTravelIntent {
  const mentionedZoneIds = extractZoneMentions({
    message: params.message,
    aliasMap: params.aliasMap,
  })
    .map((entry) => entry.zoneId)
    .filter((zoneId, index, all) => all.indexOf(zoneId) === index)
    .filter((zoneId) => zoneId !== params.currentZoneId);

  let pathZoneId = "";
  let destinationZoneId = "";

  if (mentionedZoneIds.length >= 2) {
    pathZoneId = mentionedZoneIds[0] as string;
    destinationZoneId = mentionedZoneIds[mentionedZoneIds.length - 1] as string;
  } else if (mentionedZoneIds.length === 1) {
    destinationZoneId = mentionedZoneIds[0] as string;
  }

  if (!destinationZoneId && params.persistedDestinationZoneId) {
    destinationZoneId = params.persistedDestinationZoneId;
  }

  if (destinationZoneId === params.currentZoneId) {
    destinationZoneId = "";
  }

  return {
    pathZoneId,
    destinationZoneId,
    mentionedZoneIds,
  };
}

function shortestPath(zoneGraph: Record<string, ZoneGraphNode>, start: string, goal: string): string[] {
  if (!zoneGraph[start] || !zoneGraph[goal]) {
    return [];
  }
  if (start === goal) {
    return [start];
  }

  const queue: string[] = [start];
  const visited = new Set<string>([start]);
  const parent: Record<string, string> = {};

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const neighbor of zoneGraph[current]?.connections ?? []) {
      if (visited.has(neighbor)) {
        continue;
      }
      visited.add(neighbor);
      parent[neighbor] = current;
      if (neighbor === goal) {
        const route: string[] = [goal];
        let cursor = goal;
        while (parent[cursor]) {
          cursor = parent[cursor] as string;
          route.unshift(cursor);
        }
        return route;
      }
      queue.push(neighbor);
    }
  }

  return [];
}

function zoneName(zoneGraph: Record<string, ZoneGraphNode>, zoneId: string): string {
  return zoneGraph[zoneId]?.name || zoneId;
}

function zoneType(zoneGraph: Record<string, ZoneGraphNode>, zoneId: string): string {
  return zoneGraph[zoneId]?.type || "unknown";
}

function pressureSignalsForZone(
  pressureParsed: unknown,
  zoneId: string,
): { pressure: number; trend: string; signals: string[] } {
  const pressureRoot = toObject(pressureParsed);
  const zonePressure = toObject(toObject(pressureRoot.zone_pressure)[zoneId]);
  const score = Number(zonePressure.pressure ?? zonePressure.score ?? 45);
  return {
    pressure: Math.max(0, Math.min(100, Number.isFinite(score) ? Math.round(score) : 45)),
    trend: readString(zonePressure.trend) || "stable",
    signals: toStringArray(zonePressure.signals).slice(0, 4),
  };
}

function travelHintsByZoneType(value: string): {
  environment: string;
  obstacles: string[];
  presence: string[];
  opportunities: string[];
} {
  const lower = value.toLowerCase();

  if (lower.includes("wilderness") || lower.includes("forest")) {
    return {
      environment: "tree line thickens, visibility narrows, and sounds travel unpredictably",
      obstacles: ["rough footing", "broken trail markers", "weather shifts"],
      presence: ["scouts", "wild creatures", "refugee traces"],
      opportunities: ["concealed approach", "track reading", "foraging clues"],
    };
  }

  if (lower.includes("road") || lower.includes("frontier")) {
    return {
      environment: "open route with long sightlines and exposed choke points",
      obstacles: ["checkpoint delay", "road debris", "caravan congestion"],
      presence: ["patrols", "caravan guards", "migrant foot traffic"],
      opportunities: ["roadside intel", "escort work", "faction contact windows"],
    };
  }

  if (lower.includes("port") || lower.includes("sea")) {
    return {
      environment: "salt wind, moving cargo lanes, and unstable footing",
      obstacles: ["dock checks", "tide timing", "customs bottlenecks"],
      presence: ["dock crews", "ship hands", "harbor inspectors"],
      opportunities: ["cargo manifests", "stowaway routes", "maritime rumors"],
    };
  }

  if (lower.includes("ruin") || lower.includes("dungeon") || lower.includes("shrine")) {
    return {
      environment: "collapsed structures and layered silence around disturbed ground",
      obstacles: ["unstable footing", "sealed passages", "latent hazards"],
      presence: ["scavengers", "cult cells", "territorial creatures"],
      opportunities: ["ancient records", "hidden chambers", "ritual residue"],
    };
  }

  return {
    environment: "pressure pockets shift with crowd flow and institutional control",
    obstacles: ["inspection queues", "restricted access", "documentation friction"],
    presence: ["official patrols", "informal brokers", "watchful bystanders"],
    opportunities: ["public cover", "social leverage", "document trails"],
  };
}


type GeneratedZoneResult = { destinationZoneId: string; contextLine: string; zoneNameValue: string; zoneTypeValue: string };

function inferZoneTypeFromLabel(label: string): string {
  const lower = label.toLowerCase();
  if (/(항구|선창|부두|항로|harbor|dock|port|sea)/i.test(lower)) return "port";
  if (/(숲|산길|습지|forest|wild|wilderness)/i.test(lower)) return "wilderness";
  if (/(폐허|유적|사원|성소|ruin|shrine|dungeon|catacomb)/i.test(lower)) return "ruin";
  if (/(가도|도로|길|road|frontier|checkpoint)/i.test(lower)) return "road";
  return "settlement";
}

function normalizeUnknownDestinationLabel(raw: string): string {
  let candidate = raw
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!candidate) {
    return "";
  }

  candidate = candidate
    .replace(/^(?:나는|난|저는|전|우리는|내가|제가)\s+/i, "")
    .replace(/^(?:지금|곧바로|바로|저\s*멀리|멀리)\s+/i, "");

  candidate = candidate
    .replace(
      /\s*(?:으)?로\s*(?:이동(?:한다|해|하겠다|할게)?|간다|가겠다|가자|향한다|향해|출발(?:한다|해)?|move|go|travel|head(?:s|ing)?).*$/i,
      "",
    )
    .replace(
      /\s*에\s*(?:이동(?:한다|해|하겠다|할게)?|간다|가겠다|가자|향한다|향해|출발(?:한다|해)?|도착(?:한다|해)?|move|go|travel|head(?:s|ing)?).*$/i,
      "",
    )
    .replace(/[.,!?;:]+$/g, "")
    .trim();

  candidate = candidate.replace(/\s*(?:으)?로$|\s*에$|\s*에서$|\s*쪽으로$|\s*쪽$/i, "").trim();

  if (candidate.length > 32) {
    const words = candidate.split(/\s+/).filter(Boolean);
    candidate = words.slice(0, 4).join(" ").trim();
  }

  return candidate;
}

function isKnownDestinationAlias(candidate: string, aliasMap: Record<string, string>): boolean {
  const aliasKey = normalizeAlias(candidate);
  const zoneKey = normalizeAlias(normalizeZoneId(candidate));
  return Boolean(aliasMap[aliasKey] || aliasMap[zoneKey]);
}

function extractUnknownDestinationLabel(message: string, aliasMap: Record<string, string>): string {
  const quoted = message.match(/["'“”‘’]([^"'“”‘’]{2,48})["'“”‘’]/);
  if (quoted && quoted[1]) {
    const candidate = normalizeUnknownDestinationLabel(quoted[1]);
    if (candidate && !isKnownDestinationAlias(candidate, aliasMap)) {
      return candidate;
    }
  }

  const patterns = [
    /(?:^|\s)(?:나는|난|저는|전|우리는|내가|제가)?\s*([가-힣a-zA-Z0-9][가-힣a-zA-Z0-9\s'’\-]{1,42}?)\s*(?:으)?로\s*(?:이동(?:한다|해|하겠다|할게)?|간다|가겠다|가자|향한다|향해|출발(?:한다|해)?|move|go|travel|head(?:s|ing)?)/i,
    /(?:^|\s)(?:나는|난|저는|전|우리는|내가|제가)?\s*([가-힣a-zA-Z0-9][가-힣a-zA-Z0-9\s'’\-]{1,42}?)\s*쪽으로\s*(?:이동(?:한다|해|하겠다|할게)?|간다|가겠다|향한다|향해|move|go|travel)/i,
    /(?:^|\s)(?:나는|난|저는|전|우리는|내가|제가)?\s*([가-힣a-zA-Z0-9][가-힣a-zA-Z0-9\s'’\-]{1,42}?)\s*에\s*(?:간다|가겠다|이동(?:한다|해|하겠다|할게)?|향한다|향해|도착(?:한다|해)?)/i,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match || !match[1]) {
      continue;
    }

    const candidate = normalizeUnknownDestinationLabel(match[1]);
    if (!candidate) {
      continue;
    }

    if (isKnownDestinationAlias(candidate, aliasMap)) {
      return "";
    }

    return candidate;
  }

  return "";
}

async function generateLinkedZoneForUnknownDestination(params: {
  worldRoot: string;
  latestUserMessage: string;
  currentZoneId: string;
  zoneGraph: Record<string, ZoneGraphNode>;
  pressureParsed: unknown;
  pressureFormat: string;
  aliasMap: Record<string, string>;
}): Promise<GeneratedZoneResult | null> {
  const requestedLabel = extractUnknownDestinationLabel(params.latestUserMessage, params.aliasMap);
  if (!requestedLabel) return null;

  const pressureRoot = toObject(params.pressureParsed);
  const zoneTypeValue = inferZoneTypeFromLabel(requestedLabel);
  const timestampSuffix = String(Date.now()).slice(-6);
  const zoneId = normalizeZoneId(`zone-${requestedLabel}-${timestampSuffix}`);
  if (!zoneId || params.zoneGraph[zoneId]) return null;

  const links = uniqStrings([params.currentZoneId, ...(params.zoneGraph[params.currentZoneId]?.connections ?? []).slice(0, 1)]).slice(0, 3);
  const pressure = Math.max(25, Math.min(90, Math.round(((params.zoneGraph[params.currentZoneId]?.pressure ?? 50) + 8) / 1.1)));
  const pressureLevel = pressure >= 70 ? "high" : pressure >= 50 ? "medium" : "low";

  const zonesNode = pressureRoot.zones;
  const lifecycleNow = new Date().toISOString();
  const zonePayload = {
    id: zoneId,
    name: requestedLabel,
    type: zoneTypeValue,
    parent_region: params.zoneGraph[params.currentZoneId]?.parentRegion || "generated-frontier",
    tags: ["generated", zoneTypeValue, "runtime"],
    aliases: [requestedLabel],
    connections: links,
    nearby_zone_ids: links,
    exploration_surface: `${requestedLabel} routes and clues`,
    social_surface: `${requestedLabel} faction contact friction`,
    conflict_surface: `${requestedLabel} control contest and hazard points`,
    faction_presence: ["city watch", "local brokers", "independent cells"],
    pressure_level: pressureLevel,
    pressure_signals: ["checkpoint_shift", "watch_rotation", "rumor_spread"],
    lifecycle_state: "active",
    significance_score: Math.max(35, Math.min(85, pressure + 4)),
    retention_weight: pressureLevel === "high" ? 0.78 : pressureLevel === "medium" ? 0.62 : 0.48,
    last_active_turn_or_tick: lifecycleNow,
    last_player_presence: lifecycleNow,
    last_meaningful_change: lifecycleNow,
    active_threads_count: 1,
    archived_summary_ref: null,
    reactivation_conditions: [
      "player revisit",
      "adjacent pressure spill",
      "faction influence expansion",
      "seed chain reconnect",
    ],
  };
  if (Array.isArray(zonesNode)) zonesNode.push(zonePayload);
  else {
    const zonesObj = toObject(zonesNode);
    zonesObj[zoneId] = zonePayload;
    pressureRoot.zones = zonesObj;
  }

  const topo = toObject(toObject(pressureRoot.zone_topology).nearby_zones);
  topo[zoneId] = links;
  for (const linked of links) topo[linked] = uniqStrings([...toStringArray(topo[linked]), zoneId]);
  pressureRoot.zone_topology = { ...toObject(pressureRoot.zone_topology), nearby_zones: topo };

  const zp = toObject(pressureRoot.zone_pressure);
  zp[zoneId] = { label: requestedLabel, pressure, score: pressure, trend: "up", soft_threshold: Math.max(35, pressure - 12), hard_threshold: Math.min(95, pressure + 18), signals: ["checkpoint_shift", "watch_rotation", "rumor_spread"] };
  pressureRoot.zone_pressure = zp;

  const dt = toObject(pressureRoot.district_tension);
  dt[zoneId] = { label: requestedLabel, score: pressure, trend: "up", soft_threshold: Math.max(35, pressure - 12), hard_threshold: Math.min(95, pressure + 18) };
  pressureRoot.district_tension = dt;

  pressureRoot.meta = { ...toObject(pressureRoot.meta), schema_version: 1, last_updated: new Date().toISOString() };
  const rendered = renderStructuredContent(params.pressureFormat as "yaml" | "json", pressureRoot);
  await fs.writeFile(resolveWorldAbsolutePath(params.worldRoot, "state/world-pressure.yaml"), rendered, "utf8");

  return {
    destinationZoneId: zoneId,
    zoneNameValue: requestedLabel,
    zoneTypeValue,
    contextLine: `A new connected area emerges nearby: ${requestedLabel}. It carries ${pressureLevel} pressure with exploration/social/conflict surfaces and active faction presence.`,
  };
}

async function appendZoneSeeds(params: { cfg: ReturnType<typeof parseTrpgRuntimeConfig>; worldRoot: string; zoneIds: string[]; zoneGraph: Record<string, ZoneGraphNode> }): Promise<string[]> {
  const zoneIds = uniqStrings(params.zoneIds.map((z) => normalizeZoneId(z))).slice(0, 3);
  if (zoneIds.length === 0) return [];
  const loaded = await loadStructuredWorldFile(params.worldRoot, "state/world-seeds.yaml", { allowMissing: true, maxReadBytes: params.cfg.maxReadBytes });
  const root = toObject(loaded.parsed);
  const entries = (Array.isArray(root.zone_seeds) ? root.zone_seeds : []).map((e) => toObject(e));
  const types = ["rumor", "hidden_location", "npc_connection", "faction_interest", "environmental_mystery"] as const;
  const hints: string[] = [];
  let changed = false;
  for (const zoneId of zoneIds) {
    const idx = Math.abs(zoneId.split("").reduce((a, c) => a + c.charCodeAt(0), 0)) % types.length;
    const seedType = types[idx];
    const duplicate = entries.some((e) => normalizeZoneId(readString(e.zone_id)) === zoneId && readString(e.type) === seedType);
    if (duplicate) continue;
    const zoneLabel = zoneName(params.zoneGraph, zoneId);
    entries.push({ seed_id: `seed-${zoneId}-${seedType}-${String(Date.now()).slice(-6)}`, zone_id: zoneId, zone_name: zoneLabel, type: seedType, prerequisite: "set up at least one prerequisite action first", payoff: "delayed narrative leverage", tension_weight: idx + 1, state: "pending", created_at: new Date().toISOString() });
    hints.push(`${zoneLabel}: deferred ${seedType.replace('_', ' ')} hook available after setup.`);
    changed = true;
  }
  if (!changed) return [];
  root.zone_seeds = entries;
  root.meta = { ...toObject(root.meta), schema_version: 1, last_updated: new Date().toISOString() };
  const rendered = renderStructuredContent(loaded.format, root);
  await fs.writeFile(resolveWorldAbsolutePath(params.worldRoot, "state/world-seeds.yaml"), rendered, "utf8");
  return hints.slice(0, 3);
}

async function runTravelMovement(params: {
  cfg: ReturnType<typeof parseTrpgRuntimeConfig>;
  worldRoot: string;
  messages: unknown[];
  prompt: string;
}): Promise<TravelTransitionResult> {
  const latestUserMessage =
    extractLatestUserMessageFromPrompt(params.prompt) || extractLatestUserMessage(params.messages);
  if (!latestUserMessage || !isMovementIntent(latestUserMessage)) {
    return {
      movementIntent: false,
      occurred: false,
      reason: "no movement intent",
    };
  }

  const [pressureLoaded, sceneLoaded, travelLoaded] = await Promise.all([
    loadStructuredWorldFile(params.worldRoot, "state/world-pressure.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/current-scene.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/travel-state.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
  ]);

  const safeIntent = sanitizeIntentText(latestUserMessage, 220) || clipForGuard(latestUserMessage, 220);

  const zoneGraph = buildZoneGraph(pressureLoaded.parsed);
  const zoneIds = Object.keys(zoneGraph);
  if (zoneIds.length === 0) {
    return {
      movementIntent: true,
      occurred: false,
      reason: "zone graph unavailable",
    };
  }

  const sceneRoot = toObject(sceneLoaded.parsed);
  const sceneLocation = toObject(toObject(sceneRoot.scene).location);
  const sceneZone = normalizeZoneId(readString(sceneLocation.zone_id));

  const travelRoot = toObject(travelLoaded.parsed);
  const travelState = toObject(travelRoot.travel_state);
  const currentZoneId = normalizeZoneId(
    readString(travelState.current_zone) || sceneZone || zoneIds[0] || "",
  );

  if (!currentZoneId || !zoneGraph[currentZoneId]) {
    return {
      movementIntent: true,
      occurred: false,
      reason: "current zone unavailable",
    };
  }

  const persistedDestinationZoneId = normalizeZoneId(readString(travelState.destination_zone));
  const aliasMap = buildZoneAliasMap(zoneGraph);
  const travelIntent = resolveTravelIntent({
    message: latestUserMessage,
    currentZoneId,
    persistedDestinationZoneId,
    aliasMap,
  });

  let destinationZoneId = travelIntent.destinationZoneId;
  let generatedZoneContextLine = "";
  const explicitUnknownDestination = extractUnknownDestinationLabel(latestUserMessage, aliasMap);
  const shouldPreferGeneratedDestination = Boolean(
    explicitUnknownDestination && !isKnownDestinationAlias(explicitUnknownDestination, aliasMap),
  );

  if (!destinationZoneId || shouldPreferGeneratedDestination) {
    const generatedZone = await generateLinkedZoneForUnknownDestination({
      worldRoot: params.worldRoot,
      latestUserMessage,
      currentZoneId,
      zoneGraph,
      pressureParsed: pressureLoaded.parsed,
      pressureFormat: pressureLoaded.format,
      aliasMap,
    });

    if (generatedZone) {
      destinationZoneId = generatedZone.destinationZoneId;
      generatedZoneContextLine = generatedZone.contextLine;
      zoneGraph[destinationZoneId] = {
        id: destinationZoneId,
        name: generatedZone.zoneNameValue,
        type: generatedZone.zoneTypeValue,
        parentRegion: zoneGraph[currentZoneId]?.parentRegion || "generated-frontier",
        tags: ["generated", "runtime"],
        connections: uniqStrings([currentZoneId, ...(zoneGraph[currentZoneId]?.connections ?? []).slice(0, 1)]),
        aliases: [generatedZone.zoneNameValue],
        pressure: 55,
      };
      for (const conn of zoneGraph[destinationZoneId].connections) {
        if (zoneGraph[conn]) {
          zoneGraph[conn].connections = uniqStrings([...zoneGraph[conn].connections, destinationZoneId]);
        }
      }
    }
  }

  if (!destinationZoneId) {
    return {
      movementIntent: true,
      occurred: false,
      reason: "destination unresolved",
    };
  }

  const destinationRoute = shortestPath(zoneGraph, currentZoneId, destinationZoneId);
  if (destinationRoute.length === 0) {
    return {
      movementIntent: true,
      occurred: false,
      reason: 'no traversable route',
    };
  }

  let immediateTargetZoneId =
    travelIntent.pathZoneId && travelIntent.pathZoneId !== currentZoneId
      ? travelIntent.pathZoneId
      : destinationZoneId;

  let route = shortestPath(zoneGraph, currentZoneId, immediateTargetZoneId);
  if (route.length <= 1 && immediateTargetZoneId !== destinationZoneId) {
    immediateTargetZoneId = destinationZoneId;
    route = destinationRoute;
  }

  if (route.length === 0) {
    return {
      movementIntent: true,
      occurred: false,
      reason: 'no traversable route',
    };
  }

  if (route.length === 1) {
    return {
      movementIntent: true,
      occurred: false,
      reason: 'already in destination zone',
    };
  }

  const nextZoneId = route[1] as string;
  const destinationRouteFromNext = shortestPath(zoneGraph, nextZoneId, destinationZoneId);
  const remainingPath = destinationRouteFromNext.length > 1 ? destinationRouteFromNext.slice(1) : [];
  const reachedDestination = nextZoneId === destinationZoneId;
  const mode = detectTravelMode(latestUserMessage);
  const totalEdges = Math.max(destinationRoute.length - 1, 1);
  const completedEdges = reachedDestination ? totalEdges : 1;

  travelRoot.meta = {
    schema_version: 1,
    last_updated: new Date().toISOString(),
  };
  travelRoot.travel_state = {
    current_zone: nextZoneId,
    destination_zone: reachedDestination ? null : destinationZoneId,
    path: remainingPath,
    travel_mode: mode,
    travel_progress: Math.max(0, Math.min(100, Math.round((completedEdges / totalEdges) * 100))),
    last_user_intent: safeIntent,
  };

  const rendered = renderStructuredContent(travelLoaded.format, travelRoot);
  const absolute = resolveWorldAbsolutePath(params.worldRoot, "state/travel-state.yaml");
  await fs.writeFile(absolute, rendered, "utf8");

  const nextConnections = zoneGraph[nextZoneId]?.connections.slice(0, 4) ?? [];
  const nextPressure = pressureSignalsForZone(pressureLoaded.parsed, nextZoneId);
  const nearbySignalLines = nextConnections
    .slice(0, 3)
    .map((zoneId) => {
      const signal = pressureSignalsForZone(pressureLoaded.parsed, zoneId);
      return `${zoneName(zoneGraph, zoneId)}: pressure ${signal.pressure} (${signal.trend})`;
    });
  const hints = travelHintsByZoneType(zoneType(zoneGraph, nextZoneId));

  const remainingPathNames = remainingPath.map((zoneId) => zoneName(zoneGraph, zoneId));
  const seedHints = await appendZoneSeeds({
    cfg: params.cfg,
    worldRoot: params.worldRoot,
    zoneIds: [nextZoneId, destinationZoneId],
    zoneGraph,
  });

  const contextLines: string[] = [
    "[TRPG_RUNTIME_TRAVEL_TRANSITION]",
    `Movement intent detected: ${safeIntent}`,
    `Zone transition: ${zoneName(zoneGraph, currentZoneId)} -> ${zoneName(zoneGraph, nextZoneId)}`,
    reachedDestination
      ? `Destination reached: ${zoneName(zoneGraph, destinationZoneId)}`
      : `Destination pending: ${zoneName(zoneGraph, destinationZoneId)}; remaining path: ${remainingPathNames.join(" -> ") || "none"}`,
    `Travel mode: ${mode}`,
    "For this response, output order is mandatory:",
    "1) context introduction",
    "2) environment observations",
    "3) zone pressure signals",
    "4) NPC/creature posture",
    "5) freeform action invitation",
    "6) optional suggestions only after freeform invitation",
    "Never open with menu choices.",
    `Environment shift: ${hints.environment}`,
    `Travel obstacles: ${hints.obstacles.join(", ")}`,
    `Likely presence: ${hints.presence.join(", ")}`,
    `Opportunities: ${hints.opportunities.join(", ")}`,
    `Current-zone pressure: ${zoneName(zoneGraph, nextZoneId)} pressure ${nextPressure.pressure} (${nextPressure.trend})`,
  ];

  if (generatedZoneContextLine) {
    contextLines.push(generatedZoneContextLine);
  }
  if (nextPressure.signals.length > 0) {
    contextLines.push(`Current-zone signals: ${nextPressure.signals.join(", ")}`);
  }
  if (nearbySignalLines.length > 0) {
    contextLines.push("Adjacent-zone pressure:");
    for (const line of nearbySignalLines) {
      contextLines.push(`- ${line}`);
    }
  }
  if (seedHints.length > 0) {
    contextLines.push("Deferred zone hooks (non-immediate):");
    for (const hint of seedHints) {
      contextLines.push(`- ${hint}`);
    }
  }

  return {
    movementIntent: true,
    occurred: true,
    reason: `travel zone changed (${currentZoneId} -> ${nextZoneId})`,
    contextChunk: joinLines(contextLines),
    generatedZone: Boolean(generatedZoneContextLine),
  };
}

async function detectSceneTransition(params: {
  cfg: ReturnType<typeof parseTrpgRuntimeConfig>;
  worldRoot: string;
  guard: { introRequired: boolean; sceneId: string; majorSceneStart: boolean };
  travelTransition?: TravelTransitionResult;
}): Promise<{ shouldTick: boolean; reason: string }> {
  if (params.guard.introRequired) {
    return {
      shouldTick: true,
      reason: "intro guard major scene start",
    };
  }

  if (params.travelTransition?.occurred) {
    return {
      shouldTick: true,
      reason: params.travelTransition.reason,
    };
  }

  const loaded = await loadStructuredWorldFile(params.worldRoot, "state/world-pressure.yaml", {
    allowMissing: true,
    maxReadBytes: params.cfg.maxReadBytes,
  });
  const pressureRoot = toObject(loaded.parsed);
  const engineState = toObject(pressureRoot.engine_state);

  const persistedSceneId =
    readString(engineState.last_scene_id) ||
    readString(engineState.last_scene) ||
    parseSceneIdFromTick(readString(engineState.last_advanced_tick));

  if (persistedSceneId && persistedSceneId !== params.guard.sceneId) {
    return {
      shouldTick: true,
      reason: "scene_id changed (" + persistedSceneId + " -> " + params.guard.sceneId + ")",
    };
  }

  return {
    shouldTick: false,
    reason: "scene unchanged",
  };
}

function jsonToolResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type SceneNpcVisibility = {
  id: string;
  rawName: string;
  role: string;
  displayName: string;
  hidden: boolean;
};

function readBooleanFlag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function visibilityHint(value: unknown): "show" | "hide" | "unknown" {
  const normalized = readString(value).toLowerCase();
  if (!normalized) return "unknown";
  if (["public", "introduced", "revealed", "known", "open"].includes(normalized)) return "show";
  if (["hidden", "secret", "unrevealed", "private", "masked"].includes(normalized)) return "hide";
  return "unknown";
}

function isNpcNameVisibleToPlayer(npc: Record<string, unknown>): boolean {
  const publicExceptionKeys = [
    "public_figure",
    "is_public_figure",
    "player_would_reasonably_know",
    "known_by_common_knowledge",
    "is_well_known",
  ] as const;
  for (const key of publicExceptionKeys) {
    if (readBooleanFlag(npc[key]) === true) {
      return true;
    }
  }

  const keys = [
    "introduced_to_player",
    "publicly_known",
    "public_identity",
    "name_public",
    "name_revealed",
    "player_known_name",
  ] as const;
  for (const key of keys) if (readBooleanFlag(npc[key]) === true) return true;
  for (const key of ["name_visibility", "identity_visibility", "disclosure_state", "reveal_state"] as const) {
    const hint = visibilityHint(npc[key]);
    if (hint === "show") return true;
    if (hint === "hide") return false;
  }
  for (const key of keys) if (readBooleanFlag(npc[key]) === false) return false;
  return true;
}

function npcMaskLabel(npc: Record<string, unknown>, index: number): string {
  const role = readString(npc.role);
  if (role) return `${role} (name withheld)`;
  const id = readString(npc.id);
  if (id) return `${id} (name withheld)`;
  return `unidentified-npc-${index + 1}`;
}

function collectSceneNpcVisibility(parsed: unknown): SceneNpcVisibility[] {
  const root = toObject(parsed);
  const actors = toObject(root.actors);
  const visibleNpcs = Array.isArray(actors.visible_npcs) ? actors.visible_npcs : [];
  return visibleNpcs.map((entry, index) => {
    const npc = toObject(entry);
    const rawName = readString(npc.name);
    const role = readString(npc.role);
    const hidden = rawName ? !isNpcNameVisibleToPlayer(npc) : false;
    const displayName = hidden ? npcMaskLabel(npc, index) : rawName || npcMaskLabel(npc, index);
    return { id: readString(npc.id) || `npc-${index + 1}`, rawName, role, displayName, hidden };
  });
}

function escapeRegExpLiteral(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replace(/[.*+?^${}()|[\\]]/g, "\\$&");
}

function redactHiddenNpcNames(value: string, npcVisibility: SceneNpcVisibility[]): string {
  if (!value) return "";
  const replacements = npcVisibility
    .filter((entry) => entry.hidden && entry.rawName && entry.displayName && entry.rawName !== entry.displayName)
    .sort((a, b) => b.rawName.length - a.rawName.length);
  let output = value;
  for (const entry of replacements) {
    const pattern = new RegExp(escapeRegExpLiteral(entry.rawName), "g");
    output = output.replace(pattern, entry.displayName);
  }
  return output;
}

function buildNpcVisibilityGuardChunk(parsed: unknown): string {
  const hiddenNpcs = collectSceneNpcVisibility(parsed).filter((entry) => entry.hidden);
  if (hiddenNpcs.length === 0) return "";
  const lines: string[] = [
    "[TRPG_RUNTIME_NPC_VISIBILITY_GUARD]",
    "Do not reveal hidden NPC real names until they are explicitly introduced or publicly disclosed in-scene.",
    "Keep hidden names out of narration, clues, summaries, and optional suggestions.",
    "If the player asserts a hidden name, treat it as an unverified claim unless current evidence confirms it.",
    "Use these safe references while names remain hidden:",
  ];
  for (const entry of hiddenNpcs.slice(0, 8)) lines.push(`- ${entry.id}: ${entry.displayName}`);
  return joinLines(lines);
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function formatGauge(label: string, current: number | null, max: number | null): string {
  if (current === null && max === null) {
    return `${label}: unknown`;
  }
  if (max === null) {
    return `${label}: ${String(Math.round(current ?? 0))}`;
  }
  return `${label}: ${String(Math.round(current ?? 0))}/${String(Math.round(max))}`;
}

function sanitizeIntentText(value: string, maxLength = 240): string {
  if (!value) {
    return "";
  }

  const withoutBlocks = value.replace(/```[\s\S]*?```/g, " ");
  const flattened = withoutBlocks
    .replace(/"label"\s*:\s*"[^"]+"/g, " ")
    .replace(/"id"\s*:\s*"[^"]+"/g, " ")
    .replace(/"username"\s*:\s*"[^"]+"/g, " ")
    .replace(/"tag"\s*:\s*"[^"]+"/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!flattened) {
    return "";
  }

  return clipForGuard(flattened, maxLength);
}

function normalizeInventoryToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/x\d+$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function buildInventoryTokenSet(status: StatusPanelData): Set<string> {
  return new Set(
    [...status.carriedItems, ...status.equippedItems, ...status.inventoryHighlights]
      .map((entry) => normalizeInventoryToken(entry))
      .filter(Boolean),
  );
}

function hasInventoryTokenMatch(inventoryTokens: Set<string>, token: string): boolean {
  const normalizedToken = normalizeInventoryToken(token);
  if (!normalizedToken) {
    return false;
  }

  for (const known of inventoryTokens) {
    if (known.includes(normalizedToken) || normalizedToken.includes(known)) {
      return true;
    }
  }

  return false;
}

function extractLegacyInventory(entries: unknown[]): {
  carried: string[];
  equipped: string[];
  highlights: string[];
} {
  const carried: string[] = [];
  const equipped: string[] = [];
  const highlights: string[] = [];

  for (const entry of entries) {
    const item = toObject(entry);
    const name = readString(item.name);
    if (!name) {
      continue;
    }

    const quantity = readFiniteNumber(item.quantity);
    const equippedFlag = item.equipped === true;
    const display =
      quantity !== null && quantity > 1
        ? `${name} x${String(Math.round(quantity))}${equippedFlag ? " [equipped]" : ""}`
        : `${name}${equippedFlag ? " [equipped]" : ""}`;

    carried.push(name);
    if (equippedFlag) {
      equipped.push(name);
    }
    highlights.push(display);
  }

  return {
    carried: uniqStrings(carried),
    equipped: uniqStrings(equipped),
    highlights: uniqStrings(highlights),
  };
}

async function loadStatusPanelData(params: {
  cfg: ReturnType<typeof parseTrpgRuntimeConfig>;
  worldRoot: string;
}): Promise<StatusPanelData> {
  const [statusLoaded, inventoryLoaded] = await Promise.all([
    loadStructuredWorldFile(params.worldRoot, "state/player-status.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/inventory.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
  ]);

  const statusRoot = toObject(statusLoaded.parsed);
  const playerStatus = toObject(statusRoot.player_status);
  const legacyStatus = toObject(statusRoot.status);
  const health = toObject(legacyStatus.health);
  const staminaGauge = toObject(legacyStatus.stamina);
  const stress = toObject(legacyStatus.stress);
  const economy = toObject(legacyStatus.economy);

  const inventoryRoot = toObject(inventoryLoaded.parsed);
  const inventoryNode = toObject(inventoryRoot.inventory);
  const carried = uniqStrings(toStringArray(inventoryNode.carried));
  const equipped = uniqStrings(toStringArray(inventoryNode.equipped));
  const notes = toStringArray(inventoryNode.notes).slice(0, 6);

  const authoritativeCarried = carried.slice(0, 6);
  const authoritativeEquipped = equipped.slice(0, 6);
  const highlights = uniqStrings([
    ...authoritativeEquipped.map((entry) => `${entry} [equipped]`),
    ...authoritativeCarried,
  ]).slice(0, 6);

  const money =
    readFiniteNumber(playerStatus.money) ??
    readFiniteNumber(economy.money) ??
    readFiniteNumber(economy.funds);
  const fundsText =
    money !== null
      ? `coins ${String(Math.round(money))}`
      : readString(economy.funds) || readString(economy.currency) || "unknown";

  return {
    hpCurrent: readFiniteNumber(health.current),
    hpMax: readFiniteNumber(health.max),
    staminaCurrent: readFiniteNumber(staminaGauge.current),
    staminaMax: readFiniteNumber(staminaGauge.max),
    stressCurrent: readFiniteNumber(stress.current),
    stressMax: readFiniteNumber(stress.max),
    money,
    staminaState: readString(playerStatus.stamina) || "normal",
    conditionState: readString(playerStatus.condition) || "healthy",
    tags: toStringArray(playerStatus.tags).slice(0, 6),
    fundsText,
    inventoryHighlights: highlights,
    carriedItems: authoritativeCarried,
    equippedItems: authoritativeEquipped,
    inventoryNotes: notes,
  };
}

function isStatusRecallIntent(message: string): boolean {
  if (!message) {
    return false;
  }

  return /(상태창|상태\s*(확인|보여|요약)|스탯|체력\s*상태|인벤|소지품|장비\s*확인|status\s*(check|panel|recall)|inventory\s*(check|recall))/i.test(
    message,
  );
}

function buildStatusPanelGuardChunk(params: {
  status: StatusPanelData;
  latestAction: string;
}): string {
  const lines: string[] = [
    "[TRPG_RUNTIME_STATUS_PANEL_V1]",
    "Keep a compact status panel available every turn.",
    "Panel placement policy: after NPC posture and before freeform invitation.",
    `${formatGauge("HP", params.status.hpCurrent, params.status.hpMax)} | ${formatGauge("Stamina", params.status.staminaCurrent, params.status.staminaMax)} | ${formatGauge("Stress", params.status.stressCurrent, params.status.stressMax)}`,
    `Money: ${params.status.money === null ? "unknown" : String(Math.round(params.status.money))} | Stamina state: ${params.status.staminaState} | Condition: ${params.status.conditionState}`,
    `Funds: ${params.status.fundsText}`,
    "Economy mode: lightweight narrative currency only (no market simulation).",
  ];

  if (params.status.tags.length > 0) {
    lines.push(`Player tags: ${params.status.tags.join(", ")}`);
  }

  lines.push(
    "Inventory-authoritative policy: only use carried/equipped anchors listed here; never invent missing items from prior turns.",
  );

  if (params.status.equippedItems.length > 0) {
    lines.push(`Equipped anchors: ${params.status.equippedItems.slice(0, 3).join(" | ")}`);
  }

  if (params.status.carriedItems.length > 0) {
    lines.push(`Carried anchors: ${params.status.carriedItems.slice(0, 4).join(" | ")}`);
  }

  if (params.status.inventoryHighlights.length > 0) {
    lines.push(`Inventory highlights: ${params.status.inventoryHighlights.slice(0, 6).join(" | ")}`);
  }

  if (params.status.inventoryNotes.length > 0 && isStatusRecallIntent(params.latestAction)) {
    lines.push(`Inventory notes: ${params.status.inventoryNotes.slice(0, 2).join(" | ")}`);
  }

  if (isStatusRecallIntent(params.latestAction)) {
    lines.push("Latest player intent includes explicit status recall; show the compact panel first, then continue normal scene flow.");
    lines.push("Do not switch to menu-first output for status recall.");
  }

  return joinLines(lines);
}

function parseEconomyPurchaseIntent(message: string): { item: string; cost: number } | null {
  if (!message) {
    return null;
  }

  if (!/(구매|구입|산다|샀다|buy|purchase|procure)/i.test(message)) {
    return null;
  }

  let item = "";
  const quoted = message.match(/["'“”‘’]([^"'“”‘’]{1,48})["'“”‘’]/);
  if (quoted && quoted[1]) {
    item = quoted[1].trim();
  }

  if (!item) {
    const inferred = message.match(
      /([가-힣a-zA-Z0-9][가-힣a-zA-Z0-9\s\-]{1,32})(?:을|를)?\s*(?:\d+\s*(?:은화|골드|coin|coins|money|금화|코인)\s*)?(?:구매|구입|산다|buy|purchase|procure)/i,
    );
    if (inferred && inferred[1]) {
      item = inferred[1].trim();
    }
  }

  const costMatch = message.match(/(\d{1,4})\s*(?:은화|골드|coin|coins|money|금화|코인|원)/i);
  const cost = costMatch ? Math.max(1, Number.parseInt(costMatch[1], 10)) : 1;

  const cleanedItem = item.replace(/\s+/g, " ").trim();
  if (!cleanedItem) {
    return null;
  }

  return {
    item: cleanedItem,
    cost,
  };
}

async function applyLightweightEconomyUpdate(params: {
  cfg: ReturnType<typeof parseTrpgRuntimeConfig>;
  worldRoot: string;
  latestAction: string;
}): Promise<{ contextChunk?: string }> {
  const purchase = parseEconomyPurchaseIntent(params.latestAction);
  if (!purchase) {
    return {};
  }

  const [statusLoaded, inventoryLoaded] = await Promise.all([
    loadStructuredWorldFile(params.worldRoot, "state/player-status.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/inventory.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
  ]);

  const statusRoot = toObject(statusLoaded.parsed);
  const playerStatus = toObject(statusRoot.player_status);
  const previousMoney = readFiniteNumber(playerStatus.money) ?? 0;

  if (previousMoney < purchase.cost) {
    return {
      contextChunk: joinLines([
        "[TRPG_RUNTIME_ECONOMY_LITE_V1]",
        `Purchase intent detected but insufficient money: need ${String(purchase.cost)}, have ${String(previousMoney)}.`,
        "Classify this as conditional/impossible unless another in-scene funding source is established.",
        "Explain shortfall briefly and keep freeform-first.",
      ]),
    };
  }

  playerStatus.money = Math.max(0, Math.round(previousMoney - purchase.cost));
  if (!readString(playerStatus.stamina)) {
    playerStatus.stamina = "normal";
  }
  if (!readString(playerStatus.condition)) {
    playerStatus.condition = "healthy";
  }
  if (!Array.isArray(playerStatus.tags)) {
    playerStatus.tags = [];
  }

  statusRoot.player_status = playerStatus;
  statusRoot.meta = {
    ...toObject(statusRoot.meta),
    schema_version: 1,
    last_updated: new Date().toISOString(),
  };

  const inventoryRoot = toObject(inventoryLoaded.parsed);
  const inventory = toObject(inventoryRoot.inventory);
  const carried = uniqStrings([...toStringArray(inventory.carried), purchase.item]);
  const equipped = uniqStrings(toStringArray(inventory.equipped));
  const notes = uniqStrings([
    ...toStringArray(inventory.notes).slice(-5),
    `purchase:${purchase.item}:${String(purchase.cost)}`,
  ]).slice(-6);

  inventory.carried = carried;
  inventory.equipped = equipped;
  inventory.notes = notes;
  inventoryRoot.inventory = inventory;
  inventoryRoot.meta = {
    ...toObject(inventoryRoot.meta),
    schema_version: 1,
    last_updated: new Date().toISOString(),
  };

  const [statusRendered, inventoryRendered] = [
    renderStructuredContent(statusLoaded.format, statusRoot),
    renderStructuredContent(inventoryLoaded.format, inventoryRoot),
  ];

  await Promise.all([
    fs.writeFile(resolveWorldAbsolutePath(params.worldRoot, "state/player-status.yaml"), statusRendered, "utf8"),
    fs.writeFile(resolveWorldAbsolutePath(params.worldRoot, "state/inventory.yaml"), inventoryRendered, "utf8"),
  ]);

  return {
    contextChunk: joinLines([
      "[TRPG_RUNTIME_ECONOMY_LITE_V1]",
      `Narrative purchase applied: ${purchase.item} (cost ${String(purchase.cost)}).`,
      `Money updated: ${String(previousMoney)} -> ${String(playerStatus.money)}.`,
      "Inventory updated as token-level carried/equipped data.",
      "No market simulation, pricing tables, or shop subsystem should be introduced.",
    ]),
  };
}


function detectInventoryGatedAction(message: string, status: StatusPanelData): string[] {
  if (!message) {
    return [];
  }

  const normalizedMessage = message.toLowerCase();
  const inventoryTokens = buildInventoryTokenSet(status);

  const hasAnyToken = (tokens: string[]): boolean =>
    tokens.some((token) => hasInventoryTokenMatch(inventoryTokens, token));

  const missing: string[] = [];
  const gatedChecks: Array<{ pattern: RegExp; itemAliases: string[]; hint: string }> = [
    {
      pattern: /(자물쇠|잠금|따개|pick\s*lock|lockpick|lock\s*open)/i,
      itemAliases: ["락픽", "lockpick", "열쇠", "key"],
      hint: "Lock-related action appears to need lockpick/key access.",
    },
    {
      pattern: /(불을\s*붙|횃불|torch|lantern|light\s*the\s*way)/i,
      itemAliases: ["횃불", "torch", "랜턴", "lantern"],
      hint: "Light-source action appears to need torch/lantern.",
    },
    {
      pattern: /(밧줄|rope|tie\s*off|descend|climb\s*down)/i,
      itemAliases: ["밧줄", "rope", "갈고리", "hook"],
      hint: "Traversal action appears to need rope/hook support.",
    },
    {
      pattern: /(검문|서류|증명|통행증|permit|papers|pass)/i,
      itemAliases: ["통행증", "허가증", "문서", "permit", "papers", "seal"],
      hint: "Checkpoint/document action appears to need suitable papers.",
    },
  ];

  for (const check of gatedChecks) {
    if (check.pattern.test(normalizedMessage) && !hasAnyToken(check.itemAliases)) {
      missing.push(check.hint);
    }
  }

  const quotedItem = message.match(/["'“”‘’]([^"'“”‘’]{2,48})["'“”‘’]/);
  if (quotedItem && /(꺼내|사용|장착|equip|use|wield|draw)/i.test(message)) {
    const demandedItem = quotedItem[1]?.trim() || "";
    if (demandedItem && !hasAnyToken([demandedItem])) {
      missing.push(`Player referenced item '${demandedItem}' not found in known carried/equipped inventory.`);
    }
  }

  return uniqStrings(missing).slice(0, 3);
}

function detectHardImpossibleActionGates(message: string, status: StatusPanelData): string[] {
  if (!message) {
    return [];
  }

  const normalizedMessage = message.toLowerCase();
  const inventoryTokens = buildInventoryTokenSet(status);
  const hasAnyToken = (tokens: string[]): boolean =>
    tokens.some((token) => hasInventoryTokenMatch(inventoryTokens, token));

  const hardGates: string[] = [];
  const weaponChecks: Array<{ pattern: RegExp; aliases: string[]; reason: string }> = [
    {
      pattern: /(칼|검|단검|knife|dagger|sword).*(뽑|꺼내|휘두|겨누|위협|찌르|베|draw|wield|threat|stab|slash)/i,
      aliases: ["칼", "검", "단검", "knife", "dagger", "sword"],
      reason: "Weapon declaration has no carried/equipped anchor; classify original action as impossible.",
    },
    {
      pattern: /(창|spear|pike).*(겨누|찌르|투척|thrust|stab|throw)/i,
      aliases: ["창", "spear", "pike"],
      reason: "Spear weapon use has no carried/equipped anchor; classify original action as impossible.",
    },
    {
      pattern: /(활|석궁|bow|crossbow).*(쏘|당기|발사|shoot|fire)/i,
      aliases: ["활", "석궁", "bow", "crossbow"],
      reason: "Ranged weapon use has no carried/equipped anchor; classify original action as impossible.",
    },
    {
      pattern: /(권총|총|pistol|rifle|gun).*(쏘|겨누|발사|shoot|fire|aim)/i,
      aliases: ["권총", "총", "pistol", "rifle", "gun"],
      reason: "Firearm use has no carried/equipped anchor; classify original action as impossible.",
    },
  ];

  for (const check of weaponChecks) {
    if (!check.pattern.test(normalizedMessage)) {
      continue;
    }
    if (!hasAnyToken(check.aliases)) {
      hardGates.push(check.reason);
    }
  }

  const quotedItem = message.match(/["'“”‘’]([^"'“”‘’]{2,48})["'“”‘’]/);
  if (quotedItem && /(꺼내|사용|장착|equip|use|wield|draw|brandish)/i.test(message)) {
    const demandedItem = quotedItem[1]?.trim() || "";
    if (demandedItem && !hasAnyToken([demandedItem])) {
      hardGates.push(
        "Quoted item '" + demandedItem + "' is not present in carried/equipped inventory; classify original action as impossible.",
      );
    }
  }

  const preResolvedPatterns = [
    /(이미|벌써|already).*(위조|통과|잠입|침투|훔치|확보|해결|forg|pass|infiltrat|stole|secured|resolved)/i,
    /(위조|통과|잠입|침투|훔치|확보|해결).*(한\s*상태|완료|끝났|되어\s*있)/i,
  ];
  if (preResolvedPatterns.some((pattern) => pattern.test(normalizedMessage))) {
    hardGates.push(
      "Completed-outcome assertions require prior in-scene evidence; do not narrate the claimed success as already true.",
    );
  }

  return uniqStrings(hardGates).slice(0, 4);
}

function actionLikelyTargetsNpc(message: string, npc: SceneNpcVisibility): boolean {
  const normalized = message.toLowerCase();
  const candidates = [npc.id, npc.rawName, npc.role, npc.displayName]
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return candidates.some((candidate) => normalized.includes(candidate));
}

function isNpcMemoryRelevantAction(message: string): boolean {
  if (!message) {
    return false;
  }

  return /(질문|묻|심문|추궁|회유|협상|탐문|정보|단서|설득|협박|deal|question|ask|interrogat|negotiat|probe)/i.test(
    message,
  );
}

async function updateAndBuildNpcMemoryChunk(params: {
  cfg: ReturnType<typeof parseTrpgRuntimeConfig>;
  worldRoot: string;
  sceneParsed: unknown;
  latestAction: string;
}): Promise<string> {
  const loaded = await loadStructuredWorldFile(params.worldRoot, "state/npc-memory.yaml", {
    allowMissing: true,
    maxReadBytes: params.cfg.maxReadBytes,
  });

  const root = toObject(loaded.parsed);
  const memoryNode = toObject(root.memory);
  const byNpc = toObject(memoryNode.by_npc);
  const visibleNpcs = collectSceneNpcVisibility(params.sceneParsed);
  const safeLatestAction = sanitizeIntentText(params.latestAction, 220);

  let changed = false;
  if (safeLatestAction && isNpcMemoryRelevantAction(safeLatestAction)) {
    for (const npc of visibleNpcs) {
      if (!actionLikelyTargetsNpc(safeLatestAction, npc)) {
        continue;
      }

      const npcMemory = toObject(byNpc[npc.id]);
      if (npcMemory.last_player_focus !== safeLatestAction) {
        npcMemory.last_player_focus = safeLatestAction;
        changed = true;
      }
      npcMemory.last_player_focus_at = new Date().toISOString();
      if (!Array.isArray(npcMemory.notes)) {
        npcMemory.notes = [];
        changed = true;
      }
      byNpc[npc.id] = npcMemory;
    }
  }

  const summaries: NpcMemorySummary[] = visibleNpcs.map((npc) => {
    const npcMemory = toObject(byNpc[npc.id]);
    const notes = toStringArray(npcMemory.notes).slice(0, 2);
    return {
      npcId: npc.id,
      displayName: npc.displayName,
      notes,
      lastPlayerFocus: readString(npcMemory.last_player_focus),
    };
  });

  if (changed) {
    root.meta = {
      schema_version: 1,
      last_updated: new Date().toISOString(),
    };
    root.memory = {
      by_npc: byNpc,
    };
    const rendered = renderStructuredContent(loaded.format, root);
    const absolute = resolveWorldAbsolutePath(params.worldRoot, "state/npc-memory.yaml");
    await fs.writeFile(absolute, rendered, "utf8");
  }

  if (summaries.length === 0) {
    return "";
  }

  const lines: string[] = [
    "[TRPG_RUNTIME_NPC_MEMORY_V1]",
    "Maintain continuity for visible NPCs using compact memory cues.",
    "Prefer consistency with prior posture, tension, and disclosed facts.",
  ];

  for (const summary of summaries.slice(0, 5)) {
    const noteText = summary.notes.length > 0 ? `notes: ${summary.notes.join("; ")}` : "notes: none";
    const focusText = summary.lastPlayerFocus
      ? `last_focus: ${clipForGuard(summary.lastPlayerFocus, 120)}`
      : "last_focus: none";
    lines.push(`- ${summary.npcId} (${summary.displayName}) -> ${noteText} | ${focusText}`);
  }

  return joinLines(lines);
}

function parseFastWaitDurationLabel(message: string): string {
  const lower = message.toLowerCase();
  const match = lower.match(/(\d{1,2})\s*(턴|분|시간|일|turn|minute|hour|day)s?/i);
  if (match && match[1] && match[2]) {
    return `${match[1]} ${match[2]}`;
  }

  if (/(잠깐|잠시|briefly|a\s*moment)/i.test(lower)) {
    return "brief";
  }
  if (/(하루|하룻밤|overnight)/i.test(lower)) {
    return "1 day";
  }
  if (/(한\s*시간|1\s*hour)/i.test(lower)) {
    return "1 hour";
  }

  return "short";
}

function isFastWaitIntent(message: string): boolean {
  if (!message) {
    return false;
  }

  const waitPattern = /(기다|대기|잠복|잠시\s*쉰|시간\s*(보내|넘기|건너뛰)|턴\s*넘기|wait|pass\s*time|skip\s*time|hold\s*position)/gi;
  const movementPattern = /(이동|출발|향한다|향해|떠나|travel|move|head|sail|ride)/i;
  const matches = Array.from(message.matchAll(waitPattern));

  if (matches.length === 0) {
    return false;
  }

  const last = matches[matches.length - 1];
  const start = Math.max(0, (last?.index ?? 0) - 80);
  const end = Math.min(message.length, (last?.index ?? 0) + 160);
  const localWindow = message.slice(start, end);

  return !movementPattern.test(localWindow);
}


async function applyFastWaitWorldDrift(params: {
  cfg: ReturnType<typeof parseTrpgRuntimeConfig>;
  worldRoot: string;
  waitCount: number;
}): Promise<string[]> {
  const [pressureLoaded, travelLoaded, sceneLoaded, memoryLoaded] = await Promise.all([
    loadStructuredWorldFile(params.worldRoot, "state/world-pressure.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/travel-state.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/current-scene.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/npc-memory.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
  ]);

  const pressureRoot = toObject(pressureLoaded.parsed);
  const travelRoot = toObject(travelLoaded.parsed);
  const sceneRoot = toObject(sceneLoaded.parsed);

  const currentZoneId = normalizeZoneId(
    readString(toObject(travelRoot.travel_state).current_zone) ||
      readString(toObject(toObject(sceneRoot.scene).location).zone_id),
  );

  const driftLines: string[] = [];
  let pressureChanged = false;

  if (currentZoneId) {
    const zonePressureRoot = toObject(pressureRoot.zone_pressure);
    const zonePressure = toObject(zonePressureRoot[currentZoneId]);
    const previous = readFiniteNumber(zonePressure.pressure) ?? readFiniteNumber(zonePressure.score) ?? 45;
    const delta = params.waitCount >= 3 ? 3 : params.waitCount >= 2 ? 2 : 1;
    const next = Math.max(0, Math.min(100, Math.round(previous + delta)));

    zonePressure.pressure = next;
    zonePressure.score = next;
    zonePressure.trend = next > previous ? "up" : readString(zonePressure.trend) || "stable";
    const signals = uniqStrings([...toStringArray(zonePressure.signals), "watch_rotation_shift"]);
    zonePressure.signals = signals.slice(-4);
    zonePressureRoot[currentZoneId] = zonePressure;
    pressureRoot.zone_pressure = zonePressureRoot;

    const districtTensionRoot = toObject(pressureRoot.district_tension);
    const district = toObject(districtTensionRoot[currentZoneId]);
    district.score = next;
    district.trend = next > previous ? "up" : readString(district.trend) || "stable";
    districtTensionRoot[currentZoneId] = district;
    pressureRoot.district_tension = districtTensionRoot;

    pressureRoot.meta = {
      ...toObject(pressureRoot.meta),
      schema_version: 1,
      last_updated: new Date().toISOString(),
    };

    pressureChanged = true;
    const zoneLabel = readString(zonePressure.label) || currentZoneId;
    driftLines.push(`Zone pressure drift: ${zoneLabel} ${String(Math.round(previous))} -> ${String(next)}.`);
  }

  if (pressureChanged) {
    const renderedPressure = renderStructuredContent(pressureLoaded.format, pressureRoot);
    await fs.writeFile(resolveWorldAbsolutePath(params.worldRoot, "state/world-pressure.yaml"), renderedPressure, "utf8");
  }

  const memoryRoot = toObject(memoryLoaded.parsed);
  const memory = toObject(memoryRoot.memory);
  const byNpc = toObject(memory.by_npc);
  let decayedNpcCount = 0;

  if (params.waitCount >= 2) {
    for (const npcState of Object.values(byNpc)) {
      const node = toObject(npcState);
      const notes = toStringArray(node.notes);
      if (notes.length > 3) {
        node.notes = notes.slice(-3);
        decayedNpcCount += 1;
      }
    }
  }

  if (decayedNpcCount > 0) {
    memory.by_npc = byNpc;
    memoryRoot.memory = memory;
    memoryRoot.meta = {
      ...toObject(memoryRoot.meta),
      schema_version: 1,
      last_updated: new Date().toISOString(),
    };
    const renderedMemory = renderStructuredContent(memoryLoaded.format, memoryRoot);
    await fs.writeFile(resolveWorldAbsolutePath(params.worldRoot, "state/npc-memory.yaml"), renderedMemory, "utf8");
    driftLines.push(`NPC memory decay applied to ${String(decayedNpcCount)} threads after prolonged waiting.`);
  }

  return driftLines;
}

async function applyFastWaitV1(params: {
  cfg: ReturnType<typeof parseTrpgRuntimeConfig>;
  worldRoot: string;
  latestAction: string;
  prompt: string;
}): Promise<FastWaitContext> {
  const promptTail = typeof params.prompt === "string" ? params.prompt.slice(-2200) : "";
  const combinedProbe = `${params.latestAction}
${promptTail}`;
  if (!isFastWaitIntent(combinedProbe)) {
    return {
      waitApplied: false,
      durationLabel: "",
    };
  }

  const durationLabel = parseFastWaitDurationLabel(combinedProbe);
  const loaded = await loadStructuredWorldFile(params.worldRoot, "state/fast-wait.yaml", {
    allowMissing: true,
    maxReadBytes: params.cfg.maxReadBytes,
  });

  const root = toObject(loaded.parsed);
  const waitNode = toObject(root.fast_wait);
  const lastCount = readFiniteNumber(waitNode.consecutive_wait_count) ?? 0;
  waitNode.consecutive_wait_count = Math.max(0, Math.floor(lastCount + 1));
  waitNode.last_duration = durationLabel;
  waitNode.last_user_intent = sanitizeIntentText(params.latestAction || combinedProbe, 180);
  waitNode.last_applied_at = new Date().toISOString();

  root.meta = {
    schema_version: 1,
    last_updated: new Date().toISOString(),
  };
  root.fast_wait = waitNode;

  const rendered = renderStructuredContent(loaded.format, root);
  const absolute = resolveWorldAbsolutePath(params.worldRoot, "state/fast-wait.yaml");
  await fs.writeFile(absolute, rendered, "utf8");

  const driftLines = await applyFastWaitWorldDrift({
    cfg: params.cfg,
    worldRoot: params.worldRoot,
    waitCount: Math.max(0, Math.floor(readFiniteNumber(waitNode.consecutive_wait_count) ?? 0)),
  });

  const contextChunk = joinLines([
    "[TRPG_RUNTIME_FAST_WAIT_V1]",
    `Fast-wait intent detected (${durationLabel}).`,
    "Resolve time-skip succinctly: brief progression, pressure shift, and one actionable next hook.",
    "Keep context-first and freeform-first. Do not switch to menu-first output.",
    "Unless player explicitly requests travel, stay in the same scene/zone while applying wait consequences.",
    ...driftLines,
  ]);

  return {
    waitApplied: true,
    durationLabel,
    contextChunk,
  };
}

async function applySceneIntroGuard(params: {
  cfg: ReturnType<typeof parseTrpgRuntimeConfig>;
  worldRoot: string;
}): Promise<{ introRequired: boolean; sceneId: string; majorSceneStart: boolean }> {
  const loaded = await loadStructuredWorldFile(params.worldRoot, "state/current-scene.yaml", {
    allowMissing: true,
    maxReadBytes: params.cfg.maxReadBytes,
  });

  const root = toObject(loaded.parsed);
  const scene = toObject(root.scene);
  const sceneFlow = toObject(scene.scene_flow);

  const majorSceneStart = scene.major_scene_start === true;
  const introShown = sceneFlow.intro_shown === true;
  const sceneId = readSceneId(scene);

  if (!majorSceneStart || introShown) {
    return {
      introRequired: false,
      sceneId,
      majorSceneStart,
    };
  }

  sceneFlow.intro_shown = true;
  sceneFlow.awaiting_player_action = true;
  scene.scene_flow = sceneFlow;
  root.scene = scene;

  const absolute = resolveWorldAbsolutePath(params.worldRoot, "state/current-scene.yaml");
  const rendered = renderStructuredContent(loaded.format, root);
  await fs.writeFile(absolute, rendered, "utf8");

  return {
    introRequired: true,
    sceneId,
    majorSceneStart,
  };
}

function clipForGuard(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function summarizeSceneClock(clock: unknown): string {
  const clockObj = toObject(clock);
  const label = readString(clockObj.label) || readString(clockObj.id) || "clock";
  const remainingRaw = clockObj.remaining_turns;
  const remaining =
    typeof remainingRaw === "number" && Number.isFinite(remainingRaw)
      ? Math.max(0, Math.trunc(remainingRaw))
      : readString(remainingRaw) || "?";
  const consequence = readString(clockObj.consequence_on_zero);
  return consequence
    ? `${label} (remaining: ${String(remaining)}; zero: ${consequence})`
    : `${label} (remaining: ${String(remaining)})`;
}

async function buildActionFeasibilityGuardChunk(params: {
  cfg: ReturnType<typeof parseTrpgRuntimeConfig>;
  worldRoot: string;
  messages: unknown[];
  prompt: string;
  sceneParsed?: unknown;
  statusPanelData?: StatusPanelData;
}): Promise<string> {
  const latestAction =
    extractLatestUserMessageFromPrompt(params.prompt) || extractLatestUserMessage(params.messages);

  let sceneParsed = params.sceneParsed;
  if (sceneParsed === undefined) {
    const loaded = await loadStructuredWorldFile(params.worldRoot, "state/current-scene.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    });
    sceneParsed = loaded.parsed;
  }

  const sceneRoot = toObject(sceneParsed);
  const scene = toObject(sceneRoot.scene);
  const npcVisibility = collectSceneNpcVisibility(sceneRoot);
  const redact = (value: string) => redactHiddenNpcNames(value, npcVisibility);
  const statusData = params.statusPanelData ?? (await loadStatusPanelData({ cfg: params.cfg, worldRoot: params.worldRoot }));

  const hardLimits = (Array.isArray(scene.hard_limits) ? scene.hard_limits : [])
    .map((entry) => redact(readString(entry)))
    .filter(Boolean)
    .slice(0, 6);

  const obviousRisk = redact(readString(scene.obvious_risk));
  const clocks = (Array.isArray(sceneRoot.ticking_clocks) ? sceneRoot.ticking_clocks : [])
    .map((entry) => redact(summarizeSceneClock(entry)))
    .filter(Boolean)
    .slice(0, 4);

  const lines: string[] = [
    "[TRPG_RUNTIME_ACTION_FEASIBILITY_GUARD]",
    "Adjudicate the latest player action before narration.",
    "Internally classify the action as exactly one: immediate | costly | conditional | impossible.",
    "Do not expose these labels to the player.",
    "Mapping: immediate=possible now, costly=possible but costly, conditional=needs prerequisite or risk handling, impossible=cannot be executed as stated now.",
    "Resolution contract:",
    "- immediate: resolve directly with concrete in-world consequences.",
    "- conditional: do not fake success; explain missing condition or risk gate, then offer 1-2 viable setup routes.",
    "- costly: resolve only with an explicit trade-off (time, resource, position, reputation, clue burn).",
    "- impossible: never validate the assertion as already true; reject it in-world and ask for revised intent.",
    "Name-dependent social actions require in-scene name knowledge; unknown names are insufficient declarations.",
    "Item/equipment assertions must align with known inventory and carried gear unless newly acquired in-scene.",
    "Missing weapon/equipment anchors default to impossible; do not narrate asserted success.",
    "Keep context-first and freeform-first. Avoid menu-first recovery prompts.",
    "Do not emit immediate_options or mandatory numbered choices.",
  ];

  if (latestAction) {
    lines.push(`Latest player action: ${redact(clipForGuard(latestAction, 420))}`);
  }

  if (hardLimits.length > 0) {
    lines.push(`Scene hard limits: ${hardLimits.join(" | ")}`);
  }

  if (obviousRisk) {
    lines.push(`Scene obvious risk: ${clipForGuard(obviousRisk, 260)}`);
  }

  if (clocks.length > 0) {
    lines.push("Active clocks:");
    for (const clock of clocks) {
      lines.push(`- ${clock}`);
    }
  }

  if (statusData.inventoryHighlights.length > 0) {
    lines.push(`Known inventory anchors: ${statusData.inventoryHighlights.join(" | ")}`);
  }

  const inventoryGates = detectInventoryGatedAction(latestAction, statusData);
  if (inventoryGates.length > 0) {
    lines.push("Potential inventory gates to enforce:");
    for (const gate of inventoryGates) {
      lines.push(`- ${gate}`);
    }
  }

  const hardImpossibleGates = detectHardImpossibleActionGates(latestAction, statusData);
  if (hardImpossibleGates.length > 0) {
    lines.push("Hard feasibility overrides (must be enforced):");
    for (const gate of hardImpossibleGates) {
      lines.push(`- ${gate}`);
    }
    lines.push("If any hard override applies, default verdict is impossible.");
    lines.push("Never narrate the asserted success when hard overrides are present.");
    lines.push("Offer 1-2 short in-world alternatives without menu-first formatting.");
  }

  return joinLines(lines);
}


type ScenePersistenceSignals = {
  interrogation: boolean;
  negotiation: boolean;
  investigation: boolean;
  explicitTransition: boolean;
  pressurePush: boolean;
};

function readDisclosureStage(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(5, Math.trunc(value)));
  }

  const asString = readString(value);
  if (!asString) {
    return 1;
  }

  const parsed = Number.parseInt(asString, 10);
  if (!Number.isFinite(parsed)) {
    return 1;
  }

  return Math.max(1, Math.min(5, parsed));
}

function detectScenePersistenceSignals(message: string): ScenePersistenceSignals {
  const normalized = message.toLowerCase();
  return {
    interrogation: /(심문|추궁|캐묻|자백|압박\s*신문|interrogat|cross[-\s]?exam)/.test(normalized),
    negotiation: /(협상|흥정|거래\s*조건|합의|타협|deal|negotiat|bargain)/.test(normalized),
    investigation: /(질문|조사|탐문|단서|기록\s*대조|알리바이|진술\s*확인|probe|investigat)/.test(normalized),
    explicitTransition: /(다음\s*장면|장면\s*넘어|장면\s*전환|이동하자|떠나자|다음으로\s*가|move on|next scene)/.test(normalized),
    pressurePush: /(회피하지\s*말|솔직히\s*말|진실을\s*말|지금\s*말해|끝까지\s*묻|압박)/.test(normalized),
  };
}

function applyScenePersistenceDefaults(params: {
  sceneParsed: unknown;
  latestAction: string;
}): { changed: boolean; sceneFlow: Record<string, unknown>; signals: ScenePersistenceSignals } {
  const root = toObject(params.sceneParsed);
  const scene = toObject(root.scene);
  const sceneFlow = toObject(scene.scene_flow);
  const signals = detectScenePersistenceSignals(params.latestAction);

  let changed = false;

  if (typeof sceneFlow.scene_persistence !== "boolean") {
    sceneFlow.scene_persistence = true;
    changed = true;
  }
  if (typeof sceneFlow.transition_allowed !== "boolean") {
    sceneFlow.transition_allowed = false;
    changed = true;
  }
  if (!readString(sceneFlow.unresolved_tension)) {
    sceneFlow.unresolved_tension = "high";
    changed = true;
  }
  if (typeof sceneFlow.interrogation_active !== "boolean") {
    sceneFlow.interrogation_active = false;
    changed = true;
  }

  const currentStage = readDisclosureStage(sceneFlow.disclosure_stage);
  if (sceneFlow.disclosure_stage !== currentStage) {
    sceneFlow.disclosure_stage = currentStage;
    changed = true;
  }

  const highValueDialog = signals.interrogation || signals.negotiation || signals.investigation;
  if (highValueDialog) {
    if (sceneFlow.scene_persistence !== true) {
      sceneFlow.scene_persistence = true;
      changed = true;
    }
    if (sceneFlow.transition_allowed !== false) {
      sceneFlow.transition_allowed = false;
      changed = true;
    }
    if (sceneFlow.unresolved_tension !== "high") {
      sceneFlow.unresolved_tension = "high";
      changed = true;
    }
  }

  if (signals.interrogation && sceneFlow.interrogation_active !== true) {
    sceneFlow.interrogation_active = true;
    changed = true;
  }

  if (signals.explicitTransition) {
    if (sceneFlow.transition_allowed !== true) {
      sceneFlow.transition_allowed = true;
      changed = true;
    }
  }

  if (signals.pressurePush && sceneFlow.interrogation_active === true) {
    const nextStage = Math.min(5, currentStage + 1);
    if (nextStage !== currentStage) {
      sceneFlow.disclosure_stage = nextStage;
      changed = true;
    }
  }

  scene.scene_flow = sceneFlow;
  root.scene = scene;

  return {
    changed,
    sceneFlow,
    signals,
  };
}

function buildScenePersistenceGuardChunk(params: {
  sceneParsed: unknown;
  latestAction: string;
  sceneFlow: Record<string, unknown>;
  signals: ScenePersistenceSignals;
}): string {
  const sceneRoot = toObject(params.sceneParsed);
  const scene = toObject(sceneRoot.scene);
  const sceneTitle = readString(scene.title) || readString(scene.id) || "current-scene";
  const scenePersistence = params.sceneFlow.scene_persistence === true;
  const transitionAllowed = params.sceneFlow.transition_allowed === true;
  const unresolvedTension = readString(params.sceneFlow.unresolved_tension) || "high";
  const disclosureStage = readDisclosureStage(params.sceneFlow.disclosure_stage);
  const interrogationActive = params.sceneFlow.interrogation_active === true;

  const lines: string[] = [
    "[TRPG_RUNTIME_SCENE_PERSISTENCE_GUARD]",
    `Scene: ${sceneTitle}`,
    "Keep high-value dialog in the same scene by default (interrogation, negotiation, investigation, tense questioning).",
    "Do not jump scenes after one reply unless transition is explicitly requested or strongly forced.",
    "Transition is allowed only when at least one applies: player explicitly asks, current objective is substantially resolved, interaction value is exhausted, or a strong external interruption occurs.",
    "Use layered disclosure in tense dialog:",
    "1) evasive response",
    "2) partial statement",
    "3) contradiction leak",
    "4) pressured admission",
    "5) broader implication",
    `scene_persistence=${String(scenePersistence)} transition_allowed=${String(transitionAllowed)} unresolved_tension=${unresolvedTension} disclosure_stage=${String(disclosureStage)} interrogation_active=${String(interrogationActive)}`,
  ];

  if (params.latestAction) {
    lines.push(`Latest player action: ${clipForGuard(params.latestAction, 320)}`);
  }

  if (params.signals.explicitTransition) {
    lines.push("Player message includes explicit transition intent; transition can be considered if scene objective is also resolved.");
  }

  return joinLines(lines);
}


async function runCharacterBootstrapGate(params: {
  cfg: ReturnType<typeof parseTrpgRuntimeConfig>;
  worldRoot: string;
  agentId: string;
  patchCache: ReturnType<typeof createPatchCache>;
  messages: unknown[];
  prompt: string;
}): Promise<BootstrapGateResult> {
  const loaded = await loadStructuredWorldFile(params.worldRoot, "canon/player.yaml", {
    allowMissing: true,
    maxReadBytes: params.cfg.maxReadBytes,
  });

  const root = toObject(loaded.parsed);
  const player = toObject(root.player);
  const gameState = toObject(root.game_state);
  const worldHints = toObject(root.world_hints);

  const latestUserMessage =
    extractLatestUserMessageFromPrompt(params.prompt) || extractLatestUserMessage(params.messages);

  const bootstrapUpdate = parseBootstrapUpdate(latestUserMessage);

  let changed = false;
  for (const field of ["name", "background", "motive", "secret", "fear", "goal"] as const) {
    const candidate = readString(bootstrapUpdate[field]);
    if (!candidate || player[field] === candidate) {
      continue;
    }
    player[field] = candidate;
    changed = true;
  }

  const incomingFreeform = extractBootstrapFreeform(latestUserMessage);
  const mergedFreeform = mergeFreeformDescription(
    readString(player.freeform_description),
    incomingFreeform,
  );
  if (readString(player.freeform_description) !== mergedFreeform) {
    player.freeform_description = mergedFreeform;
    changed = true;
  }

  if (typeof gameState.character_created !== "boolean") {
    gameState.character_created = false;
    changed = true;
  }
  if (typeof gameState.bootstrap_complete !== "boolean") {
    gameState.bootstrap_complete = false;
    changed = true;
  }

  const priorBootstrapComplete = gameState.bootstrap_complete === true;
  const explicitReady = hasBootstrapReadySignal(latestUserMessage);
  const minimalComplete = hasMinimalBootstrapFields(player);
  const shouldComplete = !priorBootstrapComplete && (minimalComplete || explicitReady);

  const characterCreated = gameState.character_created === true || Boolean(readString(player.name));
  if (gameState.character_created !== characterCreated) {
    gameState.character_created = characterCreated;
    changed = true;
  }

  if (shouldComplete && gameState.bootstrap_complete !== true) {
    gameState.bootstrap_complete = true;
    changed = true;
  }

  root.player = player;
  root.game_state = gameState;
  root.world_hints = worldHints;

  const bootstrapComplete = gameState.bootstrap_complete === true;
  const justCompleted = !priorBootstrapComplete && bootstrapComplete;

  const sceneLoaded = await loadStructuredWorldFile(params.worldRoot, "state/current-scene.yaml", {
    allowMissing: true,
    maxReadBytes: params.cfg.maxReadBytes,
  });
  if (sceneLoaded.exists) {
    const sceneRoot = toObject(sceneLoaded.parsed);
    const scene = toObject(sceneRoot.scene);
    if (Object.keys(scene).length > 0) {
      const sceneFlow = toObject(scene.scene_flow);
      let sceneChanged = false;

      if (sceneFlow.player_setup_complete !== bootstrapComplete) {
        sceneFlow.player_setup_complete = bootstrapComplete;
        sceneChanged = true;
      }

      if (!bootstrapComplete && sceneFlow.intro_shown !== false) {
        sceneFlow.intro_shown = false;
        sceneChanged = true;
      }

      if (justCompleted && sceneFlow.intro_shown !== false) {
        sceneFlow.intro_shown = false;
        sceneChanged = true;
      }

      if (sceneChanged) {
        scene.scene_flow = sceneFlow;
        sceneRoot.scene = scene;
        const sceneRendered = renderStructuredContent(sceneLoaded.format, sceneRoot);
        const sceneAbsolute = resolveWorldAbsolutePath(params.worldRoot, "state/current-scene.yaml");
        await fs.writeFile(sceneAbsolute, sceneRendered, "utf8");
      }
    }
  }

  if (changed) {
    const persisted = await applyBootstrapAuditedPersistence({
      cfg: params.cfg,
      worldRoot: params.worldRoot,
      agentId: params.agentId,
      patchCache: params.patchCache,
      title: "bootstrap player canon persistence",
      operations: [
        {
          op: "set",
          file: "canon/player.yaml",
          pointer: "/",
          value: root,
        },
      ],
    });
    if (!persisted.ok) {
      throw new Error(persisted.error || "bootstrap player persistence failed");
    }
  }

  const [worldSeedsLoaded, relationshipsLoaded] = await Promise.all([
    loadStructuredWorldFile(params.worldRoot, "state/world-seeds.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/relationships.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
  ]);

  const worldSeedsRoot = toObject(worldSeedsLoaded.parsed);
  const worldSeeds = toObject(worldSeedsRoot.seeds);
  const bootstrapSeeds = toObject(worldSeeds.bootstrap);
  const existingSeedStructures = toStringArray(bootstrapSeeds.inferred_structures);
  const existingSeedZones = toStringArray(bootstrapSeeds.zone_hints);
  const inferredMerged = Array.from(
    new Set([...existingSeedStructures, ...toStringArray(worldHints.inferred_structures)]),
  );
  const mergedSeedZones = Array.from(new Set(existingSeedZones));

  let worldSeedsChanged = false;
  if (
    inferredMerged.length !== existingSeedStructures.length ||
    mergedSeedZones.length !== existingSeedZones.length
  ) {
    bootstrapSeeds.inferred_structures = inferredMerged;
    bootstrapSeeds.zone_hints = mergedSeedZones;
    worldSeeds.bootstrap = bootstrapSeeds;
    worldSeedsRoot.seeds = worldSeeds;
    worldSeedsRoot.meta = {
      ...toObject(worldSeedsRoot.meta),
      schema_version: 1,
      last_updated: new Date().toISOString(),
    };
    worldSeedsChanged = true;
  }

  const relationshipsRoot = toObject(relationshipsLoaded.parsed);
  const relationshipsNode = toObject(relationshipsRoot.relationships);
  const existingEdges = Array.isArray(relationshipsNode.edges)
    ? relationshipsNode.edges
    : Array.isArray(relationshipsRoot.edges)
      ? relationshipsRoot.edges
      : [];
  const mergedEdges: Record<string, unknown>[] = [];
  const seenEdgeKeys = new Set<string>();
  for (const edge of existingEdges) {
    const edgeObj = toObject(edge);
    const key = relationshipKey(edgeObj);
    if (!key || seenEdgeKeys.has(key)) continue;
    seenEdgeKeys.add(key);
    mergedEdges.push(edgeObj);
  }
  const relationshipsChanged = mergedEdges.length !== existingEdges.length;
  if (relationshipsChanged) {
    relationshipsNode.edges = mergedEdges;
    relationshipsRoot.relationships = relationshipsNode;
    relationshipsRoot.meta = {
      ...toObject(relationshipsRoot.meta),
      schema_version: 1,
      last_updated: new Date().toISOString(),
    };
  }

  if (worldSeedsChanged || relationshipsChanged) {
    const ops: Array<Record<string, unknown>> = [];
    if (worldSeedsChanged) {
      ops.push({ op: "set", file: "state/world-seeds.yaml", pointer: "/", value: worldSeedsRoot });
    }
    if (relationshipsChanged) {
      ops.push({ op: "set", file: "state/relationships.yaml", pointer: "/", value: relationshipsRoot });
    }
    const persisted = await applyBootstrapAuditedPersistence({
      cfg: params.cfg,
      worldRoot: params.worldRoot,
      agentId: params.agentId,
      patchCache: params.patchCache,
      title: "bootstrap seed and relationship persistence",
      operations: ops,
    });
    if (!persisted.ok) {
      throw new Error(persisted.error || "bootstrap seed/relationship persistence failed");
    }
  }

  if (bootstrapComplete) {
    return {
      bootstrapComplete,
      justCompleted,
    };
  }

  const missingFields = collectMissingBootstrapFields(player);
  const contextLines: string[] = [
    "[TRPG_RUNTIME_CHARACTER_BOOTSTRAP]",
    "game_state.bootstrap_complete=false. Character bootstrap phase is mandatory.",
    "For this response, output order is mandatory:",
    "1) character creation 안내 한 줄",
    "2) PART A structured prompts (exact questions)",
    "3) PART B freeform prompt",
    "4) missing fields may remain open",
    "Do NOT output scene narration, clues, NPC posture, travel, or action resolution in this phase.",
    "Even if user says '게임 시작', remain in bootstrap question flow until bootstrap_complete=true.",
    "PART A structured prompts:",
    "1. 이름",
    "2. 출신 / 배경",
    "3. 지금 이 세계에 들어온 이유",
    "4. 숨기고 있는 비밀",
    "5. 두려워하는 것",
    "6. 지금 당장의 목표",
    "PART B freeform prompt:",
    "캐릭터의 성격, 과거 사건, 관계, 외형, 또는 세계와의 연결고리를 자유롭게 설명해도 된다.",
    "Partial answers are valid. Keep missing items open for later turns.",
  ];

  if (readString(player.name)) contextLines.push(`Known 이름: ${readString(player.name)}`);
  if (readString(player.background)) contextLines.push(`Known 출신 / 배경: ${readString(player.background)}`);
  if (readString(player.motive))
    contextLines.push(`Known 지금 이 세계에 들어온 이유: ${readString(player.motive)}`);
  if (readString(player.secret))
    contextLines.push(`Known 숨기고 있는 비밀: ${readString(player.secret)}`);
  if (readString(player.fear)) contextLines.push(`Known 두려워하는 것: ${readString(player.fear)}`);
  if (readString(player.goal)) contextLines.push(`Known 지금 당장의 목표: ${readString(player.goal)}`);

  if (missingFields.length > 0) {
    contextLines.push(`Still open: ${missingFields.join(", ")}`);
  }

  return {
    bootstrapComplete,
    justCompleted,
    contextChunk: joinLines(contextLines),
  };
}

function isAllowedRuntimeAgent(
  cfg: ReturnType<typeof parseTrpgRuntimeConfig>,
  agentId: string | undefined,
): boolean {
  const normalized = typeof agentId === "string" ? agentId.trim() : "";
  if (!normalized) {
    return false;
  }

  if (cfg.allowedAgentIds.length === 0) {
    return true;
  }

  return cfg.allowedAgentIds.includes(normalized);
}

function toolGate(params: {
  cfg: ReturnType<typeof parseTrpgRuntimeConfig>;
  ctx: OpenClawPluginToolContext;
  api: OpenClawPluginApi;
}): { ok: true; worldRoot: string; agentId: string } | { ok: false; payload: Record<string, unknown> } {
  const allowed = assertAgentAllowed(params.cfg, params.ctx);
  if (!allowed.ok) {
    return {
      ok: false,
      payload: { ok: false, error: allowed.error },
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
    agentId: params.ctx.agentId as string,
  };
}

const trpgRuntimePlugin = {
  id: "trpg-runtime-v2",
  name: "TRPG Runtime V2",
  description: "Structured world-store and patch tooling for dedicated TRPG sessions.",
  configSchema: trpgRuntimeConfigSchema,
  register(api: OpenClawPluginApi) {
    const cfg = parseTrpgRuntimeConfig(api.pluginConfig);
    const patchCache = createPatchCache();

    api.on("before_prompt_build", async (event, hookCtx) => {
      if (!isAllowedRuntimeAgent(cfg, hookCtx.agentId)) {
        return;
      }

      try {
        const worldRoot = resolveWorldRootForContext({
          cfg,
          ctx: hookCtx as OpenClawPluginToolContext,
          resolvePath: api.resolvePath,
        });

        const appendChunks: string[] = [];
        const promptMessages = Array.isArray(event.messages) ? event.messages : [];
        const extractedLatestAction =
          extractLatestUserMessageFromPrompt(event.prompt) || extractLatestUserMessage(promptMessages);
        const latestAction =
          extractedLatestAction ||
          sanitizeIntentText(typeof event.prompt === "string" ? event.prompt.slice(-900) : "", 320);

        const bootstrap = await runCharacterBootstrapGate({
          cfg,
          worldRoot,
          agentId: hookCtx.agentId as string,
          patchCache,
          messages: promptMessages,
          prompt: event.prompt,
        });

        if (bootstrap.contextChunk) {
          appendChunks.push(bootstrap.contextChunk);
        }

        if (!bootstrap.bootstrapComplete) {
          api.logger.info("[trpg-runtime] scene intro/travel/faction gated until character bootstrap completes");
          if (appendChunks.length === 0) {
            return;
          }
          const bootstrapBudgeted = applyPromptInjectionBudget({
            chunks: appendChunks,
            latestAction,
            bootstrapIncomplete: true,
          });
          if (bootstrapBudgeted.droppedTags.length > 0) {
            api.logger.info(
              "[trpg-runtime] injection budget dropped tags=" + bootstrapBudgeted.droppedTags.join(","),
            );
          }
          return {
            appendSystemContext: bootstrapBudgeted.selected.join(String.fromCharCode(10) + String.fromCharCode(10)),
          };
        }

        if (bootstrap.justCompleted) {
          appendChunks.push(
            [
              "[TRPG_RUNTIME_BOOTSTRAP_COMPLETED]",
              "Character bootstrap has just completed. Resume normal scene engine flow now.",
              "For this opening response, output order is mandatory:",
              "1) current location and situation",
              "2) visible clues",
              "3) environmental pressure",
              "4) nearby NPC posture",
              "5) freeform action invitation",
              "6) optional suggestions only after freeform invitation",
            ].join(String.fromCharCode(10)),
          );
        }

        const guard = await applySceneIntroGuard({ cfg, worldRoot });
        if (guard.introRequired) {
          const guidance = [
            "[TRPG_RUNTIME_INTRO_GUARD]",
            "scene.scene_flow.intro_shown was false for a major scene start.",
            "Runtime has now set scene.scene_flow.intro_shown=true and awaiting_player_action=true.",
            `Current scene id: ${guard.sceneId || "unknown-scene"}`,
            "If scene details are missing, use neutral wording and state that the current scene is unknown.",
            "For this response, output order is mandatory:",
            "1) current location and situation",
            "2) visible observations and clues",
            "3) environmental pressure",
            "4) nearby NPC posture",
            "5) freeform action invitation",
            "6) optional suggestions only after freeform invitation",
            "Never lead with bare choices or menu lists before step 4.",
            "If the player already supplied a concrete freeform action this turn, resolve it directly and skip suggestion lists.",
          ].join(String.fromCharCode(10));
          appendChunks.push(guidance);
          api.logger.info(
            "[trpg-runtime] intro guard applied for scene " + guard.sceneId + "; intro_shown toggled true",
          );
        }

        const sceneStateLoaded = await loadStructuredWorldFile(worldRoot, "state/current-scene.yaml", {
          allowMissing: true,
          maxReadBytes: cfg.maxReadBytes,
        });
        const sceneStateRoot = toObject(sceneStateLoaded.parsed);

        const persistenceState = applyScenePersistenceDefaults({
          sceneParsed: sceneStateRoot,
          latestAction,
        });
        if (persistenceState.changed) {
          const renderedSceneState = renderStructuredContent(sceneStateLoaded.format, sceneStateRoot);
          const sceneStateAbsolute = resolveWorldAbsolutePath(worldRoot, "state/current-scene.yaml");
          await fs.writeFile(sceneStateAbsolute, renderedSceneState, "utf8");
        }

        const scenePersistenceGuardChunk = buildScenePersistenceGuardChunk({
          sceneParsed: sceneStateRoot,
          latestAction,
          sceneFlow: persistenceState.sceneFlow,
          signals: persistenceState.signals,
        });
        if (scenePersistenceGuardChunk) {
          appendChunks.push(scenePersistenceGuardChunk);
        }

        const npcVisibilityGuardChunk = buildNpcVisibilityGuardChunk(sceneStateRoot);
        if (npcVisibilityGuardChunk) {
          appendChunks.push(npcVisibilityGuardChunk);
        }

        const economyContext = await applyLightweightEconomyUpdate({
          cfg,
          worldRoot,
          latestAction,
        });
        if (economyContext.contextChunk) {
          appendChunks.push(economyContext.contextChunk);
        }

        const statusPanelData = await loadStatusPanelData({
          cfg,
          worldRoot,
        });
        const statusPanelChunk = buildStatusPanelGuardChunk({
          status: statusPanelData,
          latestAction,
        });
        if (statusPanelChunk) {
          appendChunks.push(statusPanelChunk);
        }

        const actionFeasibilityGuardChunk = await buildActionFeasibilityGuardChunk({
          cfg,
          worldRoot,
          messages: promptMessages,
          prompt: event.prompt,
          sceneParsed: sceneStateRoot,
          statusPanelData,
        });
        if (actionFeasibilityGuardChunk) {
          appendChunks.push(actionFeasibilityGuardChunk);
        }

        const npcMemoryChunk = await updateAndBuildNpcMemoryChunk({
          cfg,
          worldRoot,
          sceneParsed: sceneStateRoot,
          latestAction,
        });
        if (npcMemoryChunk) {
          appendChunks.push(npcMemoryChunk);
        }

        const fastWaitContext = await applyFastWaitV1({
          cfg,
          worldRoot,
          latestAction,
          prompt: event.prompt,
        });
        if (fastWaitContext.contextChunk) {
          appendChunks.push(fastWaitContext.contextChunk);
        }

        appendChunks.push(
          [
            "[TRPG_RUNTIME_FREEFORM_RULE]",
            "Freeform-first remains mandatory.",
            "If the player already supplied a concrete action in the latest turn, resolve that action directly.",
            "Do not output forced option menus (A/B/C or numbered choices) in that case.",
            "When a concrete freeform action is already provided, do not append suggestion bullets or slash options.",
            "When the player intent is broad, provide one freeform invitation first and treat suggestions as optional examples only.",
            "Never require the player to pick from a list before they can act.",
            "Keep default response order: current location/situation -> visible observations -> environmental pressure -> nearby NPC posture -> freeform invitation -> optional suggestions.",
            "Use explicit section markers when possible (상황, 관찰, NPC, 자유행동, 선택 제안[선택]).",
            "If suggestions are present, label them as optional and keep them secondary.",
          ].join(String.fromCharCode(10)),
        );

        // Discord component usage guide — always injected
        appendChunks.push(COMPONENT_USAGE_GUIDE);

        const travelTransition = fastWaitContext.waitApplied
          ? {
              movementIntent: false,
              occurred: false,
              reason: "fast-wait intent handled without movement",
            }
          : await runTravelMovement({
              cfg,
              worldRoot,
              messages: promptMessages,
              prompt: event.prompt,
            });

        if (travelTransition.contextChunk) {
          appendChunks.push(travelTransition.contextChunk);
        }

        if (travelTransition.occurred) {
          api.logger.info("[trpg-runtime] travel transition applied reason=" + travelTransition.reason);
        }

        const transition = await detectSceneTransition({
          cfg,
          worldRoot,
          guard,
          travelTransition,
        });

        const lifecycleFallbackTrigger = detectLifecycleFallbackTrigger({
          fastWaitApplied: fastWaitContext.waitApplied,
          generatedZone: travelTransition.generatedZone === true,
          sceneTransition: transition.shouldTick,
          latestAction,
        });
        await runLifecyclePreviewIfNeeded({
          api,
          cfg,
          worldRoot,
          latestAction,
          trigger: lifecycleFallbackTrigger,
        });

        if (transition.shouldTick) {
          const factionTick = await runFactionEngineTick({
            worldRoot,
            cfg,
            input: {
              mode: "read-only",
              trigger: "scene_transition",
              maxEvents: 3,
              includeUndropped: false,
              prompt: event.prompt,
            },
          });
          appendChunks.push(formatFactionPromptSummary(factionTick));
          api.logger.info(
            "[trpg-runtime] faction tick preview trigger=scene_transition reason=" +
              transition.reason +
              " advanced=" +
              String(factionTick.tick.advanced) +
              " events=" +
              String(factionTick.generated_events.length),
          );
        } else {
          api.logger.info("[trpg-runtime] faction tick skipped reason=" + transition.reason);
        }

        if (appendChunks.length === 0) {
          return;
        }

        const budgeted = applyPromptInjectionBudget({
          chunks: appendChunks,
          latestAction,
          bootstrapIncomplete: false,
        });
        if (budgeted.droppedTags.length > 0) {
          api.logger.info(
            "[trpg-runtime] injection budget dropped tags=" + budgeted.droppedTags.join(","),
          );
        }

        return {
          appendSystemContext: budgeted.selected.join(String.fromCharCode(10) + String.fromCharCode(10)),
        };
      } catch (error) {
        api.logger.warn(
          `[trpg-runtime] prompt hook skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
    });

    api.registerTool(
      (ctx) => ({
        name: "trpg_store_get",
        description:
          "Read structured TRPG world data by entity id, path, or scope with explicit knowledge-view filtering.",
        parameters: STORE_GET_PARAMETERS,
        async execute(_toolCallId, params) {
          const gate = toolGate({ cfg, ctx, api });
          if (!gate.ok) {
            return jsonToolResult(gate.payload);
          }

          try {
            const payload = await runStoreGet({
              worldRoot: gate.worldRoot,
              cfg,
              input: params as StoreGetInput,
            });
            return jsonToolResult(payload);
          } catch (error) {
            return jsonToolResult({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
      { name: "trpg_store_get" },
    );

    api.registerTool(
      (ctx) => ({
        name: "trpg_patch_dry_run",
        description:
          "Validate a TRPG patch proposal without writing files and return conflicts plus normalized diff preview.",
        parameters: PATCH_DRY_RUN_PARAMETERS,
        async execute(_toolCallId, params) {
          const gate = toolGate({ cfg, ctx, api });
          if (!gate.ok) {
            return jsonToolResult(gate.payload);
          }

          const payload = await runPatchDryRun({
            worldRoot: gate.worldRoot,
            cfg,
            agentId: gate.agentId,
            cache: patchCache,
            input: params as PatchDryRunInput,
          });
          return jsonToolResult(payload);
        },
      }),
      { name: "trpg_patch_dry_run" },
    );

    api.registerTool(
      (ctx) => ({
        name: "trpg_faction_tick",
        description:
          "Advance or preview causality-first offscreen faction motion with drop/delay/silent emission summaries.",
        parameters: FACTION_TICK_PARAMETERS,
        async execute(_toolCallId, params) {
          const gate = toolGate({ cfg, ctx, api });
          if (!gate.ok) {
            return jsonToolResult(gate.payload);
          }

          try {
            const input = params as FactionTickInput;
            const tickResult = await runFactionEngineTick({
              worldRoot: gate.worldRoot,
              cfg,
              input,
            });

            if (tickResult.patch_draft && input.mode === "dry-run") {
              const dryRunResult = await runPatchDryRun({
                worldRoot: gate.worldRoot,
                cfg,
                agentId: gate.agentId,
                cache: patchCache,
                input: tickResult.patch_draft as PatchDryRunInput,
              });
              return jsonToolResult({
                ...tickResult,
                dry_run_result: dryRunResult,
              });
            }

            return jsonToolResult(tickResult);
          } catch (error) {
            return jsonToolResult({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
      { name: "trpg_faction_tick" },
    );

    api.registerTool(
      (ctx) => ({
        name: "trpg_patch_apply",
        description:
          "Apply a previously validated TRPG patch only with canon-auditor approval metadata and strict world-root write guards.",
        parameters: PATCH_APPLY_PARAMETERS,
        async execute(_toolCallId, params) {
          const gate = toolGate({ cfg, ctx, api });
          if (!gate.ok) {
            return jsonToolResult(gate.payload);
          }

          const payload = await runPatchApply({
            worldRoot: gate.worldRoot,
            cfg,
            agentId: gate.agentId,
            cache: patchCache,
            input: params as PatchApplyInput,
          });
          return jsonToolResult(payload);
        },
      }),
      { name: "trpg_patch_apply", optional: true },
    );

    api.registerTool(
      (ctx) => ({
        name: "trpg_state_compact",
        description:
          "Build lifecycle compaction patch drafts with weighted pruning candidates and optional audited apply.",
        parameters: STATE_COMPACT_PARAMETERS,
        async execute(_toolCallId, params) {
          const gate = toolGate({ cfg, ctx, api });
          if (!gate.ok) {
            return jsonToolResult(gate.payload);
          }

          try {
            const payload = await runStateCompactionTool({
              cfg,
              worldRoot: gate.worldRoot,
              agentId: gate.agentId,
              cache: patchCache,
              input: params as StateCompactInput,
            });
            return jsonToolResult(payload);
          } catch (error) {
            return jsonToolResult({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
      { name: "trpg_state_compact" },
    );

    api.registerTool(
      (ctx) => ({
        name: "trpg_hooks_query",
        description:
          "Return dormant hook and reveal candidates with prerequisite status and tension scoring.",
        parameters: HOOKS_QUERY_PARAMETERS,
        async execute(_toolCallId, params) {
          const gate = toolGate({ cfg, ctx, api });
          if (!gate.ok) {
            return jsonToolResult(gate.payload);
          }

          try {
            const payload = await runHooksQuery({
              worldRoot: gate.worldRoot,
              cfg,
              input: params as HooksQueryInput,
            });
            return jsonToolResult(payload);
          } catch (error) {
            return jsonToolResult({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
      { name: "trpg_hooks_query" },
    );

    api.registerTool(
      (ctx) => ({
        name: "trpg_dice_roll",
        description: "Return deterministic and traceable structured dice roll results.",
        parameters: DICE_ROLL_PARAMETERS,
        async execute(_toolCallId, params) {
          const gate = toolGate({ cfg, ctx, api });
          if (!gate.ok) {
            return jsonToolResult(gate.payload);
          }

          try {
            const payload = runDiceRoll({
              input: params as DiceRollInput,
              agentId: gate.agentId,
              sessionId: ctx.sessionId,
            });
            return jsonToolResult(payload);
          } catch (error) {
            return jsonToolResult({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
      { name: "trpg_dice_roll" },
    );

    // ── Discord component builder tool ──
    const SCENE_COMPONENT_PARAMETERS = {
      type: "object",
      additionalProperties: false,
      properties: {
        scene: {
          type: "string",
          enum: ["exploration", "npc_encounter", "combat", "choice", "dialogue"],
          description: "Scene type determines template",
        },
        description: {
          type: "string",
          description: "Scene description text (Discord markdown supported)",
        },
        locationInfo: {
          type: "string",
          description: "Optional location/status line",
        },
        npc: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            title: { type: "string" },
            dialogue: { type: "string" },
            disposition: { type: "string" },
            status: { type: "string" },
            color: { type: "string" },
            action: { type: "string" },
            oldDisposition: { type: "string" },
            newDisposition: { type: "string" },
          },
          required: ["name", "title"],
        },
        combat: {
          type: "object",
          additionalProperties: false,
          properties: {
            round: { type: "integer" },
            hpCurrent: { type: "integer" },
            hpMax: { type: "integer" },
            ac: { type: "integer" },
            acBuff: { type: "string" },
            manaCurrent: { type: "integer" },
            manaMax: { type: "integer" },
            enemySummary: { type: "string" },
            effects: { type: "string" },
          },
          required: ["round", "hpCurrent", "hpMax", "ac", "manaCurrent", "manaMax", "enemySummary"],
        },
        buttons: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              label: { type: "string" },
              style: { type: "string", enum: ["primary", "secondary", "success", "danger"] },
            },
            required: ["label", "style"],
          },
          description: "Override default buttons for this scene type",
        },
        choices: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              label: { type: "string" },
              description: { type: "string" },
              value: { type: "string" },
              emoji: { type: "string" },
            },
            required: ["label", "value"],
          },
          description: "Select menu choices (required for choice scene)",
        },
        modalTitle: {
          type: "string",
          description: "Override modal dialog title",
        },
        includeInput: {
          type: "boolean",
          description: "Include freeform input modal (default: true)",
        },
      },
      required: ["scene", "description"],
    } as const;

    api.registerTool(
      (ctx) => ({
        name: "trpg_scene_components",
        description:
          "Build a Discord component payload for a TRPG scene response. Returns JSON components to pass to the message tool. " +
          "Always use this for scene responses instead of plain text. " +
          "Scene types: exploration, npc_encounter, combat, choice, dialogue.",
        parameters: SCENE_COMPONENT_PARAMETERS,
        async execute(_toolCallId, params) {
          const gate = toolGate({ cfg, ctx, api });
          if (!gate.ok) {
            return jsonToolResult(gate.payload);
          }

          try {
            const components = buildSceneComponents(params as SceneComponentInput);
            return jsonToolResult({
              ok: true,
              components,
              instructions:
                "Pass this 'components' object to the message tool: message(action='send', message='scene update', components=<this.components>)",
            });
          } catch (error) {
            return jsonToolResult({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
      { name: "trpg_scene_components" },
    );

    api.logger.info(
      "[trpg-runtime] registered tools: trpg_store_get, trpg_patch_dry_run, trpg_patch_apply, trpg_state_compact, trpg_faction_tick, trpg_hooks_query, trpg_dice_roll, trpg_scene_components",
    );
  },
};

export default trpgRuntimePlugin;
