import fs from "node:fs/promises";
import type { TrpgRuntimeConfig } from "../../config.js";
import {
  loadStructuredWorldFile,
  renderStructuredContent,
  resolveWorldAbsolutePath,
} from "../../world-store.js";

type ApplyLightweightEconomyUpdateDeps = {
  toObject: (value: unknown) => Record<string, unknown>;
  readString: (value: unknown) => string;
  readFiniteNumber: (value: unknown) => number | null;
  uniqStrings: (values: string[]) => string[];
  toStringArray: (value: unknown) => string[];
  joinLines: (lines: string[]) => string;
};

type EconomyPurchaseIntent = {
  item: string;
  cost: number;
};

function parseEconomyPurchaseIntent(message: string): EconomyPurchaseIntent | null {
  if (!message) {
    return null;
  }

  if (!/(구매|구입|산다|샀다|buy|purchase|procure)/i.test(message)) {
    return null;
  }

  let item = "";
  const quoted = message.match(/["'“”‘’]([^"'“”‘’]{1,48})["'“”‘’]/);
  if (quoted && quoted[1]) {
    item = quoted[1].trim();
  }

  if (!item) {
    const inferred = message.match(
      /([가-힣a-zA-Z0-9][가-힣a-zA-Z0-9\s\-]{1,32})(?:을|를)?\s*(?:\d+\s*(?:은화|골드|coin|coins|money|금화|코인)\s*)?(?:구매|구입|산다|buy|purchase|procure)/i,
    );
    if (inferred && inferred[1]) {
      item = inferred[1].trim();
    }
  }

  const costMatch = message.match(/(\d{1,4})\s*(?:은화|골드|coin|coins|money|금화|코인|원)/i);
  const cost = costMatch ? Math.max(1, Number.parseInt(costMatch[1], 10)) : 1;

  const cleanedItem = item.replace(/\s+/g, " ").trim();
  if (!cleanedItem) {
    return null;
  }

  return {
    item: cleanedItem,
    cost,
  };
}

export async function applyLightweightEconomyUpdate(
  params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
    latestAction: string;
  },
  deps: ApplyLightweightEconomyUpdateDeps,
): Promise<{ contextChunk?: string }> {
  const purchase = parseEconomyPurchaseIntent(params.latestAction);
  if (!purchase) {
    return {};
  }

  const [statusLoaded, inventoryLoaded] = await Promise.all([
    loadStructuredWorldFile(params.worldRoot, "state/player-status.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
    loadStructuredWorldFile(params.worldRoot, "state/inventory.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
  ]);

  const statusRoot = deps.toObject(statusLoaded.parsed);
  const playerStatus = deps.toObject(statusRoot.player_status);
  const previousMoney = deps.readFiniteNumber(playerStatus.money) ?? 0;

  if (previousMoney < purchase.cost) {
    return {
      contextChunk: deps.joinLines([
        "[TRPG_RUNTIME_ECONOMY_LITE_V1]",
        `Purchase intent detected but insufficient money: need ${String(purchase.cost)}, have ${String(previousMoney)}.`,
        "Classify this as conditional/impossible unless another in-scene funding source is established.",
        "Explain shortfall briefly and keep freeform-first.",
      ]),
    };
  }

  playerStatus.money = Math.max(0, Math.round(previousMoney - purchase.cost));
  if (!deps.readString(playerStatus.stamina)) {
    playerStatus.stamina = "normal";
  }
  if (!deps.readString(playerStatus.condition)) {
    playerStatus.condition = "healthy";
  }
  if (!Array.isArray(playerStatus.tags)) {
    playerStatus.tags = [];
  }

  statusRoot.player_status = playerStatus;
  statusRoot.meta = {
    ...deps.toObject(statusRoot.meta),
    schema_version: 1,
    last_updated: new Date().toISOString(),
  };

  const inventoryRoot = deps.toObject(inventoryLoaded.parsed);
  const inventory = deps.toObject(inventoryRoot.inventory);
  const carried = deps.uniqStrings([...deps.toStringArray(inventory.carried), purchase.item]);
  const equipped = deps.uniqStrings(deps.toStringArray(inventory.equipped));
  const notes = deps
    .uniqStrings([...deps.toStringArray(inventory.notes).slice(-5), `purchase:${purchase.item}:${String(purchase.cost)}`])
    .slice(-6);

  inventory.carried = carried;
  inventory.equipped = equipped;
  inventory.notes = notes;
  inventoryRoot.inventory = inventory;
  inventoryRoot.meta = {
    ...deps.toObject(inventoryRoot.meta),
    schema_version: 1,
    last_updated: new Date().toISOString(),
  };

  const [statusRendered, inventoryRendered] = [
    renderStructuredContent(statusLoaded.format, statusRoot),
    renderStructuredContent(inventoryLoaded.format, inventoryRoot),
  ];

  await Promise.all([
    fs.writeFile(resolveWorldAbsolutePath(params.worldRoot, "state/player-status.yaml"), statusRendered, "utf8"),
    fs.writeFile(resolveWorldAbsolutePath(params.worldRoot, "state/inventory.yaml"), inventoryRendered, "utf8"),
  ]);

  return {
    contextChunk: deps.joinLines([
      "[TRPG_RUNTIME_ECONOMY_LITE_V1]",
      `Narrative purchase applied: ${purchase.item} (cost ${String(purchase.cost)}).`,
      `Money updated: ${String(previousMoney)} -> ${String(playerStatus.money)}.`,
      "Inventory updated as token-level carried/equipped data.",
      "No market simulation, pricing tables, or shop subsystem should be introduced.",
    ]),
  };
}
