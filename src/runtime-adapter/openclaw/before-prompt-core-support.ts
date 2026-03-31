import { runCharacterBootstrapGate as runCharacterBootstrapGateBase } from "./run-character-bootstrap-gate.js";
import { runTravelMovement as runTravelMovementBase } from "./run-travel-movement.js";
import { applySceneIntroGuard as applySceneIntroGuardBase } from "./scene-intro-guard-helper.js";
import { detectSceneTransition as detectSceneTransitionBase } from "./scene-transition-helpers.js";
import {
  extractLatestUserMessage,
  extractLatestUserMessageFromPrompt,
} from "./latest-user-message-helpers.js";
import {
  clipForGuard,
  joinLines,
  readString,
  sanitizeIntentText,
  toObject,
  uniqStrings,
} from "./runtime-guard-utils.js";

export async function runCharacterBootstrapGate(params: Parameters<typeof runCharacterBootstrapGateBase>[0]) {
  return runCharacterBootstrapGateBase(params, {
    toObject,
    readString,
    joinLines,
    extractLatestUserMessageFromPrompt,
    extractLatestUserMessage,
  });
}

export async function applySceneIntroGuard(params: Parameters<typeof applySceneIntroGuardBase>[0]) {
  return applySceneIntroGuardBase(params, {
    toObject,
    readString,
  });
}

export async function runTravelMovement(params: Parameters<typeof runTravelMovementBase>[0]) {
  return runTravelMovementBase(params, {
    toObject,
    readString,
    sanitizeIntentText,
    clipForGuard,
    uniqStrings,
    joinLines,
    extractLatestUserMessageFromPrompt,
    extractLatestUserMessage,
  });
}

export async function detectSceneTransition(params: Parameters<typeof detectSceneTransitionBase>[0]) {
  return detectSceneTransitionBase(params, {
    toObject,
    readString,
  });
}
