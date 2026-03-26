function toFiniteNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeEvent(payload) {
  if (!payload || typeof payload !== "object") {
    return { event: "unknown" };
  }
  return payload;
}

export function buildTuningProposal(metrics) {
  const safeMetrics = metrics && typeof metrics === "object" ? metrics : {};
  const turnCount = Number.isFinite(safeMetrics.turnCount) ? safeMetrics.turnCount : 0;
  const llmInvalidCount = Number.isFinite(safeMetrics.llmInvalidCount) ? safeMetrics.llmInvalidCount : 0;
  const llmFallbackCount = Number.isFinite(safeMetrics.llmFallbackCount) ? safeMetrics.llmFallbackCount : 0;
  const staleRecoverCount = Number.isFinite(safeMetrics.staleRecoverCount) ? safeMetrics.staleRecoverCount : 0;
  const llmLaneErrorCount = Number.isFinite(safeMetrics.llmLaneErrorCount) ? safeMetrics.llmLaneErrorCount : 0;
  const repeatedSelectionStreak = Number.isFinite(safeMetrics.repeatedSelectionStreak)
    ? safeMetrics.repeatedSelectionStreak
    : 0;

  if (turnCount <= 0) {
    return null;
  }

  const reasons = [];
  const suggestedSettings = {};
  const promptAppendLines = [];

  if (llmInvalidCount > 0 || llmFallbackCount > 0) {
    reasons.push(`llm invalid/fallback observed (invalid=${llmInvalidCount}, fallback=${llmFallbackCount})`);
    suggestedSettings.temperature = 0;
    suggestedSettings.topP = 0.05;
    promptAppendLines.push(
      "Return strict JSON only using one visible customId. If uncertain, follow the recommendation actionId and do not invent fields.",
    );
  }

  if (llmFallbackCount >= 2 || llmInvalidCount >= 2) {
    suggestedSettings.maxTokens = 160;
  }

  if (staleRecoverCount > 0) {
    reasons.push(`stale recover observed (${staleRecoverCount})`);
    suggestedSettings.maxTokens = Number.isFinite(suggestedSettings.maxTokens)
      ? Math.min(suggestedSettings.maxTokens, 140)
      : 140;
    promptAppendLines.push("Prefer compact decisions and avoid extra prose to reduce delayed or stale interactions.");
  }

  if (llmLaneErrorCount > 0) {
    reasons.push(`llm lane errors observed (${llmLaneErrorCount}); check provider/auth/credits/network status`);
    if (promptAppendLines.length === 0) {
      promptAppendLines.push("Always return one strict JSON selection quickly using only visible customId values.");
    }
  }

  if (repeatedSelectionStreak >= 3 && llmInvalidCount === 0 && llmFallbackCount === 0) {
    reasons.push(`repeated route streak observed (${repeatedSelectionStreak})`);
    suggestedSettings.temperature = 0.15;
    suggestedSettings.topP = 0.2;
    promptAppendLines.push("Avoid repeating the exact same route more than two turns in a row when other safe options are visible.");
  }

  if (promptAppendLines.length > 0) {
    suggestedSettings.systemPromptAppend = promptAppendLines.join(" ");
  }

  if (reasons.length === 0) {
    return null;
  }

  return {
    reasons,
    suggestedSettings,
  };
}

export function applyTuningToProfile(profileObj, proposal) {
  const baseProfile = profileObj && typeof profileObj === "object" ? profileObj : {};
  const safeProposal = proposal && typeof proposal === "object" ? proposal : {};
  const settings = safeProposal.suggestedSettings && typeof safeProposal.suggestedSettings === "object"
    ? safeProposal.suggestedSettings
    : {};

  const next = {
    profileName: typeof baseProfile.profileName === "string" && baseProfile.profileName ? baseProfile.profileName : "gamer-smoke-live",
    version: Number.isFinite(baseProfile.version) ? baseProfile.version : 1,
    lane: typeof baseProfile.lane === "string" && baseProfile.lane ? baseProfile.lane : "openclaw",
    ...baseProfile,
  };

  const nextLlm = {
    ...(baseProfile.llm && typeof baseProfile.llm === "object" ? baseProfile.llm : {}),
  };

  const temperature = toFiniteNumber(settings.temperature);
  const topP = toFiniteNumber(settings.topP);
  const maxTokens = toFiniteNumber(settings.maxTokens);
  const systemPromptAppend = typeof settings.systemPromptAppend === "string" ? settings.systemPromptAppend.trim() : "";

  if (temperature !== null) {
    nextLlm.temperature = temperature;
  }
  if (topP !== null) {
    nextLlm.topP = topP;
  }
  if (maxTokens !== null && maxTokens > 0) {
    nextLlm.maxTokens = Math.trunc(maxTokens);
  }
  if (systemPromptAppend) {
    const existingPrompt = typeof nextLlm.systemPrompt === "string" ? nextLlm.systemPrompt.trim() : "";
    if (!existingPrompt) {
      nextLlm.systemPrompt = systemPromptAppend;
    } else if (!existingPrompt.includes(systemPromptAppend)) {
      nextLlm.systemPrompt = `${existingPrompt}\n\n${systemPromptAppend}`;
    }
  }

  next.llm = nextLlm;
  return next;
}

export class GamerLiveImprover {
  constructor() {
    this.metrics = {
      turnCount: 0,
      llmInvalidCount: 0,
      llmFallbackCount: 0,
      staleRecoverCount: 0,
      llmLaneErrorCount: 0,
      repeatedSelectionStreak: 0,
    };
    this.maxRepeatedSelectionStreak = 0;
    this.lastSelectionCustomId = null;
    this.currentSelectionStreak = 0;
    this.lastEvaluatedSnapshot = {
      turnCount: 0,
      llmInvalidCount: 0,
      llmFallbackCount: 0,
      staleRecoverCount: 0,
      llmLaneErrorCount: 0,
      maxRepeatedSelectionStreak: 0,
    };
  }

  observe(payload) {
    const eventPayload = normalizeEvent(payload);
    const event = eventPayload.event;

    if (event === "turn_end") {
      this.metrics.turnCount += 1;
      return;
    }
    if (event === "llm_choice_invalid") {
      this.metrics.llmInvalidCount += 1;
      return;
    }
    if (event === "llm_choice_fallback") {
      this.metrics.llmFallbackCount += 1;
      return;
    }
    if (event === "stale_recover_result" && eventPayload.ok === true) {
      this.metrics.staleRecoverCount += 1;
      return;
    }
    if (event === "llm_lane_error") {
      this.metrics.llmLaneErrorCount += 1;
      return;
    }
    if (event === "interact_request") {
      const customId = typeof eventPayload.customId === "string" ? eventPayload.customId : null;
      if (!customId) {
        return;
      }
      if (customId === this.lastSelectionCustomId) {
        this.currentSelectionStreak += 1;
      } else {
        this.lastSelectionCustomId = customId;
        this.currentSelectionStreak = 1;
      }
      this.maxRepeatedSelectionStreak = Math.max(this.maxRepeatedSelectionStreak, this.currentSelectionStreak);
      this.metrics.repeatedSelectionStreak = this.maxRepeatedSelectionStreak;
    }
  }

  snapshot() {
    return {
      ...this.metrics,
    };
  }

  evaluateProposal(options = {}) {
    const windowTurnsRaw = Number.parseInt(String(options.windowTurns ?? 3), 10);
    const windowTurns = Number.isFinite(windowTurnsRaw) && windowTurnsRaw > 0 ? windowTurnsRaw : 3;
    const force = options.force === true;

    const turnsSinceLast = this.metrics.turnCount - this.lastEvaluatedSnapshot.turnCount;
    if (!force && turnsSinceLast < windowTurns) {
      return null;
    }
    if (turnsSinceLast <= 0) {
      return null;
    }

    const windowMetrics = {
      turnCount: turnsSinceLast,
      llmInvalidCount: this.metrics.llmInvalidCount - this.lastEvaluatedSnapshot.llmInvalidCount,
      llmFallbackCount: this.metrics.llmFallbackCount - this.lastEvaluatedSnapshot.llmFallbackCount,
      staleRecoverCount: this.metrics.staleRecoverCount - this.lastEvaluatedSnapshot.staleRecoverCount,
      llmLaneErrorCount: this.metrics.llmLaneErrorCount - this.lastEvaluatedSnapshot.llmLaneErrorCount,
      repeatedSelectionStreak: Math.max(
        0,
        this.maxRepeatedSelectionStreak - this.lastEvaluatedSnapshot.maxRepeatedSelectionStreak,
      ),
    };

    this.lastEvaluatedSnapshot = {
      turnCount: this.metrics.turnCount,
      llmInvalidCount: this.metrics.llmInvalidCount,
      llmFallbackCount: this.metrics.llmFallbackCount,
      staleRecoverCount: this.metrics.staleRecoverCount,
      llmLaneErrorCount: this.metrics.llmLaneErrorCount,
      maxRepeatedSelectionStreak: this.maxRepeatedSelectionStreak,
    };

    return buildTuningProposal(windowMetrics);
  }
}
