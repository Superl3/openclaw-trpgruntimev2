import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import type { TrpgRuntimeConfig } from "../../config.js";
import {
  buildSceneComponents,
  type RuntimePhase,
  type SceneComponentInput,
} from "../../discord-components.js";
import { emitRuntimeDiagnostic } from "../../runtime-core/runtime-diagnostics.js";

const SCENE_COMPONENT_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    scene: {
      type: "string",
      enum: [
        "bootstrap_choice",
        "exploration",
        "npc_encounter",
        "combat",
        "choice",
        "dialogue",
        "system",
        "system_input",
        "resolution",
        "travel_transition",
      ],
      description: "Scene type determines template",
    },
    turnKind: {
      type: "string",
      enum: ["scene-turn", "etc"],
      description: "Optional caller-provided routing hint for scene vs meta/etc turns",
    },
    latestUserMessage: {
      type: "string",
      description: "Latest raw user input used for routing/classification fallback",
    },
    description: {
      type: "string",
      description: "Scene description text (Discord markdown supported)",
    },
    locationInfo: {
      type: "string",
      description: "Optional location/status line",
    },
    npc: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        title: { type: "string" },
        dialogue: { type: "string" },
        disposition: { type: "string" },
        status: { type: "string" },
        color: { type: "string" },
        action: { type: "string" },
        oldDisposition: { type: "string" },
        newDisposition: { type: "string" },
      },
      required: ["name", "title"],
    },
    combat: {
      type: "object",
      additionalProperties: false,
      properties: {
        round: { type: "integer" },
        hpCurrent: { type: "integer" },
        hpMax: { type: "integer" },
        ac: { type: "integer" },
        acBuff: { type: "string" },
        manaCurrent: { type: "integer" },
        manaMax: { type: "integer" },
        enemySummary: { type: "string" },
        effects: { type: "string" },
      },
      required: ["round", "hpCurrent", "hpMax", "ac", "manaCurrent", "manaMax", "enemySummary"],
    },
    buttons: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          style: { type: "string", enum: ["primary", "secondary", "success", "danger"] },
          actionId: { type: "string" },
          customId: { type: ["string", "null"] },
          custom_id: { type: ["string", "null"] },
          disabled: { type: "boolean" },
        },
        required: ["label", "style"],
      },
      description: "Override default buttons for this scene type",
    },
    choices: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string" },
          description: { type: "string" },
          value: { type: "string" },
          emoji: { type: "string" },
        },
        required: ["label", "value"],
      },
      description: "Select menu choices (required for choice scene)",
    },
    modalTitle: {
      type: "string",
      description: "Override modal dialog title",
    },
    includeInput: {
      type: "boolean",
      description: "Include freeform input modal (default: true)",
    },
  },
  required: ["scene", "description"],
} as const;

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
