import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { applyPromptInjectionBudget } from "./prompt-injection-budget.js";

export function buildBudgetedAppendSystemContext(params: {
  api: OpenClawPluginApi;
  chunks: string[];
  latestAction: string;
  bootstrapIncomplete: boolean;
  isNpcMemoryRelevantAction: (latestAction: string) => boolean;
}): { appendSystemContext: string } | undefined {
  if (params.chunks.length === 0) {
    return undefined;
  }

  const budgeted = applyPromptInjectionBudget({
    chunks: params.chunks,
    latestAction: params.latestAction,
    bootstrapIncomplete: params.bootstrapIncomplete,
    isNpcMemoryRelevantAction: params.isNpcMemoryRelevantAction,
  });

  if (budgeted.droppedTags.length > 0) {
    params.api.logger.info("[trpg-runtime] injection budget dropped tags=" + budgeted.droppedTags.join(","));
  }

  return {
    appendSystemContext: budgeted.selected.join(String.fromCharCode(10) + String.fromCharCode(10)),
  };
}
