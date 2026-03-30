import { applyWhimAdjustment } from "./recommendation-whim.js";
const RECOMMEND_WEIGHTS = {
    traitFit: 0.35,
    goalFit: 0.2,
    safetyFit: 0.2,
    pressureFit: 0.15,
    continuityFit: 0.1,
    contextFit: 0.05,
};
function clampUnit(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.min(1, value));
}
function signedToUnit(value) {
    return clampUnit((value + 1) / 2);
}
function fitFromPreference(current, preferred) {
    return clampUnit(1 - Math.abs(current - preferred));
}
function pressureLevel(loop) {
    const tierBias = loop.scene.riskTier === "high" ? 0.08 : loop.scene.riskTier === "medium" ? 0 : -0.08;
    return clampUnit(loop.scene.pressure / 100 + tierBias);
}
function goalLevel(loop) {
    const slots = loop.questEconomy.presentation.hookSlots;
    const topActive = slots.find((slot) => slot.lifecycle === "active" || slot.lifecycle === "stalled") ?? null;
    if (topActive) {
        const byBand = {
            low: 0.25,
            moderate: 0.5,
            high: 0.75,
            critical: 1,
        };
        return {
            level: byBand[topActive.urgencyBand] ?? 0.5,
            label: `활성 과제 urgency=${topActive.urgencyBand}`,
        };
    }
    const avg = loop.questEconomy.presentation.tuning.averageUrgency;
    return { level: clampUnit(avg / 100), label: `퀘스트 평균 긴급도=${String(avg)}` };
}
function traitFit(actionId, loop) {
    const drift = loop.behavioralDrift.drift;
    let raw = 0;
    switch (actionId) {
        case "action.observe":
            raw = drift.caution * 0.6 + drift.altruism * 0.2 - drift.aggression * 0.2;
            break;
        case "action.move":
            raw = drift.boldness * 0.55 + drift.humor * 0.05 - drift.caution * 0.15;
            break;
        case "action.wait":
            raw = drift.caution * 0.6 - drift.boldness * 0.1 - drift.aggression * 0.2;
            break;
        case "action.talk":
            raw = drift.warmth * 0.55 + drift.altruism * 0.3 + drift.humor * 0.1 - drift.aggression * 0.1;
            break;
        case "action.rush":
            raw = drift.aggression * 0.55 + drift.boldness * 0.35 - drift.caution * 0.4;
            break;
        default:
            raw = 0;
            break;
    }
    const fit = signedToUnit(raw);
    return {
        fit,
        weight: RECOMMEND_WEIGHTS.traitFit,
        contribution: fit * RECOMMEND_WEIGHTS.traitFit,
        detail: `성향 적합도=${fit.toFixed(2)}`,
    };
}
function goalFit(actionId, goalUrgency) {
    const preferred = {
        "action.observe": 0.55,
        "action.move": 0.75,
        "action.wait": 0.2,
        "action.talk": 0.45,
        "action.rush": 0.95,
    };
    const fit = fitFromPreference(goalUrgency, preferred[actionId] ?? 0.5);
    return {
        fit,
        weight: RECOMMEND_WEIGHTS.goalFit,
        contribution: fit * RECOMMEND_WEIGHTS.goalFit,
        detail: `목표 적합도=${fit.toFixed(2)}`,
    };
}
function safetyFit(actionId, pressure) {
    const preferred = {
        "action.observe": 0.75,
        "action.move": 0.5,
        "action.wait": 0.65,
        "action.talk": 0.35,
        "action.rush": 0.25,
    };
    const fit = fitFromPreference(pressure, preferred[actionId] ?? 0.5);
    return {
        fit,
        weight: RECOMMEND_WEIGHTS.safetyFit,
        contribution: fit * RECOMMEND_WEIGHTS.safetyFit,
        detail: `안전성 적합도=${fit.toFixed(2)}`,
    };
}
function pressureFit(actionId, pressure) {
    const preferred = {
        "action.observe": 0.45,
        "action.move": 0.7,
        "action.wait": 0.1,
        "action.talk": 0.4,
        "action.rush": 0.9,
    };
    const fit = fitFromPreference(pressure, preferred[actionId] ?? 0.5);
    return {
        fit,
        weight: RECOMMEND_WEIGHTS.pressureFit,
        contribution: fit * RECOMMEND_WEIGHTS.pressureFit,
        detail: `장면 압력 적합도=${fit.toFixed(2)}`,
    };
}
function continuityFit(actionId, loop) {
    let fit = 0.5;
    const recent = loop.analyzerMemory.recentResolvedActions.slice(-3);
    const lastActionId = recent[recent.length - 1] ?? loop.intentInertia.lastMappedActionId;
    const streakCount = lastActionId && lastActionId === actionId ? Math.min(3, loop.intentInertia.streakCount) : 0;
    const highPressure = loop.scene.pressure >= 70;
    if (lastActionId === actionId) {
        fit += streakCount >= 2 ? 0.12 : 0.2;
    }
    if (recent.length >= 2 && recent.every((entry) => entry === actionId)) {
        fit -= actionId === "action.wait" ? 0.18 : 0.08;
        if (highPressure && (actionId === "action.observe" || actionId === "action.wait")) {
            fit -= 0.16;
        }
    }
    if (!highPressure && actionId === "action.observe" && recent[recent.length - 1] === "action.rush") {
        fit += 0.14;
    }
    if (highPressure && loop.exchange?.classification === "reckless" && actionId === "action.move") {
        fit += 0.14;
    }
    if (loop.exchange?.classification === "reckless" && (actionId === "action.observe" || actionId === "action.wait")) {
        fit += highPressure ? 0.04 : 0.12;
    }
    return {
        fit: clampUnit(fit),
        weight: RECOMMEND_WEIGHTS.continuityFit,
        contribution: clampUnit(fit) * RECOMMEND_WEIGHTS.continuityFit,
        detail: `연속성 적합도=${clampUnit(fit).toFixed(2)}`,
    };
}
function contextFit(actionId, loop, paletteEntry) {
    let fit = 0.5;
    const highPressure = loop.scene.pressure >= 70;
    if (!loop.exchange && actionId === "action.observe") {
        fit += 0.2;
    }
    if (loop.scene.phase === "transitioning" && actionId === "action.move") {
        fit += 0.25;
    }
    if (loop.scene.phase === "resolved" && actionId === "action.wait") {
        fit += 0.18;
    }
    if (actionId === "action.talk") {
        fit += loop.scene.npcAvailable ? 0.22 : -0.34;
    }
    if (actionId === "action.wait" && loop.ongoingAction?.status === "in_progress") {
        fit += 0.14;
    }
    if (actionId === "action.wait" && !loop.ongoingAction) {
        fit -= 0.12;
    }
    if (highPressure && actionId === "action.move") {
        fit += 0.18;
    }
    if (highPressure && loop.exchange?.classification === "reckless" && actionId === "action.move") {
        fit += 0.12;
    }
    if (highPressure && actionId === "action.observe") {
        fit -= 0.06;
    }
    if (highPressure && actionId === "action.wait") {
        fit -= 0.24;
    }
    if (actionId === "action.move" &&
        loop.ongoingAction?.status === "in_progress" &&
        loop.ongoingAction.interruptible === false &&
        loop.ongoingAction.kind !== "move") {
        fit -= 0.35;
    }
    if (paletteEntry?.availability === "currently_impossible" || paletteEntry?.availability === "impossible") {
        fit = Math.min(fit, 0.12);
    }
    return {
        fit: clampUnit(fit),
        weight: RECOMMEND_WEIGHTS.contextFit,
        contribution: clampUnit(fit) * RECOMMEND_WEIGHTS.contextFit,
        detail: `상황 맥락 적합도=${clampUnit(fit).toFixed(2)}`,
    };
}
export function recommendationReason(score, sourceLabel, whimEnabled, params) {
    const maxFactors = Math.max(1, Math.min(3, Math.trunc(params?.maxFactors ?? 2)));
    const ranked = Object.entries(score.factors)
        .slice()
        .sort((a, b) => b[1].contribution - a[1].contribution)
        .slice(0, maxFactors);
    const labels = {
        traitFit: "성향",
        goalFit: "목표",
        safetyFit: "안전성",
        pressureFit: "장면 압력",
        continuityFit: "연속성",
        contextFit: "장면 맥락",
    };
    const reasons = ranked.map(([key, value]) => `${labels[key]} ${value.fit.toFixed(2)}`).join(" · ");
    const whimSuffix = whimEnabled && params?.includeWhimDetail
        ? ` · 변덕보정 ${score.whimAdjustment >= 0 ? "+" : ""}${score.whimAdjustment.toFixed(3)}`
        : "";
    if (params?.concise) {
        return `근거: ${reasons}`;
    }
    return `근거: ${reasons} (${sourceLabel})${whimSuffix}`;
}
export function selectRuleBasedActionRecommendation(params) {
    if (params.palette.length === 0) {
        return {
            actionId: null,
            reasonText: null,
            whimEnabled: params.whimEnabled === true,
            scores: [],
        };
    }
    const goal = goalLevel(params.loop);
    const pressure = pressureLevel(params.loop);
    const baseScored = params.palette.map((entry) => {
        const factors = {
            traitFit: traitFit(entry.actionId, params.loop),
            goalFit: goalFit(entry.actionId, goal.level),
            safetyFit: safetyFit(entry.actionId, pressure),
            pressureFit: pressureFit(entry.actionId, goal.level * 0.45 + pressure * 0.55),
            continuityFit: continuityFit(entry.actionId, params.loop),
            contextFit: contextFit(entry.actionId, params.loop, entry),
        };
        const totalScore = Object.values(factors).reduce((sum, factor) => sum + factor.contribution, 0);
        return {
            actionId: entry.actionId,
            baseScore: totalScore,
            whimAdjustment: 0,
            totalScore,
            factors,
            availability: entry.availability,
        };
    });
    const whimEnabled = params.whimEnabled === true;
    const leaderBaseScore = baseScored.reduce((max, row) => Math.max(max, row.baseScore), Number.NEGATIVE_INFINITY);
    const scored = baseScored.map((row) => {
        const whim = applyWhimAdjustment({
            actionId: row.actionId,
            availability: row.availability,
            baseScore: row.baseScore,
            leaderBaseScore,
            riskLevel: pressure,
            config: { enabled: whimEnabled },
        });
        return {
            actionId: row.actionId,
            baseScore: row.baseScore,
            whimAdjustment: whim.adjustment,
            totalScore: whim.adjustedScore,
            factors: row.factors,
        };
    });
    const best = scored.slice().sort((a, b) => b.totalScore - a.totalScore || a.actionId.localeCompare(b.actionId))[0];
    return {
        actionId: best?.actionId ?? null,
        reasonText: best
            ? recommendationReason(best, `${goal.label}, pressure=${pressure.toFixed(2)}`, whimEnabled, {
                concise: params.verboseMode !== true,
                includeWhimDetail: params.verboseMode === true,
                maxFactors: params.verboseMode ? 3 : 2,
            })
            : null,
        whimEnabled,
        scores: scored,
    };
}
export function selectDelegateActionId(params) {
    const palette = (params.palette ?? params.loop.actionPalette)
        .filter((entry) => entry.actionId !== "action.free_input.submit" && entry.actionId !== "action.unknown")
        .filter((entry) => entry.availability !== "currently_impossible" && entry.availability !== "impossible");
    return selectRuleBasedActionRecommendation({ loop: params.loop, palette }).actionId;
}
