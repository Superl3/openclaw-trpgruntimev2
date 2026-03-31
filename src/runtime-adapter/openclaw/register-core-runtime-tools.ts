import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
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
  DICE_ROLL_PARAMETERS,
  FACTION_TICK_PARAMETERS,
  HOOKS_QUERY_PARAMETERS,
  PATCH_APPLY_PARAMETERS,
  PATCH_DRY_RUN_TOOL_PARAMETERS,
  STATE_COMPACT_PARAMETERS,
  STORE_GET_PARAMETERS,
} from "./core-runtime-tool-schemas.js";

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

export function registerCoreRuntimeTools(params: RegisterCoreRuntimeToolsParams): void {
  const { api, cfg, patchCache, toolGate, jsonToolResult } = params;

  api.registerTool(
    (ctx) => ({
      name: "trpg_store_get",
      description:
        "Read structured TRPG world data by entity id, path, or scope with explicit knowledge-view filtering.",
      parameters: STORE_GET_PARAMETERS,
      async execute(_toolCallId, input) {
        const gate = toolGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        try {
          const payload = await runStoreGet({
            worldRoot: gate.worldRoot,
            cfg,
            input: input as StoreGetInput,
          });
          return jsonToolResult(payload);
        } catch (error) {
          return jsonToolResult({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
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
      async execute(_toolCallId, input) {
        const gate = toolGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        const payload = await runPatchDryRun({
          worldRoot: gate.worldRoot,
          cfg,
          agentId: gate.agentId,
          cache: patchCache,
          input: input as PatchDryRunInput,
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
      async execute(_toolCallId, input) {
        const gate = toolGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        try {
          const factionInput = input as FactionTickInput;
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
            return jsonToolResult({
              ...tickResult,
              dry_run_result: dryRunResult,
            });
          }

          return jsonToolResult(tickResult);
        } catch (error) {
          return jsonToolResult({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
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
      async execute(_toolCallId, input) {
        const gate = toolGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        const payload = await runPatchApply({
          worldRoot: gate.worldRoot,
          cfg,
          agentId: gate.agentId,
          sessionId: ctx.sessionId,
          cache: patchCache,
          input: input as PatchApplyInput,
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
      async execute(_toolCallId, input) {
        const gate = toolGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        try {
          const payload = await runStateCompactionTool({
            cfg,
            worldRoot: gate.worldRoot,
            agentId: gate.agentId,
            cache: patchCache,
            input: input as StateCompactInput,
          });
          return jsonToolResult(payload);
        } catch (error) {
          return jsonToolResult({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }),
    { name: "trpg_state_compact" },
  );

  api.registerTool(
    (ctx) => ({
      name: "trpg_hooks_query",
      description:
        "Return dormant hook and reveal candidates with prerequisite status and tension scoring.",
      parameters: HOOKS_QUERY_PARAMETERS,
      async execute(_toolCallId, input) {
        const gate = toolGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        try {
          const payload = await runHooksQuery({
            worldRoot: gate.worldRoot,
            cfg,
            input: input as HooksQueryInput,
          });
          return jsonToolResult(payload);
        } catch (error) {
          return jsonToolResult({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }),
    { name: "trpg_hooks_query" },
  );

  api.registerTool(
    (ctx) => ({
      name: "trpg_dice_roll",
      description: "Return deterministic and traceable structured dice roll results.",
      parameters: DICE_ROLL_PARAMETERS,
      async execute(_toolCallId, input) {
        const gate = toolGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        try {
          const payload = runDiceRoll({
            input: input as DiceRollInput,
            agentId: gate.agentId,
            sessionId: ctx.sessionId,
          });
          return jsonToolResult(payload);
        } catch (error) {
          return jsonToolResult({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }),
    { name: "trpg_dice_roll" },
  );
}
