import type { TrpgRuntimeConfig } from "../../config.js";
import { type RuntimePhase, type SceneComponentInput } from "../../discord-components.js";
import { emitRuntimeDiagnostic } from "../../runtime-core/runtime-diagnostics.js";
import { loadStructuredWorldFile } from "../../world-store.js";

function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function detectRuntimePhase(params: {
  cfg: TrpgRuntimeConfig;
  worldRoot: string;
  sessionId?: string;
}): Promise<RuntimePhase> {
  const [playerLoaded, sceneLoaded] = await Promise.all([
    loadStructuredWorldFile(params.worldRoot, "canon/player.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/current-scene.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
  ]);

  const playerRoot = toObject(playerLoaded.parsed);
  const gameState = toObject(playerRoot.game_state);
  const player = toObject(playerRoot.player);
  const sceneRoot = toObject(sceneLoaded.parsed);
  const sceneFlow = toObject(toObject(sceneRoot.scene).scene_flow);

  const characterCreated = gameState.character_created === true || Boolean(readString(player.name));
  const bootstrapComplete = gameState.bootstrap_complete === true;
  const setupComplete = sceneFlow.player_setup_complete === true;
  const introShown = sceneFlow.intro_shown === true;
  const runtimePhase: RuntimePhase = !characterCreated || !bootstrapComplete
    ? "BOOTSTRAP"
    : !setupComplete || !introShown
      ? "READY_FOR_INTRO"
      : "IN_GAME";

  await emitRuntimeDiagnostic({
    cfg: params.cfg,
    worldRoot: params.worldRoot,
    sessionId: params.sessionId,
    event: "runtime_phase_detected",
    severity: "info",
    runtimePhase,
    route: "phase_detection",
    gate: "phase",
    result: runtimePhase,
    details: {
      intro_shown: introShown,
      player_setup_complete: setupComplete,
      bootstrap_complete: bootstrapComplete,
      character_created: characterCreated,
    },
  });

  return runtimePhase;
}

export function classifyTurnKind(latestUserMessage: string): "scene-turn" | "etc" {
  const text = latestUserMessage.trim().toLowerCase();
  if (!text) {
    return "scene-turn";
  }

  if (/^(?:\/(?:help|status|debug|config|설정)|ooc\b|meta\b)/.test(text)) {
    return "etc";
  }

  if (/(?:구현|브릿지|bridge|runtime|plugin|코드|test|테스트|schema|스키마|config|debug|디버그|버그|fix|커밋|commit|pr\b|patch|tool|modal|component|discord|openclaw|trpg-v2|drifter|어떻게\s*바꾸|how\s+do\s+i\s+change)/.test(text)) {
    return "etc";
  }

  if (/(?:이동|조사|공격|대화|말한다|묻는다|살핀다|본다|사용한다|열어본다|간다|한다|선택|입력|완료|계속)/.test(text)) {
    return "scene-turn";
  }

  return "scene-turn";
}

export function normalizeSceneComponentInputByPhase(
  input: SceneComponentInput,
  runtimePhase: RuntimePhase,
  sanitizeLegacyBootstrapTemplateText: (value: string) => string,
): SceneComponentInput {
  const sanitizedDescription = sanitizeLegacyBootstrapTemplateText(readString(input.description));
  const safeDescription = sanitizedDescription || "캐릭터 준비 정보를 입력해 주세요.";
  if (runtimePhase === "IN_GAME") {
    return {
      ...input,
      description: safeDescription,
      runtimePhase,
    };
  }

  const safeChoices = (input.choices ?? [])
    .map((choice) => ({
      label: readString(choice.label),
      description: readString(choice.description),
      value: readString(choice.value),
      emoji: readString(choice.emoji),
    }))
    .filter((choice) => choice.label && choice.value)
    .filter((choice) => choice.label.length <= 80 && choice.value.length <= 80);

  if (input.scene === "choice" && safeChoices.length > 0 && safeChoices.length === (input.choices ?? []).length) {
    return {
      ...input,
      scene: "choice",
      description: safeDescription,
      choices: safeChoices,
      includeInput: true,
      runtimePhase,
    };
  }

  return {
    ...input,
    scene: "system",
    description: safeDescription,
    buttons: [
      { label: "🪪 이름 입력", style: "primary" },
      { label: "🌍 배경/출신 입력", style: "secondary" },
      { label: "🎯 현재 목표 입력", style: "secondary" },
      { label: "✅ 완료/다음 단계", style: "success" },
      { label: "🆕 새 캐릭터 시작", style: "primary" },
    ],
    includeInput: true,
    runtimePhase,
  };
}
