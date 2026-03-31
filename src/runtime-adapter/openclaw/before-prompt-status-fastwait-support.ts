import type { TrpgRuntimeConfig } from "../../config.js";
import { applyFastWaitWorldDrift as applyFastWaitWorldDriftBase } from "./apply-fast-wait-world-drift.js";
import { applyFastWaitV1 as applyFastWaitV1Base } from "./apply-fast-wait-v1.js";
import { applyLightweightEconomyUpdate as applyLightweightEconomyUpdateBase } from "./apply-lightweight-economy-update.js";
import { buildActionFeasibilityGuardChunk as buildActionFeasibilityGuardChunkBase } from "./build-action-feasibility-guard-chunk.js";
import { buildStatusPanelGuardChunk as buildStatusPanelGuardChunkBase } from "./build-status-panel-guard-chunk.js";
import { isFastWaitIntent, parseFastWaitDurationLabel } from "./fast-wait-intent-helpers.js";
import { extractLatestUserMessage, extractLatestUserMessageFromPrompt } from "./latest-user-message-helpers.js";
import { loadStatusPanelData as loadStatusPanelDataBase } from "./load-status-panel-data.js";
import { collectSceneNpcVisibility, redactHiddenNpcNames } from "./before-prompt-npc-scene-support.js";
import {
  clipForGuard,
  joinLines,
  readFiniteNumber,
  readString,
  sanitizeIntentText,
  toObject,
  toStringArray,
  uniqStrings,
} from "./runtime-guard-utils.js";

export async function loadStatusPanelData(params: {
  cfg: TrpgRuntimeConfig;
  worldRoot: string;
}) {
  return loadStatusPanelDataBase(params, {
    toObject,
    readString,
    readFiniteNumber,
    toStringArray,
    uniqStrings,
  });
}

export function buildStatusPanelGuardChunk(params: {
  status: Awaited<ReturnType<typeof loadStatusPanelData>>;
  latestAction: string;
}): string {
  return buildStatusPanelGuardChunkBase(params, {
    joinLines,
  });
}

export async function applyLightweightEconomyUpdate(params: {
  cfg: TrpgRuntimeConfig;
  worldRoot: string;
  latestAction: string;
}): Promise<{ contextChunk?: string }> {
  return applyLightweightEconomyUpdateBase(params, {
    toObject,
    readString,
    readFiniteNumber,
    uniqStrings,
    toStringArray,
    joinLines,
  });
}

export async function applyFastWaitWorldDrift(params: {
  cfg: TrpgRuntimeConfig;
  worldRoot: string;
  waitCount: number;
}): Promise<string[]> {
  return applyFastWaitWorldDriftBase(params, {
    toObject,
    readString,
    readFiniteNumber,
    toStringArray,
    uniqStrings,
  });
}

export async function applyFastWaitV1(params: {
  cfg: TrpgRuntimeConfig;
  worldRoot: string;
  latestAction: string;
  prompt: string;
}) {
  return applyFastWaitV1Base(params, {
    toObject,
    readFiniteNumber,
    sanitizeIntentText,
    joinLines,
    isFastWaitIntent,
    parseFastWaitDurationLabel,
    applyFastWaitWorldDrift,
  });
}

export async function buildActionFeasibilityGuardChunk(params: {
  cfg: TrpgRuntimeConfig;
  worldRoot: string;
  messages: unknown[];
  prompt: string;
  sceneParsed?: unknown;
  statusPanelData?: Awaited<ReturnType<typeof loadStatusPanelData>>;
}): Promise<string> {
  return buildActionFeasibilityGuardChunkBase(params, {
    extractLatestUserMessageFromPrompt,
    extractLatestUserMessage,
    toObject,
    readString,
    collectSceneNpcVisibility,
    redactHiddenNpcNames,
    loadStatusPanelData,
    clipForGuard,
    joinLines,
    uniqStrings,
  });
}
