import test from "node:test";
import assert from "node:assert/strict";
import {
  CHARACTER_PERSONALITY_PROFILES,
  DIVERGENCE_SCENARIOS,
  DRIFTER_STYLE_PRESETS,
  buildDivergenceSystemPrompt,
  buildScenarioDecisionContext,
  summarizeDivergenceResults,
} from "../helpers/drifter-divergence.mjs";

test("divergence context separates drifter style from character personality", () => {
  const scenario = DIVERGENCE_SCENARIOS[0];
  const personality = CHARACTER_PERSONALITY_PROFILES[0];
  const drifterStyle = DRIFTER_STYLE_PRESETS[1];
  const prompt = buildDivergenceSystemPrompt({ drifterStyle });
  const context = buildScenarioDecisionContext({ scenario, personality, drifterStyle, richness: "rich", preferModal: true });

  assert.match(prompt, /separate from the played character personality/i);
  assert.match(context.visible.originalText, /Character personality:/);
  assert.match(context.visible.originalText, /Drifter behavior style:/);
  assert.equal(context.visible.recommendation.actionId, scenario.recommendationActionId);
  assert.equal(context.visible.modal.customId, `${scenario.id}:modal`);
});

test("rich scenario context carries more grounding than thin context", () => {
  const scenario = DIVERGENCE_SCENARIOS[2];
  const personality = CHARACTER_PERSONALITY_PROFILES[2];
  const thin = buildScenarioDecisionContext({ scenario, personality, richness: "thin" });
  const rich = buildScenarioDecisionContext({ scenario, personality, richness: "rich" });

  assert.ok(rich.visible.originalText.length > thin.visible.originalText.length);
  assert.match(rich.visible.originalText, /Taking it could make you rich, cursed, hunted, or all three/i);
});

test("divergence summary reports context-sensitive change when thin and rich differ", () => {
  const summary = summarizeDivergenceResults([
    {
      scenarioId: "sudden-intimacy",
      personalityId: "wounded-romantic",
      richness: "thin",
      recommendationActionId: "action.listen",
      selection: { type: "modal", customId: "sudden-intimacy:modal", freeInput: "솔직히 네 마음을 묻는다" },
    },
    {
      scenarioId: "sudden-intimacy",
      personalityId: "wounded-romantic",
      richness: "rich",
      recommendationActionId: "action.listen",
      selection: { type: "button", customId: "sudden-intimacy:action.flirt", actionId: "action.flirt" },
    },
    {
      scenarioId: "hostage-escape",
      personalityId: "cold-strategist",
      richness: "thin",
      recommendationActionId: "action.talk",
      selection: { type: "button", customId: "hostage-escape:action.talk", actionId: "action.talk", label: "시간을 번다" },
    },
    {
      scenarioId: "hostage-escape",
      personalityId: "cold-strategist",
      richness: "rich",
      recommendationActionId: "action.talk",
      selection: { type: "modal", customId: "hostage-escape:modal", freeInput: "상대를 말로 묶고 천창으로 신호를 보낸다" },
    },
  ]);

  assert.equal(summary.verdict, "context_or_personality_affects_behavior");
  assert.equal(summary.totals.pairCount, 2);
  assert.equal(summary.totals.changedActions, 2);
  assert.ok(summary.richnessSummary.find((entry) => entry.richness === "rich").uniqueActions >= 2);
});
