import type { TrpgRuntimeConfig } from "../../config.js";
import { loadStructuredWorldFile } from "../../world-store.js";

type SceneTransitionHelperDeps = {
  toObject: (value: unknown) => Record<string, unknown>;
  readString: (value: unknown) => string;
};

type SceneIntroGuardState = {
  introRequired: boolean;
  sceneId: string;
  majorSceneStart: boolean;
};

type TravelTransitionState = {
  occurred: boolean;
  reason: string;
};

function parseSceneIdFromTick(lastAdvancedTick: string): string {
  const marker = ":scene-";
  const markerIndex = lastAdvancedTick.indexOf(marker);
  if (markerIndex < 0) {
    return "";
  }

  const afterMarker = lastAdvancedTick.slice(markerIndex + marker.length);
  const nextDelimiter = afterMarker.indexOf(":");
  return (nextDelimiter >= 0 ? afterMarker.slice(0, nextDelimiter) : afterMarker).trim();
}

export async function detectSceneTransition(
  params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
    guard: SceneIntroGuardState;
    travelTransition?: TravelTransitionState;
  },
  deps: SceneTransitionHelperDeps,
): Promise<{ shouldTick: boolean; reason: string }> {
  if (params.guard.introRequired) {
    return {
      shouldTick: true,
      reason: "intro guard major scene start",
    };
  }

  if (params.travelTransition?.occurred) {
    return {
      shouldTick: true,
      reason: params.travelTransition.reason,
    };
  }

  const loaded = await loadStructuredWorldFile(params.worldRoot, "state/world-pressure.yaml", {
    allowMissing: true,
    maxReadBytes: params.cfg.maxReadBytes,
  });
  const pressureRoot = deps.toObject(loaded.parsed);
  const engineState = deps.toObject(pressureRoot.engine_state);

  const persistedSceneId =
    deps.readString(engineState.last_scene_id) ||
    deps.readString(engineState.last_scene) ||
    parseSceneIdFromTick(deps.readString(engineState.last_advanced_tick));

  if (persistedSceneId && persistedSceneId !== params.guard.sceneId) {
    return {
      shouldTick: true,
      reason: "scene_id changed (" + persistedSceneId + " -> " + params.guard.sceneId + ")",
    };
  }

  return {
    shouldTick: false,
    reason: "scene unchanged",
  };
}
