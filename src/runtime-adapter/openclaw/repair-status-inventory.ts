import fs from "node:fs/promises";
import path from "node:path";
import type { TrpgRuntimeConfig } from "../../config.js";
import {
  loadStructuredWorldFile,
  renderStructuredContent,
  resolveWorldAbsolutePath,
  type LoadedStructuredFile,
} from "../../world-store.js";
import { readFiniteNumber, readString, toObject, toStringArray } from "./runtime-guard-utils.js";

export type StatusInventoryRepairInput = {
  dryRun?: boolean;
  repairStatus?: boolean;
  repairInventory?: boolean;
};

type RepairFileResult = {
  target: string;
  attempted: boolean;
  repaired: boolean;
  wrote: boolean;
  dryRun: boolean;
  parseErrorRecovered: boolean;
  missing: boolean;
  reason: string;
};

type LoadedWithFallback = {
  loaded: LoadedStructuredFile;
  parseErrorRecovered: boolean;
};

const STATUS_SCHEMA_VERSION = 2;
const STATUS_SCHEMA_TAG = "player_status_v2";

function isParseFailure(error: unknown, worldRelativePath: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes(`failed to parse ${worldRelativePath.toLowerCase()}`);
}

async function loadWithParseFallback(params: {
  worldRoot: string;
  cfg: TrpgRuntimeConfig;
  worldRelativePath: string;
  fallbackRoot: Record<string, unknown>;
}): Promise<LoadedWithFallback> {
  try {
    const loaded = await loadStructuredWorldFile(params.worldRoot, params.worldRelativePath, {
      allowMissing: true,
      maxReadBytes: params.cfg.maxReadBytes,
    });
    return {
      loaded,
      parseErrorRecovered: false,
    };
  } catch (error) {
    if (!isParseFailure(error, params.worldRelativePath)) {
      throw error;
    }
    return {
      loaded: {
        exists: false,
        format: "yaml",
        sourceText: "",
        parsed: params.fallbackRoot,
        sha256: "",
      },
      parseErrorRecovered: true,
    };
  }
}

function needsStatusRepair(statusRoot: Record<string, unknown>): boolean {
  const meta = toObject(statusRoot.meta);
  const migrations = toObject(meta.migrations);
  const schemaVersion = readFiniteNumber(meta.schema_version) ?? 0;
  const schemaMigrated = schemaVersion >= STATUS_SCHEMA_VERSION || migrations[STATUS_SCHEMA_TAG] === true;

  const playerStatus = toObject(statusRoot.player_status);
  const legacyStatus = toObject(statusRoot.status);
  const health = toObject(legacyStatus.health);
  const economy = toObject(legacyStatus.economy);
  const legacyFunds = toObject(statusRoot.funds);

  const hasLegacyFlatStatusKeys =
    readFiniteNumber(legacyStatus.hp_current) !== null ||
    readFiniteNumber(legacyStatus.hp_max) !== null ||
    readFiniteNumber(legacyStatus.stamina_current) !== null ||
    readFiniteNumber(legacyStatus.stamina_max) !== null ||
    readFiniteNumber(legacyStatus.stress_current) !== null ||
    readFiniteNumber(legacyStatus.stress_max) !== null;
  const hasLegacyTopLevelKeys =
    readFiniteNumber(legacyFunds.coins) !== null ||
    Array.isArray(statusRoot.tags) ||
    readString(statusRoot.condition).length > 0 ||
    Array.isArray(statusRoot.inventory);

  if (!schemaMigrated) {
    return true;
  }
  if (hasLegacyFlatStatusKeys || hasLegacyTopLevelKeys) {
    return true;
  }

  if (readFiniteNumber(health.current) === null || readFiniteNumber(health.max) === null) {
    return true;
  }
  if (readFiniteNumber(playerStatus.money) === null && readFiniteNumber(economy.money) === null) {
    return true;
  }
  if (!readString(playerStatus.stamina) && !readString(playerStatus.stamina_state)) {
    return true;
  }
  return false;
}

function buildNormalizedStatusRoot(statusRoot: Record<string, unknown>, nowIso: string): Record<string, unknown> {
  const meta = toObject(statusRoot.meta);
  const migrations = toObject(meta.migrations);
  const playerStatus = toObject(statusRoot.player_status);
  const bootstrapStatus = toObject(playerStatus.bootstrap);
  const legacyStatus = toObject(statusRoot.status);
  const health = toObject(legacyStatus.health);
  const staminaGauge = toObject(legacyStatus.stamina);
  const stress = toObject(legacyStatus.stress);
  const economy = toObject(legacyStatus.economy);
  const legacyFunds = toObject(statusRoot.funds);

  const hpCurrent = readFiniteNumber(health.current) ?? readFiniteNumber(legacyStatus.hp_current) ?? 12;
  const hpMax = readFiniteNumber(health.max) ?? readFiniteNumber(legacyStatus.hp_max) ?? 12;
  const staminaCurrent =
    readFiniteNumber(staminaGauge.current) ?? readFiniteNumber(legacyStatus.stamina_current) ?? 10;
  const staminaMax = readFiniteNumber(staminaGauge.max) ?? readFiniteNumber(legacyStatus.stamina_max) ?? 10;
  const stressCurrent = readFiniteNumber(stress.current) ?? readFiniteNumber(legacyStatus.stress_current) ?? 0;
  const stressMax = readFiniteNumber(stress.max) ?? readFiniteNumber(legacyStatus.stress_max) ?? 10;

  const money =
    readFiniteNumber(playerStatus.money) ??
    readFiniteNumber(economy.money) ??
    readFiniteNumber(economy.funds) ??
    readFiniteNumber(legacyFunds.coins) ??
    0;
  const playerTags = toStringArray(playerStatus.tags);
  const legacyTags = toStringArray(statusRoot.tags);
  const normalizedTags = playerTags.length > 0 ? playerTags : legacyTags;
  const normalizedCondition = readString(playerStatus.condition) || readString(statusRoot.condition) || "healthy";
  const normalizedStaminaState =
    readString(playerStatus.stamina_state) || readString(playerStatus.stamina) || "normal";

  const normalizedRoot: Record<string, unknown> = {
    ...statusRoot,
    meta: {
      ...meta,
      schema_version: STATUS_SCHEMA_VERSION,
      status_schema: STATUS_SCHEMA_TAG,
      migrations: {
        ...migrations,
        [STATUS_SCHEMA_TAG]: true,
        [`${STATUS_SCHEMA_TAG}_applied_at`]: nowIso,
      },
      last_updated: nowIso,
    },
    player_status: {
      ...playerStatus,
      money,
      stamina_state: normalizedStaminaState,
      stamina: readString(playerStatus.stamina) || normalizedStaminaState,
      condition: normalizedCondition,
      tags: normalizedTags,
      bootstrap: {
        ...bootstrapStatus,
      },
    },
    status: {
      health: {
        current: hpCurrent,
        max: hpMax,
      },
      stamina: {
        current: staminaCurrent,
        max: staminaMax,
      },
      stress: {
        current: stressCurrent,
        max: stressMax,
      },
      economy: {
        money,
        funds: readFiniteNumber(economy.funds) ?? money,
      },
    },
  };

  delete normalizedRoot.funds;
  delete normalizedRoot.condition;
  delete normalizedRoot.tags;
  delete normalizedRoot.inventory;

  return normalizedRoot;
}

function needsInventoryRepair(inventoryRoot: Record<string, unknown>): boolean {
  const inventory = toObject(inventoryRoot.inventory);
  if (!Array.isArray(inventory.carried)) {
    return true;
  }
  if (!Array.isArray(inventory.equipped)) {
    return true;
  }
  if (!Array.isArray(inventory.notes)) {
    return true;
  }
  return false;
}

function buildNormalizedInventoryRoot(inventoryRoot: Record<string, unknown>, nowIso: string): Record<string, unknown> {
  const inventory = toObject(inventoryRoot.inventory);
  return {
    ...inventoryRoot,
    meta: {
      ...toObject(inventoryRoot.meta),
      schema_version: 1,
      last_updated: nowIso,
    },
    inventory: {
      ...inventory,
      carried: Array.isArray(inventory.carried) ? toStringArray(inventory.carried) : [],
      equipped: Array.isArray(inventory.equipped) ? toStringArray(inventory.equipped) : [],
      notes: Array.isArray(inventory.notes) ? toStringArray(inventory.notes) : [],
    },
  };
}

async function writeStructuredFile(params: {
  worldRoot: string;
  worldRelativePath: string;
  rendered: string;
}): Promise<void> {
  const absolute = resolveWorldAbsolutePath(params.worldRoot, params.worldRelativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, params.rendered, "utf8");
}

export async function runStatusInventoryRepairTool(params: {
  cfg: TrpgRuntimeConfig;
  worldRoot: string;
  input: StatusInventoryRepairInput;
}): Promise<Record<string, unknown>> {
  const dryRun = params.input.dryRun === true;
  const repairStatus = params.input.repairStatus !== false;
  const repairInventory = params.input.repairInventory !== false;
  if (!repairStatus && !repairInventory) {
    return {
      ok: false,
      error: "at least one target must be enabled (repairStatus or repairInventory)",
    };
  }

  const nowIso = new Date().toISOString();

  const statusResult: RepairFileResult = {
    target: "state/player-status.yaml",
    attempted: repairStatus,
    repaired: false,
    wrote: false,
    dryRun,
    parseErrorRecovered: false,
    missing: false,
    reason: repairStatus ? "already_healthy" : "skipped",
  };
  const inventoryResult: RepairFileResult = {
    target: "state/inventory.yaml",
    attempted: repairInventory,
    repaired: false,
    wrote: false,
    dryRun,
    parseErrorRecovered: false,
    missing: false,
    reason: repairInventory ? "already_healthy" : "skipped",
  };

  if (repairStatus) {
    const loadedStatus = await loadWithParseFallback({
      worldRoot: params.worldRoot,
      cfg: params.cfg,
      worldRelativePath: "state/player-status.yaml",
      fallbackRoot: {
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
      },
    });
    const statusRoot = toObject(loadedStatus.loaded.parsed);
    const normalizedStatusRoot = buildNormalizedStatusRoot(statusRoot, nowIso);
    const needsRepair = loadedStatus.parseErrorRecovered || !loadedStatus.loaded.exists || needsStatusRepair(statusRoot);
    const rendered = renderStructuredContent(loadedStatus.loaded.format, normalizedStatusRoot);
    const shouldWrite = needsRepair && (loadedStatus.parseErrorRecovered || rendered !== loadedStatus.loaded.sourceText);

    statusResult.parseErrorRecovered = loadedStatus.parseErrorRecovered;
    statusResult.missing = !loadedStatus.loaded.exists;
    statusResult.repaired = needsRepair;
    statusResult.reason = needsRepair
      ? loadedStatus.parseErrorRecovered
        ? "parse_error_recovered"
        : !loadedStatus.loaded.exists
          ? "missing_file_repaired"
          : "schema_migrated_v2"
      : "already_healthy";

    if (shouldWrite && !dryRun) {
      await writeStructuredFile({
        worldRoot: params.worldRoot,
        worldRelativePath: statusResult.target,
        rendered,
      });
      statusResult.wrote = true;
    }
  }

  if (repairInventory) {
    const loadedInventory = await loadWithParseFallback({
      worldRoot: params.worldRoot,
      cfg: params.cfg,
      worldRelativePath: "state/inventory.yaml",
      fallbackRoot: {
        meta: { schema_version: 1, last_updated: nowIso },
        inventory: { carried: [], equipped: [], notes: [] },
      },
    });
    const inventoryRoot = toObject(loadedInventory.loaded.parsed);
    const normalizedInventoryRoot = buildNormalizedInventoryRoot(inventoryRoot, nowIso);
    const needsRepair =
      loadedInventory.parseErrorRecovered || !loadedInventory.loaded.exists || needsInventoryRepair(inventoryRoot);
    const rendered = renderStructuredContent(loadedInventory.loaded.format, normalizedInventoryRoot);
    const shouldWrite = needsRepair && (loadedInventory.parseErrorRecovered || rendered !== loadedInventory.loaded.sourceText);

    inventoryResult.parseErrorRecovered = loadedInventory.parseErrorRecovered;
    inventoryResult.missing = !loadedInventory.loaded.exists;
    inventoryResult.repaired = needsRepair;
    inventoryResult.reason = needsRepair
      ? loadedInventory.parseErrorRecovered
        ? "parse_error_recovered"
        : !loadedInventory.loaded.exists
          ? "missing_file_repaired"
          : "schema_shape_repaired"
      : "already_healthy";

    if (shouldWrite && !dryRun) {
      await writeStructuredFile({
        worldRoot: params.worldRoot,
        worldRelativePath: inventoryResult.target,
        rendered,
      });
      inventoryResult.wrote = true;
    }
  }

  return {
    ok: true,
    mode: dryRun ? "dry-run" : "apply",
    repairedAny: statusResult.repaired || inventoryResult.repaired,
    wroteAny: statusResult.wrote || inventoryResult.wrote,
    status: statusResult,
    inventory: inventoryResult,
  };
}
