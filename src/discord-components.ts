/**
 * Discord Component Templates for TRPG Runtime
 *
 * Standardized layouts for TRPG scene responses.
 * The TRPG agent sends these via the message tool with components payload.
 * Only create new templates when existing ones don't fit the situation.
 */

export type SceneType =
  | "bootstrap_choice"
  | "exploration"
  | "npc_encounter"
  | "combat"
  | "choice"
  | "dialogue"
  | "system"
  | "system_input"
  | "resolution"
  | "travel_transition";

export type RuntimePhase = "BOOTSTRAP" | "READY_FOR_INTRO" | "IN_GAME";

export interface SceneComponentInput {
  /** Scene type determines template */
  scene: SceneType;

  /** Optional turn-kind contract for caller-side routing */
  turnKind?: "scene-turn" | "etc";

  /** Latest raw user input used for turn-kind fallback classification */
  latestUserMessage?: string;

  /** Scene description text (supports Discord markdown) */
  description: string;

  /** Location/status info line */
  locationInfo?: string;

  /** NPC data (required for npc_encounter / dialogue) */
  npc?: {
    name: string;
    title: string;
    dialogue?: string;
    disposition?: string;
    status?: string;
    color?: string;
    action?: string;
    oldDisposition?: string;
    newDisposition?: string;
  };

  /** Combat data (required for combat) */
  combat?: {
    round: number;
    hpCurrent: number;
    hpMax: number;
    ac: number;
    acBuff?: string;
    manaCurrent: number;
    manaMax: number;
    enemySummary: string;
    effects?: string;
  };

  /** Quick action buttons (scene-specific defaults used if omitted) */
  buttons?: Array<{
    label: string;
    style: "primary" | "secondary" | "success" | "danger";
    actionId?: string;
    customId?: string | null;
    custom_id?: string | null;
    disabled?: boolean;
  }>;

  /** Select menu choices (required for choice scene) */
  choices?: Array<{
    label: string;
    description?: string;
    value: string;
    emoji?: string;
  }>;

  /** Custom modal title override */
  modalTitle?: string;

  /** Whether to include the freeform input modal (default: true) */
  includeInput?: boolean;

  /** Runtime phase contract for UI gating */
  runtimePhase?: RuntimePhase;
}

function progressBar(current: number, max: number, length = 10): string {
  if (!Number.isFinite(max) || max <= 0) {
    return "`" + "░".repeat(length) + "`";
  }
  const filled = Math.max(0, Math.min(length, Math.round((current / max) * length)));
  const empty = length - filled;
  return "`" + "█".repeat(filled) + "░".repeat(empty) + "`";
}

const SYSTEM_MODAL_FIELDS = [
  {
    type: "text",
    name: "name",
    label: "이름 입력",
    placeholder: "예: 슈슈",
    style: "short",
    required: false,
  },
  {
    type: "text",
    name: "background",
    label: "배경/출신 입력",
    placeholder: "예: 항구 출신 견습 탐정",
    style: "paragraph",
    required: false,
  },
  {
    type: "text",
    name: "goal",
    label: "현재 목표 입력",
    placeholder: "예: 길드 의뢰를 받아 정착하기",
    style: "paragraph",
    required: false,
  },
  {
    type: "text",
    name: "freeform",
    label: "자유서술 입력",
    placeholder: "성격/과거/관계/분위기를 자유롭게 적어주세요",
    style: "paragraph",
    required: false,
  },
] as const;

const CHARACTER_MODAL_FIELDS = [
  {
    type: "text",
    name: "action",
    label: "행동 (무엇을 하는가?)",
    placeholder: "예: 검을 뽑아 경계 자세를 취한다",
    style: "paragraph",
    required: false,
  },
  {
    type: "text",
    name: "speech",
    label: "대사 (무엇을 말하는가?)",
    placeholder: '예: "조심해, 함정이 있을 수 있어"',
    style: "paragraph",
    required: false,
  },
  {
    type: "select",
    name: "tone",
    label: "태도",
    options: [
      { label: "🤝 친근하게", value: "friendly" },
      { label: "😐 무덤덤하게", value: "neutral" },
      { label: "😠 위협적으로", value: "intimidating" },
      { label: "🤔 경계하며", value: "cautious" },
    ],
    required: false,
  },
] as const;

function freeformModal(title?: string, runtimePhase: RuntimePhase = "IN_GAME") {
  if (runtimePhase === "BOOTSTRAP") {
    return {
      type: "system",
      title: title || "캐릭터 준비",
      triggerLabel: "✍️ 자유서술 입력",
      fields: SYSTEM_MODAL_FIELDS.map((field) => ({ ...field })),
    };
  }

  return {
    type: "character",
    title: title || "🗣️ 직접 행동/대사 입력",
    triggerLabel: "✏️ 직접 입력",
    fields: CHARACTER_MODAL_FIELDS.map((field) => ({ ...field })),
  };
}

function dedupeByKey<T>(items: readonly T[] | undefined, keyOf: (entry: T) => string): T[] {
  const out: T[] = [];
  const seen = new Set<string>();

  for (const entry of items ?? []) {
    const key = keyOf(entry).trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(entry);
  }

  return out;
}

const FREE_INPUT_OPTION_PATTERN = /(?:자유\s*(?:입력|서술\s*입력)|직접\s*입력|free\s*input)/i;
function isFreeInputOptionLabel(value: string): boolean {
  return FREE_INPUT_OPTION_PATTERN.test(value.trim());
}

const DEFAULT_BUTTONS: Record<SceneType, Array<{ label: string; style: string }>> = {
  bootstrap_choice: [
    { label: "🪪 이름 입력", style: "primary" },
    { label: "🌍 배경/출신 입력", style: "secondary" },
    { label: "🎯 현재 목표 입력", style: "secondary" },
    { label: "✅ 완료/다음 단계", style: "success" },
  ],
  exploration: [
    { label: "🔍 조사", style: "primary" },
    { label: "🚶 이동", style: "secondary" },
    { label: "🎒 가방 열기", style: "secondary" },
  ],
  npc_encounter: [
    { label: "🤝 동행 요청", style: "success" },
    { label: "💬 대화하기", style: "primary" },
    { label: "⚔️ 위협하기", style: "danger" },
    { label: "🚶 무시하고 지나가기", style: "secondary" },
  ],
  combat: [
    { label: "⚔️ 공격", style: "danger" },
    { label: "✨ 마법", style: "primary" },
    { label: "🧪 포션", style: "success" },
    { label: "🏃 후퇴", style: "secondary" },
  ],
  choice: [],
  dialogue: [
    { label: "💬 계속 듣기", style: "primary" },
    { label: "❓추가 질문", style: "secondary" },
    { label: "🤝 설득 시도", style: "success" },
  ],
  system: [
    { label: "🪪 이름 입력", style: "primary" },
    { label: "🌍 배경/출신 입력", style: "secondary" },
    { label: "🎯 현재 목표 입력", style: "secondary" },
    { label: "✅ 완료/다음 단계", style: "success" },
  ],
  system_input: [
    { label: "🪪 이름 입력", style: "primary" },
    { label: "🌍 배경/출신 입력", style: "secondary" },
    { label: "🎯 현재 목표 입력", style: "secondary" },
    { label: "✅ 완료/다음 단계", style: "success" },
  ],
  resolution: [
    { label: "📌 결과 정리", style: "primary" },
    { label: "➡️ 다음 행동", style: "secondary" },
  ],
  travel_transition: [
    { label: "🧭 경로 확인", style: "primary" },
    { label: "🚶 이동 계속", style: "secondary" },
  ],
};

const ACCENT_COLORS: Record<SceneType, string> = {
  bootstrap_choice: "#6c7a89",
  exploration: "#2ecc71",
  npc_encounter: "#f39c12",
  combat: "#e74c3c",
  choice: "#9b59b6",
  dialogue: "#f39c12",
  system: "#6c7a89",
  system_input: "#6c7a89",
  resolution: "#3498db",
  travel_transition: "#16a085",
};

const BLOCK_TITLES: Record<SceneType, string> = {
  bootstrap_choice: "⚙️ 캐릭터 준비",
  exploration: "🗺️ 탐색",
  npc_encounter: "👤 NPC 만남",
  combat: "⚔️ 전투 중",
  choice: "🔀 선택",
  dialogue: "💬 대화 진행 중",
  system: "⚙️ 시스템 안내",
  system_input: "⚙️ 시스템 안내",
  resolution: "📌 결과 정리",
  travel_transition: "🧭 이동 전환",
};

type SceneSectionKey =
  | "summary"
  | "location"
  | "selection"
  | "npc_intro"
  | "dialogue_line"
  | "combat_status"
  | "combat_effects"
  | "resolution_summary"
  | "travel_route"
  | "system_guidance";

const FIXED_SECTIONS: Record<SceneType, SceneSectionKey[]> = {
  bootstrap_choice: ["summary", "selection", "system_guidance"],
  exploration: ["summary", "location"],
  npc_encounter: ["npc_intro", "location"],
  combat: ["combat_status", "combat_effects"],
  choice: ["summary", "selection"],
  dialogue: ["npc_intro", "dialogue_line"],
  system: ["summary", "system_guidance"],
  system_input: ["summary", "system_guidance"],
  resolution: ["summary", "resolution_summary"],
  travel_transition: ["summary", "travel_route"],
};

function isValidSelectOptionLabel(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 80;
}

function normalizeActionButtons(
  buttons: SceneComponentInput["buttons"],
): NonNullable<SceneComponentInput["buttons"]> {
  return dedupeByKey(buttons ?? [], (button) => button.label)
    .filter((button) => !isFreeInputOptionLabel(button.label))
    .slice(0, 5);
}

function normalizeSelectChoices(
  choices: SceneComponentInput["choices"],
): Array<{ label: string; description?: string; value: string; emoji?: string }> {
  return dedupeByKey(
    (choices ?? [])
      .map((choice) => ({
        label: choice.label?.trim() || "",
        description: choice.description,
        value: choice.value?.trim() || "",
        emoji: choice.emoji,
      }))
      .filter((choice) => choice.label && choice.value)
      .filter((choice) => !isFreeInputOptionLabel(choice.label) && !isFreeInputOptionLabel(choice.value))
      .filter((choice) => isValidSelectOptionLabel(choice.label)),
    (choice) => `${choice.label}|${choice.value}`,
  );
}

function normalizeSceneType(input: SceneComponentInput): SceneType {
  const runtimePhase = input.runtimePhase ?? "IN_GAME";
  const requestedScene = input.scene;
  const text = [input.latestUserMessage, input.description, input.locationInfo].filter(Boolean).join(" ").toLowerCase();
  const hasChoices = normalizeSelectChoices(input.choices).length > 0;
  const hasNpc = Boolean(input.npc?.name);
  const hasDialogue = Boolean(input.npc?.dialogue) || /대화|말한다|묻는다|설득|협상|interview|talk|says?/.test(text);
  const hasCombat = Boolean(input.combat) || /전투|공격|battle|combat|initiative|라운드/.test(text);
  const hasTravel = /이동|여행|경로|출발|travel|journey|route/.test(text);
  const hasResolution = /결과|정리|resolve|resolution|후처리|마무리/.test(text);
  const hasSystemInput = /이름|배경|목표|설정|부트스트랩|bootstrap|character setup/.test(text);

  if (runtimePhase === "BOOTSTRAP") {
    if (requestedScene === "bootstrap_choice" || requestedScene === "choice" || hasChoices) {
      return "bootstrap_choice";
    }
    return "system_input";
  }

  if (requestedScene === "combat" || hasCombat) {
    return "combat";
  }
  if (requestedScene === "dialogue" || hasDialogue) {
    return "dialogue";
  }
  if (requestedScene === "npc_encounter" || (hasNpc && !hasDialogue)) {
    return "npc_encounter";
  }
  if (requestedScene === "resolution" || hasResolution) {
    return "resolution";
  }
  if (requestedScene === "travel_transition" || hasTravel) {
    return "travel_transition";
  }
  if (requestedScene === "system_input" || requestedScene === "system" || hasSystemInput) {
    return "exploration";
  }
  if (requestedScene === "choice") {
    return hasChoices ? "choice" : "exploration";
  }
  return requestedScene === "bootstrap_choice" ? "exploration" : requestedScene || "exploration";
}

function buildSectionText(section: SceneSectionKey, scene: SceneType, input: SceneComponentInput): string | null {
  const description = input.description?.trim() || "";
  const locationInfo = input.locationInfo?.trim() || "";
  const npc = input.npc;
  const combat = input.combat;

  switch (section) {
    case "summary":
      return description || null;
    case "location":
      return locationInfo ? `📍 **현장 정보**\n${locationInfo}` : null;
    case "selection": {
      if (scene === "bootstrap_choice") {
        return "**선택 안내**\n이름 / 배경 / 목표를 정하거나 직접 서술로 캐릭터 준비를 진행하세요.";
      }
      if (scene === "choice") {
        return "**선택 안내**\n아래 선택지 중 하나를 고르거나 직접 입력으로 진행하세요.";
      }
      return null;
    }
    case "npc_intro": {
      if (!npc) {
        return null;
      }
      const meta = [npc.title ? `직함: ${npc.title}` : null, npc.disposition ? `호감도: ${npc.disposition}` : null, npc.status ? `상태: ${npc.status}` : null]
        .filter(Boolean)
        .join(" · ");
      return [`**👤 ${npc.name}**`, meta ? `\`${meta}\`` : null].filter(Boolean).join("\n");
    }
    case "dialogue_line":
      return npc?.dialogue ? `**💬 대사**\n*"${npc.dialogue}"*` : description || null;
    case "combat_status": {
      if (!combat) {
        return description || null;
      }
      const acLine = combat.acBuff ? `(+${combat.acBuff})` : "";
      return [
        `**전투 라운드 ${combat.round}**`,
        `❤️ **HP:** ${progressBar(combat.hpCurrent, combat.hpMax)} ${combat.hpCurrent}/${combat.hpMax}`,
        `🛡️ **방어도:** \`${combat.ac}\` ${acLine}`,
        `✨ **마나:** ${progressBar(combat.manaCurrent, combat.manaMax)} ${combat.manaCurrent}/${combat.manaMax}`,
        `**적:** ${combat.enemySummary}`,
      ].join("\n");
    }
    case "combat_effects":
      return `**버프/디버프**\n${combat?.effects || "없음"}`;
    case "resolution_summary":
      return `**결과 정리**\n${description || "이번 턴의 결과를 정리합니다."}`;
    case "travel_route":
      return `**이동 전환**\n${locationInfo || description || "다음 목적지로 이동합니다."}`;
    case "system_guidance":
      return scene === "bootstrap_choice" || scene === "system_input" || scene === "system"
        ? "**입력 모드**\n이 단계에서는 시스템 입력만 받습니다. 이름/배경/목표를 버튼 또는 자유서술로 정리하세요."
        : null;
    default:
      return null;
  }
}

export function buildSceneComponents(input: SceneComponentInput): Record<string, unknown> {
  const includeInput = input.includeInput !== false;
  const runtimePhase = input.runtimePhase ?? "IN_GAME";
  const normalizedScene = normalizeSceneType(input);
  const blocks: unknown[] = [];

  for (const section of FIXED_SECTIONS[normalizedScene] ?? ["summary"]) {
    const text = buildSectionText(section, normalizedScene, input);
    if (text) {
      blocks.push({ type: "text", text });
    }
  }

  const normalizedChoices = normalizeSelectChoices(input.choices);
  const choiceNormalizationPreserved = normalizedChoices.length === (input.choices?.length ?? 0);
  const buttons = normalizeActionButtons(
    (input.buttons || DEFAULT_BUTTONS[normalizedScene]) as NonNullable<SceneComponentInput["buttons"]>,
  );

  if ((normalizedScene === "choice" || normalizedScene === "bootstrap_choice") && normalizedChoices.length > 0 && choiceNormalizationPreserved) {
    blocks.push({
      type: "actions",
      select: {
        type: "string",
        placeholder: normalizedScene === "bootstrap_choice" ? "배경/설정 선택..." : "선택하세요...",
        options: normalizedChoices.map((c) => ({
          label: c.emoji ? `${c.emoji} ${c.label}` : c.label,
          description: c.description,
          value: c.value,
        })).slice(0, 25),
      },
    });
  } else if (buttons.length > 0) {
    blocks.push({
      type: "actions",
      buttons: buttons.map((b) => ({
        label: b.label,
        style: b.style,
        ...(typeof b.actionId === "string" ? { actionId: b.actionId } : {}),
        ...(typeof b.customId === "string" || b.customId === null ? { customId: b.customId } : {}),
        ...(typeof b.custom_id === "string" || b.custom_id === null ? { custom_id: b.custom_id } : {}),
        ...(typeof b.disabled === "boolean" ? { disabled: b.disabled } : {}),
      })),
    });
  }

  const components: Record<string, unknown> = {
    text: BLOCK_TITLES[normalizedScene],
    embeds: [
      {
        title: BLOCK_TITLES[normalizedScene],
        description: input.description,
        color: input.npc?.color || ACCENT_COLORS[normalizedScene],
      },
    ],
    blocks,
    container: {
      accentColor: input.npc?.color || ACCENT_COLORS[normalizedScene],
    },
  };

  if (includeInput) {
    components.modal = freeformModal(input.modalTitle, runtimePhase);
  }

  return components;
}

export const COMPONENT_USAGE_GUIDE = [
  "[TRPG_DISCORD_COMPONENTS]",
  "You MUST send scene responses using the message tool with Discord components.",
  "Build the components JSON YOURSELF based on actual game state from world/*.",
  "NEVER invent content. Only describe what the player can actually see/know.",
  "",
  "LAYOUT DECISION TREE:",
  "A) If selectable actions exist → buttons only; direct input remains the single modal trigger",
  "B) If no clear choices → text + modal only (no buttons)",
  "C) If 3+ distinct options → select menu",
  "",
  "ALWAYS include '캐릭터에게 맡기기' (delegate to character) when actions exist.",
  "Direct input must have exactly one entry point per turn.",
  "Never expose a modal trigger and a normal direct-input button in the same turn. Keep exactly one direct-input entry point.",
  "",
  "EXAMPLE A (actions exist):",
  "message(action='send', components={",
  "  text: '상황', blocks: [",
  "    {type: 'text', text: '설명'},",
  "    {type: 'actions', buttons: [",
  "      {label: '행동1', style: 'primary'},",
  "      {label: '캐릭터에게 맡기기', style: 'secondary'},",
  "      {label: '✏️ 직접 입력', style: 'secondary'}  // LAST",
  "    ]}",
  "  ], modal: {type: 'character', title: '직접 입력', triggerLabel: '...', fields: [...]}})",
  "",
  "EXAMPLE B (freeform):",
  "message(action='send', components={",
  "  text: '상황', blocks: [{type: 'text', text: '설명'}],",
  "  modal: {type: 'character', title: '행동 입력', triggerLabel: '✏️ 행동하기', fields: [...]}})",
  "",
  "RULES:",
  "- Buttons: 0-5, variable. No clear actions = no buttons.",
  "- NEVER hallucinate actions that aren't possible.",
  "- Fewer buttons + free input is ALWAYS safer.",
  "- Button clicks arrive as the player's next message.",
].join("\n");
