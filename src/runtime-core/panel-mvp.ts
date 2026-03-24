import { actionLabelFor, collectButtonActionIds, feasibilityLabel } from "./scene-loop.js";
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
};

export const PANEL_MODAL_SUBMIT_ACTION_ID = "action.free_input.submit";

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

function fixedSectionText(session: SessionState): string {
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

function mainSectionText(session: SessionState): string {
  const loop = session.deterministicLoop;
  const lines = [
    "**Main UI**",
    `장면: ${loop.scene.title} (${loop.scene.sceneId}) / phase=${loop.scene.phase}`,
    `Beat ${String(loop.beat.beatIndex)}: ${loop.beat.objective}`,
    `압력: ${String(loop.scene.pressure)} (${loop.scene.riskTier})`,
  ];

  if (session.status === "ended") {
    lines.push("세션이 종료되었다. `/trpg new`로 새 세션을 시작할 수 있다.");
    return lines.join("\n");
  }

  if (!loop.exchange) {
    lines.push("아직 처리된 Exchange가 없다. 버튼 또는 직접 입력으로 첫 행동을 수행하라.");
    return lines.join("\n");
  }

  lines.push(
    `최근 Exchange #${String(loop.exchange.exchangeIndex)}: ${feasibilityLabel(loop.exchange.classification)}`,
    `delta_time: +${String(loop.exchange.deltaTimeSec)}s (누적 ${String(loop.time.worldElapsedSec)}s)`,
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

function subSectionText(session: SessionState, debugRuntimeSignals: boolean): string {
  const loop = session.deterministicLoop;
  const lines = ["**Sub UI**"];

  if (session.status === "ended") {
    lines.push("세션 종료 상태다.");
    return lines.join("\n");
  }

  const visibleButtons = loop.actionPalette.filter((entry) => entry.showInButtons);
  lines.push(
    `가능 버튼: ${visibleButtons.length > 0 ? visibleButtons.map((entry) => entry.label).join(" | ") : "없음"}`,
    "모달: ✏️ 직접 입력",
  );

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
      `ongoing_action: ${loop.ongoingAction.kind} ${String(loop.ongoingAction.elapsedSec)}/${String(loop.ongoingAction.requiredSec)}s (${String(progressPercent)}%)`,
    );
  }

  const drift = loop.behavioralDrift.drift;
  lines.push(
    `행동 성향 추세: warm=${driftQualitativeLabel(drift.warmth)} bold=${driftQualitativeLabel(drift.boldness)} caution=${driftQualitativeLabel(drift.caution)} altruism=${driftQualitativeLabel(drift.altruism)} aggression=${driftQualitativeLabel(drift.aggression)} humor=${driftQualitativeLabel(drift.humor)}`,
  );

  if (debugRuntimeSignals) {
    lines.push(
      `debug.behavioral_drift.raw: warm=${drift.warmth.toFixed(2)} bold=${drift.boldness.toFixed(2)} caution=${drift.caution.toFixed(2)} altruism=${drift.altruism.toFixed(2)} aggression=${drift.aggression.toFixed(2)} humor=${drift.humor.toFixed(2)}`,
    );
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
    return input ? `직접 입력: ${input}` : "직접 입력(빈 입력)";
  }
  return actionLabelFor(normalized);
}

export function buildCheckpoint1Panel(input: PanelRenderInput): PanelRenderOutput {
  const routeByAction = routeMapByAction(input.routes);
  const ended = input.session.status === "ended";
  const debugRuntimeSignals = input.debugRuntimeSignals === true;
  const visiblePalette = input.session.deterministicLoop.actionPalette
    .filter((entry) => entry.showInButtons)
    .slice(0, 4);

  const buttons = ended
    ? []
    : visiblePalette.map((entry) => {
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
  const blocks: Array<Record<string, unknown>> = [
    { type: "text", text: fixedSectionText(input.session) },
    { type: "text", text: mainSectionText(input.session) },
    { type: "text", text: subSectionText(input.session, debugRuntimeSignals) },
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

  const components: Record<string, unknown> = {
    text: "TRPG Session Panel",
    container: {
      accentColor: ended ? "#7f8c8d" : "#3498db",
    },
    blocks,
  };

  if (!ended) {
    components.modal = {
      title: "직접 입력",
      triggerLabel: "✏️ 직접 입력",
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
