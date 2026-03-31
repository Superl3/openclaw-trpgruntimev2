export type StatusPanelDataForGuard = {
  hpCurrent: number | null;
  hpMax: number | null;
  staminaCurrent: number | null;
  staminaMax: number | null;
  stressCurrent: number | null;
  stressMax: number | null;
  money: number | null;
  staminaState: string;
  conditionState: string;
  tags: string[];
  fundsText: string;
  inventoryHighlights: string[];
  carriedItems: string[];
  equippedItems: string[];
  inventoryNotes: string[];
  worldTime: string;
  playerName: string;
  currentGoal: string;
  bootstrapCharacterCreated: boolean;
  bootstrapComplete: boolean;
};

type BuildStatusPanelGuardChunkDeps = {
  joinLines: (lines: string[]) => string;
};

function formatGauge(label: string, current: number | null, max: number | null): string {
  if (current === null && max === null) {
    return `${label}: unknown`;
  }
  if (max === null) {
    return `${label}: ${String(Math.round(current ?? 0))}`;
  }
  return `${label}: ${String(Math.round(current ?? 0))}/${String(Math.round(max))}`;
}

function isStatusRecallIntent(message: string): boolean {
  if (!message) {
    return false;
  }

  return /(상태창|상태\s*(확인|보여|요약)|스탯|체력\s*상태|인벤|소지품|장비\s*확인|status\s*(check|panel|recall)|inventory\s*(check|recall))/i.test(
    message,
  );
}

export function buildStatusPanelGuardChunk(
  params: {
    status: StatusPanelDataForGuard;
    latestAction: string;
  },
  deps: BuildStatusPanelGuardChunkDeps,
): string {
  const lines: string[] = [
    "[TRPG_RUNTIME_STATUS_PANEL_V1]",
    `World time: ${params.status.worldTime}`,
    "Keep a compact status panel available every turn.",
    "Panel placement policy: after NPC posture and before freeform invitation.",
    `${formatGauge("HP", params.status.hpCurrent, params.status.hpMax)} | ${formatGauge("Stamina", params.status.staminaCurrent, params.status.staminaMax)} | ${formatGauge("Stress", params.status.stressCurrent, params.status.stressMax)}`,
    `Money: ${params.status.money === null ? "unknown" : String(Math.round(params.status.money))} | Stamina state: ${params.status.staminaState} | Condition: ${params.status.conditionState}`,
    `Funds: ${params.status.fundsText}`,
    "Economy mode: lightweight narrative currency only (no market simulation).",
  ];

  if (params.status.tags.length > 0) {
    lines.push(`Player tags: ${params.status.tags.join(", ")}`);
  }

  lines.push(
    "Inventory-authoritative policy: only use carried/equipped anchors listed here; never invent missing items from prior turns.",
  );

  if (params.status.playerName || params.status.currentGoal) {
    lines.push(
      `Profile (state/player-status): ${params.status.playerName || "unknown"} | Goal: ${params.status.currentGoal || "unset"}`,
    );
  }

  if (params.status.bootstrapCharacterCreated || params.status.bootstrapComplete) {
    lines.push(
      `Bootstrap flags (state/player-status): character_created=${String(params.status.bootstrapCharacterCreated)} | bootstrap_complete=${String(params.status.bootstrapComplete)}`,
    );
  }

  if (params.status.equippedItems.length > 0) {
    lines.push(`Equipped anchors: ${params.status.equippedItems.slice(0, 3).join(" | ")}`);
  }

  if (params.status.carriedItems.length > 0) {
    lines.push(`Carried anchors: ${params.status.carriedItems.slice(0, 4).join(" | ")}`);
  }

  if (params.status.inventoryHighlights.length > 0) {
    lines.push(`Inventory highlights: ${params.status.inventoryHighlights.slice(0, 6).join(" | ")}`);
  }

  if (params.status.inventoryNotes.length > 0 && isStatusRecallIntent(params.latestAction)) {
    lines.push(`Inventory notes: ${params.status.inventoryNotes.slice(0, 2).join(" | ")}`);
  }

  if (isStatusRecallIntent(params.latestAction)) {
    lines.push("Latest player intent includes explicit status recall; show the compact panel first, then continue normal scene flow.");
    lines.push("Do not switch to menu-first output for status recall.");
  }

  return deps.joinLines(lines);
}
