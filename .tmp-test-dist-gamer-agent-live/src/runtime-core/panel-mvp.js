import { actionLabelFor, collectButtonActionIds, feasibilityLabel } from "./scene-loop.js";
import { buildQuestEconomyQualitativeSummary } from "./quest-economy.js";
import { buildTemporalQualitativeSummary } from "./temporal-systems.js";
import { buildAnchorQualitativeSummary } from "./anchor-layer.js";
import { applyWhimAdjustment } from "./recommendation-whim.js";
export const PANEL_MODAL_SUBMIT_ACTION_ID = "action.free_input.submit";
const PANEL_RECOMMEND_LABEL = "🎯 성향 추천 선택";
const PANEL_FREE_INPUT_TRIGGER_LABEL = "✏️ 자유 입력";
// Conservative initial weights for deterministic v1 recommendation.
// Requested defaults: trait=0.35, quest=0.20, risk=0.20, time=0.15, resource=0.10.
// contextFit is kept as a small additive weight to avoid over-steering.
const RECOMMEND_WEIGHTS = {
    traitFit: 0.35,
    questUrgency: 0.2,
    riskFit: 0.2,
    timePressure: 0.15,
    resourceFit: 0.1,
    contextFit: 0.05,
};
const PANEL_CUSTOM_ID_PREFIX = "trpg:v1";
function normalizeInt(value, fallback) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.trunc(value);
    }
    if (typeof value === "string" && value.trim()) {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return fallback;
}
function readString(value, fallback = "") {
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
function routeMapByAction(routes) {
    return new Map(routes.map((route) => [route.actionId, route]));
}
function clampUnit(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.min(1, value));
}
function signedToUnit(value) {
    return clampUnit((value + 1) / 2);
}
function riskLevel(session) {
    const loop = session.deterministicLoop;
    const tierBias = loop.scene.riskTier === "high" ? 0.08 : loop.scene.riskTier === "medium" ? 0 : -0.08;
    return clampUnit(loop.scene.pressure / 100 + tierBias);
}
function questUrgencyLevel(session) {
    const slots = session.deterministicLoop.questEconomy.presentation.hookSlots;
    const topActive = slots.find((slot) => slot.lifecycle === "active" || slot.lifecycle === "stalled") ?? null;
    if (topActive) {
        const byBand = {
            low: 0.25,
            moderate: 0.5,
            high: 0.75,
            critical: 1,
        };
        const level = byBand[topActive.urgencyBand] ?? 0.5;
        return { level, label: `활성 과제 urgency=${topActive.urgencyBand}` };
    }
    const avg = session.deterministicLoop.questEconomy.presentation.tuning.averageUrgency;
    return { level: clampUnit(avg / 100), label: `퀘스트 평균 긴급도=${String(avg)}` };
}
function timePressureLevel(session, questUrgency) {
    const loop = session.deterministicLoop;
    const elapsed = clampUnit(loop.time.worldElapsedSec / 2400);
    const ongoing = loop.ongoingAction
        ? clampUnit(loop.ongoingAction.elapsedSec / Math.max(1, loop.ongoingAction.requiredSec))
        : 0;
    const level = clampUnit(questUrgency * 0.45 + elapsed * 0.3 + ongoing * 0.25);
    return {
        level,
        label: `긴급=${questUrgency.toFixed(2)} 누적시간=${elapsed.toFixed(2)} 진행행동=${ongoing.toFixed(2)}`,
    };
}
function traitFit(actionId, session) {
    const drift = session.deterministicLoop.behavioralDrift.drift;
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
function fitFromPreference(current, preferred) {
    return clampUnit(1 - Math.abs(current - preferred));
}
function questUrgencyFit(actionId, urgencyLevel) {
    const preferred = {
        "action.observe": 0.55,
        "action.move": 0.75,
        "action.wait": 0.2,
        "action.talk": 0.45,
        "action.rush": 0.95,
    };
    const fit = fitFromPreference(urgencyLevel, preferred[actionId] ?? 0.5);
    return {
        fit,
        weight: RECOMMEND_WEIGHTS.questUrgency,
        contribution: fit * RECOMMEND_WEIGHTS.questUrgency,
        detail: `퀘스트 긴급 적합도=${fit.toFixed(2)}`,
    };
}
function riskFit(actionId, risk) {
    const preferred = {
        "action.observe": 0.75,
        "action.move": 0.5,
        "action.wait": 0.65,
        "action.talk": 0.35,
        "action.rush": 0.25,
    };
    const fit = fitFromPreference(risk, preferred[actionId] ?? 0.5);
    return {
        fit,
        weight: RECOMMEND_WEIGHTS.riskFit,
        contribution: fit * RECOMMEND_WEIGHTS.riskFit,
        detail: `위험도 적합도=${fit.toFixed(2)}`,
    };
}
function timePressureFit(actionId, pressure) {
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
        weight: RECOMMEND_WEIGHTS.timePressure,
        contribution: fit * RECOMMEND_WEIGHTS.timePressure,
        detail: `시간 압박 적합도=${fit.toFixed(2)}`,
    };
}
function resourceFit(actionId, session, paletteEntry) {
    let fit = 0.5;
    const availability = paletteEntry?.availability;
    if (availability === "possible" || availability === "reckless") {
        fit = 0.68;
    }
    else if (availability === "currently_impossible" || availability === "impossible") {
        fit = 0.12;
    }
    if (actionId === "action.talk") {
        fit += session.deterministicLoop.scene.npcAvailable ? 0.22 : -0.34;
    }
    if (actionId === "action.wait" && session.deterministicLoop.ongoingAction?.status === "in_progress") {
        fit += 0.14;
    }
    if (actionId === "action.move" &&
        session.deterministicLoop.ongoingAction?.status === "in_progress" &&
        session.deterministicLoop.ongoingAction.interruptible === false &&
        session.deterministicLoop.ongoingAction.kind !== "move") {
        fit -= 0.35;
    }
    fit = clampUnit(fit);
    return {
        fit,
        weight: RECOMMEND_WEIGHTS.resourceFit,
        contribution: fit * RECOMMEND_WEIGHTS.resourceFit,
        detail: `자원/가용 적합도=${fit.toFixed(2)}`,
    };
}
function contextFit(actionId, session) {
    const loop = session.deterministicLoop;
    let fit = 0.5;
    if (!loop.exchange && actionId === "action.observe") {
        fit += 0.2;
    }
    if (loop.scene.phase === "transitioning" && actionId === "action.move") {
        fit += 0.25;
    }
    if (loop.scene.phase === "resolved" && actionId === "action.wait") {
        fit += 0.18;
    }
    if (loop.exchange?.classification === "reckless" && (actionId === "action.observe" || actionId === "action.wait")) {
        fit += 0.16;
    }
    if (loop.beat.objective.includes("접근") && actionId === "action.move") {
        fit += 0.14;
    }
    if (loop.beat.objective.includes("리스크") && (actionId === "action.observe" || actionId === "action.wait")) {
        fit += 0.14;
    }
    fit = clampUnit(fit);
    return {
        fit,
        weight: RECOMMEND_WEIGHTS.contextFit,
        contribution: fit * RECOMMEND_WEIGHTS.contextFit,
        detail: `상황 맥락 적합도=${fit.toFixed(2)}`,
    };
}
function recommendationReason(score, sourceLabel, whimEnabled, params) {
    const maxFactors = Math.max(1, Math.min(3, Math.trunc(params?.maxFactors ?? 2)));
    const ranked = Object.entries(score.factors)
        .slice()
        .sort((a, b) => b[1].contribution - a[1].contribution)
        .slice(0, maxFactors);
    const labels = {
        traitFit: "성향",
        questUrgency: "퀘스트 긴급도",
        riskFit: "현재 위험도",
        timePressure: "시간 압박",
        resourceFit: "자원/가용 상태",
        contextFit: "장면 맥락",
    };
    const reasons = ranked
        .map(([key, value]) => `${labels[key]} ${value.fit.toFixed(2)}`)
        .join(" · ");
    const whimSuffix = whimEnabled && params?.includeWhimDetail
        ? ` · 변덕보정 ${score.whimAdjustment >= 0 ? "+" : ""}${score.whimAdjustment.toFixed(3)}`
        : "";
    if (params?.concise) {
        return `근거: ${reasons}`;
    }
    return `근거: ${reasons} (${sourceLabel})${whimSuffix}`;
}
function recommendedDecision(session, palette, params) {
    if (palette.length === 0) {
        return {
            actionId: null,
            reasonText: null,
            whimEnabled: params?.whimEnabled === true,
            scores: [],
        };
    }
    const questUrgency = questUrgencyLevel(session);
    const risk = riskLevel(session);
    const timePressure = timePressureLevel(session, questUrgency.level);
    const baseScored = palette.map((entry) => {
        const factors = {
            traitFit: traitFit(entry.actionId, session),
            questUrgency: questUrgencyFit(entry.actionId, questUrgency.level),
            riskFit: riskFit(entry.actionId, risk),
            timePressure: timePressureFit(entry.actionId, timePressure.level),
            resourceFit: resourceFit(entry.actionId, session, entry),
            contextFit: contextFit(entry.actionId, session),
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
    const whimEnabled = params?.whimEnabled === true;
    const leaderBaseScore = baseScored.reduce((max, row) => Math.max(max, row.baseScore), Number.NEGATIVE_INFINITY);
    const scored = baseScored.map((row) => {
        const whim = applyWhimAdjustment({
            actionId: row.actionId,
            availability: row.availability,
            baseScore: row.baseScore,
            leaderBaseScore,
            riskLevel: risk,
            config: {
                enabled: whimEnabled,
            },
        });
        return {
            actionId: row.actionId,
            baseScore: row.baseScore,
            whimAdjustment: whim.adjustment,
            totalScore: whim.adjustedScore,
            factors: row.factors,
        };
    });
    const best = scored
        .slice()
        .sort((a, b) => b.totalScore - a.totalScore || a.actionId.localeCompare(b.actionId))[0];
    return {
        actionId: best?.actionId ?? null,
        reasonText: best
            ? recommendationReason(best, `${questUrgency.label}, ${timePressure.label}`, whimEnabled, {
                concise: params?.verboseMode !== true,
                includeWhimDetail: params?.verboseMode === true,
                maxFactors: params?.verboseMode ? 3 : 2,
            })
            : null,
        whimEnabled,
        scores: scored,
    };
}
function fixedSectionText(session) {
    const loop = session.deterministicLoop;
    return [
        "**Fixed UI**",
        `- status: ${session.status}`,
        `- sessionId: ${session.sessionId}`,
        `- ownerId: ${session.ownerId}`,
        `- sceneId: ${loop.scene.sceneId}`,
        `- uiVersion: ${String(session.uiVersion)}`,
        `- world_time: ${loop.time.worldNowIso}`,
    ].join("\n");
}
function mainSectionText(session, params) {
    const loop = session.deterministicLoop;
    const questSummary = buildQuestEconomyQualitativeSummary({
        economy: loop.questEconomy,
        locationId: loop.scene.locationId,
    });
    const anchorSummary = buildAnchorQualitativeSummary({
        anchor: loop.anchor,
        lastSummary: null,
    });
    const lines = [
        "**Main UI**",
        `장면: ${loop.scene.title} (${loop.scene.sceneId}) / phase=${loop.scene.phase}`,
        `위치: ${loop.scene.locationId ?? "(미지정)"}`,
        `Beat ${String(loop.beat.beatIndex)}: ${loop.beat.objective}`,
        `압력: ${String(loop.scene.pressure)} (${loop.scene.riskTier})`,
        `활성 과제: ${String(questSummary.actionable.activeCount)}건 · ${questSummary.actionable.activeTop ? (questSummary.actionable.activeTop.llmShortText ?? questSummary.actionable.activeTop.defaultText) : "진행 중 과제가 없다."}`,
        `접촉 기회: ${String(questSummary.actionable.surfacedCount)}건 · ${questSummary.actionable.surfacedTop.length > 0 ? questSummary.actionable.surfacedTop.map((slot) => slot.llmShortText ?? slot.defaultText).join(" / ") : "현재 접촉 가능한 기회가 없다."}`,
        `세계 동향: ${questSummary.worldPulse.text}`,
        `최근 변화: ${questSummary.recentOutcomes.text}`,
    ];
    if (params.anchorLifecycleEnabled) {
        lines.splice(7, 0, `장기 축: ${anchorSummary.text}`);
    }
    if (session.status === "ended") {
        lines.push("세션이 종료되었다. `/trpg new`로 새 세션을 시작할 수 있다.");
        return lines.join("\n");
    }
    if (!loop.exchange) {
        lines.push("아직 처리된 Exchange가 없다. 버튼 또는 직접 입력으로 첫 행동을 수행하라.");
        return lines.join("\n");
    }
    lines.push(`최근 Exchange #${String(loop.exchange.exchangeIndex)}: ${feasibilityLabel(loop.exchange.classification)}`, `delta_time: +${String(loop.exchange.deltaTimeSec)}s (누적 ${String(loop.time.worldElapsedSec)}s)`, `결과: ${loop.exchange.resultSummary}`);
    if (loop.exchange.riskNote) {
        lines.push(`리스크: ${loop.exchange.riskNote}`);
    }
    if (loop.exchange.reactionChain.length > 0) {
        lines.push(`반응 체인: ${loop.exchange.reactionChain.join(" -> ")}`);
    }
    return lines.join("\n");
}
function driftQualitativeLabel(value) {
    if (value >= 0.35) {
        return "상승";
    }
    if (value <= -0.35) {
        return "하락";
    }
    return "안정";
}
function subSectionText(session, params) {
    const loop = session.deterministicLoop;
    const lines = ["**Sub UI**"];
    const temporalSummary = buildTemporalQualitativeSummary({
        temporal: loop.temporal,
        locationId: loop.scene.locationId,
    });
    const questSummary = buildQuestEconomyQualitativeSummary({
        economy: loop.questEconomy,
        locationId: loop.scene.locationId,
    });
    const anchorSummary = buildAnchorQualitativeSummary({
        anchor: loop.anchor,
        lastSummary: null,
    });
    if (session.status === "ended") {
        lines.push("세션 종료 상태다.");
        return lines.join("\n");
    }
    const visibleButtons = loop.actionPalette.filter((entry) => entry.showInButtons);
    lines.push(`가능 버튼: ${visibleButtons.length > 0 ? visibleButtons.map((entry) => entry.label).join(" | ") : "없음"}`, `추천 버튼: ${PANEL_RECOMMEND_LABEL}`, `추천 근거: ${params.recommendationReason ?? "근거 없음(선택 가능한 액션 부족)"}`, `모달: ${PANEL_FREE_INPUT_TRIGGER_LABEL}`);
    if (params.verboseMode) {
        const compact = session.trace.events
            .slice(-4)
            .map((event) => `${event.lane}:${event.type}${event.code ? `(${event.code})` : ""}`)
            .join(" / ");
        lines.push(`trace.tail: ${compact || "없음"}`);
        lines.push(`변덕 보정: ${params.recommendationWhimEnabled ? "ON" : "OFF"}`);
    }
    const blocked = loop.actionPalette
        .filter((entry) => entry.availability === "currently_impossible" || entry.availability === "impossible")
        .map((entry) => `${entry.label}(${entry.reason})`)
        .slice(0, 3);
    if (blocked.length > 0) {
        lines.push(`제약: ${blocked.join(" / ")}`);
    }
    if (loop.ongoingAction && loop.ongoingAction.status === "in_progress") {
        const progressPercent = Math.min(100, Math.round((loop.ongoingAction.elapsedSec / Math.max(1, loop.ongoingAction.requiredSec)) * 100));
        lines.push(`ongoing_action: ${loop.ongoingAction.kind} ${String(loop.ongoingAction.elapsedSec)}/${String(loop.ongoingAction.requiredSec)}s (${String(progressPercent)}%)`);
    }
    const drift = loop.behavioralDrift.drift;
    if (params.behavioralDriftEnabled) {
        lines.push(`행동 성향 추세: warm=${driftQualitativeLabel(drift.warmth)} bold=${driftQualitativeLabel(drift.boldness)} caution=${driftQualitativeLabel(drift.caution)} altruism=${driftQualitativeLabel(drift.altruism)} aggression=${driftQualitativeLabel(drift.aggression)} humor=${driftQualitativeLabel(drift.humor)}`);
    }
    else {
        lines.push("행동 성향 추세: 안전 모드(core identity only, drift off)");
    }
    lines.push(`시간/기억: ${temporalSummary.memory}`, `정보 신선도: ${temporalSummary.freshness}`, `잔여 흔적: ${temporalSummary.traces}`, `지역 상태: ${temporalSummary.location}`);
    lines.push(`퀘스트(진행): ${questSummary.actionable.activeText}`, `퀘스트(기회): ${questSummary.actionable.surfacedText}`, `월드 축: ${questSummary.worldPulse.text}`);
    if (params.anchorLifecycleEnabled) {
        lines.splice(lines.length - 1, 0, `앵커 축: ${anchorSummary.text}`);
    }
    if (questSummary.recentOutcomes.items.length > 0) {
        lines.push(`최근 변화: ${questSummary.recentOutcomes.items.map((entry) => entry.text).join(" / ")}`);
    }
    if (params.debugRuntimeSignals && params.verboseMode) {
        const hookDebug = questSummary.debug.hookText;
        const canonicalSync = session.runtimeMetadata?.canonicalSync;
        if (params.behavioralDriftEnabled) {
            lines.push(`debug.behavioral_drift.raw: warm=${drift.warmth.toFixed(2)} bold=${drift.boldness.toFixed(2)} caution=${drift.caution.toFixed(2)} altruism=${drift.altruism.toFixed(2)} aggression=${drift.aggression.toFixed(2)} humor=${drift.humor.toFixed(2)}`);
        }
        lines.push(`debug.temporal.raw: location=${temporalSummary.debug.locationId ?? "none"} memory=${String(temporalSummary.debug.memoryCount)} max_familiarity=${String(temporalSummary.debug.maxFamiliarity)} max_freshness=${String(temporalSummary.debug.maxFreshness)} traces=${String(temporalSummary.debug.activeTraceCount)} max_trace=${String(temporalSummary.debug.maxTraceIntensity)} location_state=${temporalSummary.debug.locationState ? `tension=${String(temporalSummary.debug.locationState.tension)} alertness=${String(temporalSummary.debug.locationState.alertness)} accessibility=${String(temporalSummary.debug.locationState.accessibility)}` : "none"}`);
        lines.push(`debug.quest_hook_text.raw: attempted=${String(hookDebug.generationAttempted)} result=${hookDebug.result} reason=${hookDebug.reason ?? "none"} cache_hit=${String(hookDebug.cacheHitCount)} cache_miss=${String(hookDebug.cacheMissCount)} slots=${hookDebug.slotMeta.length > 0 ? hookDebug.slotMeta.map((entry) => `${entry.slotType}:${entry.slotKey}:${entry.source}:${entry.cacheHit ? "hit" : "miss"}${entry.skipReason ? `:${entry.skipReason}` : ""}`).join(" / ") : "none"}`);
        if (params.telemetryExtended) {
            lines.push(`debug.quest_tuning.raw: surfacing_rate=${questSummary.debug.tuning.surfacingRate.toFixed(2)} expiration_rate=${questSummary.debug.tuning.expirationRate.toFixed(2)} mutation_rate=${questSummary.debug.tuning.mutationRate.toFixed(2)} successor_rate=${questSummary.debug.tuning.successorRate.toFixed(2)} avg_urgency=${String(questSummary.debug.tuning.averageUrgency)} active_vs_surfaced=${questSummary.debug.tuning.activeVsSurfacedRatio.toFixed(2)} budget_util=live:${questSummary.debug.tuning.budgetUtilization.live.toFixed(2)}/world:${questSummary.debug.tuning.budgetUtilization.world.toFixed(2)}/attention:${questSummary.debug.tuning.budgetUtilization.attention.toFixed(2)}/narrative:${questSummary.debug.tuning.budgetUtilization.narrative.toFixed(2)} quota_sat=loc:${questSummary.debug.tuning.quotaSaturation.location.toFixed(2)}/pressure:${questSummary.debug.tuning.quotaSaturation.pressure.toFixed(2)}/archetype:${questSummary.debug.tuning.quotaSaturation.archetype.toFixed(2)}`);
            lines.push(`debug.quest_budget.raw: live=${String(questSummary.debug.liveQuestCount)} budget_used=live:${String(questSummary.debug.budget.used.livePool)}/world:${String(questSummary.debug.budget.used.world)}/attention:${String(questSummary.debug.budget.used.attention)}/narrative:${String(questSummary.debug.budget.used.narrative)} budget_caps=live:${String(questSummary.debug.budget.caps.livePool)}/world:${String(questSummary.debug.budget.caps.world)}/attention:${String(questSummary.debug.budget.caps.attention)}/narrative:${String(questSummary.debug.budget.caps.narrative)} quota_caps=loc:${String(questSummary.debug.softQuota.caps.perLocation)}/pressure:${String(questSummary.debug.softQuota.caps.perPressure)}/archetype:${String(questSummary.debug.softQuota.caps.perArchetype)} top_pressure_intensity=${String(questSummary.debug.topPressureIntensity)}`);
        }
        if (params.anchorLifecycleEnabled) {
            lines.push(`debug.anchor.raw: count=${String(anchorSummary.debug.anchorCount)} active=${String(anchorSummary.activeCount)} escalated=${String(anchorSummary.escalatedCount)} signal_mode=${anchorSummary.debug.signalMode} signal_reason=${anchorSummary.debug.signalReason ?? "none"} active_ids=${anchorSummary.debug.activeIds.length > 0 ? anchorSummary.debug.activeIds.join(",") : "none"} terminal_ids=${anchorSummary.debug.terminalIds.length > 0 ? anchorSummary.debug.terminalIds.join(",") : "none"}`);
        }
        if (params.canonicalSyncEnabled) {
            lines.push(`debug.canonical_sync.raw: policy=${canonicalSync?.sourcePolicy ?? "seed_bootstrap_only"} drift=${canonicalSync?.driftStatus ?? "unknown"} drift_counts=added:${String(canonicalSync?.driftCounts.addedInSeed ?? 0)}/missing:${String(canonicalSync?.driftCounts.missingInSeed ?? 0)}/changed:${String(canonicalSync?.driftCounts.changedScaffold ?? 0)}/incompatible:${String(canonicalSync?.driftCounts.incompatible ?? 0)} seed_fp=${canonicalSync?.seedFingerprint ?? "none"} canon_fp=${canonicalSync?.canonFingerprint ?? "none"}`);
        }
        if (params.recommendationScores.length > 0) {
            const compact = params.recommendationScores
                .slice()
                .sort((a, b) => b.totalScore - a.totalScore || a.actionId.localeCompare(b.actionId))
                .map((row) => `${row.actionId}:${row.totalScore.toFixed(3)}(base=${row.baseScore.toFixed(3)},whim=${row.whimAdjustment.toFixed(3)})`)
                .join(" / ");
            lines.push(`debug.recommendation.score.raw: ${compact}`);
        }
    }
    return lines.join("\n");
}
export function collectPanelRouteActionIds(session) {
    if (session.status === "ended") {
        return [PANEL_MODAL_SUBMIT_ACTION_ID];
    }
    const set = new Set();
    for (const actionId of collectButtonActionIds(session.deterministicLoop)) {
        set.add(actionId);
    }
    set.add(PANEL_MODAL_SUBMIT_ACTION_ID);
    return Array.from(set);
}
export function formatPanelCustomId(key) {
    return [
        PANEL_CUSTOM_ID_PREFIX,
        encodeURIComponent(key.sessionId),
        String(Math.max(1, Math.trunc(key.uiVersion))),
        encodeURIComponent(key.sceneId),
        encodeURIComponent(key.actionId),
    ].join(":");
}
export function parsePanelCustomId(customId) {
    if (!customId || !customId.startsWith(`${PANEL_CUSTOM_ID_PREFIX}:`)) {
        return null;
    }
    const parts = customId.split(":");
    if (parts.length !== 6) {
        return null;
    }
    if (`${parts[0]}:${parts[1]}` !== PANEL_CUSTOM_ID_PREFIX) {
        return null;
    }
    const sessionId = readString(decodeURIComponent(parts[2] ?? ""));
    const uiVersion = normalizeInt(parts[3], 0);
    const sceneId = readString(decodeURIComponent(parts[4] ?? ""));
    const actionId = readString(decodeURIComponent(parts[5] ?? ""));
    if (!sessionId || !sceneId || !actionId || uiVersion < 1) {
        return null;
    }
    return {
        sessionId,
        uiVersion,
        sceneId,
        actionId,
    };
}
export function actionLabel(actionId, freeInput) {
    const normalized = readString(actionId);
    if (normalized === PANEL_MODAL_SUBMIT_ACTION_ID) {
        const input = readString(freeInput);
        return input ? `자유 입력: ${input}` : "자유 입력(빈 입력)";
    }
    return actionLabelFor(normalized);
}
export function buildCheckpoint1Panel(input) {
    const routeByAction = routeMapByAction(input.routes);
    const ended = input.session.status === "ended";
    const debugRuntimeSignals = input.debugRuntimeSignals === true;
    const behavioralDriftEnabled = input.behavioralDriftEnabled !== false;
    const anchorLifecycleEnabled = input.anchorLifecycleEnabled !== false;
    const telemetryExtended = input.telemetryExtended === true;
    const canonicalSyncEnabled = input.canonicalSyncEnabled === true;
    const recommendationWhimEnabled = input.recommendationWhimEnabled === true;
    const verboseMode = input.verboseMode === true;
    const visiblePalette = input.session.deterministicLoop.actionPalette
        .filter((entry) => entry.showInButtons)
        .slice(0, 4);
    const recommendation = ended
        ? { actionId: null, reasonText: null, whimEnabled: recommendationWhimEnabled, scores: [] }
        : recommendedDecision(input.session, visiblePalette, {
            whimEnabled: recommendationWhimEnabled,
            verboseMode,
        });
    const recommendedId = recommendation.actionId;
    const buttonSpecs = ended
        ? []
        : [
            ...(recommendedId
                ? visiblePalette.filter((entry) => entry.actionId === recommendedId).map((entry) => {
                    return {
                        label: PANEL_RECOMMEND_LABEL,
                        style: "primary",
                        actionId: entry.actionId,
                    };
                })
                : []),
            ...visiblePalette.filter((entry) => entry.actionId !== recommendedId),
        ];
    const buttons = buttonSpecs.map((entry) => {
        const route = routeByAction.get(entry.actionId);
        const customId = route ? formatPanelCustomId(route) : null;
        return {
            label: entry.label,
            style: entry.style,
            actionId: entry.actionId,
            customId,
            custom_id: customId,
            disabled: !customId,
        };
    });
    const modalRoute = routeByAction.get(PANEL_MODAL_SUBMIT_ACTION_ID);
    const modalCustomId = modalRoute ? formatPanelCustomId(modalRoute) : null;
    const message = ended ? "TRPG 세션이 종료되었다." : "TRPG 세션 패널";
    const blocks = [
        { type: "text", text: fixedSectionText(input.session) },
        { type: "text", text: mainSectionText(input.session, { anchorLifecycleEnabled }) },
        {
            type: "text",
            text: subSectionText(input.session, {
                verboseMode,
                debugRuntimeSignals,
                behavioralDriftEnabled,
                anchorLifecycleEnabled,
                telemetryExtended,
                canonicalSyncEnabled,
                recommendationReason: recommendation.reasonText,
                recommendationWhimEnabled: recommendation.whimEnabled,
                recommendationScores: recommendation.scores,
            }),
        },
    ];
    if (buttons.length > 0) {
        blocks.push({
            type: "actions",
            buttons,
        });
    }
    if (input.errorHint) {
        blocks.push({
            type: "text",
            text: `\`주의\`: ${input.errorHint}`,
        });
    }
    const components = {
        text: "TRPG Session Panel",
        container: {
            accentColor: ended ? "#7f8c8d" : "#3498db",
        },
        blocks,
    };
    if (!ended) {
        if (recommendedId) {
            components.recommendation = {
                label: PANEL_RECOMMEND_LABEL,
                actionId: recommendedId,
                reason: recommendation.reasonText,
                scores: recommendation.scores.map((entry) => ({
                    actionId: entry.actionId,
                    base: Number(entry.baseScore.toFixed(6)),
                    whimAdjustment: Number(entry.whimAdjustment.toFixed(6)),
                    total: Number(entry.totalScore.toFixed(6)),
                    factors: Object.fromEntries(Object.entries(entry.factors).map(([key, factor]) => [
                        key,
                        {
                            fit: Number(factor.fit.toFixed(6)),
                            weight: factor.weight,
                            contribution: Number(factor.contribution.toFixed(6)),
                        },
                    ])),
                })),
            };
        }
        components.modal = {
            title: "자유 입력",
            triggerLabel: PANEL_FREE_INPUT_TRIGGER_LABEL,
            submitLabel: "반영",
            submitActionId: PANEL_MODAL_SUBMIT_ACTION_ID,
            submitCustomId: modalCustomId,
            submit_custom_id: modalCustomId,
            fields: [
                {
                    type: "text",
                    name: "freeInput",
                    label: "행동 또는 대사",
                    placeholder: "예: 주변을 조사한다 / 이동한다 / 강행 돌파한다",
                    style: "paragraph",
                    required: true,
                    maxLength: 280,
                },
            ],
        };
    }
    return {
        mode: input.mode,
        message,
        messageId: input.mode === "edit" ? input.session.panels.main.messageId : null,
        components,
        routeKeys: input.routes,
    };
}
