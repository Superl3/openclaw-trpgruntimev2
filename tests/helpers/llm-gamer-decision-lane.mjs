const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_SYSTEM_PROMPT =
  "You are a TRPG player action selector, not a narrator. Choose exactly one visible valid action only. Never hallucinate fields, hidden facts, or unavailable actions. Prefer stable identifiers (customId/actionId/value) over UI labels when selecting. Prefer interesting but progress-safe choices; avoid chaos-only griefing. Return exactly one strict JSON object only (no markdown, no prose): {\"type\":\"button\",\"customId\":\"...\"} OR {\"type\":\"modal\",\"customId\":\"...\",\"freeInput\":\"...\"}.";

function resolveTimeoutMs(optionsTimeout) {
  const raw = optionsTimeout ?? process.env.GAMER_LLM_TIMEOUT_MS;
  const parsed = Number.parseInt(String(raw ?? DEFAULT_TIMEOUT_MS), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function resolveEndpoint(baseUrl) {
  const resolvedBase = (baseUrl ?? process.env.GAMER_LLM_BASE_URL ?? DEFAULT_BASE_URL).trim();
  if (!resolvedBase) {
    return `${DEFAULT_BASE_URL}/chat/completions`;
  }
  if (resolvedBase.endsWith("/chat/completions")) {
    return resolvedBase;
  }
  const normalized = resolvedBase.endsWith("/") ? resolvedBase.slice(0, -1) : resolvedBase;
  return `${normalized}/chat/completions`;
}

function resolveNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveTemperature(options = {}) {
  const explicit = resolveNumber(options.temperature);
  if (explicit !== null) {
    return explicit;
  }
  const envValue = resolveNumber(process.env.GAMER_LLM_TEMPERATURE);
  if (envValue !== null) {
    return envValue;
  }
  return DEFAULT_TEMPERATURE;
}

function resolveTopP(options = {}) {
  const explicit = resolveNumber(options.topP);
  if (explicit !== null) {
    return explicit;
  }
  return resolveNumber(process.env.GAMER_LLM_TOP_P);
}

function resolveMaxTokens(options = {}) {
  const explicit = resolveNumber(options.maxTokens);
  if (explicit !== null) {
    return Math.trunc(explicit);
  }
  const envValue = resolveNumber(process.env.GAMER_LLM_MAX_TOKENS);
  return envValue === null ? null : Math.trunc(envValue);
}

function resolveSystemPrompt(options = {}) {
  const explicit = typeof options.systemPrompt === "string" ? options.systemPrompt.trim() : "";
  if (explicit) {
    return explicit;
  }
  const fromEnv = typeof process.env.GAMER_LLM_SYSTEM_PROMPT === "string" ? process.env.GAMER_LLM_SYSTEM_PROMPT.trim() : "";
  if (fromEnv) {
    return fromEnv;
  }
  return DEFAULT_SYSTEM_PROMPT;
}

function extractJsonObject(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const slice = trimmed.slice(start, end + 1);
      return JSON.parse(slice);
    }
    throw new Error("No JSON object found in model response");
  }
}

function sanitizePromptContext(context) {
  const visible = context?.visible || {};
  const buttons = Array.isArray(visible.buttons)
    ? visible.buttons
        .map((button) => ({
          customId: typeof button?.customId === "string" ? button.customId : null,
          label: typeof button?.label === "string" ? button.label : null,
          actionId: typeof button?.actionId === "string" ? button.actionId : null,
        }))
        .filter((button) => typeof button.customId === "string")
    : [];
  const modal = visible?.modal && typeof visible.modal.customId === "string" ? { customId: visible.modal.customId } : null;
  const recommendation =
    visible?.recommendation && typeof visible.recommendation.actionId === "string"
      ? { actionId: visible.recommendation.actionId }
      : null;
  const textSummary = typeof visible?.textSummary === "string" ? visible.textSummary.slice(0, 1500) : "";

  return {
    recommendation,
    buttons,
    modal,
    textSummary,
  };
}

function buildUserPrompt(promptContext) {
  const selectionRules = [
    "Pick exactly one action route.",
    "Use only customId values visible in the provided buttons/modal blocks.",
    "Prefer customId/actionId/value signals over human-readable labels.",
    "If recommendation exists and appears safe/progressive, prefer it.",
    "Do not invent extra keys. Output one JSON object only.",
  ];

  const payload = {
    scene: {
      visibleText: promptContext.textSummary,
    },
    visibleButtons: promptContext.buttons,
    visibleModal: promptContext.modal,
    recommendation: promptContext.recommendation,
    selectionRules,
    outputSchema: {
      button: { type: "button", customId: "string" },
      modal: { type: "modal", customId: "string", freeInput: "string (optional)" },
    },
  };

  return [
    "Select the next player action using only this machine-readable context.",
    "Return exactly one JSON object only.",
    "BEGIN_CONTEXT_JSON",
    JSON.stringify(payload),
    "END_CONTEXT_JSON",
  ].join("\n");
}

function buildAllowedSelectionSet(promptContext) {
  const allowedButtons = new Set(
    (Array.isArray(promptContext?.buttons) ? promptContext.buttons : [])
      .map((entry) => (typeof entry?.customId === "string" ? entry.customId : null))
      .filter(Boolean),
  );
  const modalCustomId = typeof promptContext?.modal?.customId === "string" ? promptContext.modal.customId : null;
  return {
    allowedButtons,
    modalCustomId,
  };
}

export function createOpenAiChatDecisionLane(options = {}) {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const allowNoAuth = options.allowNoAuth === true;
  if (!apiKey && !allowNoAuth) {
    throw new Error("OPENAI_API_KEY is required for createOpenAiChatDecisionLane");
  }
  const model = options.model ?? process.env.GAMER_LLM_MODEL ?? DEFAULT_MODEL;
  const endpoint = resolveEndpoint(options.baseUrl);
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const systemPrompt = resolveSystemPrompt(options);
  const temperature = resolveTemperature(options);
  const topP = resolveTopP(options);
  const maxTokens = resolveMaxTokens(options);

  return async function decisionLane(context) {
    const promptContext = sanitizePromptContext(context);
    const allowed = buildAllowedSelectionSet(promptContext);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          temperature,
          ...(topP !== null ? { top_p: topP } : {}),
          ...(maxTokens !== null && maxTokens > 0 ? { max_tokens: maxTokens } : {}),
          messages: [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: buildUserPrompt(promptContext),
            },
          ],
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`OpenAI HTTP ${response.status}: ${errorBody.slice(0, 400)}`);
      }

      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new Error("OpenAI response missing choices[0].message.content");
      }

      const parsed = extractJsonObject(content);
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Decision JSON must be an object");
      }
      if (parsed.type === "button" && typeof parsed.customId === "string") {
        if (!allowed.allowedButtons.has(parsed.customId)) {
          throw new Error(`Decision customId '${parsed.customId}' is not a visible button`);
        }
        return {
          type: "button",
          customId: parsed.customId,
        };
      }
      if (parsed.type === "modal" && typeof parsed.customId === "string") {
        if (!allowed.modalCustomId || parsed.customId !== allowed.modalCustomId) {
          throw new Error(`Decision customId '${parsed.customId}' is not the visible modal route`);
        }
        return {
          type: "modal",
          customId: parsed.customId,
          ...(typeof parsed.freeInput === "string" ? { freeInput: parsed.freeInput.slice(0, 1000) } : {}),
        };
      }

      throw new Error("Decision JSON does not match required schema");
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`OpenAI decision lane timeout after ${timeoutMs}ms`);
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`OpenAI decision lane failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  };
}
