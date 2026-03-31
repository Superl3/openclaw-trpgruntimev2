import {
  classifyTurnKind,
  detectRuntimePhase,
  normalizeSceneComponentInputByPhase as normalizeSceneComponentInputByPhaseBase,
} from "./scene-component-phase-helpers.js";
import { readString } from "./runtime-guard-utils.js";
import { sanitizeLegacyBootstrapTemplateText } from "./bootstrap-text-helpers.js";
import type { RuntimePhase, SceneComponentInput } from "../../discord-components.js";
import { registerSceneComponentsTool } from "./register-scene-components-tool.js";
import { buildBeforePromptDeps } from "./build-before-prompt-deps.js";

type SceneComponentsDeps = Pick<
  Parameters<typeof registerSceneComponentsTool>[0],
  "detectRuntimePhase" | "normalizeSceneComponentInputByPhase" | "classifyTurnKind" | "readString"
>;

export function buildRuntimeRegistrationDeps(): {
  beforePromptDeps: ReturnType<typeof buildBeforePromptDeps>;
  sceneComponentsDeps: SceneComponentsDeps;
} {
  const sceneComponentsDeps: SceneComponentsDeps = {
    detectRuntimePhase,
    normalizeSceneComponentInputByPhase: (input: SceneComponentInput, runtimePhase: RuntimePhase) =>
      normalizeSceneComponentInputByPhaseBase(
        input,
        runtimePhase,
        sanitizeLegacyBootstrapTemplateText,
      ),
    classifyTurnKind,
    readString,
  };

  return {
    beforePromptDeps: buildBeforePromptDeps(),
    sceneComponentsDeps,
  };
}
