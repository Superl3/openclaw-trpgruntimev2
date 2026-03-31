import { updateAndBuildNpcMemoryChunk as updateAndBuildNpcMemoryChunkBase, isNpcMemoryRelevantAction as isNpcMemoryRelevantActionBase } from "./npc-memory-chunk-helpers.js";
import { buildNpcVisibilityGuardChunk as buildNpcVisibilityGuardChunkBase, collectSceneNpcVisibility as collectSceneNpcVisibilityBase, redactHiddenNpcNames as redactHiddenNpcNamesBase, type SceneNpcVisibility } from "./npc-visibility-helpers.js";
import { buildScenePersistenceGuardChunk as buildScenePersistenceGuardChunkBase, applyScenePersistenceDefaults as applyScenePersistenceDefaultsBase } from "./scene-persistence-helpers.js";
import {
  clipForGuard,
  joinLines,
  readString,
  sanitizeIntentText,
  toObject,
  toStringArray,
} from "./runtime-guard-utils.js";
import type { TrpgRuntimeConfig } from "../../config.js";

export function collectSceneNpcVisibility(parsed: unknown): SceneNpcVisibility[] {
  return collectSceneNpcVisibilityBase(parsed, {
    toObject,
    readString,
    joinLines,
  });
}

export function redactHiddenNpcNames(value: string, npcVisibility: SceneNpcVisibility[]): string {
  return redactHiddenNpcNamesBase(value, npcVisibility);
}

export function buildNpcVisibilityGuardChunk(parsed: unknown): string {
  return buildNpcVisibilityGuardChunkBase(parsed, {
    toObject,
    readString,
    joinLines,
  });
}

export function isNpcMemoryRelevantAction(message: string): boolean {
  return isNpcMemoryRelevantActionBase(message);
}

export async function updateAndBuildNpcMemoryChunk(params: {
  cfg: TrpgRuntimeConfig;
  worldRoot: string;
  sceneParsed: unknown;
  latestAction: string;
}): Promise<string> {
  return updateAndBuildNpcMemoryChunkBase(params, {
    toObject,
    readString,
    toStringArray,
    sanitizeIntentText,
    clipForGuard,
    joinLines,
    collectSceneNpcVisibility,
  });
}

export function applyScenePersistenceDefaults(params: {
  sceneParsed: unknown;
  latestAction: string;
}) {
  return applyScenePersistenceDefaultsBase(params, {
    toObject,
    readString,
  });
}

export function buildScenePersistenceGuardChunk(params: {
  sceneParsed: unknown;
  latestAction: string;
  sceneFlow: Record<string, unknown>;
  signals: Parameters<typeof buildScenePersistenceGuardChunkBase>[0]["signals"];
}): string {
  return buildScenePersistenceGuardChunkBase(params, {
    toObject,
    readString,
    clipForGuard,
    joinLines,
  });
}
