import { joinLines } from "./runtime-guard-utils.js";

export function buildBootstrapCompletedChunk(): string {
  return joinLines([
    "[TRPG_RUNTIME_BOOTSTRAP_COMPLETED]",
    "Character bootstrap has just completed. Resume normal scene engine flow now.",
    "Canon/state sync for player bootstrap has already been applied before response rendering.",
    "For this opening response, output order is mandatory:",
    "1) current location and situation",
    "2) visible clues",
    "3) environmental pressure",
    "4) nearby NPC posture",
    "5) freeform action invitation",
    "6) optional suggestions only after freeform invitation",
  ]);
}

export function buildTurnPipelineChunk(): string {
  return joinLines([
    "[TRPG_RUNTIME_TURN_PIPELINE]",
    "Enforce this order for every scene-turn response:",
    "1) authoritative state read",
    "2) classify latest input",
    "3) adjudicate feasibility",
    "4) apply state patch",
    "5) render response/components",
    "6) send",
    "Never describe post-patch state that has not been written yet.",
    "Status panel facts must follow state/player-status as the primary source.",
  ]);
}

export function buildIntroGuardGuidanceChunk(sceneId: string): string {
  return joinLines([
    "[TRPG_RUNTIME_INTRO_GUARD]",
    "scene.scene_flow.intro_shown was false for a major scene start.",
    "Runtime has now set scene.scene_flow.intro_shown=true and awaiting_player_action=true.",
    `Current scene id: ${sceneId || "unknown-scene"}`,
    "If scene details are missing, use neutral wording and state that the current scene is unknown.",
    "For this response, output order is mandatory:",
    "1) current location and situation",
    "2) visible observations and clues",
    "3) environmental pressure",
    "4) nearby NPC posture",
    "5) freeform action invitation",
    "6) optional suggestions only after freeform invitation",
    "Never lead with bare choices or menu lists before step 4.",
    "If the player already supplied a concrete freeform action this turn, resolve it directly and skip suggestion lists.",
  ]);
}

export function buildFreeformRuleChunk(): string {
  return joinLines([
    "[TRPG_RUNTIME_FREEFORM_RULE]",
    "Freeform-first remains mandatory.",
    "If the player already supplied a concrete action in the latest turn, resolve that action directly.",
    "Do not output forced option menus (A/B/C or numbered choices) in that case.",
    "When a concrete freeform action is already provided, do not append suggestion bullets or slash options.",
    "When the player intent is broad, provide one freeform invitation first and treat suggestions as optional examples only.",
    "Never require the player to pick from a list before they can act.",
    "Keep default response order: current location/situation -> visible observations -> environmental pressure -> nearby NPC posture -> freeform invitation -> optional suggestions.",
    "Use explicit section markers when possible (상황, 관찰, NPC, 자유행동, 선택 제안[선택]).",
    "If suggestions are present, label them as optional and keep them secondary.",
  ]);
}
