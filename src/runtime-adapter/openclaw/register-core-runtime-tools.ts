import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { createHash } from "node:crypto";
import type { TrpgRuntimeConfig } from "../../config.js";
import { runDiceRoll, type DiceRollInput } from "../../dice.js";
import {
  createPatchCache,
  runPatchApply,
  runPatchDryRun,
  type PatchApplyInput,
  type PatchDryRunInput,
} from "../../patch-engine.js";
import {
  runFactionEngineTick,
  type FactionTickInput,
} from "../../faction-engine.js";
import {
  runHooksQuery,
  runStoreGet,
  type HooksQueryInput,
  type StoreGetInput,
} from "../../world-store.js";
import {
  runStateCompactionTool,
  type StateCompactInput,
} from "../../lifecycle-compact.js";
import {
  runStatusInventoryRepairTool,
  type StatusInventoryRepairInput,
} from "./repair-status-inventory.js";
import {
  DICE_ROLL_PARAMETERS,
  FACTION_TICK_PARAMETERS,
  HOOKS_QUERY_PARAMETERS,
  PATCH_APPLY_PARAMETERS,
  PATCH_DRY_RUN_TOOL_PARAMETERS,
  STATUS_INVENTORY_REPAIR_PARAMETERS,
  STATE_COMPACT_PARAMETERS,
  STORE_GET_PARAMETERS,
} from "./core-runtime-tool-schemas.js";
import { readFiniteNumber, readString, toObject } from "./runtime-guard-utils.js";
import { createInMemoryIdempotencyStore } from "./tool-governance-idempotency-store.js";
import {
  runGovernedTool,
  type GovernanceToolMeta,
  type ToolSessionState,
} from "./tool-governance-guard.js";

type ToolGateResult =
  | { ok: true; worldRoot: string; agentId: string }
  | { ok: false; payload: Record<string, unknown> };

type JsonToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

type RegisterCoreRuntimeToolsParams = {
  api: OpenClawPluginApi;
  cfg: TrpgRuntimeConfig;
  patchCache: ReturnType<typeof createPatchCache>;
  toolGate: (params: {
    cfg: TrpgRuntimeConfig;
    ctx: OpenClawPluginToolContext;
    api: OpenClawPluginApi;
  }) => ToolGateResult;
  jsonToolResult: (payload: unknown) => JsonToolResult;
};

type CoreToolName =
  | "trpg_store_get"
  | "trpg_patch_dry_run"
  | "trpg_faction_tick"
  | "trpg_patch_apply"
  | "trpg_state_compact"
  | "trpg_status_inventory_repair"
  | "trpg_hooks_query"
  | "trpg_dice_roll";

const CORE_RUNTIME_IDEMPOTENCY_STORE = createInMemoryIdempotencyStore<Record<string, unknown>>();

const ALL_GOVERNANCE_SESSION_STATES: ToolSessionState[] = ["NO_SESSION", "ACTIVE", "PAUSED", "ENDED"];

const CORE_RUNTIME_TOOL_GOVERNANCE: Record<CoreToolName, GovernanceToolMeta> = {
  trpg_store_get: {
    mutatesState: false,
    requiresSessionStates: ALL_GOVERNANCE_SESSION_STATES,
    allowedScopes: ["system"],
  },
  trpg_patch_dry_run: {
    mutatesState: false,
    requiresSessionStates: ALL_GOVERNANCE_SESSION_STATES,
    allowedScopes: ["system"],
  },
  trpg_faction_tick: {
    mutatesState: false,
    requiresSessionStates: ALL_GOVERNANCE_SESSION_STATES,
    allowedScopes: ["system"],
    requiresIdempotencyKey: true,
  },
  trpg_patch_apply: {
    mutatesState: true,
    requiresSessionStates: ALL_GOVERNANCE_SESSION_STATES,
    allowedScopes: ["system"],
    requiresIdempotencyKey: true,
  },
  trpg_state_compact: {
    mutatesState: true,
    requiresSessionStates: ALL_GOVERNANCE_SESSION_STATES,
    allowedScopes: ["system"],
    requiresIdempotencyKey: true,
  },
  trpg_status_inventory_repair: {
    mutatesState: true,
    requiresSessionStates: ALL_GOVERNANCE_SESSION_STATES,
    allowedScopes: ["system"],
    requiresIdempotencyKey: true,
  },
  trpg_hooks_query: {
    mutatesState: false,
    requiresSessionStates: ALL_GOVERNANCE_SESSION_STATES,
    allowedScopes: ["system"],
  },
  trpg_dice_roll: {
    mutatesState: false,
    requiresSessionStates: ALL_GOVERNANCE_SESSION_STATES,
    allowedScopes: ["system"],
    requiresIdempotencyKey: true,
  },
};

function resolveGovernanceRequestId(input: Record<string, unknown>, toolCallId: string): string {
  const requestId = readString(input.requestId);
  if (requestId) {
    return requestId;
  }
  return toolCallId || `tool-call-${Date.now().toString(36)}`;
}

function buildInputFingerprint(input: Record<string, unknown>): string {
  const stableJson = JSON.stringify(input);
  return createHash("sha256").update(stableJson).digest("hex").slice(0, 16);
}

function resolveGovernanceIdempotencyKey(input: Record<string, unknown>, requestId: string): string {
  const idempotencyKey = readString(input.idempotencyKey);
  if (idempotencyKey) {
    return idempotencyKey;
  }
  return `${requestId}:${buildInputFingerprint(input)}`;
}

function resolveExpectedStateVersion(input: Record<string, unknown>): number | undefined {
  const parsed = readFiniteNumber(input.expectedStateVersion);
  if (parsed === null) {
    return undefined;
  }
  return Math.max(0, Math.trunc(parsed));
}

function resolveToolSessionStateFromContext(sessionId: string): Promise<ToolSessionState> {
  return Promise.resolve(sessionId ? "ACTIVE" : "NO_SESSION");
}

async function runCoreGovernedTool(params: {
  toolName: CoreToolName;
  toolCallId: string;
  input: Record<string, unknown>;
  agentId: string;
  sessionId?: string;
  execute: () => Promise<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  const requestId = resolveGovernanceRequestId(params.input, params.toolCallId);
  const idempotencyKey = resolveGovernanceIdempotencyKey(params.input, requestId);

  return runGovernedTool<Record<string, unknown>, Record<string, unknown>>({
    req: {
      toolName: params.toolName,
      requestId,
      actor: {
        id: params.agentId,
        scope: "system",
      },
      input: params.input,
      sessionId: params.sessionId,
      idempotencyKey,
      expectedStateVersion: resolveExpectedStateVersion(params.input),
      confirm: params.input.confirm === true,
    },
    meta: CORE_RUNTIME_TOOL_GOVERNANCE[params.toolName],
    resolvers: {
      resolveSessionState: resolveToolSessionStateFromContext,
    },
    idempotencyStore: CORE_RUNTIME_IDEMPOTENCY_STORE,
    execute: async () => params.execute(),
  });
}

export function registerCoreRuntimeTools(params: RegisterCoreRuntimeToolsParams): void {
  const { api, cfg, patchCache, toolGate, jsonToolResult } = params;

  api.registerTool(
    (ctx) => ({
      name: "trpg_store_get",
      description:
        "Read structured TRPG world data by entity id, path, or scope with explicit knowledge-view filtering.",
      parameters: STORE_GET_PARAMETERS,
      async execute(toolCallId, input) {
        const gate = toolGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        const normalizedInput = toObject(input);
        const payload = await runCoreGovernedTool({
          toolName: "trpg_store_get",
          toolCallId,
          input: normalizedInput,
          agentId: gate.agentId,
          sessionId: ctx.sessionId || undefined,
          execute: async () => {
            try {
              return await runStoreGet({
                worldRoot: gate.worldRoot,
                cfg,
                input: normalizedInput as StoreGetInput,
              });
            } catch (error) {
              return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
        });

        return jsonToolResult(payload);
      },
    }),
    { name: "trpg_store_get" },
  );

  api.registerTool(
    (ctx) => ({
      name: "trpg_patch_dry_run",
      description:
        "Validate a TRPG patch proposal without writing files and return conflicts plus normalized diff preview.",
      parameters: PATCH_DRY_RUN_TOOL_PARAMETERS,
      async execute(toolCallId, input) {
        const gate = toolGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        const normalizedInput = toObject(input);
        const payload = await runCoreGovernedTool({
          toolName: "trpg_patch_dry_run",
          toolCallId,
          input: normalizedInput,
          agentId: gate.agentId,
          sessionId: ctx.sessionId || undefined,
          execute: async () => {
            try {
              return await runPatchDryRun({
                worldRoot: gate.worldRoot,
                cfg,
                agentId: gate.agentId,
                cache: patchCache,
                input: normalizedInput as PatchDryRunInput,
              });
            } catch (error) {
              return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
        });

        return jsonToolResult(payload);
      },
    }),
    { name: "trpg_patch_dry_run" },
  );

  api.registerTool(
    (ctx) => ({
      name: "trpg_faction_tick",
      description:
        "Advance or preview causality-first offscreen faction motion with drop/delay/silent emission summaries.",
      parameters: FACTION_TICK_PARAMETERS,
      async execute(toolCallId, input) {
        const gate = toolGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        const normalizedInput = toObject(input);
        const payload = await runCoreGovernedTool({
          toolName: "trpg_faction_tick",
          toolCallId,
          input: normalizedInput,
          agentId: gate.agentId,
          sessionId: ctx.sessionId || undefined,
          execute: async () => {
            try {
              const factionInput = normalizedInput as FactionTickInput;
              const tickResult = await runFactionEngineTick({
                worldRoot: gate.worldRoot,
                cfg,
                input: factionInput,
              });

              if (tickResult.patch_draft && factionInput.mode === "dry-run") {
                const dryRunResult = await runPatchDryRun({
                  worldRoot: gate.worldRoot,
                  cfg,
                  agentId: gate.agentId,
                  cache: patchCache,
                  input: tickResult.patch_draft as PatchDryRunInput,
                });
                return {
                  ...tickResult,
                  dry_run_result: dryRunResult,
                };
              }

              return tickResult;
            } catch (error) {
              return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
        });

        return jsonToolResult(payload);
      },
    }),
    { name: "trpg_faction_tick" },
  );

  api.registerTool(
    (ctx) => ({
      name: "trpg_patch_apply",
      description:
        "Apply a previously validated TRPG patch only with canon-auditor approval metadata and strict world-root write guards.",
      parameters: PATCH_APPLY_PARAMETERS,
      async execute(toolCallId, input) {
        const gate = toolGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        const normalizedInput = toObject(input);
        const payload = await runCoreGovernedTool({
          toolName: "trpg_patch_apply",
          toolCallId,
          input: normalizedInput,
          agentId: gate.agentId,
          sessionId: ctx.sessionId || undefined,
          execute: async () => {
            try {
              return await runPatchApply({
                worldRoot: gate.worldRoot,
                cfg,
                agentId: gate.agentId,
                sessionId: ctx.sessionId,
                cache: patchCache,
                input: normalizedInput as PatchApplyInput,
              });
            } catch (error) {
              return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
        });

        return jsonToolResult(payload);
      },
    }),
    { name: "trpg_patch_apply", optional: true },
  );

  api.registerTool(
    (ctx) => ({
      name: "trpg_state_compact",
      description:
        "Build lifecycle compaction patch drafts with weighted pruning candidates and optional audited apply.",
      parameters: STATE_COMPACT_PARAMETERS,
      async execute(toolCallId, input) {
        const gate = toolGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        const normalizedInput = toObject(input);
        const payload = await runCoreGovernedTool({
          toolName: "trpg_state_compact",
          toolCallId,
          input: normalizedInput,
          agentId: gate.agentId,
          sessionId: ctx.sessionId || undefined,
          execute: async () => {
            try {
              return await runStateCompactionTool({
                cfg,
                worldRoot: gate.worldRoot,
                agentId: gate.agentId,
                cache: patchCache,
                input: normalizedInput as StateCompactInput,
              });
            } catch (error) {
              return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
        });

        return jsonToolResult(payload);
      },
    }),
    { name: "trpg_state_compact" },
  );

  api.registerTool(
    (ctx) => ({
      name: "trpg_status_inventory_repair",
      description:
        "Explicitly repair malformed state/player-status.yaml and state/inventory.yaml files; never runs implicitly on read paths.",
      parameters: STATUS_INVENTORY_REPAIR_PARAMETERS,
      async execute(toolCallId, input) {
        const gate = toolGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        const normalizedInput = toObject(input);
        const payload = await runCoreGovernedTool({
          toolName: "trpg_status_inventory_repair",
          toolCallId,
          input: normalizedInput,
          agentId: gate.agentId,
          sessionId: ctx.sessionId || undefined,
          execute: async () => {
            try {
              return await runStatusInventoryRepairTool({
                cfg,
                worldRoot: gate.worldRoot,
                input: normalizedInput as StatusInventoryRepairInput,
              });
            } catch (error) {
              return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
        });

        return jsonToolResult(payload);
      },
    }),
    { name: "trpg_status_inventory_repair" },
  );

  api.registerTool(
    (ctx) => ({
      name: "trpg_hooks_query",
      description:
        "Return dormant hook and reveal candidates with prerequisite status and tension scoring.",
      parameters: HOOKS_QUERY_PARAMETERS,
      async execute(toolCallId, input) {
        const gate = toolGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        const normalizedInput = toObject(input);
        const payload = await runCoreGovernedTool({
          toolName: "trpg_hooks_query",
          toolCallId,
          input: normalizedInput,
          agentId: gate.agentId,
          sessionId: ctx.sessionId || undefined,
          execute: async () => {
            try {
              return await runHooksQuery({
                worldRoot: gate.worldRoot,
                cfg,
                input: normalizedInput as HooksQueryInput,
              });
            } catch (error) {
              return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
        });

        return jsonToolResult(payload);
      },
    }),
    { name: "trpg_hooks_query" },
  );

  api.registerTool(
    (ctx) => ({
      name: "trpg_dice_roll",
      description: "Return deterministic and traceable structured dice roll results.",
      parameters: DICE_ROLL_PARAMETERS,
      async execute(toolCallId, input) {
        const gate = toolGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        const normalizedInput = toObject(input);
        const payload = await runCoreGovernedTool({
          toolName: "trpg_dice_roll",
          toolCallId,
          input: normalizedInput,
          agentId: gate.agentId,
          sessionId: ctx.sessionId || undefined,
          execute: async () => {
            try {
              return runDiceRoll({
                input: normalizedInput as DiceRollInput,
                agentId: gate.agentId,
                sessionId: ctx.sessionId,
              });
            } catch (error) {
              return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
        });

        return jsonToolResult(payload);
      },
    }),
    { name: "trpg_dice_roll" },
  );
}
