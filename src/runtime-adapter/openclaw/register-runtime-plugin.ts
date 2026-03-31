import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { TrpgRuntimeConfig } from "../../config.js";
import type { PatchCache } from "../../patch-engine.js";
import type { RegisterBeforePromptBuildHookDeps } from "./before-prompt-types.js";
import { registerBeforePromptBuildHook } from "./register-before-prompt-build-hook.js";
import { registerCoreRuntimeTools } from "./register-core-runtime-tools.js";
import { registerSceneComponentsTool } from "./register-scene-components-tool.js";
import { jsonToolResult, toolGate } from "./tool-gate.js";

type RegisterRuntimePluginParams = {
  api: OpenClawPluginApi;
  cfg: TrpgRuntimeConfig;
  patchCache: PatchCache;
  beforePromptDeps: RegisterBeforePromptBuildHookDeps;
  sceneComponentsDeps: Pick<
    Parameters<typeof registerSceneComponentsTool>[0],
    "detectRuntimePhase" | "normalizeSceneComponentInputByPhase" | "classifyTurnKind" | "readString"
  >;
};

export function registerRuntimePlugin(params: RegisterRuntimePluginParams): void {
  const { api, cfg, patchCache, beforePromptDeps, sceneComponentsDeps } = params;

  registerBeforePromptBuildHook({
    api,
    cfg,
    patchCache,
    deps: beforePromptDeps,
  });

  registerCoreRuntimeTools({
    api,
    cfg,
    patchCache,
    toolGate,
    jsonToolResult,
  });

  registerSceneComponentsTool({
    api,
    cfg,
    toolGate,
    jsonToolResult,
    ...sceneComponentsDeps,
  });

  api.logger.info(
    "[trpg-runtime] registered tools: trpg_store_get, trpg_patch_dry_run, trpg_patch_apply, trpg_state_compact, trpg_faction_tick, trpg_hooks_query, trpg_dice_roll, trpg_scene_components",
  );
}
