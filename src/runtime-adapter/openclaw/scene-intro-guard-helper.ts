import fs from "node:fs/promises";
import type { TrpgRuntimeConfig } from "../../config.js";
import {
  loadStructuredWorldFile,
  renderStructuredContent,
  resolveWorldAbsolutePath,
} from "../../world-store.js";

type SceneIntroGuardHelperDeps = {
  toObject: (value: unknown) => Record<string, unknown>;
  readString: (value: unknown) => string;
};

function readSceneId(scene: Record<string, unknown>, readString: (value: unknown) => string): string {
  return readString(scene.scene_id) || readString(scene.id) || "unknown-scene";
}

export async function applySceneIntroGuard(
  params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
  },
  deps: SceneIntroGuardHelperDeps,
): Promise<{ introRequired: boolean; sceneId: string; majorSceneStart: boolean }> {
  const loaded = await loadStructuredWorldFile(params.worldRoot, "state/current-scene.yaml", {
    allowMissing: true,
    maxReadBytes: params.cfg.maxReadBytes,
  });

  const root = deps.toObject(loaded.parsed);
  const scene = deps.toObject(root.scene);
  const sceneFlow = deps.toObject(scene.scene_flow);

  const majorSceneStart = scene.major_scene_start === true;
  const introShown = sceneFlow.intro_shown === true;
  const sceneId = readSceneId(scene, deps.readString);

  if (!majorSceneStart || introShown) {
    return {
      introRequired: false,
      sceneId,
      majorSceneStart,
    };
  }

  sceneFlow.intro_shown = true;
  sceneFlow.awaiting_player_action = true;
  scene.scene_flow = sceneFlow;
  root.scene = scene;

  const absolute = resolveWorldAbsolutePath(params.worldRoot, "state/current-scene.yaml");
  const rendered = renderStructuredContent(loaded.format, root);
  await fs.writeFile(absolute, rendered, "utf8");

  return {
    introRequired: true,
    sceneId,
    majorSceneStart,
  };
}
