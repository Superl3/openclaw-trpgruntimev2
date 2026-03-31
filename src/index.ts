import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  parseTrpgRuntimeConfig,
  trpgRuntimeConfigSchema,
} from "./config.js";
import {
  createPatchCache,
} from "./patch-engine.js";
import { extractBootstrapFreeform } from "./runtime-adapter/openclaw/bootstrap-text-helpers.js";
import {
  extractLatestUserMessageFromPrompt,
} from "./runtime-adapter/openclaw/latest-user-message-helpers.js";
import {
  classifyTurnKind,
} from "./runtime-adapter/openclaw/scene-component-phase-helpers.js";
import { registerRuntimePlugin } from "./runtime-adapter/openclaw/register-runtime-plugin.js";
import { buildRuntimeRegistrationDeps } from "./runtime-adapter/openclaw/build-runtime-registration-deps.js";

const trpgRuntimePlugin = {
  id: "trpg-runtime-v2",
  name: "TRPG Runtime V2",
  description: "Structured world-store and patch tooling for dedicated TRPG sessions.",
  configSchema: trpgRuntimeConfigSchema,
  register(api: OpenClawPluginApi) {
    const cfg = parseTrpgRuntimeConfig(api.pluginConfig);
    const patchCache = createPatchCache();
    const { beforePromptDeps, sceneComponentsDeps } = buildRuntimeRegistrationDeps();

    registerRuntimePlugin({
      api,
      cfg,
      patchCache,
      beforePromptDeps,
      sceneComponentsDeps,
    });
  },
};

export const __internalTestHooks = {
  extractLatestUserMessageFromPrompt,
  extractBootstrapFreeform,
  classifyTurnKind,
};

export default trpgRuntimePlugin;
