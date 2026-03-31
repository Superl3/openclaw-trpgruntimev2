import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { TrpgRuntimeConfig } from "../../config.js";
import { formatFactionPromptSummary, runFactionEngineTick } from "../../faction-engine.js";
import { COMPONENT_USAGE_GUIDE } from "../../discord-components.js";
import {
  detectLifecycleFallbackTrigger,
  runLifecyclePreviewIfNeeded,
} from "./lifecycle-fallback-helpers.js";
import { buildFreeformRuleChunk } from "./before-prompt-guard-chunks.js";
import type {
  FastWaitContext,
  RegisterBeforePromptBuildHookDeps,
  SceneIntroGuardResult,
} from "./before-prompt-types.js";

type RunBeforePromptTravelFactionFlowParams = {
  api: OpenClawPluginApi;
  cfg: TrpgRuntimeConfig;
  worldRoot: string;
  latestAction: string;
  prompt: string;
  promptMessages: unknown[];
  guard: SceneIntroGuardResult;
  fastWaitContext: FastWaitContext;
  deps: RegisterBeforePromptBuildHookDeps;
  appendChunks: string[];
};

export async function runBeforePromptTravelFactionFlow(
  params: RunBeforePromptTravelFactionFlowParams,
): Promise<void> {
  const { api, cfg, worldRoot, latestAction, prompt, promptMessages, guard, fastWaitContext, deps, appendChunks } =
    params;

  appendChunks.push(buildFreeformRuleChunk());

  // Discord component usage guide — always injected
  appendChunks.push(COMPONENT_USAGE_GUIDE);

  const travelTransition = fastWaitContext.waitApplied
    ? {
        movementIntent: false,
        occurred: false,
        reason: "fast-wait intent handled without movement",
      }
    : await deps.runTravelMovement({
        cfg,
        worldRoot,
        messages: promptMessages,
        prompt,
      });

  if (travelTransition.contextChunk) {
    appendChunks.push(travelTransition.contextChunk);
  }

  if (travelTransition.occurred) {
    api.logger.info("[trpg-runtime] travel transition applied reason=" + travelTransition.reason);
  }

  const transition = await deps.detectSceneTransition({
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
        prompt,
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
}
