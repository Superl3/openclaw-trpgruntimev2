function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function lower(value) {
  return asText(value).toLowerCase();
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function ratio(numerator, denominator) {
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

function hasMetaLanguage(text) {
  const normalized = lower(text);
  if (!normalized) return false;
  return [
    "fallback",
    "json",
    "model",
    "구조화",
    "형식",
    "customid",
    "actionid",
    "button",
    "modal",
    "패널",
    "추천 action",
    "visible",
    "tool",
    "schema",
  ].some((token) => normalized.includes(token));
}

function isFallbackTurn(transcript) {
  const contractStatus = lower(transcript?.sent?.audit?.contractStatus);
  if (contractStatus === "fallback_unambiguous") {
    return true;
  }
  const decisionSource = lower(transcript?.sent?.decisionSource);
  if (decisionSource === "fallback") {
    return true;
  }
  const reason = lower(transcript?.sent?.reason);
  return reason.includes("fallback") || reason.includes("안전 fallback");
}

function isRecommendedSelection(transcript) {
  const label = asText(transcript?.sent?.label);
  return label.includes("추천");
}

function actionIdentity(transcript) {
  return asText(transcript?.sent?.actionId) || asText(transcript?.sent?.customId) || "unknown";
}

function availableContextLines(transcript) {
  const text = asText(transcript?.received?.textSummary) || asText(transcript?.received?.originalText);
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function scoreDimension({ name, score, rationale, evidence, focus }) {
  const normalized = clamp01(score);
  const status = normalized >= 0.8 ? "good" : normalized >= 0.55 ? "watch" : "poor";
  return {
    name,
    status,
    score: Number(normalized.toFixed(3)),
    rationale,
    evidence,
    focus,
  };
}

function normalizeValidity(validity) {
  if (!validity || typeof validity !== "object") {
    return {
      ok: true,
      issueCount: 0,
      issues: [],
      summary: { errors: 0, warnings: 0 },
    };
  }

  const issues = safeArray(validity.issues);
  const errors = Number.isFinite(validity?.summary?.errors)
    ? validity.summary.errors
    : issues.filter((entry) => entry?.level === "error").length;
  const warnings = Number.isFinite(validity?.summary?.warnings)
    ? validity.summary.warnings
    : issues.filter((entry) => entry?.level === "warn").length;

  return {
    ok: validity.ok === true,
    issueCount: issues.length,
    issues,
    summary: { errors, warnings },
  };
}

function pushCriterion(list, code, message) {
  list.push({ code, message });
}

export function buildDrifterTuningChecklist() {
  return [
    "Gate on smoke-session validity first; never interpret drifter quality from an invalid report.",
    "Measure fallback/invalid pressure before tuning creativity.",
    "Check modal vs button choice fit: direct-input scenarios should stay modal and freeInput should be in-world, not meta.",
    "Check meta vs in-world separation in reasons and freeInput.",
    "Track recommendation acceptance, but treat blind acceptance and total rejection as separate smells.",
    "Track repeated-route streaks so stability does not collapse into autopilot.",
    "Prefer shadow recommendations and audit output before enabling any auto-apply path.",
  ];
}

export function buildDrifterFeedbackAudit(report) {
  const turnTranscripts = safeArray(report?.turnTranscripts);
  const proposals = safeArray(report?.proposals);
  const laneIssues = safeArray(report?.laneIssues);
  const totalTurns = turnTranscripts.length;

  let okTurns = 0;
  let recoveredTurns = 0;
  let modalTurns = 0;
  let buttonTurns = 0;
  let freeInputTurns = 0;
  let metaFreeInputTurns = 0;
  let explicitReasonTurns = 0;
  let metaReasonTurns = 0;
  let fallbackTurns = 0;
  let recommendedTurns = 0;
  let repeatedActionMaxStreak = 0;
  let currentStreak = 0;
  let lastAction = null;
  let contextRichTurns = 0;

  for (const transcript of turnTranscripts) {
    if (transcript?.response?.ok === true) okTurns += 1;
    if (transcript?.recovered === true) recoveredTurns += 1;

    const sentType = asText(transcript?.sent?.type);
    if (sentType === "modal") modalTurns += 1;
    if (sentType === "button") buttonTurns += 1;

    const freeInput = asText(transcript?.sent?.freeInput);
    if (freeInput) {
      freeInputTurns += 1;
      if (hasMetaLanguage(freeInput)) metaFreeInputTurns += 1;
    }

    const reason = asText(transcript?.sent?.reason);
    if (reason) {
      explicitReasonTurns += 1;
      if (hasMetaLanguage(reason)) metaReasonTurns += 1;
    }

    if (isFallbackTurn(transcript)) fallbackTurns += 1;
    if (isRecommendedSelection(transcript)) recommendedTurns += 1;

    const action = actionIdentity(transcript);
    if (action === lastAction) currentStreak += 1;
    else {
      lastAction = action;
      currentStreak = 1;
    }
    repeatedActionMaxStreak = Math.max(repeatedActionMaxStreak, currentStreak);

    const lines = availableContextLines(transcript);
    if (lines.some((line) => /추천 근거|퀘스트|압력|시간\/기억|정보 신선도|잔여 흔적|지역 상태/.test(line))) {
      contextRichTurns += 1;
    }
  }

  const invalidSignals = proposals.filter((proposal) => safeArray(proposal?.reasons).some((reason) => /invalid/i.test(String(reason)))).length;
  const staleSignals = proposals.filter((proposal) => safeArray(proposal?.reasons).some((reason) => /stale/i.test(String(reason)))).length;
  const laneSignalCount = laneIssues.length;

  const okRate = ratio(okTurns, totalTurns) ?? 0;
  const fallbackRate = ratio(fallbackTurns, totalTurns) ?? 0;
  const metaReasonRate = ratio(metaReasonTurns, explicitReasonTurns) ?? 0;
  const metaFreeInputRate = ratio(metaFreeInputTurns, freeInputTurns) ?? 0;
  const recommendationRate = ratio(recommendedTurns, totalTurns) ?? 0;
  const contextRate = ratio(contextRichTurns, totalTurns) ?? 0;
  const clarityRate = ratio(explicitReasonTurns - metaReasonTurns, totalTurns) ?? 0;
  const repetitionPenalty = totalTurns > 0 ? Math.max(0, repeatedActionMaxStreak - 2) / Math.max(1, totalTurns - 1) : 0;
  const modalInWorldRate = freeInputTurns > 0 ? 1 - metaFreeInputRate : null;

  const dimensions = [
    scoreDimension({
      name: "routing_reliability",
      score: okRate - (recoveredTurns > 0 ? 0.1 : 0) - (staleSignals > 0 ? 0.15 : 0),
      rationale: "Drifter should reliably convert visible UI into valid interactions without stale or recovery-heavy behavior.",
      evidence: { totalTurns, okTurns, recoveredTurns, staleSignals },
      focus: recoveredTurns > 0 || staleSignals > 0 ? "Reduce stale/retry pressure before tuning creativity." : "Healthy enough for deeper tuning.",
    }),
    scoreDimension({
      name: "fallback_discipline",
      score: 1 - Math.min(1, fallbackRate + invalidSignals / Math.max(1, totalTurns)),
      rationale: "Fallback is useful as a safety net, but high fallback pressure means you are not actually observing drifter behavior.",
      evidence: { totalTurns, fallbackTurns, fallbackRate: Number(fallbackRate.toFixed(3)), invalidSignals },
      focus: fallbackRate > 0.2 ? "Tighten output contract and response compactness first." : "Fallback pressure is acceptable.",
    }),
    scoreDimension({
      name: "modal_choice_fit",
      score: modalInWorldRate === null ? 0.7 : modalInWorldRate,
      rationale: "When drifter uses freeform input, the content should stay in-world rather than talking about buttons, JSON, or routing.",
      evidence: { modalTurns, freeInputTurns, metaFreeInputTurns, modalInWorldRate },
      focus: metaFreeInputTurns > 0 ? "Rewrite prompt examples so modal text expresses player intent, not UI mechanics." : "Modal usage looks grounded.",
    }),
    scoreDimension({
      name: "meta_vs_in_world_separation",
      score: 1 - Math.min(1, (metaReasonRate * 0.7) + (metaFreeInputRate * 0.3)),
      rationale: "Good smoke feedback should distinguish evaluator meta from player-facing in-world intent.",
      evidence: { explicitReasonTurns, metaReasonTurns, freeInputTurns, metaFreeInputTurns },
      focus: metaReasonRate > 0.5 || metaFreeInputRate > 0 ? "Separate audit/explanation channels from player-intent output." : "Meta leakage is under control.",
    }),
    scoreDimension({
      name: "recommendation_balance",
      score: recommendationRate > 0.9 || recommendationRate === 0 ? 0.45 : recommendationRate >= 0.2 ? 0.85 : 0.65,
      rationale: "Recommendations should be usable, but blind acceptance or total rejection both hide true evaluator quality.",
      evidence: { totalTurns, recommendedTurns, recommendationRate: Number(recommendationRate.toFixed(3)) },
      focus: recommendationRate > 0.9 ? "Drifter may be over-following recommendations." : recommendationRate === 0 ? "Drifter may be ignoring safe recommendation guidance." : "Recommendation usage looks balanced enough.",
    }),
    scoreDimension({
      name: "feedback_clarity",
      score: Math.max(clarityRate, contextRate * 0.6) - repetitionPenalty,
      rationale: "Useful tuning feedback should explain choices clearly and show some use of visible panel/state context.",
      evidence: {
        clarityRate: Number(clarityRate.toFixed(3)),
        contextRate: Number(contextRate.toFixed(3)),
        repeatedActionMaxStreak,
      },
      focus: clarityRate < 0.3 ? "Collect or synthesize cleaner human-readable reasons before trusting qualitative conclusions." : "Reason clarity is serviceable.",
    }),
  ];

  const overallScore = Number((dimensions.reduce((sum, dimension) => sum + dimension.score, 0) / Math.max(1, dimensions.length)).toFixed(3));
  const gate = overallScore >= 0.8 && fallbackRate <= 0.2 && laneSignalCount === 0
    ? "ready_for_behavior_tuning"
    : overallScore >= 0.6
    ? "shadow_tuning_only"
    : "fix_feedback_quality_first";

  const topFindings = [];
  if (fallbackRate > 0.2) topFindings.push("Fallback pressure is too high to treat the run as strong evidence of drifter behavior.");
  if (metaReasonRate > 0.5 || metaFreeInputRate > 0) topFindings.push("Meta language is leaking into feedback or modal input; split evaluator notes from player intent.");
  if (recommendationRate > 0.9) topFindings.push("Recommendation acceptance is near-automatic, so the run may be measuring the recommender more than drifter.");
  if (repeatedActionMaxStreak >= 3) topFindings.push("Repeated route streak suggests stable behavior may have collapsed into autopilot.");
  if (topFindings.length === 0) topFindings.push("No critical feedback-quality smell detected in this sample; continue collecting broader scenario coverage.");

  const roadmap = [
    "Keep improve mode on shadow while collecting feedback-quality audits.",
    "Prioritize fallback/meta leakage fixes before exploration-vs-variety tuning.",
    "Only compare prompt/profile tweaks against runs that pass smoke-session validity and reach at least shadow_tuning_only.",
    "Add more scenario coverage once modal choice fit and recommendation balance stabilize.",
  ];

  return {
    version: 1,
    summary: {
      totalTurns,
      overallScore,
      gate,
      topFindings,
    },
    metrics: {
      okTurns,
      recoveredTurns,
      buttonTurns,
      modalTurns,
      freeInputTurns,
      fallbackTurns,
      recommendedTurns,
      explicitReasonTurns,
      metaReasonTurns,
      metaFreeInputTurns,
      repeatedActionMaxStreak,
      laneSignalCount,
    },
    dimensions,
    checklist: buildDrifterTuningChecklist(),
    roadmap,
  };
}

export function buildDrifterStopCriteria(report, options = {}) {
  const validity = normalizeValidity(options.validity);
  const audit = options.audit && typeof options.audit === "object"
    ? options.audit
    : buildDrifterFeedbackAudit(report);

  const totalTurns = Number.isFinite(audit?.summary?.totalTurns) ? audit.summary.totalTurns : safeArray(report?.turnTranscripts).length;
  const fallbackTurns = Number.isFinite(audit?.metrics?.fallbackTurns) ? audit.metrics.fallbackTurns : 0;
  const metaReasonTurns = Number.isFinite(audit?.metrics?.metaReasonTurns) ? audit.metrics.metaReasonTurns : 0;
  const explicitReasonTurns = Number.isFinite(audit?.metrics?.explicitReasonTurns) ? audit.metrics.explicitReasonTurns : 0;
  const metaFreeInputTurns = Number.isFinite(audit?.metrics?.metaFreeInputTurns) ? audit.metrics.metaFreeInputTurns : 0;
  const freeInputTurns = Number.isFinite(audit?.metrics?.freeInputTurns) ? audit.metrics.freeInputTurns : 0;
  const recoveredTurns = Number.isFinite(audit?.metrics?.recoveredTurns) ? audit.metrics.recoveredTurns : 0;
  const laneSignalCount = Number.isFinite(audit?.metrics?.laneSignalCount) ? audit.metrics.laneSignalCount : 0;
  const repeatedActionMaxStreak = Number.isFinite(audit?.metrics?.repeatedActionMaxStreak) ? audit.metrics.repeatedActionMaxStreak : 0;
  const gate = asText(audit?.summary?.gate) || "unknown";

  const fallbackRate = ratio(fallbackTurns, totalTurns) ?? 0;
  const metaReasonRate = ratio(metaReasonTurns, explicitReasonTurns) ?? 0;
  const metaFreeInputRate = ratio(metaFreeInputTurns, freeInputTurns) ?? 0;

  const hardStop = [];
  const softStop = [];
  const successStop = [];

  if (validity.ok !== true) {
    pushCriterion(hardStop, "invalid_smoke_session", "Smoke-session validity failed; this run is not structurally trustworthy evidence.");
  }
  if (totalTurns === 0) {
    pushCriterion(hardStop, "no_turn_evidence", "No turn transcripts were captured, so the run cannot be audited as drifter evidence.");
  }

  if (gate === "fix_feedback_quality_first") {
    pushCriterion(softStop, "audit_gate_fix_first", "Feedback-quality audit says to fix harness/feedback quality before extending the run.");
  }
  if (fallbackRate > 0.2) {
    pushCriterion(softStop, "fallback_pressure", "Fallback pressure exceeded 20%, so additional turns mostly measure the safety net.");
  }
  if (metaReasonRate > 0.5 || metaFreeInputTurns > 0) {
    pushCriterion(softStop, "meta_leakage", "Meta/UI language is leaking into reasons or free input, so qualitative observations are degrading.");
  }
  if (laneSignalCount > 0) {
    pushCriterion(softStop, "lane_instability", "Lane issues were observed; stop after the current capture window and fix the lane before more sampling.");
  }
  if (recoveredTurns > 0) {
    pushCriterion(softStop, "recovery_observed", "Recovery/stale handling appeared in the sample; extending the run will mix recovery behavior into evaluation evidence.");
  }
  if (repeatedActionMaxStreak >= 3) {
    pushCriterion(softStop, "autopilot_streak", "A repeated-route streak of 3+ suggests the sample is collapsing into autopilot rather than yielding fresh evidence.");
  }

  if (
    validity.ok === true
    && totalTurns >= 3
    && (gate === "ready_for_behavior_tuning" || gate === "shadow_tuning_only")
    && fallbackRate <= 0.2
    && laneSignalCount === 0
    && metaReasonRate <= 0.5
    && metaFreeInputRate === 0
    && recoveredTurns === 0
  ) {
    pushCriterion(
      successStop,
      gate === "ready_for_behavior_tuning" ? "tuning_ready_sample" : "shadow_quality_sample",
      gate === "ready_for_behavior_tuning"
        ? "Session captured a valid, low-fallback sample that is ready for behavior-tuning comparisons."
        : "Session captured a valid observation-grade sample; stop and file it before chasing more turns."
    );
  }

  let classification = "continue";
  let shouldStop = false;
  let operatorAction = "continue_collecting";
  let primaryReason = "No stop criterion matched yet; keep sampling until a stop class is reached.";

  if (hardStop.length > 0) {
    classification = "hard_stop";
    shouldStop = true;
    operatorAction = "discard_run_and_fix_plumbing";
    primaryReason = hardStop[0].message;
  } else if (successStop.length > 0) {
    classification = "success_stop";
    shouldStop = true;
    operatorAction = "archive_run_and_compare_against_other_valid_runs";
    primaryReason = successStop[0].message;
  } else if (softStop.length > 0) {
    classification = "soft_stop";
    shouldStop = true;
    operatorAction = "stop_after_current_window_and_fix_feedback_quality";
    primaryReason = softStop[0].message;
  }

  const usageGuidance = {
    hard_stop: "Abort interpretation immediately. Do not tune prompts/profiles from this run. Fix validity/plumbing, then rerun.",
    soft_stop: "Finish the current capture window, then stop. Save the report as diagnostic evidence, but do not extend the same run for more behavioral conclusions.",
    success_stop: "Stop on purpose. Save the run, cite the audit payload, and compare future changes only against other success-stop runs.",
    continue: "Keep collecting until you either have a valid success sample or a clear reason to soft-stop.",
  };

  return {
    version: 1,
    summary: {
      classification,
      shouldStop,
      operatorAction,
      primaryReason,
    },
    criteria: {
      hardStop,
      softStop,
      successStop,
    },
    evidence: {
      validityOk: validity.ok,
      validityIssueCount: validity.issueCount,
      validityErrorCount: validity.summary.errors,
      validityWarningCount: validity.summary.warnings,
      auditGate: gate,
      totalTurns,
      fallbackTurns,
      fallbackRate: Number(fallbackRate.toFixed(3)),
      metaReasonRate: Number(metaReasonRate.toFixed(3)),
      metaFreeInputRate: Number(metaFreeInputRate.toFixed(3)),
      recoveredTurns,
      laneSignalCount,
      repeatedActionMaxStreak,
    },
    usageGuidance,
  };
}
