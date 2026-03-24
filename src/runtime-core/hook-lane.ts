import type { QuestHookTextRenderer } from "./contracts.js";
import {
  LLM_CONTRACT_VERSION,
  isQuestHookTextOutput,
  type QuestHookTextInput,
  type QuestHookTextOutput,
  type QuestHookTextOutputOverride,
} from "./llm-contracts.js";

export type HookTextModelInvoker = {
  inferJson(prompt: string): Promise<unknown>;
};

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function promptEnvelope(task: string, input: unknown): string {
  return [
    `TASK=${task}`,
    "ROLE=You are a short hook text rewriter. Output JSON only.",
    "RULES=Do not invent facts. Keep each shortText concise, one line, and no longer than defaultText.",
    "INPUT_JSON=",
    JSON.stringify(input),
  ].join("\n");
}

function fallbackOutput(): QuestHookTextOutput {
  return {
    contractVersion: LLM_CONTRACT_VERSION,
    overrides: [],
  };
}

function normalizeShortText(raw: string, defaultText: string): string | null {
  const compact = raw.replace(/\s+/g, " ").trim();
  if (!compact) {
    return null;
  }

  const maxLength = Math.max(1, defaultText.length);
  const sliced = compact.slice(0, maxLength).trim();
  return sliced || null;
}

function normalizeOverrides(
  overrides: QuestHookTextOutputOverride[],
  input: QuestHookTextInput,
): QuestHookTextOutputOverride[] {
  const slotTextLimits = new Map(input.slots.map((slot) => [slot.slotKey, slot.defaultText]));
  const normalized: QuestHookTextOutputOverride[] = [];
  const seen = new Set<string>();

  for (const override of overrides) {
    const slotKey = readString(override.slotKey);
    if (!slotKey || seen.has(slotKey)) {
      continue;
    }

    const defaultText = slotTextLimits.get(slotKey);
    if (!defaultText) {
      continue;
    }

    const shortText = normalizeShortText(override.shortText, defaultText);
    if (!shortText) {
      continue;
    }

    normalized.push({
      slotKey,
      shortText,
    });
    seen.add(slotKey);
    if (normalized.length >= 3) {
      break;
    }
  }

  return normalized;
}

export function validateQuestHookTextOutput(value: unknown): QuestHookTextOutput | null {
  return isQuestHookTextOutput(value) ? value : null;
}

export class RuleBasedQuestHookTextRenderer implements QuestHookTextRenderer {
  constructor(private readonly invoker?: HookTextModelInvoker) {}

  async render(input: QuestHookTextInput): Promise<QuestHookTextOutput> {
    const fallback = fallbackOutput();
    if (!this.invoker || input.slots.length === 0) {
      return fallback;
    }

    try {
      const prompt = promptEnvelope("quest_hook_text_renderer_v1", input);
      const raw = await this.invoker.inferJson(prompt);
      const validated = validateQuestHookTextOutput(raw);
      if (!validated) {
        return fallback;
      }
      return {
        contractVersion: LLM_CONTRACT_VERSION,
        overrides: normalizeOverrides(validated.overrides, input),
      };
    } catch {
      return fallback;
    }
  }
}
