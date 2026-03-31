import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { TrpgRuntimeConfig } from "../../config.js";
import { buildBootstrapCompletedChunk, buildTurnPipelineChunk } from "./before-prompt-guard-chunks.js";
import { runBeforePromptScenePrepFlow } from "./before-prompt-scene-prep-flow.js";
import { runBeforePromptTravelFactionFlow } from "./before-prompt-travel-faction-flow.js";
import type { RegisterBeforePromptBuildHookDeps } from "./before-prompt-types.js";

type RunInGameBeforePromptFlowParams = {
  api: OpenClawPluginApi;
  cfg: TrpgRuntimeConfig;
  worldRoot: string;
  prompt: string;
  promptMessages: unknown[];
  latestAction: string;
  bootstrapJustCompleted: boolean;
  deps: RegisterBeforePromptBuildHookDeps;
  appendChunks: string[];
};

export async function runInGameBeforePromptFlow(params: RunInGameBeforePromptFlowParams): Promise<void> {
  const { api, cfg, worldRoot, prompt, promptMessages, latestAction, bootstrapJustCompleted, deps, appendChunks } =
    params;

  if (bootstrapJustCompleted) {
    appendChunks.push(buildBootstrapCompletedChunk());
  }

  appendChunks.push(buildTurnPipelineChunk());

  const { guard, fastWaitContext } = await runBeforePromptScenePrepFlow({
    api,
    cfg,
    worldRoot,
    prompt,
    promptMessages,
    latestAction,
    deps,
    appendChunks,
  });

  await runBeforePromptTravelFactionFlow({
    api,
    cfg,
    worldRoot,
    latestAction,
    prompt,
    promptMessages,
    guard,
    fastWaitContext,
    deps,
    appendChunks,
  });
}
