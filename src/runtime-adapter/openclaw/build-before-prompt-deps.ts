import { resolveWorldRootForContext } from "../../config.js";
import { isAllowedRuntimeAgent } from "./allowed-runtime-agent.js";
import {
  extractLatestUserMessage,
  extractLatestUserMessageFromPrompt,
} from "./latest-user-message-helpers.js";
import type { RegisterBeforePromptBuildHookDeps } from "./before-prompt-types.js";
import {
  sanitizeIntentText,
  toObject,
} from "./runtime-guard-utils.js";
import {
  applySceneIntroGuard,
  detectSceneTransition,
  runCharacterBootstrapGate,
  runTravelMovement,
} from "./before-prompt-core-support.js";
import {
  applyFastWaitV1,
  applyLightweightEconomyUpdate,
  applyScenePersistenceDefaults,
  buildActionFeasibilityGuardChunk,
  buildNpcVisibilityGuardChunk,
  buildScenePersistenceGuardChunk,
  buildStatusPanelGuardChunk,
  isNpcMemoryRelevantAction,
  loadStatusPanelData,
  updateAndBuildNpcMemoryChunk,
} from "./before-prompt-deps-support.js";

type BeforePromptDeps = RegisterBeforePromptBuildHookDeps;

export function buildBeforePromptDeps(): BeforePromptDeps {
  return {
    isAllowedRuntimeAgent,
    resolveWorldRootForContext,
    extractLatestUserMessageFromPrompt,
    extractLatestUserMessage,
    sanitizeIntentText,
    runCharacterBootstrapGate,
    applySceneIntroGuard,
    toObject,
    loadStatusPanelData,
    buildStatusPanelGuardChunk,
    buildActionFeasibilityGuardChunk,
    applyScenePersistenceDefaults,
    buildScenePersistenceGuardChunk,
    buildNpcVisibilityGuardChunk,
    applyLightweightEconomyUpdate,
    updateAndBuildNpcMemoryChunk,
    applyFastWaitV1,
    runTravelMovement,
    detectSceneTransition,
    isNpcMemoryRelevantAction,
  };
}
