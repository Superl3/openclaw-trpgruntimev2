import fs from "node:fs/promises";
import type { TrpgRuntimeConfig } from "../../config.js";
import {
  loadStructuredWorldFile,
  renderStructuredContent,
  resolveWorldAbsolutePath,
} from "../../world-store.js";

export type StatusPanelDataResult = {
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

type LoadStatusPanelDataDeps = {
  toObject: (value: unknown) => Record<string, unknown>;
  readString: (value: unknown) => string;
  readFiniteNumber: (value: unknown) => number | null;
  toStringArray: (value: unknown) => string[];
  uniqStrings: (values: string[]) => string[];
};

export async function loadStatusPanelData(
  params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
  },
  deps: LoadStatusPanelDataDeps,
): Promise<StatusPanelDataResult> {
  const nowIso = new Date().toISOString();
  const loadOrRepair = async (relativePath: string, fallbackRoot: Record<string, unknown>) => {
    try {
      return await loadStructuredWorldFile(params.worldRoot, relativePath, {
        allowMissing: true,
        maxReadBytes: params.cfg.maxReadBytes,
      });
    } catch {
      const rendered = renderStructuredContent("yaml", fallbackRoot);
      await fs.writeFile(resolveWorldAbsolutePath(params.worldRoot, relativePath), rendered, "utf8");
      return {
        exists: true,
        format: "yaml" as const,
        sourceText: rendered,
        parsed: fallbackRoot,
        sha256: "",
      };
    }
  };

  const [statusLoaded, inventoryLoaded, sceneLoaded] = await Promise.all([
    loadOrRepair("state/player-status.yaml", {
      meta: { schema_version: 1, last_updated: nowIso },
      player_status: { money: 0, stamina: "normal", condition: "healthy", tags: [] },
      status: {
        health: { current: 12, max: 12 },
        stamina: { current: 10, max: 10 },
        stress: { current: 0, max: 10 },
        economy: { money: 0, funds: 0 },
      },
    }),
    loadOrRepair("state/inventory.yaml", {
      meta: { schema_version: 1, last_updated: nowIso },
      inventory: { carried: [], equipped: [], notes: [] },
    }),
    loadStructuredWorldFile(params.worldRoot, "state/current-scene.yaml", {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    }),
  ]);

  const statusRoot = deps.toObject(statusLoaded.parsed);
  const playerStatus = deps.toObject(statusRoot.player_status);
  const bootstrapStatus = deps.toObject(playerStatus.bootstrap);
  const legacyStatus = deps.toObject(statusRoot.status);
  const health = deps.toObject(legacyStatus.health);
  const staminaGauge = deps.toObject(legacyStatus.stamina);
  const stress = deps.toObject(legacyStatus.stress);
  const economy = deps.toObject(legacyStatus.economy);

  const inventoryRoot = deps.toObject(inventoryLoaded.parsed);
  const inventoryNode = deps.toObject(inventoryRoot.inventory);
  const carried = deps.uniqStrings(deps.toStringArray(inventoryNode.carried));
  const equipped = deps.uniqStrings(deps.toStringArray(inventoryNode.equipped));
  const notes = deps.toStringArray(inventoryNode.notes).slice(0, 6);

  const authoritativeCarried = carried.slice(0, 6);
  const authoritativeEquipped = equipped.slice(0, 6);
  const highlights = deps.uniqStrings([
    ...authoritativeEquipped.map((entry) => `${entry} [equipped]`),
    ...authoritativeCarried,
  ]).slice(0, 6);

  const money =
    deps.readFiniteNumber(playerStatus.money) ??
    deps.readFiniteNumber(economy.money) ??
    deps.readFiniteNumber(economy.funds);
  const fundsText =
    money !== null
      ? `coins ${String(Math.round(money))}`
      : deps.readString(economy.funds) || deps.readString(economy.currency) || "unknown";

  let statusNeedsRepair = false;
  if (deps.readFiniteNumber(health.current) === null || deps.readFiniteNumber(health.max) === null) {
    statusNeedsRepair = true;
  }
  if (deps.readFiniteNumber(playerStatus.money) === null && deps.readFiniteNumber(economy.money) === null) {
    statusNeedsRepair = true;
  }
  if (!deps.readString(playerStatus.stamina) && !deps.readString(playerStatus.stamina_state)) {
    statusNeedsRepair = true;
  }

  if (statusNeedsRepair) {
    statusRoot.meta = {
      ...deps.toObject(statusRoot.meta),
      schema_version: 1,
      last_updated: nowIso,
    };
    statusRoot.player_status = {
      ...deps.toObject(statusRoot.player_status),
      money: deps.readFiniteNumber(playerStatus.money) ?? deps.readFiniteNumber(economy.money) ?? 0,
      stamina_state:
        deps.readString(playerStatus.stamina_state) || deps.readString(playerStatus.stamina) || "normal",
      stamina:
        deps.readString(playerStatus.stamina) || deps.readString(playerStatus.stamina_state) || "normal",
      condition: deps.readString(playerStatus.condition) || "healthy",
      tags: deps.toStringArray(playerStatus.tags),
    };
    statusRoot.status = {
      ...deps.toObject(statusRoot.status),
      health: {
        current: deps.readFiniteNumber(health.current) ?? 12,
        max: deps.readFiniteNumber(health.max) ?? 12,
      },
      stamina: {
        current: deps.readFiniteNumber(staminaGauge.current) ?? 10,
        max: deps.readFiniteNumber(staminaGauge.max) ?? 10,
      },
      stress: {
        current: deps.readFiniteNumber(stress.current) ?? 0,
        max: deps.readFiniteNumber(stress.max) ?? 10,
      },
      economy: {
        money: deps.readFiniteNumber(economy.money) ?? deps.readFiniteNumber(playerStatus.money) ?? 0,
        funds: deps.readFiniteNumber(economy.funds) ?? deps.readFiniteNumber(playerStatus.money) ?? 0,
      },
    };
    await fs.writeFile(
      resolveWorldAbsolutePath(params.worldRoot, "state/player-status.yaml"),
      renderStructuredContent(statusLoaded.format, statusRoot),
      "utf8",
    );
  }

  const inventoryNeedsRepair = !Array.isArray(inventoryNode.carried) || !Array.isArray(inventoryNode.notes);
  if (inventoryNeedsRepair) {
    inventoryRoot.meta = {
      ...deps.toObject(inventoryRoot.meta),
      schema_version: 1,
      last_updated: nowIso,
    };
    inventoryRoot.inventory = {
      carried: Array.isArray(inventoryNode.carried) ? deps.toStringArray(inventoryNode.carried) : [],
      equipped: Array.isArray(inventoryNode.equipped) ? deps.toStringArray(inventoryNode.equipped) : [],
      notes: Array.isArray(inventoryNode.notes) ? deps.toStringArray(inventoryNode.notes) : [],
    };
    await fs.writeFile(
      resolveWorldAbsolutePath(params.worldRoot, "state/inventory.yaml"),
      renderStructuredContent(inventoryLoaded.format, inventoryRoot),
      "utf8",
    );
  }

  const statusMeta = deps.toObject(statusRoot.meta);
  const sceneMeta = deps.toObject(deps.toObject(sceneLoaded.parsed).meta);
  const worldTime = deps.readString(statusMeta.last_updated) || deps.readString(sceneMeta.last_updated) || nowIso;

  return {
    hpCurrent: deps.readFiniteNumber(health.current),
    hpMax: deps.readFiniteNumber(health.max),
    staminaCurrent: deps.readFiniteNumber(staminaGauge.current),
    staminaMax: deps.readFiniteNumber(staminaGauge.max),
    stressCurrent: deps.readFiniteNumber(stress.current),
    stressMax: deps.readFiniteNumber(stress.max),
    money,
    staminaState: deps.readString(playerStatus.stamina) || deps.readString(playerStatus.stamina_state) || "normal",
    conditionState: deps.readString(playerStatus.condition) || "healthy",
    tags: deps.toStringArray(playerStatus.tags).slice(0, 6),
    fundsText,
    inventoryHighlights: highlights,
    carriedItems: authoritativeCarried,
    equippedItems: authoritativeEquipped,
    inventoryNotes: notes,
    worldTime,
    playerName: deps.readString(playerStatus.name) || deps.readString(bootstrapStatus.name),
    currentGoal: deps.readString(playerStatus.current_goal) || deps.readString(bootstrapStatus.goal),
    bootstrapCharacterCreated:
      typeof playerStatus.character_created === "boolean"
        ? playerStatus.character_created === true
        : bootstrapStatus.character_created === true,
    bootstrapComplete:
      typeof playerStatus.bootstrap_complete === "boolean"
        ? playerStatus.bootstrap_complete === true
        : bootstrapStatus.bootstrap_complete === true,
  };
}
