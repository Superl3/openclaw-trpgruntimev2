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
          const components = buildSceneComponents(normalizedInput);
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
