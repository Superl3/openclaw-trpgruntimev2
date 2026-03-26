/**
 * Discord Component Templates for TRPG Runtime
 *
 * Standardized layouts for TRPG scene responses.
 * The TRPG agent sends these via the message tool with components payload.
 * Only create new templates when existing ones don't fit the situation.
 */

export type SceneType =
  | "exploration"
  | "npc_encounter"
  | "combat"
  | "choice"
  | "dialogue"
  | "system";

export type RuntimePhase = "BOOTSTRAP" | "READY_FOR_INTRO" | "IN_GAME";

export interface SceneComponentInput {
  /** Scene type determines template */
  scene: SceneType;

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

// ─── Template Builders ──────────────────────────────────────────────

function progressBar(current: number, max: number, length = 10): string {
  if (!Number.isFinite(max) || max <= 0) {
    return "`" + "░".repeat(length) + "`";
  }
  const filled = Math.max(0, Math.min(length, Math.round((current / max) * length)));
  const empty = length - filled;
  return "`" + "█".repeat(filled) + "░".repeat(empty) + "`";
}

function freeformModal(title?: string, runtimePhase: RuntimePhase = "IN_GAME") {
  if (runtimePhase !== "IN_GAME") {
    return {
      title: title || "캐릭터 준비",
      triggerLabel: "✍️ 자유서술 입력",
      fields: [
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
      ],
    };
  }

  return {
    title: title || "🗣️ 직접 행동/대사 입력",
    triggerLabel: "✏️ 직접 입력",
    fields: [
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
    ],
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

const FREE_INPUT_OPTION_PATTERN = /(?:자유\s*입력|직접\s*입력|free\s*input)/i;
function isFreeInputOptionLabel(value: string): boolean {
  return FREE_INPUT_OPTION_PATTERN.test(value.trim());
}

const DEFAULT_BUTTONS: Record<SceneType, Array<{ label: string; style: string }>> = {
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
  dialogue: [],
  system: [
    { label: "🪪 이름 입력", style: "primary" },
    { label: "🌍 배경/출신 입력", style: "secondary" },
    { label: "🎯 현재 목표 입력", style: "secondary" },
    { label: "✅ 완료/다음 단계", style: "success" },
  ],
};

const ACCENT_COLORS: Record<SceneType, string> = {
  exploration: "#2ecc71",
  npc_encounter: "#f39c12",
  combat: "#e74c3c",
  choice: "#9b59b6",
  dialogue: "#f39c12",
  system: "#6c7a89",
};

const BLOCK_TITLES: Record<SceneType, string> = {
  exploration: "🗺️ 탐색",
  npc_encounter: "👤 NPC 만남",
  combat: "⚔️ 전투 중",
  choice: "🔀 선택",
  dialogue: "💬 대화 진행 중",
  system: "⚙️ 시스템 안내",
};

function isValidSelectOptionLabel(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 80;
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

// ─── Main Builder ───────────────────────────────────────────────────

export function buildSceneComponents(input: SceneComponentInput): Record<string, unknown> {
  const { scene, npc, combat } = input;
  const includeInput = input.includeInput !== false;
  const runtimePhase = input.runtimePhase ?? "IN_GAME";
  const blocks: unknown[] = [];
  const normalizedScene: SceneType =
    scene === "exploration" ||
    scene === "npc_encounter" ||
    scene === "combat" ||
    scene === "choice" ||
    scene === "dialogue" ||
    scene === "system"
      ? scene
      : "system";
  const container: Record<string, unknown> = {
    accentColor: npc?.color || ACCENT_COLORS[normalizedScene],
  };

  // ── Main description block ──
  let mainText = input.description;
  if (input.locationInfo) {
    mainText += "\n\n" + input.locationInfo;
  }

  if (normalizedScene === "npc_encounter" && npc) {
    const statusLine = [
      npc.disposition ? `\`호감도: ${npc.disposition}\`` : null,
      npc.status ? `\`상태: ${npc.status}\`` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    mainText = `**🗡️ ${npc.name} - ${npc.title}**\n\n${npc.dialogue ? `*\"${npc.dialogue}\"*\n\n` : ""}${statusLine}`;
  } else if (normalizedScene === "dialogue" && npc) {
    const changeLine =
      npc.oldDisposition && npc.newDisposition
        ? `\n\n**호감도 변화:** \`${npc.oldDisposition} → ${npc.newDisposition}\` ${npc.oldDisposition < npc.newDisposition ? "⬆️" : npc.oldDisposition > npc.newDisposition ? "⬇️" : "➡️"}`
        : "";
    mainText = `**🗡️ ${npc.name}**${npc.action ? ` ${npc.action}` : ""}:\n\n*\"${npc.dialogue}\"*${changeLine}`;
  }

  if (normalizedScene === "combat" && combat) {
    const acLine = combat.acBuff ? `(+${combat.acBuff})` : "";
    const effects = combat.effects || "없음";
    mainText = [
      `**전투 라운드 ${combat.round}**\n`,
      `❤️ **HP:** ${progressBar(combat.hpCurrent, combat.hpMax)} ${combat.hpCurrent}/${combat.hpMax}`,
      `🛡️ **방어도:** \`${combat.ac}\` ${acLine}`,
      `✨ **마나:** ${progressBar(combat.manaCurrent, combat.manaMax)} ${combat.manaCurrent}/${combat.manaMax}\n`,
      `**적:** ${combat.enemySummary}`,
    ].join("\n");

    blocks.push({
      type: "text",
      text: mainText,
    });

    blocks.push({
      type: "text",
      text: `**버프/디버프:**\n${effects}`,
    });
  } else {
    blocks.push({
      type: "text",
      text: mainText,
    });
  }

  // ── Action buttons or select menu ──
  const buttons = dedupeByKey(
    input.buttons || DEFAULT_BUTTONS[normalizedScene],
    (button) => button.label,
  )
    .filter((button) => !isFreeInputOptionLabel(button.label))
    .slice(0, 5);

  if (normalizedScene === "choice" && input.choices) {
    const normalizedChoices = normalizeSelectChoices(input.choices);

    blocks.push({
      type: "actions",
      select: {
        type: "string",
        placeholder: "선택하세요...",
        options: normalizedChoices
          .map((c) => ({
            label: c.emoji ? `${c.emoji} ${c.label}` : c.label,
            description: c.description,
            value: c.value,
          }))
          .slice(0, 25),
      },
    });
  } else if (buttons.length > 0) {
    blocks.push({
      type: "actions",
      buttons: buttons.map((b) => ({
        label: b.label,
        style: b.style,
      })),
    });
  }

  // ── Assemble components payload ──
  const components: Record<string, unknown> = {
    text: BLOCK_TITLES[normalizedScene],
    embeds: [
      {
        title: BLOCK_TITLES[normalizedScene],
        description: input.description,
        color: npc?.color || ACCENT_COLORS[normalizedScene],
      },
    ],
    blocks,
  };

  if (includeInput) {
    components.modal = freeformModal(input.modalTitle, runtimePhase);
  }

  components.container = container;
  return components;
}

// ─── System Prompt Injection ────────────────────────────────────────

export const COMPONENT_USAGE_GUIDE = [
  "[TRPG_DISCORD_COMPONENTS]",
  "You MUST send scene responses using the message tool with Discord components.",
  "Build the components JSON YOURSELF based on actual game state from world/*.",
  "NEVER invent content. Only describe what the player can actually see/know.",
  "",
  "LAYOUT DECISION TREE:",
  "A) If selectable actions exist → buttons + ✏️ direct input as LAST button",
  "B) If no clear choices → text + modal only (no buttons)",
  "C) If 3+ distinct options → select menu",
  "",
  "ALWAYS include '캐릭터에게 맡기기' (delegate to character) when actions exist.",
  "ALWAYS put '✏️ 직접 입력' as the LAST button when buttons are shown.",
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
  "  ], modal: {title: '직접 입력', triggerLabel: '...', fields: [...]}})",
  "",
  "EXAMPLE B (freeform):",
  "message(action='send', components={",
  "  text: '상황', blocks: [{type: 'text', text: '설명'}],",
  "  modal: {title: '행동 입력', triggerLabel: '✏️ 행동하기', fields: [...]}})",
  "",
  "RULES:",
  "- Buttons: 0-5, variable. No clear actions = no buttons.",
  "- NEVER hallucinate actions that aren't possible.",
  "- Fewer buttons + free input is ALWAYS safer.",
  "- Button clicks arrive as the player's next message.",
].join("\n");
