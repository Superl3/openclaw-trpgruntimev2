import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { resolveEffectiveWorldRootForSessionSync } from "../../runtime-core/session-workspaces.js";
import {
  emitBeforePromptBranchSelected,
  emitBeforePromptBuildFailed,
  emitBeforePromptBuildStart,
  emitBeforePromptPhaseDetected,
  emitSessionWorldRootResolved,
} from "./before-prompt-diagnostics.js";
import { runInGameBeforePromptFlow } from "./before-prompt-in-game-flow.js";
import { buildBudgetedAppendSystemContext } from "./before-prompt-budgeted-response.js";
import type { RegisterBeforePromptBuildHookParams } from "./before-prompt-types.js";

export function registerBeforePromptBuildHook(params: RegisterBeforePromptBuildHookParams): void {
  const { api, cfg, patchCache, deps } = params;

  api.on("before_prompt_build", async (event, hookCtx) => {
    if (!deps.isAllowedRuntimeAgent(cfg, hookCtx.agentId as string)) {
      return;
    }

    try {
      await emitBeforePromptBuildStart({
        cfg,
        sessionId: hookCtx.sessionId,
        hasPrompt: typeof event.prompt === "string" && event.prompt.length > 0,
        messageCount: Array.isArray(event.messages) ? event.messages.length : 0,
      });

      const canonicalWorldRoot = deps.resolveWorldRootForContext({
        cfg,
        ctx: hookCtx as OpenClawPluginToolContext,
        resolvePath: api.resolvePath,
      });
      const worldRoot = resolveEffectiveWorldRootForSessionSync({
        canonicalWorldRoot,
        sessionContextId: hookCtx.sessionId,
      });

      await emitSessionWorldRootResolved({
        cfg,
        worldRoot,
        sessionId: hookCtx.sessionId,
        canonicalWorldRoot,
        effectiveWorldRoot: worldRoot,
      });

      const appendChunks: string[] = [];
      const promptMessages = Array.isArray(event.messages) ? event.messages : [];
      const extractedLatestAction =
        deps.extractLatestUserMessageFromPrompt(event.prompt) || deps.extractLatestUserMessage(promptMessages);
      const latestAction =
        extractedLatestAction ||
        deps.sanitizeIntentText(typeof event.prompt === "string" ? event.prompt.slice(-900) : "", 320);

      const bootstrap = await deps.runCharacterBootstrapGate({
        cfg,
        worldRoot,
        agentId: hookCtx.agentId as string,
        sessionId: hookCtx.sessionId,
        patchCache,
        messages: promptMessages,
        prompt: event.prompt,
      });

      await emitBeforePromptPhaseDetected({
        cfg,
        worldRoot,
        sessionId: hookCtx.sessionId,
        runtimePhase: bootstrap.runtimePhase,
        phaseSignals: bootstrap.phaseSignals,
      });

      if (bootstrap.contextChunk) {
        appendChunks.push(bootstrap.contextChunk);
      }

      if (!bootstrap.bootstrapComplete) {
        await emitBeforePromptBranchSelected({
          cfg,
          worldRoot,
          sessionId: hookCtx.sessionId,
          runtimePhase: bootstrap.runtimePhase,
          result: "bootstrap",
          bootstrapComplete: bootstrap.bootstrapComplete,
          justCompleted: bootstrap.justCompleted,
        });
        api.logger.info("[trpg-runtime] scene intro/travel/faction gated until character bootstrap completes");
        return buildBudgetedAppendSystemContext({
          api,
          chunks: appendChunks,
          latestAction,
          bootstrapIncomplete: true,
          isNpcMemoryRelevantAction: deps.isNpcMemoryRelevantAction,
        });
      }

      await emitBeforePromptBranchSelected({
        cfg,
        worldRoot,
        sessionId: hookCtx.sessionId,
        runtimePhase: bootstrap.runtimePhase,
        result: "in_game",
        bootstrapComplete: bootstrap.bootstrapComplete,
        justCompleted: bootstrap.justCompleted,
      });

      await runInGameBeforePromptFlow({
        api,
        cfg,
        worldRoot,
        prompt: event.prompt,
        promptMessages,
        latestAction,
        bootstrapJustCompleted: bootstrap.justCompleted,
        deps,
        appendChunks,
      });

      return buildBudgetedAppendSystemContext({
        api,
        chunks: appendChunks,
        latestAction,
        bootstrapIncomplete: false,
        isNpcMemoryRelevantAction: deps.isNpcMemoryRelevantAction,
      });
    } catch (error) {
      await emitBeforePromptBuildFailed({
        cfg,
        sessionId: hookCtx.sessionId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      api.logger.warn(
        `[trpg-runtime] prompt hook skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
  });
}
