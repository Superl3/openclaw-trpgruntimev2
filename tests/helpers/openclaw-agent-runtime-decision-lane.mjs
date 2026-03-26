import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const DEFAULT_AGENT_ID = "drifter";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_WSL_DISTRO = "Ubuntu-24.04";
const DEFAULT_WORKDIR = "/home/superl3/.openclaw/extensions/trpg-runtime-v2";
const DEFAULT_OPENCLAW_VERSION = "2026.3.24";

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveTimeoutMs(input) {
  const parsed = Number.parseInt(String(input ?? DEFAULT_TIMEOUT_MS), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function sanitizeDecisionContext(context) {
  const visible = context?.visible && typeof context.visible === "object" ? context.visible : {};
  const buttons = Array.isArray(visible.buttons)
    ? visible.buttons
        .map((button) => ({
          customId: typeof button?.customId === "string" ? button.customId : null,
          label: typeof button?.label === "string" ? button.label : null,
          actionId: typeof button?.actionId === "string" ? button.actionId : null,
        }))
        .filter((button) => typeof button.customId === "string")
    : [];
  const modal = visible?.modal && typeof visible.modal.customId === "string"
    ? {
      customId: visible.modal.customId,
      label: typeof visible.modal.label === "string" ? visible.modal.label : null,
    }
    : null;
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

function buildDecisionPrompt(promptContext) {
  const contract = [
    "Return EXACTLY five lines in KEY=VALUE format (no markdown):",
    "SELECTION_TYPE=<button|modal|select|text>",
    "CHOICE_VALUE=<visible customId or option value>",
    "FREE_INPUT=<text for modal/text; empty otherwise>",
    "REASON=<brief reason>",
    "CONFIDENCE=<0..1>",
  ];

  const payload = {
    scene: {
      visibleText: promptContext.textSummary,
    },
    visibleButtons: promptContext.buttons,
    visibleModal: promptContext.modal,
    recommendation: promptContext.recommendation,
    hardRules: [
      "Choose exactly one visible route.",
      "Use only visible customId/value entries.",
      "Never invent hidden options.",
    ],
  };

  return [
    "Select the next player action.",
    ...contract,
    "BEGIN_CONTEXT_JSON",
    JSON.stringify(payload),
    "END_CONTEXT_JSON",
  ].join("\n");
}

function quoteForBash(value) {
  return `'${String(value ?? "").replace(/'/g, `'"'"'`)}'`;
}

function deterministicSessionId(seedText) {
  const digest = createHash("sha256").update(seedText).digest("hex");
  return `gmr-${digest.slice(0, 12)}`;
}

function createCommandSpec({
  agentId,
  sessionId,
  prompt,
  wslDistro,
  workdir,
  openclawVersion,
}) {
  const openclawPackage = `openclaw@${openclawVersion}`;
  const commandArgs = [
    "--yes",
    openclawPackage,
    "agent",
    "--agent",
    agentId,
    "--local",
    "--session-id",
    sessionId,
    "--message",
    prompt,
    "--json",
  ];

  if (process.platform === "win32") {
    const shellCommand = [
      "cd",
      quoteForBash(workdir),
      "&&",
      "npx",
      ...commandArgs.map((value) => quoteForBash(value)),
    ].join(" ");

    return {
      command: "wsl.exe",
      args: ["-d", wslDistro, "bash", "-lc", shellCommand],
      cwd: undefined,
    };
  }

  return {
    command: "npx",
    args: commandArgs,
    cwd: workdir,
  };
}

function extractJsonObject(text) {
  const trimmed = normalizeString(text);
  if (!trimmed) {
    throw new Error("OpenClaw agent command produced empty stdout");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      try {
        return JSON.parse(line);
      } catch {
        continue;
      }
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("OpenClaw agent stdout did not include JSON payload");
  }
}

function collectAssistantText(node, out) {
  if (node === null || node === undefined) {
    return;
  }
  if (typeof node === "string") {
    const trimmed = node.trim();
    if (trimmed) {
      out.push(trimmed);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const entry of node) {
      collectAssistantText(entry, out);
    }
    return;
  }
  if (typeof node !== "object") {
    return;
  }

  const role = normalizeString(node.role).toLowerCase();
  const message = node.message;
  if (role === "assistant") {
    if (typeof node.content === "string") {
      collectAssistantText(node.content, out);
    }
    if (message !== undefined) {
      collectAssistantText(message, out);
    }
    if (node.text !== undefined) {
      collectAssistantText(node.text, out);
    }
  }

  if (node.payload !== undefined) {
    collectAssistantText(node.payload, out);
  }
  if (node.outputs !== undefined) {
    collectAssistantText(node.outputs, out);
  }
  if (node.events !== undefined) {
    collectAssistantText(node.events, out);
  }
  if (node.messages !== undefined) {
    collectAssistantText(node.messages, out);
  }
  if (node.data !== undefined) {
    collectAssistantText(node.data, out);
  }

  if (typeof message === "string") {
    collectAssistantText(message, out);
  } else if (message && typeof message === "object") {
    if (typeof message.content === "string") {
      collectAssistantText(message.content, out);
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part?.text === "string") {
          collectAssistantText(part.text, out);
        }
      }
    }
    if (message.text !== undefined) {
      collectAssistantText(message.text, out);
    }
  }
}

export function extractAssistantTextFromOpenClawJson(raw) {
  const bucket = [];
  collectAssistantText(raw, bucket);
  const best = bucket.find((entry) => entry.includes("SELECTION_TYPE") || entry.includes("CHOICE_VALUE")) ?? bucket[0] ?? null;
  if (!best) {
    throw new Error("OpenClaw agent JSON did not contain assistant message text");
  }
  return best;
}

export function parseDecisionKvText(rawText) {
  const text = String(rawText ?? "");
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const values = {};
  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_\-]*)\s*[:=]\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1].trim().toUpperCase();
    const value = match[2].trim();
    values[key] = value;
  }

  const selectionType = normalizeString(values.SELECTION_TYPE || values.TYPE).toLowerCase();
  const choiceValue = normalizeString(values.CHOICE_VALUE || values.CUSTOM_ID || values.CUSTOMID || values.VALUE);
  const freeInput = values.FREE_INPUT ?? values.FREEINPUT ?? "";

  if (!selectionType) {
    throw new Error("Agent response missing SELECTION_TYPE");
  }
  if (!choiceValue) {
    throw new Error("Agent response missing CHOICE_VALUE");
  }

  return {
    selectionType,
    choiceValue,
    freeInput: String(freeInput),
    meta: {
      reason: values.REASON ?? "",
      confidence: values.CONFIDENCE ?? "",
    },
  };
}

export function normalizeBridgeSelection(parsedDecision, promptContext) {
  const allowed = buildAllowedSelectionSet(promptContext);
  const selectionType = normalizeString(parsedDecision?.selectionType).toLowerCase();
  const choiceValue = normalizeString(parsedDecision?.choiceValue);

  if (selectionType === "button") {
    if (!allowed.allowedButtons.has(choiceValue)) {
      throw new Error(`Decision customId '${choiceValue}' is not a visible button`);
    }
    return {
      type: "button",
      customId: choiceValue,
    };
  }

  if (selectionType === "modal") {
    if (!allowed.modalCustomId || allowed.modalCustomId !== choiceValue) {
      throw new Error(`Decision customId '${choiceValue}' is not the visible modal route`);
    }
    const freeInput = typeof parsedDecision?.freeInput === "string" ? parsedDecision.freeInput.slice(0, 1000) : "";
    return {
      type: "modal",
      customId: choiceValue,
      ...(freeInput ? { freeInput } : {}),
    };
  }

  if (selectionType === "select" || selectionType === "text") {
    throw new Error(`OpenClaw pipeline bridge does not support selection type '${selectionType}'`);
  }
  throw new Error(`Unsupported SELECTION_TYPE '${selectionType}'`);
}

function runOpenClawAgentJson(commandSpec, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";

    const child = spawn(commandSpec.command, commandSpec.args, {
      cwd: commandSpec.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`OpenClaw agent pipeline timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const reason = error instanceof Error ? error.message : String(error);
      reject(new Error(`OpenClaw agent pipeline failed to start: ${reason}`));
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const stderrText = normalizeString(stderr).slice(0, 400);
        reject(
          new Error(
            `OpenClaw agent pipeline exited with code ${code}${signal ? ` signal=${signal}` : ""}${stderrText ? ` stderr=${stderrText}` : ""}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

export function createOpenClawAgentRuntimeDecisionLane(options = {}) {
  const agentId = normalizeString(options.agentId) || DEFAULT_AGENT_ID;
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const wslDistro = normalizeString(options.wslDistro) || DEFAULT_WSL_DISTRO;
  const workdir = normalizeString(options.workdir) || DEFAULT_WORKDIR;
  const openclawVersion = normalizeString(options.openclawVersion) || DEFAULT_OPENCLAW_VERSION;
  const fixedSessionId = normalizeString(options.sessionId) || null;

  return async function decisionLane(context) {
    const promptContext = sanitizeDecisionContext(context);
    const prompt = buildDecisionPrompt(promptContext);
    const sessionSeed = `${agentId}|${workdir}|${JSON.stringify(promptContext)}`;
    const sessionId = fixedSessionId || deterministicSessionId(sessionSeed);
    const commandSpec = createCommandSpec({
      agentId,
      sessionId,
      prompt,
      wslDistro,
      workdir,
      openclawVersion,
    });

    const stdout = await runOpenClawAgentJson(commandSpec, timeoutMs);
    const payloadJson = extractJsonObject(stdout);
    const assistantText = extractAssistantTextFromOpenClawJson(payloadJson);
    const parsedDecision = parseDecisionKvText(assistantText);
    return normalizeBridgeSelection(parsedDecision, promptContext);
  };
}
