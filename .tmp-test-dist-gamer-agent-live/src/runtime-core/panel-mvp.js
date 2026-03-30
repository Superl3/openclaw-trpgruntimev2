import { actionLabelFor, collectButtonActionIds, feasibilityLabel } from "./scene-loop.js";
import { buildQuestEconomyQualitativeSummary } from "./quest-economy.js";
import { buildTemporalQualitativeSummary } from "./temporal-systems.js";
import { buildAnchorQualitativeSummary } from "./anchor-layer.js";
import { selectRuleBasedActionRecommendation, } from "./action-recommendation.js";
export const PANEL_MODAL_SUBMIT_ACTION_ID = "action.free_input.submit";
const PANEL_RECOMMEND_LABEL = "🎯 성향 추천 선택";
const PANEL_FREE_INPUT_TRIGGER_LABEL = "✏️ 자유 입력";
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
        : selectRuleBasedActionRecommendation({
            loop: input.session.deterministicLoop,
            palette: visiblePalette,
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
    if (!ended && recommendedId) {
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
    if (!ended) {
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
