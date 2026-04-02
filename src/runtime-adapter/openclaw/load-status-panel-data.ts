import type { TrpgRuntimeConfig } from "../../config.js";
import { loadStructuredWorldFile } from "../../world-store.js";

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

const STATUS_SCHEMA_VERSION = 2;
const STATUS_SCHEMA_TAG = "player_status_v2";

export async function loadStatusPanelData(
  params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
  },
  deps: LoadStatusPanelDataDeps,
): Promise<StatusPanelDataResult> {
  const nowIso = new Date().toISOString();
  const loadOrDefault = async (relativePath: string, fallbackRoot: Record<string, unknown>) => {
    try {
      return await loadStructuredWorldFile(params.worldRoot, relativePath, {
        allowMissing: true,
        maxReadBytes: params.cfg.maxReadBytes,
      });
    } catch {
      return {
        exists: false,
        format: "yaml" as const,
        sourceText: "",
        parsed: fallbackRoot,
        sha256: "",
      };
    }
  };

  const [statusLoaded, inventoryLoaded, sceneLoaded] = await Promise.all([
    loadOrDefault("state/player-status.yaml", {
      meta: {
        schema_version: STATUS_SCHEMA_VERSION,
        status_schema: STATUS_SCHEMA_TAG,
        migrations: {
          [STATUS_SCHEMA_TAG]: true,
          [`${STATUS_SCHEMA_TAG}_applied_at`]: nowIso,
        },
        last_updated: nowIso,
      },
      player_status: { money: 0, stamina: "normal", condition: "healthy", tags: [] },
      status: {
        health: { current: 12, max: 12 },
        stamina: { current: 10, max: 10 },
        stress: { current: 0, max: 10 },
        economy: { money: 0, funds: 0 },
      },
    }),
    loadOrDefault("state/inventory.yaml", {
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
  const statusMeta = deps.toObject(statusRoot.meta);
  const statusMigrations = deps.toObject(statusMeta.migrations);
  const statusSchemaMigrated =
    (deps.readFiniteNumber(statusMeta.schema_version) ?? 0) >= STATUS_SCHEMA_VERSION ||
    statusMigrations[STATUS_SCHEMA_TAG] === true;
  const health = deps.toObject(legacyStatus.health);
  const staminaGauge = deps.toObject(legacyStatus.stamina);
  const stress = deps.toObject(legacyStatus.stress);
  const economy = deps.toObject(legacyStatus.economy);
  const legacyFunds = deps.toObject(statusRoot.funds);

  const hpCurrent =
    deps.readFiniteNumber(health.current) ??
    (statusSchemaMigrated ? null : deps.readFiniteNumber(legacyStatus.hp_current));
  const hpMax =
    deps.readFiniteNumber(health.max) ?? (statusSchemaMigrated ? null : deps.readFiniteNumber(legacyStatus.hp_max));
  const staminaCurrent =
    deps.readFiniteNumber(staminaGauge.current) ??
    (statusSchemaMigrated ? null : deps.readFiniteNumber(legacyStatus.stamina_current));
  const staminaMax =
    deps.readFiniteNumber(staminaGauge.max) ??
    (statusSchemaMigrated ? null : deps.readFiniteNumber(legacyStatus.stamina_max));
  const stressCurrent =
    deps.readFiniteNumber(stress.current) ??
    (statusSchemaMigrated ? null : deps.readFiniteNumber(legacyStatus.stress_current));
  const stressMax =
    deps.readFiniteNumber(stress.max) ??
    (statusSchemaMigrated ? null : deps.readFiniteNumber(legacyStatus.stress_max));

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
    deps.readFiniteNumber(economy.funds) ??
    (statusSchemaMigrated ? null : deps.readFiniteNumber(legacyFunds.coins));

  const staminaState =
    deps.readString(playerStatus.stamina) || deps.readString(playerStatus.stamina_state) || "normal";
  const conditionState =
    deps.readString(playerStatus.condition) ||
    (statusSchemaMigrated ? "" : deps.readString(statusRoot.condition)) ||
    "healthy";
  const tags = deps.toStringArray(playerStatus.tags);
  const effectiveTags =
    tags.length > 0
      ? tags.slice(0, 6)
      : statusSchemaMigrated
        ? []
        : deps.toStringArray(statusRoot.tags).slice(0, 6);

  const fundsText =
    money !== null
      ? `coins ${String(Math.round(money))}`
      : deps.readString(economy.funds) || deps.readString(economy.currency) || "unknown";

  const sceneMeta = deps.toObject(deps.toObject(sceneLoaded.parsed).meta);
  const worldTime = deps.readString(statusMeta.last_updated) || deps.readString(sceneMeta.last_updated) || nowIso;

  return {
    hpCurrent,
    hpMax,
    staminaCurrent,
    staminaMax,
    stressCurrent,
    stressMax,
    money,
    staminaState,
    conditionState,
    tags: effectiveTags,
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
