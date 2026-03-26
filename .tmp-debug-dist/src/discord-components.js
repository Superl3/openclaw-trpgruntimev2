/**
 * Discord Component Templates for TRPG Runtime
 *
 * Standardized layouts for TRPG scene responses.
 * The TRPG agent sends these via the message tool with components payload.
 * Only create new templates when existing ones don't fit the situation.
 */
// ─── Template Builders ──────────────────────────────────────────────
function progressBar(current, max, length = 10) {
    const filled = Math.round((current / max) * length);
    const empty = length - filled;
    return "`" + "█".repeat(filled) + "░".repeat(empty) + "`";
}
function freeformModal(title) {
    return {
        title: title || "🗣️ 직접 행동/대사 입력",
        triggerLabel: "✏️ 자유 입력",
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
const DEFAULT_BUTTONS = {
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
        { label: "❌ 닫기", style: "secondary" }
    ],
};
const ACCENT_COLORS = {
    exploration: "#2ecc71",
    npc_encounter: "#f39c12",
    combat: "#e74c3c",
    choice: "#9b59b6",
    dialogue: "#f39c12",
    system: "#34495e",
};
const BLOCK_TITLES = {
    exploration: "🗺️ 탐색",
    npc_encounter: "👤 NPC 만남",
    combat: "⚔️ 전투 중",
    choice: "🔀 선택",
    dialogue: "💬 대화 진행 중",
    system: "⚙️ 시스템 안내",
};
const FREE_INPUT_PATTERN = /(자유\s*입력|직접\s*입력|free\s*input|action\.free_input\.submit)/i;
function isFreeInputOptionLabel(value) {
    return FREE_INPUT_PATTERN.test(value.trim());
}
// ─── Main Builder ───────────────────────────────────────────────────
export function buildSceneComponents(input) {
    const { scene, npc, combat } = input;
    const includeInput = input.includeInput !== false;
    const blocks = [];
    const container = {
        accentColor: npc?.color || ACCENT_COLORS[scene],
    };
    const embedColor = parseInt((npc?.color || ACCENT_COLORS[scene]).replace("#", ""), 16);
    const embed = {
        title: BLOCK_TITLES[scene],
        color: embedColor,
        description: input.description + (input.locationInfo ? `\n\n*${input.locationInfo}*` : ""),
    };
    if (input.imageUrl) {
        embed.image = { url: input.imageUrl };
    }
    const fields = [];
    if (scene === "npc_encounter" && npc) {
        embed.author = { name: `${npc.name} - ${npc.title}` };
        if (npc.dialogue)
            embed.description = `*"${npc.dialogue}"*\n\n` + embed.description;
        if (npc.disposition || npc.status) {
            fields.push({
                name: "상태정보",
                value: [
                    npc.disposition ? `**호감도:** ${npc.disposition}` : null,
                    npc.status ? `**상태:** ${npc.status}` : null,
                ].filter(Boolean).join("\n"),
                inline: true
            });
        }
    }
    else if (scene === "dialogue" && npc) {
        embed.author = { name: `${npc.name}${npc.action ? ` ${npc.action}` : ""}` };
        if (npc.dialogue)
            embed.description = `*"${npc.dialogue}"*\n\n` + embed.description;
        if (npc.oldDisposition && npc.newDisposition) {
            fields.push({
                name: "호감도 변화",
                value: `${npc.oldDisposition} → ${npc.newDisposition} ${npc.oldDisposition < npc.newDisposition ? "⬆️" : npc.oldDisposition > npc.newDisposition ? "⬇️" : "➡️"}`,
                inline: true
            });
        }
    }
    if (scene === "combat" && combat) {
        const acLine = combat.acBuff ? `(+${combat.acBuff})` : "";
        embed.title = `⚔️ 전투 라운드 ${combat.round}`;
        fields.push({
            name: "❤️ HP",
            value: `${progressBar(combat.hpCurrent, combat.hpMax)}\n${combat.hpCurrent}/${combat.hpMax}`,
            inline: true
        });
        fields.push({
            name: "✨ 마나",
            value: `${progressBar(combat.manaCurrent, combat.manaMax)}\n${combat.manaCurrent}/${combat.manaMax}`,
            inline: true
        });
        fields.push({
            name: "🛡️ 방어도",
            value: `\`${combat.ac}\` ${acLine}`,
            inline: true
        });
        fields.push({ name: "상대 정보", value: combat.enemySummary, inline: false });
        if (combat.effects) {
            fields.push({ name: "버프/디버프", value: combat.effects, inline: false });
        }
    }
    if (fields.length > 0)
        embed.fields = fields;
    // ── Inventory Dropdown (Unified Context) ──
    if (input.inventoryChoices && input.inventoryChoices.length > 0) {
        blocks.push({
            type: "actions",
            select: {
                type: "string",
                placeholder: `🎒 소지품 확인 (${input.inventoryChoices.length}개)...`,
                options: input.inventoryChoices.map((c) => ({
                    label: c.emoji ? `${c.emoji} ${c.label}` : c.label,
                    description: c.description,
                    value: c.value,
                })).slice(0, 25), // Discord limits to 25
            },
        });
    }
    // ── Action buttons or select menu ──
    const buttons = (input.buttons || DEFAULT_BUTTONS[scene])
        .filter((button) => !isFreeInputOptionLabel(button.label))
        .slice(0, 5); // Fallback safety limit for Discord ActionRow API
    if (scene === "choice" && input.choices) {
        const normalizedChoices = input.choices.filter((choice) => !isFreeInputOptionLabel(choice.label) && !isFreeInputOptionLabel(choice.value));
        blocks.push({
            type: "actions",
            select: {
                type: "string",
                placeholder: "선택하세요...",
                options: normalizedChoices.map((c) => ({
                    label: c.emoji ? `${c.emoji} ${c.label}` : c.label,
                    description: c.description,
                    value: c.value,
                })),
            },
        });
    }
    else if (buttons.length > 0) {
        blocks.push({
            type: "actions",
            buttons: buttons.map((b) => ({
                label: b.label,
                style: b.style,
            })),
        });
    }
    // ── Assemble components payload ──
    const components = {
        embeds: [embed],
        blocks,
    };
    if (input.includeInput !== false) {
        components.modal = freeformModal(input.modalTitle);
    }
    components.container = container;
    return components;
}
export function buildBootstrapComponents(input = {}) {
    const includeKeepInitialInfo = input.includeKeepInitialInfo !== false;
    const buttons = [
        { label: "🆕 새 캐릭터 시작", style: "primary" },
        { label: "📂 캐릭터 불러오기", style: "secondary" },
    ];
    if (includeKeepInitialInfo) {
        buttons.push({ label: "🧷 초기 정보 유지", style: "success" });
    }
    return {
        text: input.title || "캐릭터 준비",
        blocks: [
            {
                type: "text",
                text: input.description ||
                    "게임을 시작하기 전에 캐릭터 준비 단계를 진행합니다. 새 캐릭터를 만들거나 기존 캐릭터를 불러오세요.",
            },
            {
                type: "actions",
                buttons,
            },
        ],
        modal: {
            title: "초기 정보 입력",
            triggerLabel: "✏️ 직접 입력",
            fields: [
                {
                    type: "text",
                    name: "bootstrap_freeform",
                    label: "초기 정보",
                    placeholder: "이름/배경/목표 등 알려진 정보를 자유롭게 입력",
                    style: "paragraph",
                    required: false,
                },
            ],
        },
    };
}
// ─── System Prompt Injection ────────────────────────────────────────
export const GAME_COMPONENT_USAGE_GUIDE = [
    "[TRPG_DISCORD_COMPONENTS]",
    "You MUST send scene responses using the message tool with Discord components.",
    "Build the components JSON YOURSELF based on actual game state from world/*.",
    "NEVER invent content. Only describe what the player can actually see/know.",
    "",
    "LAYOUT DECISION TREE:",
    "A) Normal progression → use appropriate scene type ('exploration', 'combat', etc.). Provide buttons for clear choices.",
    "B) If player requests inventory/items → keep the current gameplay scene and merge inventory into the same output using 'inventoryChoices'.",
    "C) If query is meta (rules, stats, info) → use scene='system' (Format cleanly)",
    "",
    "'🎯 성향 추천 선택' is IN_GAME-only and runtime-managed. Do not emit it in bootstrap/system phase.",
    "DO NOT add '자유 입력/직접 입력' as a normal button because modal trigger already covers it.",
    "DO NOT include '자유 입력/직접 입력' as a select option.",
    "",
    "EXAMPLE - Unified Scene with Inventory:",
    "message(action='send', components={",
    "  scene: 'exploration',",
    "  description: '가방을 열어 소지품을 확인합니다.',",
    "  inventoryChoices: [",
    "    { label: '낡은 단검', description: '공격력 +2', value: 'equip_dagger', emoji: '🗡️' }",
    "  ],",
    "  buttons: [",
    "    {label: '주변 더 조사하기', style: 'primary'},",
    "    {label: '🎯 성향 추천 선택', style: 'secondary'}",
    "  ]})",
    "",
    "EXAMPLE B (freeform):",
    "message(action='send', components={",
    "  scene: 'exploration',",
    "  description: '주변이 고요합니다.',",
    "  buttons: []})",
    "",
    "RULES:",
    "- Buttons: 0-5, variable. No clear actions = no buttons.",
    "- NEVER hallucinate actions that aren't possible.",
    "- Button clicks arrive as the player's next message.",
    "- For 'system', the in-game scene/time does NOT progress.",
].join("\n");
export const NON_GAME_COMPONENT_USAGE_GUIDE = [
    "[TRPG_DISCORD_COMPONENTS_BOOTSTRAP]",
    "Character setup phase UI (non-game state) must use a bootstrap-only component set.",
    "Before IN_GAME, unify UI/message type as System (scene='system').",
    "Do NOT render game status panel labels or in-game tactical actions in this phase.",
    "Do NOT open inventory as a separate scene/view and do NOT show inventory dropdowns before IN_GAME.",
    "Do NOT show personality recommendation UI/button (e.g., '🎯 성향 추천 선택') before IN_GAME.",
    "In non-IN_GAME, enforce bootstrap/system buttons only and ignore gameplay/tactical button suggestions.",
    "Provide only setup actions:",
    "- 새 캐릭터 시작",
    "- 캐릭터 불러오기",
    "- 초기 정보 유지 (가능하면)",
    "If character_created=false, prioritize create/load guidance.",
    "If character_created=true and bootstrap_complete=false, continue Bootstrap interactive setup flow.",
    "Keep recommendation and free-input handling separated (no duplicate free-input button labels).",
].join("\n");
// Backward-compatible alias for existing imports.
export const COMPONENT_USAGE_GUIDE = GAME_COMPONENT_USAGE_GUIDE;
