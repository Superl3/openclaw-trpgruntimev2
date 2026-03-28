function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function dedupeByKey(entries, keyFn) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const key = keyFn(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

export const DIVERGENCE_SCENARIOS = [
  {
    id: "sudden-intimacy",
    title: "Sudden Intimacy",
    dramaticQuestion: "Do you lean in, redirect, withdraw, or exploit the emotional opening?",
    pressure: "low but emotionally volatile",
    buttonOptions: [
      { actionId: "action.listen", label: "조용히 듣는다" },
      { actionId: "action.flirt", label: "마음을 열어 본다" },
      { actionId: "action.deflect", label: "농담으로 넘긴다" },
      { actionId: "action.leave", label: "거리를 둔다" },
    ],
    recommendationActionId: "action.listen",
    modalPrompt: "What do you actually say back?",
    modalFallback: "네 얘기, 더 듣고 싶어.",
    thinBeat: "Rainy inn. A dangerous stranger suddenly admits they have been thinking about you all week.",
    richBeat: [
      "Rain hammers the shutters of a near-empty harbor inn.",
      "Mira, a knife-calm smuggler who once sold you out to save her brother, sits too close and says she has thought about you every night since the betrayal.",
      "She is not armed, her eyes are wet, and if she is lying she is doing it with terrifying precision.",
      "Outside, dawn departure means this may be the last private minute you get before the city turns hostile again.",
      "Any move here changes trust, leverage, and future danger.",
    ].join(" "),
  },
  {
    id: "hostage-escape",
    title: "Hostage Escape",
    dramaticQuestion: "Do you negotiate, feint, rush, abandon, or sacrifice something to escape?",
    pressure: "high and immediate",
    buttonOptions: [
      { actionId: "action.talk", label: "시간을 번다" },
      { actionId: "action.rush", label: "급습한다" },
      { actionId: "action.cut-losses", label: "희생을 감수한다" },
      { actionId: "action.signal", label: "은밀히 신호를 보낸다" },
    ],
    recommendationActionId: "action.talk",
    modalPrompt: "What exactly is your move?",
    modalFallback: "시선을 끌며 틈을 만든다.",
    thinBeat: "Warehouse standoff. An ally is held at knifepoint near the only open exit.",
    richBeat: [
      "An oil-lit warehouse reeks of salt, blood, and lamp smoke.",
      "Your younger ally Joon is on his knees with a hooked blade under his jaw; the captor is nervous, wounded, and close to panicking.",
      "A side door is barred, a skylight above is cracked, and the tide is rising under the floorboards.",
      "Three smugglers are outside arguing about whether to torch the place.",
      "If you hesitate too long, the hostage may die; if you rush, everyone may die.",
    ].join(" "),
  },
  {
    id: "stealable-treasure",
    title: "Stealable Treasure",
    dramaticQuestion: "Do you steal, inspect, replace, confess, or leave the bait alone?",
    pressure: "medium, morally tempting",
    buttonOptions: [
      { actionId: "action.inspect", label: "함정을 살핀다" },
      { actionId: "action.steal", label: "훔친다" },
      { actionId: "action.swap", label: "가짜와 바꿔친다" },
      { actionId: "action.leave", label: "건드리지 않는다" },
    ],
    recommendationActionId: "action.inspect",
    modalPrompt: "Describe your actual approach.",
    modalFallback: "먼저 숨은 장치를 찾는다.",
    thinBeat: "A jewel idol sits unguarded in a shrine alcove. It looks easy to take.",
    richBeat: [
      "Moonlight cuts through the broken shrine roof onto a gold-and-lapis idol no bigger than both hands together.",
      "The villagers call it a famine charm; your employer called it payment enough to clear every debt you owe.",
      "There are no guards, which is suspicious. The dust around the pedestal is disturbed by one barefoot child-sized print and one heavy boot print.",
      "You can hear distant bells from patrols outside and smell fresh incense, meaning someone was here moments ago.",
      "Taking it could make you rich, cursed, hunted, or all three.",
    ].join(" "),
  },
  {
    id: "mercy-kill-secret",
    title: "Mercy Kill Secret",
    dramaticQuestion: "Do you comfort, expose, kill, lie, or search for another way?",
    pressure: "high, ethically corrosive",
    buttonOptions: [
      { actionId: "action.comfort", label: "안심시킨다" },
      { actionId: "action.expose", label: "진실을 드러낸다" },
      { actionId: "action.finish", label: "끝낸다" },
      { actionId: "action.search", label: "다른 길을 찾는다" },
    ],
    recommendationActionId: "action.search",
    modalPrompt: "What do you say or do?",
    modalFallback: "잠깐 버텨, 다른 방법을 찾을게.",
    thinBeat: "A plague-struck noble begs you to kill them before their family sees what they are becoming.",
    richBeat: [
      "In a locked observatory, Lord Han coughs black bloom-spores into a silk handkerchief and begs you to kill him before his daughter arrives.",
      "He financed the militia that burned your district last winter, but he also secretly paid for refugees to escape afterward.",
      "The cure notes are incomplete on the desk, the daughter is running up the stairs, and the infection twitches under his skin whenever the bells ring.",
      "If she sees him like this, she may expose the whole scandal. If you kill him, you become his final accomplice.",
    ].join(" "),
  },
];

export const CHARACTER_PERSONALITY_PROFILES = [
  {
    id: "duty-bound-guard",
    label: "Duty-bound guard",
    traits: ["protective", "disciplined", "self-sacrificing"],
    drives: ["minimize collateral harm", "keep promises"],
    faults: ["emotionally repressed", "overvalues obligation"],
  },
  {
    id: "hungry-opportunist",
    label: "Hungry opportunist",
    traits: ["ambitious", "resourceful", "risk-tolerant"],
    drives: ["escape poverty", "gain leverage fast"],
    faults: ["greedy under stress", "trusts charm too easily"],
  },
  {
    id: "wounded-romantic",
    label: "Wounded romantic",
    traits: ["yearning", "empathetic", "impulsive in intimacy"],
    drives: ["be seen truthfully", "protect fragile bonds"],
    faults: ["confuses pain with sincerity", "slow to leave toxic situations"],
  },
  {
    id: "cold-strategist",
    label: "Cold strategist",
    traits: ["analytical", "composed", "manipulative when needed"],
    drives: ["maintain control", "convert chaos into advantage"],
    faults: ["underweights human cost", "withholds vulnerability"],
  },
];

export const DRIFTER_STYLE_PRESETS = [
  {
    id: "neutral-observer",
    label: "Neutral observer",
    instruction: "As drifter, be behaviorally legible and decisive, but do not flatten the character into recommendation-following autopilot.",
  },
  {
    id: "curiosity-forward",
    label: "Curiosity-forward",
    instruction: "As drifter, privilege surprising but coherent moves that reveal motive, tension, or hidden leverage.",
  },
  {
    id: "pressure-cooker",
    label: "Pressure-cooker",
    instruction: "As drifter, respect danger and urgency, but still allow personality to bend the decision rather than defaulting to safety every time.",
  },
];

export function personalityCard(profile) {
  return [
    `Character personality: ${profile.label}`,
    `Traits: ${profile.traits.join(", ")}`,
    `Drives: ${profile.drives.join(", ")}`,
    `Faults: ${profile.faults.join(", ")}`,
  ].join("\n");
}

export function buildDivergenceSystemPrompt({ drifterStyle, append = "" } = {}) {
  const parts = [
    "You are a TRPG player action selector, not a narrator.",
    "Choose exactly one visible valid action only.",
    "Use only visible customId values.",
    "Prefer choices that express a distinct character motive instead of collapsing into autopilot safety.",
    "Treat drifter behavior style as separate from the played character personality described in the scene.",
    "If a modal is chosen, freeInput must sound like an in-world player action or spoken line, not UI commentary.",
    drifterStyle?.instruction || "",
    append,
  ].filter(Boolean);
  return parts.join(" ");
}

export function buildScenarioDecisionContext({ scenario, personality, richness = "rich", drifterStyle = null, preferModal = true }) {
  const beatText = richness === "thin" ? scenario.thinBeat : scenario.richBeat;
  const originalText = [
    `[Scenario: ${scenario.title}]`,
    `Dramatic question: ${scenario.dramaticQuestion}`,
    `Pressure: ${scenario.pressure}`,
    personalityCard(personality),
    drifterStyle ? `Drifter behavior style: ${drifterStyle.label}` : "",
    "Visible world context:",
    beatText,
    "Visible actions:",
    ...scenario.buttonOptions.map((entry, index) => `${index + 1}. ${entry.label} (actionId=${entry.actionId})`),
    `Recommendation exists but is optional: ${scenario.recommendationActionId}`,
    `Free-input is allowed: ${scenario.modalPrompt}`,
  ].filter(Boolean).join("\n");

  return {
    visible: {
      originalText,
      textSummary: [
        `${scenario.title}`,
        `pressure=${scenario.pressure}`,
        `character=${personality.label}`,
        `drifter=${drifterStyle?.label || "neutral"}`,
        beatText,
      ].join(" | "),
      buttons: scenario.buttonOptions.map((entry) => ({
        customId: `${scenario.id}:${entry.actionId}`,
        actionId: entry.actionId,
        label: entry.label,
      })),
      modal: {
        customId: `${scenario.id}:modal`,
        title: `${scenario.title} — direct intent`,
        label: scenario.modalPrompt,
        actionId: "action.free_input.submit",
        fieldLabels: [scenario.modalPrompt],
      },
      recommendation: {
        actionId: scenario.recommendationActionId,
      },
      metadata: preferModal ? { preferModal: true } : {},
    },
    metadata: preferModal ? { preferModal: true } : {},
  };
}

function normalizeSelection(selection) {
  if (!selection || typeof selection !== "object") {
    return { type: "unknown", routeKey: "unknown", freeInput: "" };
  }
  const type = normalizeText(selection.type) || "unknown";
  const customId = normalizeText(selection.customId);
  const routeKey = customId || "unknown";
  const freeInput = normalizeText(selection.freeInput);
  return { type, routeKey, freeInput };
}

function actionFingerprint(result) {
  const selection = normalizeSelection(result?.selection);
  return `${selection.type}:${selection.routeKey}`;
}

function lexicalFingerprint(result) {
  const selection = normalizeSelection(result?.selection);
  const text = selection.freeInput.toLowerCase().replace(/\s+/g, " ").trim();
  return text || "(none)";
}

function entropyFromCounts(counts, total) {
  if (!Number.isFinite(total) || total <= 0) return 0;
  let entropy = 0;
  for (const count of counts) {
    const p = count / total;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return Number(entropy.toFixed(3));
}

function jaccardDistance(a, b) {
  const left = new Set(a);
  const right = new Set(b);
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  return Number((1 - intersection / union.size).toFixed(3));
}

export function summarizeDivergenceResults(results) {
  const normalized = Array.isArray(results) ? results : [];
  const byRichness = new Map();
  const byScenarioRichness = new Map();
  const byScenarioProfile = new Map();

  for (const entry of normalized) {
    const richness = normalizeText(entry?.richness) || "unknown";
    const scenarioId = normalizeText(entry?.scenarioId) || "unknown";
    const personalityId = normalizeText(entry?.personalityId) || "unknown";
    const actionKey = actionFingerprint(entry);
    const lexicalKey = lexicalFingerprint(entry);
    const recommended = normalizeText(entry?.recommendationActionId);
    const selectedActionId = normalizeText(entry?.selection?.actionId) || normalizeText(entry?.selection?.customId).split(":").slice(-1)[0] || "";
    const acceptedRecommendation = recommended && selectedActionId && (selectedActionId === recommended || normalizeText(entry?.selection?.label).includes("추천"));

    if (!byRichness.has(richness)) byRichness.set(richness, []);
    byRichness.get(richness).push({ actionKey, lexicalKey, acceptedRecommendation });

    const scenarioRichnessKey = `${scenarioId}::${richness}`;
    if (!byScenarioRichness.has(scenarioRichnessKey)) byScenarioRichness.set(scenarioRichnessKey, []);
    byScenarioRichness.get(scenarioRichnessKey).push({ actionKey, lexicalKey, acceptedRecommendation, personalityId });

    const scenarioProfileKey = `${scenarioId}::${personalityId}`;
    if (!byScenarioProfile.has(scenarioProfileKey)) byScenarioProfile.set(scenarioProfileKey, {});
    byScenarioProfile.get(scenarioProfileKey)[richness] = { actionKey, lexicalKey };
  }

  const richnessSummary = Array.from(byRichness.entries()).map(([richness, entries]) => {
    const actionCounts = new Map();
    const lexicalCounts = new Map();
    let recommendationAccepts = 0;
    for (const entry of entries) {
      actionCounts.set(entry.actionKey, (actionCounts.get(entry.actionKey) || 0) + 1);
      lexicalCounts.set(entry.lexicalKey, (lexicalCounts.get(entry.lexicalKey) || 0) + 1);
      if (entry.acceptedRecommendation) recommendationAccepts += 1;
    }
    return {
      richness,
      samples: entries.length,
      uniqueActions: actionCounts.size,
      uniqueLexicalOutputs: lexicalCounts.size,
      actionEntropy: entropyFromCounts(Array.from(actionCounts.values()), entries.length),
      lexicalEntropy: entropyFromCounts(Array.from(lexicalCounts.values()), entries.length),
      recommendationAcceptanceRate: entries.length > 0 ? Number((recommendationAccepts / entries.length).toFixed(3)) : 0,
    };
  }).sort((a, b) => a.richness.localeCompare(b.richness));

  const scenarioSummary = Array.from(byScenarioRichness.entries()).map(([key, entries]) => {
    const [scenarioId, richness] = key.split("::");
    return {
      scenarioId,
      richness,
      samples: entries.length,
      uniqueActions: new Set(entries.map((entry) => entry.actionKey)).size,
      uniqueLexicalOutputs: new Set(entries.map((entry) => entry.lexicalKey)).size,
      personalitiesCovered: dedupeByKey(entries, (entry) => entry.personalityId).length,
    };
  }).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));

  const pairwise = [];
  for (const [key, pair] of byScenarioProfile.entries()) {
    if (!pair.thin || !pair.rich) continue;
    const [scenarioId, personalityId] = key.split("::");
    pairwise.push({
      scenarioId,
      personalityId,
      actionChanged: pair.thin.actionKey !== pair.rich.actionKey,
      lexicalChanged: pair.thin.lexicalKey !== pair.rich.lexicalKey,
      thinAction: pair.thin.actionKey,
      richAction: pair.rich.actionKey,
      thinLexical: pair.thin.lexicalKey,
      richLexical: pair.rich.lexicalKey,
    });
  }

  const thinActions = (byRichness.get("thin") || []).map((entry) => entry.actionKey);
  const richActions = (byRichness.get("rich") || []).map((entry) => entry.actionKey);
  const thinLexical = (byRichness.get("thin") || []).map((entry) => entry.lexicalKey);
  const richLexical = (byRichness.get("rich") || []).map((entry) => entry.lexicalKey);

  const changedActions = pairwise.filter((entry) => entry.actionChanged).length;
  const changedLexical = pairwise.filter((entry) => entry.lexicalChanged).length;
  const pairCount = pairwise.length;

  const verdict = pairCount === 0
    ? "insufficient_pairs"
    : changedActions / pairCount >= 0.4 || changedLexical / pairCount >= 0.6
    ? "context_or_personality_affects_behavior"
    : "behavior_still_collapsed";

  return {
    totals: {
      samples: normalized.length,
      pairCount,
      changedActions,
      changedLexical,
      actionChangeRate: pairCount > 0 ? Number((changedActions / pairCount).toFixed(3)) : 0,
      lexicalChangeRate: pairCount > 0 ? Number((changedLexical / pairCount).toFixed(3)) : 0,
      richnessActionSetDistance: jaccardDistance(thinActions, richActions),
      richnessLexicalSetDistance: jaccardDistance(thinLexical, richLexical),
    },
    verdict,
    richnessSummary,
    scenarioSummary,
    pairwise,
  };
}
