import { actionLabelFor, collectButtonActionIds, feasibilityLabel } from "./scene-loop.js";
import { buildQuestEconomyQualitativeSummary } from "./quest-economy.js";
import { buildTemporalQualitativeSummary } from "./temporal-systems.js";
import { buildAnchorQualitativeSummary } from "./anchor-layer.js";
import {
  recommendationReason,
  selectRuleBasedActionRecommendation,
  type RecommendationActionScore,
  type RecommendationDecision,
  type RecommendationFactorScore,
} from "./action-recommendation.js";
import type { InteractionRouteKey, InteractionRouteRecord, SessionState } from "./types.js";

export type PanelMessageMode = "send" | "edit";

export type PanelRenderOutput = {
  mode: PanelMessageMode;
  message: string;
  messageId: string | null;
  components: Record<string, unknown>;
  routeKeys: InteractionRouteKey[];
};

type PanelRenderInput = {
  session: SessionState;
  routes: InteractionRouteRecord[];
  mode: PanelMessageMode;
  errorHint?: string;
  debugRuntimeSignals?: boolean;
  behavioralDriftEnabled?: boolean;
  anchorLifecycleEnabled?: boolean;
  anchorSummaryOnly?: boolean;
  telemetryExtended?: boolean;
  canonicalSyncEnabled?: boolean;
  recommendationWhimEnabled?: boolean;
  verboseMode?: boolean;
};

export const PANEL_MODAL_SUBMIT_ACTION_ID = "action.free_input.submit";
const PANEL_RECOMMEND_LABEL = "🎯 성향 추천 선택";
const PANEL_FREE_INPUT_TRIGGER_LABEL = "✏️ 자유 입력";

const PANEL_CUSTOM_ID_PREFIX = "trpg:v1";

function normalizeInt(value: unknown, fallback: number): number {
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

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function routeMapByAction(routes: InteractionRouteRecord[]): Map<string, InteractionRouteRecord> {
  return new Map(routes.map((route) => [route.actionId, route]));
}

function sanitizePlayerFacingText(value: string): string {
  let output = value;
  const patterns: Array<[RegExp, string]> = [
    [/\bsess-[0-9a-fA-F-]{8,}\b/g, "[session]"],
    [/\bdisp-[0-9a-fA-F-]{8,}\b/g, "[dispatch]"],
    [/\bowner:[^\s]+\b/g, "[owner]"],
    [/\buiVersion\b\s*[:=]\s*\d+/gi, "uiVersion:[hidden]"],
    [/\bsceneId\b\s*[:=]\s*[^\s]+/gi, "sceneId:[hidden]"],
  ];

  for (const [pattern, replacement] of patterns) {
    output = output.replace(pattern, replacement);
  }

  return output;
}

function fixedSectionText(session: SessionState, params: { verboseMode: boolean }): string {
  const loop = session.deterministicLoop;
  const lines = [
    "**현재 상태**",
    `세션: ${session.status === "active" ? "진행 중" : "종료됨"}`,
    `장면: ${loop.scene.title}`,
    "노출 범위: 플레이어 인지 정보",
  ];

  if (params.verboseMode) {
    lines.push(
      `debug.sessionId: ${session.sessionId}`,
      `debug.ownerId: ${session.ownerId}`,
      `debug.sceneId: ${loop.scene.sceneId}`,
      `debug.uiVersion: ${String(session.uiVersion)}`,
    );
  }

  return lines.join("\n");
}

function riskTierLabel(value: string): string {
  const normalized = readString(value).toLowerCase();
  if (normalized === "low") return "낮음";
  if (normalized === "medium") return "보통";
  if (normalized === "high") return "높음";
  if (normalized === "critical") return "위험";
  return readString(value) || "미확인";
}

function mainSectionText(session: SessionState, params: {
  anchorLifecycleEnabled: boolean;
}): string {
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
    "**장면 정보**",
    `장면: ${loop.scene.title}`,
    `현재 비트 ${String(loop.beat.beatIndex)}: ${loop.beat.objective}`,
    `현장 긴장도: ${riskTierLabel(loop.scene.riskTier)}`,
    `활성 과제: ${String(questSummary.actionable.activeCount)}건 · ${questSummary.actionable.activeTop ? (questSummary.actionable.activeTop.llmShortText ?? questSummary.actionable.activeTop.defaultText) : "진행 중 과제가 없다."}`,
    `접촉 기회: ${String(questSummary.actionable.surfacedCount)}건 · ${questSummary.actionable.surfacedTop.length > 0 ? questSummary.actionable.surfacedTop.map((slot) => slot.llmShortText ?? slot.defaultText).join(" / ") : "현재 접촉 가능한 기회가 없다."}`,
    `세계 동향: ${questSummary.worldPulse.text}`,
    `최근 변화: ${questSummary.recentOutcomes.text}`,
  ];
  if (params.anchorLifecycleEnabled) {
    lines.push(`장기 축: ${anchorSummary.text}`);
  }

  if (session.status === "ended") {
    lines.push("세션이 종료되었다. `/trpg new`로 새 세션을 시작할 수 있다.");
    return lines.join("\n");
  }

  if (!loop.exchange) {
    lines.push("아직 처리된 Exchange가 없다. 버튼 또는 직접 입력으로 첫 행동을 수행하라.");
    return lines.join("\n");
  }

  lines.push(
    `판정 요약: ${feasibilityLabel(loop.exchange.classification)}`,
    `결과: ${loop.exchange.resultSummary}`,
  );

  if (loop.exchange.riskNote) {
    lines.push(`리스크: ${loop.exchange.riskNote}`);
  }

  if (loop.exchange.reactionChain.length > 0) {
    lines.push(`반응 체인: ${loop.exchange.reactionChain.join(" -> ")}`);
  }

  return lines.join("\n");
}

function driftQualitativeLabel(value: number): string {
  if (value >= 0.35) {
    return "상승";
  }
  if (value <= -0.35) {
    return "하락";
  }
  return "안정";
}

function subSectionText(session: SessionState, params: {
  verboseMode: boolean;
  debugRuntimeSignals: boolean;
  behavioralDriftEnabled: boolean;
  anchorLifecycleEnabled: boolean;
  telemetryExtended: boolean;
  canonicalSyncEnabled: boolean;
  recommendationReason: string | null;
  recommendationWhimEnabled: boolean;
  recommendationScores: RecommendationActionScore[];
}): string {
  const loop = session.deterministicLoop;
  const lines = ["**행동 선택**"];
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
  lines.push(
    `선택 가능 행동: ${visibleButtons.length > 0 ? visibleButtons.map((entry) => entry.label).join(" | ") : "없음"}`,
    `추천 행동: ${PANEL_RECOMMEND_LABEL}`,
    `추천 이유: ${params.recommendationReason ?? "근거 없음(선택 가능한 액션 부족)"}`,
    `직접 입력: ${PANEL_FREE_INPUT_TRIGGER_LABEL}`,
  );

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
    const progressPercent = Math.min(
      100,
      Math.round((loop.ongoingAction.elapsedSec / Math.max(1, loop.ongoingAction.requiredSec)) * 100),
    );
    lines.push(
      `진행 중 행동: ${loop.ongoingAction.kind} ${String(loop.ongoingAction.elapsedSec)}/${String(loop.ongoingAction.requiredSec)}s (${String(progressPercent)}%)`,
    );
  }

  const drift = loop.behavioralDrift.drift;

  lines.push(`상황 흐름: ${questSummary.worldPulse.text}`);
  if (questSummary.recentOutcomes.items.length > 0) {
    lines.push(`체감 변화: ${questSummary.recentOutcomes.items.map((entry) => entry.text).join(" / ")}`);
  }

  if (params.verboseMode) {
    if (params.behavioralDriftEnabled) {
      lines.push(
        `행동 성향 추세: warm=${driftQualitativeLabel(drift.warmth)} bold=${driftQualitativeLabel(drift.boldness)} caution=${driftQualitativeLabel(drift.caution)} altruism=${driftQualitativeLabel(drift.altruism)} aggression=${driftQualitativeLabel(drift.aggression)} humor=${driftQualitativeLabel(drift.humor)}`,
      );
    } else {
      lines.push("행동 성향 추세: 안전 모드(core identity only, drift off)");
    }

    lines.push(
      `시간/기억: ${temporalSummary.memory}`,
      `정보 신선도: ${temporalSummary.freshness}`,
      `잔여 흔적: ${temporalSummary.traces}`,
      `지역 상태: ${temporalSummary.location}`,
      `퀘스트(진행): ${questSummary.actionable.activeText}`,
      `퀘스트(기회): ${questSummary.actionable.surfacedText}`,
    );
    if (params.anchorLifecycleEnabled) {
      lines.push(`앵커 축: ${anchorSummary.text}`);
    }
  }

  if (params.debugRuntimeSignals && params.verboseMode) {
    const hookDebug = questSummary.debug.hookText;
    const canonicalSync = session.runtimeMetadata?.canonicalSync;
    if (params.behavioralDriftEnabled) {
      lines.push(
        `debug.behavioral_drift.raw: warm=${drift.warmth.toFixed(2)} bold=${drift.boldness.toFixed(2)} caution=${drift.caution.toFixed(2)} altruism=${drift.altruism.toFixed(2)} aggression=${drift.aggression.toFixed(2)} humor=${drift.humor.toFixed(2)}`,
      );
    }
    lines.push(
      `debug.temporal.raw: location=${temporalSummary.debug.locationId ?? "none"} memory=${String(temporalSummary.debug.memoryCount)} max_familiarity=${String(temporalSummary.debug.maxFamiliarity)} max_freshness=${String(temporalSummary.debug.maxFreshness)} traces=${String(temporalSummary.debug.activeTraceCount)} max_trace=${String(temporalSummary.debug.maxTraceIntensity)} location_state=${temporalSummary.debug.locationState ? `tension=${String(temporalSummary.debug.locationState.tension)} alertness=${String(temporalSummary.debug.locationState.alertness)} accessibility=${String(temporalSummary.debug.locationState.accessibility)}` : "none"}`,
    );
    lines.push(
      `debug.quest_hook_text.raw: attempted=${String(hookDebug.generationAttempted)} result=${hookDebug.result} reason=${hookDebug.reason ?? "none"} cache_hit=${String(hookDebug.cacheHitCount)} cache_miss=${String(hookDebug.cacheMissCount)} slots=${hookDebug.slotMeta.length > 0 ? hookDebug.slotMeta.map((entry) => `${entry.slotType}:${entry.slotKey}:${entry.source}:${entry.cacheHit ? "hit" : "miss"}${entry.skipReason ? `:${entry.skipReason}` : ""}`).join(" / ") : "none"}`,
    );
    if (params.telemetryExtended) {
      lines.push(
        `debug.quest_tuning.raw: surfacing_rate=${questSummary.debug.tuning.surfacingRate.toFixed(2)} expiration_rate=${questSummary.debug.tuning.expirationRate.toFixed(2)} mutation_rate=${questSummary.debug.tuning.mutationRate.toFixed(2)} successor_rate=${questSummary.debug.tuning.successorRate.toFixed(2)} avg_urgency=${String(questSummary.debug.tuning.averageUrgency)} active_vs_surfaced=${questSummary.debug.tuning.activeVsSurfacedRatio.toFixed(2)} budget_util=live:${questSummary.debug.tuning.budgetUtilization.live.toFixed(2)}/world:${questSummary.debug.tuning.budgetUtilization.world.toFixed(2)}/attention:${questSummary.debug.tuning.budgetUtilization.attention.toFixed(2)}/narrative:${questSummary.debug.tuning.budgetUtilization.narrative.toFixed(2)} quota_sat=loc:${questSummary.debug.tuning.quotaSaturation.location.toFixed(2)}/pressure:${questSummary.debug.tuning.quotaSaturation.pressure.toFixed(2)}/archetype:${questSummary.debug.tuning.quotaSaturation.archetype.toFixed(2)}`,
      );
      lines.push(
        `debug.quest_budget.raw: live=${String(questSummary.debug.liveQuestCount)} budget_used=live:${String(questSummary.debug.budget.used.livePool)}/world:${String(questSummary.debug.budget.used.world)}/attention:${String(questSummary.debug.budget.used.attention)}/narrative:${String(questSummary.debug.budget.used.narrative)} budget_caps=live:${String(questSummary.debug.budget.caps.livePool)}/world:${String(questSummary.debug.budget.caps.world)}/attention:${String(questSummary.debug.budget.caps.attention)}/narrative:${String(questSummary.debug.budget.caps.narrative)} quota_caps=loc:${String(questSummary.debug.softQuota.caps.perLocation)}/pressure:${String(questSummary.debug.softQuota.caps.perPressure)}/archetype:${String(questSummary.debug.softQuota.caps.perArchetype)} top_pressure_intensity=${String(questSummary.debug.topPressureIntensity)}`,
      );
    }
    if (params.anchorLifecycleEnabled) {
      lines.push(
        `debug.anchor.raw: count=${String(anchorSummary.debug.anchorCount)} active=${String(anchorSummary.activeCount)} escalated=${String(anchorSummary.escalatedCount)} signal_mode=${anchorSummary.debug.signalMode} signal_reason=${anchorSummary.debug.signalReason ?? "none"} active_ids=${anchorSummary.debug.activeIds.length > 0 ? anchorSummary.debug.activeIds.join(",") : "none"} terminal_ids=${anchorSummary.debug.terminalIds.length > 0 ? anchorSummary.debug.terminalIds.join(",") : "none"}`,
      );
    }
    if (params.canonicalSyncEnabled) {
      lines.push(
        `debug.canonical_sync.raw: policy=${canonicalSync?.sourcePolicy ?? "seed_bootstrap_only"} drift=${canonicalSync?.driftStatus ?? "unknown"} drift_counts=added:${String(canonicalSync?.driftCounts.addedInSeed ?? 0)}/missing:${String(canonicalSync?.driftCounts.missingInSeed ?? 0)}/changed:${String(canonicalSync?.driftCounts.changedScaffold ?? 0)}/incompatible:${String(canonicalSync?.driftCounts.incompatible ?? 0)} seed_fp=${canonicalSync?.seedFingerprint ?? "none"} canon_fp=${canonicalSync?.canonFingerprint ?? "none"}`,
      );
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

export function collectPanelRouteActionIds(session: SessionState): string[] {
  if (session.status === "ended") {
    return [PANEL_MODAL_SUBMIT_ACTION_ID];
  }

  const set = new Set<string>();
  for (const actionId of collectButtonActionIds(session.deterministicLoop)) {
    set.add(actionId);
  }
  set.add(PANEL_MODAL_SUBMIT_ACTION_ID);
  return Array.from(set);
}

export function formatPanelCustomId(key: InteractionRouteKey): string {
  return [
    PANEL_CUSTOM_ID_PREFIX,
    encodeURIComponent(key.sessionId),
    String(Math.max(1, Math.trunc(key.uiVersion))),
    encodeURIComponent(key.sceneId),
    encodeURIComponent(key.actionId),
  ].join(":");
}

export function parsePanelCustomId(customId: string): InteractionRouteKey | null {
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

export function actionLabel(actionId: string, freeInput?: string): string {
  const normalized = readString(actionId);
  if (normalized === PANEL_MODAL_SUBMIT_ACTION_ID) {
    const input = readString(freeInput);
    return input ? `자유 입력: ${input}` : "자유 입력(빈 입력)";
  }
  return actionLabelFor(normalized);
}

export function buildCheckpoint1Panel(input: PanelRenderInput): PanelRenderOutput {
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

  const message = ended ? "TRPG 세션이 종료되었다." : "다음 행동을 선택해 주세요.";
  const loop = input.session.deterministicLoop;
  const questSummary = buildQuestEconomyQualitativeSummary({
    economy: loop.questEconomy,
    locationId: loop.scene.locationId,
  });

  const narrativeBits = [];
  if (loop.exchange && loop.exchange.resultSummary) {
    narrativeBits.push(`**이전 행동 결과**\n${loop.exchange.resultSummary}`);
  }
  if (questSummary.recentOutcomes.items.length > 0) {
    narrativeBits.push(`**최근 변화**\n${questSummary.recentOutcomes.items.map(entry => entry.text).join(" / ")}`);
  }
  narrativeBits.push(`**상황 흐름**\n${questSummary.worldPulse.text}`);
  if (loop.exchange && loop.exchange.riskNote) {
    narrativeBits.push(`**위험 요소**\n${loop.exchange.riskNote}`);
  }

  const description = sanitizePlayerFacingText(narrativeBits.join("\n\n"));

  const embeds = [
    {
      title: ended ? "🛑 세션 종료" : `🗺️ 장면: ${loop.scene.title}`,
      description: ended ? "세션이 종료되었다. `/trpg new`로 새 세션을 시작할 수 있다." : description,
      color: ended ? "#7f8c8d" : "#2ecc71",
      fields: ended ? [] : [
        {
          name: "💖 체력",
          value: "확인 중...",
          inline: true
        },
        {
          name: "⚡ 기력",
          value: "확인 중...",
          inline: true
        },
        {
          name: "💰 소지금",
          value: "확인 중...",
          inline: true
        },
        {
          name: "🎯 현재 목표",
          value: sanitizePlayerFacingText(loop.beat.objective || "설정된 목표 없음"),
          inline: false
        }
      ]
    }
  ];

  const blocks: Array<Record<string, unknown>> = [];

  if (verboseMode) {
    blocks.push({ type: "text", text: sanitizePlayerFacingText(fixedSectionText(input.session, { verboseMode })) });
    blocks.push({ type: "text", text: sanitizePlayerFacingText(mainSectionText(input.session, { anchorLifecycleEnabled })) });
    blocks.push({
      type: "text",
      text: sanitizePlayerFacingText(
        subSectionText(input.session, {
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
      ),
    });
  }

  if (buttons.length > 0) {
    blocks.push({
      type: "actions",
      buttons,
    });
  }

  if (input.errorHint) {
    blocks.push({
      type: "text",
      text: sanitizePlayerFacingText(`\`주의\`: ${input.errorHint}`),
    });
  }

  const components: Record<string, unknown> = {
    text: "TRPG 진행 패널",
    container: {
      accentColor: ended ? "#7f8c8d" : "#2ecc71",
    },
    embeds,
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
        factors: Object.fromEntries(
          Object.entries(entry.factors).map(([key, factor]) => [
            key,
            {
              fit: Number(factor.fit.toFixed(6)),
              weight: factor.weight,
              contribution: Number(factor.contribution.toFixed(6)),
            },
          ]),
        ),
      })),
    };
  }

  if (!ended) {
    components.modal = {
      title: "🗣️ 롤플레잉 입력",
      triggerLabel: PANEL_FREE_INPUT_TRIGGER_LABEL,
      submitLabel: "반영",
      submitActionId: PANEL_MODAL_SUBMIT_ACTION_ID,
      submitCustomId: modalCustomId,
      submit_custom_id: modalCustomId,
      fields: [
        {
          type: "text",
          name: "action",
          label: "행동 (무엇을 하는가?)",
          placeholder: "예: 주변을 조사한다 / 이동한다 / 강행 돌파한다",
          style: "paragraph",
          required: false,
        },
        {
          type: "text",
          name: "speech",
          label: "대사 (무엇을 말하는가?)",
          placeholder: '예: "여기에 흔적이 남아있어."',
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

  return {
    mode: input.mode,
    message,
    messageId: input.mode === "edit" ? input.session.panels.main.messageId : null,
    components,
    routeKeys: input.routes,
  };
}
