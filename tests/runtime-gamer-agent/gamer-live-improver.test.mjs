import assert from "node:assert/strict";
import test from "node:test";
import {
  GamerLiveImprover,
  applyTuningToProfile,
} from "../helpers/gamer-live-improver.mjs";

test("gamer live improver creates proposal from unhealthy event stream", () => {
  const improver = new GamerLiveImprover();

  improver.observe({ event: "llm_choice_invalid" });
  improver.observe({ event: "llm_choice_fallback" });
  improver.observe({ event: "stale_recover_result", ok: true });
  improver.observe({ event: "interact_request", customId: "btn.attack" });
  improver.observe({ event: "interact_request", customId: "btn.attack" });
  improver.observe({ event: "interact_request", customId: "btn.attack" });
  improver.observe({ event: "turn_end" });
  improver.observe({ event: "turn_end" });
  improver.observe({ event: "turn_end" });

  const proposal = improver.evaluateProposal({ windowTurns: 3 });
  assert.ok(proposal);
  assert.ok(Array.isArray(proposal.reasons));
  assert.ok(proposal.reasons.length >= 2);
  assert.equal(proposal.suggestedSettings.temperature, 0);
  assert.equal(proposal.suggestedSettings.topP, 0.05);
  assert.equal(proposal.suggestedSettings.maxTokens, 140);
  assert.equal(typeof proposal.suggestedSettings.systemPromptAppend, "string");
});

test("gamer live improver emits no proposal for healthy window", () => {
  const improver = new GamerLiveImprover();
  improver.observe({ event: "turn_end" });
  improver.observe({ event: "turn_end" });
  improver.observe({ event: "turn_end" });

  const proposal = improver.evaluateProposal({ windowTurns: 3 });
  assert.equal(proposal, null);
});

test("applyTuningToProfile safely merges llm settings", () => {
  const profile = {
    profileName: "gamer-smoke",
    version: 1,
    lane: "openclaw",
    llm: {
      systemPrompt: "Base instruction.",
      timeoutMs: 12000,
      temperature: 0.2,
    },
  };
  const proposal = {
    reasons: ["llm fallback observed"],
    suggestedSettings: {
      temperature: 0,
      topP: 0.05,
      maxTokens: 160,
      systemPromptAppend: "Return strict JSON only.",
    },
  };

  const updated = applyTuningToProfile(profile, proposal);
  assert.equal(updated.llm.temperature, 0);
  assert.equal(updated.llm.topP, 0.05);
  assert.equal(updated.llm.maxTokens, 160);
  assert.equal(updated.llm.timeoutMs, 12000);
  assert.equal(updated.llm.systemPrompt.includes("Base instruction."), true);
  assert.equal(updated.llm.systemPrompt.includes("Return strict JSON only."), true);
});
