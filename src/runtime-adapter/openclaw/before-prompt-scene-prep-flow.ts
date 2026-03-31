import fs from "node:fs/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { TrpgRuntimeConfig } from "../../config.js";
import {
  loadStructuredWorldFile,
  renderStructuredContent,
  resolveWorldAbsolutePath,
} from "../../world-store.js";
import { buildIntroGuardGuidanceChunk } from "./before-prompt-guard-chunks.js";
import type {
  FastWaitContext,
  RegisterBeforePromptBuildHookDeps,
  SceneIntroGuardResult,
} from "./before-prompt-types.js";

type RunBeforePromptScenePrepFlowParams = {
  api: OpenClawPluginApi;
  cfg: TrpgRuntimeConfig;
  worldRoot: string;
  prompt: string;
  promptMessages: unknown[];
  latestAction: string;
  deps: RegisterBeforePromptBuildHookDeps;
  appendChunks: string[];
};

export async function runBeforePromptScenePrepFlow(
  params: RunBeforePromptScenePrepFlowParams,
): Promise<{ guard: SceneIntroGuardResult; fastWaitContext: FastWaitContext }> {
  const { api, cfg, worldRoot, prompt, promptMessages, latestAction, deps, appendChunks } = params;

  const guard = await deps.applySceneIntroGuard({ cfg, worldRoot });
  if (guard.introRequired) {
    const guidance = buildIntroGuardGuidanceChunk(guard.sceneId);
    appendChunks.push(guidance);
    api.logger.info(
      "[trpg-runtime] intro guard applied for scene " + guard.sceneId + "; intro_shown toggled true",
    );
  }

  const sceneStateLoaded = await loadStructuredWorldFile(worldRoot, "state/current-scene.yaml", {
    allowMissing: true,
    maxReadBytes: cfg.maxReadBytes,
  });
  const sceneStateRoot = deps.toObject(sceneStateLoaded.parsed);

  const statusPanelData = await deps.loadStatusPanelData({
    cfg,
    worldRoot,
  });
  const statusPanelChunk = deps.buildStatusPanelGuardChunk({
    status: statusPanelData,
    latestAction,
  });
  if (statusPanelChunk) {
    appendChunks.push(statusPanelChunk);
  }

  const actionFeasibilityGuardChunk = await deps.buildActionFeasibilityGuardChunk({
    cfg,
    worldRoot,
    messages: promptMessages,
    prompt,
    sceneParsed: sceneStateRoot,
    statusPanelData,
  });
  if (actionFeasibilityGuardChunk) {
    appendChunks.push(actionFeasibilityGuardChunk);
  }

  const persistenceState = deps.applyScenePersistenceDefaults({
    sceneParsed: sceneStateRoot,
    latestAction,
  });
  if (persistenceState.changed) {
    const renderedSceneState = renderStructuredContent(sceneStateLoaded.format, sceneStateRoot);
    const sceneStateAbsolute = resolveWorldAbsolutePath(worldRoot, "state/current-scene.yaml");
    await fs.writeFile(sceneStateAbsolute, renderedSceneState, "utf8");
  }

  const scenePersistenceGuardChunk = deps.buildScenePersistenceGuardChunk({
    sceneParsed: sceneStateRoot,
    latestAction,
    sceneFlow: persistenceState.sceneFlow,
    signals: persistenceState.signals,
  });
  if (scenePersistenceGuardChunk) {
    appendChunks.push(scenePersistenceGuardChunk);
  }

  const npcVisibilityGuardChunk = deps.buildNpcVisibilityGuardChunk(sceneStateRoot);
  if (npcVisibilityGuardChunk) {
    appendChunks.push(npcVisibilityGuardChunk);
  }

  const economyContext = await deps.applyLightweightEconomyUpdate({
    cfg,
    worldRoot,
    latestAction,
  });
  if (economyContext.contextChunk) {
    appendChunks.push(economyContext.contextChunk);
  }

  const npcMemoryChunk = await deps.updateAndBuildNpcMemoryChunk({
    cfg,
    worldRoot,
    sceneParsed: sceneStateRoot,
    latestAction,
  });
  if (npcMemoryChunk) {
    appendChunks.push(npcMemoryChunk);
  }

  const fastWaitContext = await deps.applyFastWaitV1({
    cfg,
    worldRoot,
    latestAction,
    prompt,
  });
  if (fastWaitContext.contextChunk) {
    appendChunks.push(fastWaitContext.contextChunk);
  }

  return {
    guard,
    fastWaitContext,
  };
}
