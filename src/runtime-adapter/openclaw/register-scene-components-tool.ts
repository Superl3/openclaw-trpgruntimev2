import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import type { TrpgRuntimeConfig } from "../../config.js";
import {
  buildSceneComponents,
  type RuntimePhase,
  type SceneComponentInput,
} from "../../discord-components.js";
import { emitRuntimeDiagnostic } from "../../runtime-core/runtime-diagnostics.js";
import { SCENE_COMPONENT_PARAMETERS } from "./scene-components-tool-schema.js";

type ToolGateResult =
  | { ok: true; worldRoot: string; agentId: string }
  | { ok: false; payload: Record<string, unknown> };

type JsonToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

type RegisterSceneComponentsToolParams = {
  api: OpenClawPluginApi;
  cfg: TrpgRuntimeConfig;
  toolGate: (params: {
    cfg: TrpgRuntimeConfig;
    ctx: OpenClawPluginToolContext;
    api: OpenClawPluginApi;
  }) => ToolGateResult;
  jsonToolResult: (payload: unknown) => JsonToolResult;
  detectRuntimePhase: (params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
    sessionId?: string;
  }) => Promise<RuntimePhase>;
  normalizeSceneComponentInputByPhase: (
    input: SceneComponentInput,
    runtimePhase: RuntimePhase,
  ) => SceneComponentInput;
  classifyTurnKind: (latestUserMessage: string) => "scene-turn" | "etc";
  readString: (value: unknown) => string;
  loadStatusPanelData: (params: { cfg: TrpgRuntimeConfig; worldRoot: string }) => Promise<{
    hpCurrent: number | null;
    hpMax: number | null;
    staminaState: string;
    money: number | null;
    currentGoal: string;
    carriedItems: string[];
    equippedItems: string[];
  }>;
};

export function registerSceneComponentsTool(params: RegisterSceneComponentsToolParams): void {
  const {
    api,
    cfg,
    toolGate,
    jsonToolResult,
    detectRuntimePhase,
    normalizeSceneComponentInputByPhase,
    classifyTurnKind,
    readString,
    loadStatusPanelData,
  } = params;

  api.registerTool(
    (ctx) => ({
      name: "trpg_scene_components",
      description:
        "Build a Discord component payload for a TRPG scene response. Returns JSON components to pass to the message tool. " +
        "Always use this for scene responses instead of plain text. " +
        "Scene types: exploration, npc_encounter, combat, choice, dialogue.",
      parameters: SCENE_COMPONENT_PARAMETERS,
      async execute(_toolCallId, input) {
        const gate = toolGate({ cfg, ctx, api });
        if (!gate.ok) {
          return jsonToolResult(gate.payload);
        }

        try {
          const rawInput = input as SceneComponentInput;
          const runtimePhase = await detectRuntimePhase({
            cfg,
            worldRoot: gate.worldRoot,
            sessionId: ctx.sessionId,
          });
          const routingText = readString(rawInput.turnKind)
            ? ""
            : readString(rawInput.latestUserMessage) || readString(rawInput.description);
          const turnKind = rawInput.turnKind === "etc" || rawInput.turnKind === "scene-turn"
            ? rawInput.turnKind
            : classifyTurnKind(routingText);

          if (turnKind === "etc") {
            await emitRuntimeDiagnostic({
              cfg,
              worldRoot: gate.worldRoot,
              sessionId: ctx.sessionId,
              event: "scene_components_suppressed",
              severity: "info",
              runtimePhase,
              route: "trpg_scene_components",
              gate: "turn_kind",
              result: "etc",
              details: {
                requestedScene: readString(rawInput.scene),
                latestUserMessage: readString(rawInput.latestUserMessage) || undefined,
              },
            });
            return jsonToolResult({
              ok: true,
              runtimePhase,
              turnKind,
              plainReplyRecommended: true,
              skipSceneComponents: true,
              components: null,
              instructions: "This input is meta/etc, so reply in plain text instead of sending TRPG scene components.",
            });
          }

          const normalizedInput = normalizeSceneComponentInputByPhase(rawInput, runtimePhase);
          
          const statusData = await loadStatusPanelData({ cfg, worldRoot: gate.worldRoot });
          
          // Inject player status into the Embed fields of the scene component
          const normalizedInputWithStatus: SceneComponentInput = {
            ...normalizedInput,
            status: {
              hpCurrent: statusData.hpCurrent,
              hpMax: statusData.hpMax,
              staminaState: statusData.staminaState,
              money: statusData.money,
              currentGoal: statusData.currentGoal || undefined,
            },
          };
          
          const components = buildSceneComponents(normalizedInputWithStatus);
          
          const inventoryOptions = [
            ...statusData.equippedItems.map((item) => ({ label: `[\uc7a5\ucc29] ${item}`.slice(0, 80), value: `eq_${item}`.slice(0, 100) })),
            ...statusData.carriedItems.map((item) => ({ label: item.slice(0, 80), value: `carry_${item}`.slice(0, 100) }))
          ].slice(0, 25);
          
          if (inventoryOptions.length === 0) {
            inventoryOptions.push({ label: "\ube48 \uac00\ubc29", value: "empty" });
          }
          
          if (Array.isArray(components.blocks)) {
            components.blocks.push({
              type: "actions",
              select: {
                type: "string",
                placeholder: `\ud83c\udf92 \uac00\ubc29 \ud655\uc778 (HP: ${statusData.hpCurrent ?? "?"}/${statusData.hpMax ?? "?"})`,
                options: inventoryOptions
              }
            });
          }
          const requestedButtons = Array.isArray(rawInput.buttons)
            ? rawInput.buttons?.length ?? 0
            : 0;
          const normalizedButtons = Array.isArray(normalizedInput.buttons) ? normalizedInput.buttons.length : 0;
          const requestedScene = readString(rawInput.scene);
          const blockedButtons = normalizedInput.scene !== requestedScene
            ? requestedButtons
            : Math.max(0, requestedButtons - normalizedButtons);
          await emitRuntimeDiagnostic({
            cfg,
            worldRoot: gate.worldRoot,
            sessionId: ctx.sessionId,
            event: "scene_components_normalized",
            severity: "info",
            runtimePhase,
            route: "trpg_scene_components",
            gate: "normalization",
            result: "ok",
            details: {
              requestedScene,
              normalizedScene: normalizedInput.scene,
              requestedButtons,
              normalizedButtons,
              blockedButtons,
              includeInput: normalizedInput.includeInput !== false,
              turnKind,
            },
          });
          return jsonToolResult({
            ok: true,
            runtimePhase,
            turnKind,
            plainReplyRecommended: false,
            skipSceneComponents: false,
            components,
            instructions:
              "Pass this 'components' object to the message tool: message(action='send', message='scene update', components=<this.components>)",
          });
        } catch (error) {
          return jsonToolResult({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }),
    { name: "trpg_scene_components" },
  );
}
