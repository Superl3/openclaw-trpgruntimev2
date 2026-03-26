#!/usr/bin/env node

import process from "node:process";
import { spawn } from "node:child_process";

const DEFAULT_WORKDIR = "/home/superl3/S3OpenClaw";
const DEFAULT_AGENT_ID = "drifter";
const DEFAULT_SESSION_ID = "gamer-bridge";
const DEFAULT_OPENCLAW_VERSION = "2026.3.24";
const DEFAULT_WSL_DISTRO = "Ubuntu-24.04";
const DEFAULT_TIMEOUT_MS = 30_000;

const OUTPUT_KEYS = ["choice_type", "choice_label", "choice_value", "reason", "free_input"];

function readValue(argv, index, flag) {
  const value = String(argv[index + 1] ?? "").trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseArgs(argv) {
  const parsed = {
    bridgeWorkdir: DEFAULT_WORKDIR,
    bridgeAgentId: DEFAULT_AGENT_ID,
    bridgeSessionId: DEFAULT_SESSION_ID,
    bridgeOpenclawVersion: DEFAULT_OPENCLAW_VERSION,
    bridgeWslDistro: DEFAULT_WSL_DISTRO,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "-h" || token === "--help") {
      parsed.help = true;
      continue;
    }
    if (token === "--bridge-workdir") {
      parsed.bridgeWorkdir = readValue(argv, i, "--bridge-workdir");
      i += 1;
      continue;
    }
    if (token === "--bridge-agent-id") {
      parsed.bridgeAgentId = readValue(argv, i, "--bridge-agent-id");
      i += 1;
      continue;
    }
    if (token === "--bridge-session-id") {
      parsed.bridgeSessionId = readValue(argv, i, "--bridge-session-id");
      i += 1;
      continue;
    }
    if (token === "--bridge-openclaw-version") {
      parsed.bridgeOpenclawVersion = readValue(argv, i, "--bridge-openclaw-version");
      i += 1;
      continue;
    }
    if (token === "--bridge-wsl-distro") {
      parsed.bridgeWslDistro = readValue(argv, i, "--bridge-wsl-distro");
      i += 1;
      continue;
    }
    if (token === "--agent-path" || token === "--openclaw-home" || token === "--agent-id" || token === "--provider" || token === "--model" || token === "--agent-profile") {
      readValue(argv, i, token);
      i += 1;
      continue;
    }
    if (token === "--timeout-ms") {
      const raw = readValue(argv, i, "--timeout-ms");
      i += 1;
      const parsedTimeout = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
        throw new Error("--timeout-ms must be a positive integer");
      }
      parsed.timeoutMs = parsedTimeout;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return parsed;
}

function usage() {
  return [
    "Usage: node ./scripts/openclaw-gamer-bridge.mjs [options]",
    "",
    "Reads decision context JSON from stdin and prints selection JSON to stdout.",
    "",
    "Options:",
    "  --bridge-workdir <path>            (default: /home/superl3/S3OpenClaw)",
    "  --bridge-agent-id <id>             (default: drifter)",
    "  --bridge-session-id <id>           (default: gamer-bridge)",
    "  --bridge-openclaw-version <ver>    (default: 2026.3.24)",
    "  --bridge-wsl-distro <name>         (default: Ubuntu-24.04, win32 only)",
    "  --timeout-ms <ms>",
    "  -h, --help",
  ].join("\n");
}

async function readStdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function redactSecrets(text) {
  return String(text ?? "")
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_\-]{10,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(?:api[-_ ]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED_CREDENTIAL]");
}

function bashSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function normalizeText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeBridgePath(inputPath) {
  const raw = String(inputPath ?? "").trim();
  if (!raw) {
    return raw;
  }
  const slash = raw.replace(/\\/g, "/");
  const marker = "/home/";
  const markerIndex = slash.toLowerCase().indexOf(marker);
  if (markerIndex > 0 && slash.toLowerCase().startsWith("c:/program files/git/")) {
    return slash.slice(markerIndex);
  }
  return slash;
}

function sanitizeContext(context) {
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
      actionId: typeof visible.modal.actionId === "string" ? visible.modal.actionId : null,
    }
    : null;
  const recommendation = visible?.recommendation && typeof visible.recommendation.actionId === "string"
    ? { actionId: visible.recommendation.actionId }
    : null;
  const textSummary = typeof visible?.textSummary === "string" ? visible.textSummary.slice(0, 3000) : "";
  return { visible: { textSummary, buttons, modal, recommendation } };
}

function buildPrompt(context) {
  const visible = context.visible;
  const buttonLines = visible.buttons.length > 0
    ? visible.buttons
        .map((button, index) => `${index + 1}. label="${button.label ?? ""}" customId="${button.customId}" actionId="${button.actionId ?? ""}"`)
        .join("\n")
    : "(none)";
  const modalLine = visible.modal
    ? `customId="${visible.modal.customId}" label="${visible.modal.label ?? ""}" actionId="${visible.modal.actionId ?? ""}"`
    : "(none)";
  const recommendationLine = visible.recommendation?.actionId
    ? visible.recommendation.actionId
    : "(none)";
  return [
    "You are a strict TRPG bridge selector.",
    "Choose one visible interaction only.",
    "Do not invent customId values.",
    "If submitting modal, include brief free_input.",
    "",
    "Visible summary:",
    visible.textSummary || "(empty)",
    "",
    "Visible buttons:",
    buttonLines,
    "",
    "Visible modal:",
    modalLine,
    "",
    `Recommendation actionId: ${recommendationLine}`,
    "",
    "Output format requirement (choose exactly one format):",
    "1) JSON object: {\"type\":\"button\"|\"modal\",\"customId\":\"...\",\"freeInput\":\"...\"?}",
    "2) Exactly 5 key-value lines (snake_case keys):",
    "choice_type: button|modal",
    "choice_label: <visible label or blank>",
    "choice_value: <visible customId or blank>",
    "reason: <short reason>",
    "free_input: <text or blank>",
    "",
    "Return only one of the above, no markdown fences.",
  ].join("\n");
}

function parseKvChoice(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const map = new Map();
  for (const line of lines) {
    const matched = line.match(/^([a-zA-Z_]+)\s*[:=]\s*(.*)$/);
    if (!matched) {
      continue;
    }
    map.set(matched[1].trim().toLowerCase(), matched[2].trim());
  }
  if (!OUTPUT_KEYS.every((key) => map.has(key))) {
    return null;
  }
  return {
    type: map.get("choice_type") ?? "",
    choiceLabel: map.get("choice_label") ?? "",
    choiceValue: map.get("choice_value") ?? "",
    reason: map.get("reason") ?? "",
    freeInput: map.get("free_input") ?? "",
  };
}

function extractReasonSnippet(rawText) {
  const lines = String(rawText ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return "";
  }
  const first = lines[0].slice(0, 200).trim();
  if (!first) {
    return "";
  }
  if (/^[\[{(]+\s*[\]})]+$/.test(first)) {
    return "";
  }
  return first;
}

function extractJsonObject(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        // continue
      }
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function extractTextCandidates(raw) {
  const candidates = [];
  if (typeof raw === "string") {
    candidates.push(raw);
    return candidates;
  }
  if (!raw || typeof raw !== "object") {
    return candidates;
  }
  const queue = [raw];
  const seen = new Set();
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || typeof next !== "object" || seen.has(next)) {
      continue;
    }
    seen.add(next);
    for (const [key, value] of Object.entries(next)) {
      if (typeof value === "string") {
        if (/choice_type|customId|\"type\"\s*:/i.test(value) || ["message", "content", "text", "response", "result", "output", "stdout"].includes(key)) {
          candidates.push(value);
        }
      } else if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }
  return candidates;
}

function pickCustomIdByLabel(label, entries) {
  const target = normalizeText(label);
  if (!target) {
    return null;
  }
  const matched = entries.filter((entry) => normalizeText(entry.label) === target);
  return matched.length === 1 ? matched[0].customId : null;
}

function normalizeSelection(rawSelection, context) {
  const visible = context.visible;
  const buttons = visible.buttons;
  const modal = visible.modal;
  const validButtonIds = new Set(buttons.map((button) => button.customId));
  const modalId = modal?.customId ?? null;

  const rawType = normalizeText(rawSelection?.type);
  const type = rawType === "modal" ? "modal" : "button";
  const explicitCustomId = typeof rawSelection?.customId === "string" ? rawSelection.customId.trim() : "";
  const fallbackLabel = typeof rawSelection?.choiceLabel === "string" ? rawSelection.choiceLabel.trim() : "";
  const reason = typeof rawSelection?.reason === "string" ? rawSelection.reason.trim() : "";
  let customId = explicitCustomId;

  if (!customId) {
    if (type === "button") {
      customId = pickCustomIdByLabel(fallbackLabel, buttons) ?? "";
    } else {
      customId = modalId ?? pickCustomIdByLabel(fallbackLabel, modal ? [modal] : []) ?? "";
    }
  }

  if (!customId) {
    throw new Error("Selection missing customId/choice_value and no unique label match available");
  }

  if (type === "button") {
    if (!validButtonIds.has(customId)) {
      throw new Error(`Selected button customId is not visible: ${customId}`);
    }
    return {
      type: "button",
      customId,
      ...(reason ? { reason } : {}),
    };
  }

  if (customId !== modalId) {
    throw new Error(`Selected modal customId is not visible: ${customId}`);
  }
  const freeInput = typeof rawSelection?.freeInput === "string"
    ? rawSelection.freeInput
    : typeof rawSelection?.free_input === "string"
    ? rawSelection.free_input
    : "";
  return {
    type: "modal",
    customId,
    ...(reason ? { reason } : {}),
    ...(freeInput.trim() ? { freeInput: freeInput.trim() } : {}),
  };
}

function fallbackSelectionFromContext(context) {
  const visible = context?.visible && typeof context.visible === "object" ? context.visible : {};
  const buttons = Array.isArray(visible.buttons) ? visible.buttons : [];
  const recommendationActionId = typeof visible?.recommendation?.actionId === "string"
    ? visible.recommendation.actionId
    : null;
  if (recommendationActionId) {
    const matched = buttons.filter((button) => button?.actionId === recommendationActionId && typeof button?.customId === "string");
    if (matched.length === 1) {
      return { type: "button", customId: matched[0].customId };
    }
  }
  if (buttons.length === 1 && typeof buttons[0]?.customId === "string") {
    return { type: "button", customId: buttons[0].customId };
  }
  const modalCustomId = typeof visible?.modal?.customId === "string" ? visible.modal.customId : null;
  if (modalCustomId) {
    return { type: "modal", customId: modalCustomId, freeInput: "진행" };
  }
  return null;
}

function parseBridgeSelection(rawStdout, context) {
  const normalizeWithOptionalReason = (rawSelection, snippetSource) => {
    const normalized = normalizeSelection(rawSelection, context);
    if (typeof normalized.reason === "string" && normalized.reason.trim()) {
      return normalized;
    }
    const snippet = extractReasonSnippet(snippetSource);
    return snippet ? { ...normalized, reason: snippet } : normalized;
  };

  const parsedJson = extractJsonObject(rawStdout);
  if (parsedJson && typeof parsedJson === "object") {
    if (typeof parsedJson.type === "string" || typeof parsedJson.customId === "string") {
      return normalizeWithOptionalReason(parsedJson, rawStdout);
    }
    const candidates = extractTextCandidates(parsedJson);
    for (const candidate of candidates) {
      const nestedJson = extractJsonObject(candidate);
      if (nestedJson && typeof nestedJson === "object" && typeof nestedJson.type === "string") {
        return normalizeWithOptionalReason(nestedJson, candidate);
      }
      const kv = parseKvChoice(candidate);
      if (kv) {
        return normalizeWithOptionalReason(
              {
                type: kv.type,
                customId: kv.choiceValue,
                choiceLabel: kv.choiceLabel,
                reason: kv.reason,
                free_input: kv.freeInput,
              },
              candidate,
        );
      }
    }
  }

  const kv = parseKvChoice(rawStdout);
  if (kv) {
    return normalizeWithOptionalReason(
      {
        type: kv.type,
        customId: kv.choiceValue,
        choiceLabel: kv.choiceLabel,
        reason: kv.reason,
        free_input: kv.freeInput,
      },
      rawStdout,
    );
  }

  throw new Error("Unable to parse OpenClaw bridge selection format");
}

async function runOpenClawRuntime({
  prompt,
  workdir,
  agentId,
  sessionId,
  openclawVersion,
  timeoutMs,
  wslDistro,
}) {
  const env = {
    ...process.env,
  };
  const packageRef = `openclaw@${openclawVersion}`;
  const directArgs = ["--yes", packageRef, "agent", "--agent", agentId, "--local", "--session-id", sessionId, "--message", prompt, "--json"];

  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = process.platform === "win32"
      ? spawn(
        "wsl.exe",
        [
          "-d",
          wslDistro,
          "bash",
          "-lc",
          `cd ${bashSingleQuote(workdir)} && npx ${directArgs.map((part) => bashSingleQuote(part)).join(" ")}`,
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      )
      : spawn(
        "npx",
        directArgs,
        { cwd: workdir, env, stdio: ["ignore", "pipe", "pipe"] },
      );

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`OpenClaw runtime timed out after ${timeoutMs}ms`));
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
      reject(new Error(`OpenClaw runtime failed to start: ${redactSecrets(reason)}`));
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const safeErr = redactSecrets(stderr).trim();
        const errSuffix = safeErr ? ` stderr=${safeErr.slice(0, 500)}` : "";
        reject(new Error(`OpenClaw runtime exited with code ${code}${signal ? ` signal=${signal}` : ""}${errSuffix}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const stdinText = await readStdinText();
  const context = sanitizeContext(JSON.parse(stdinText));
  const prompt = buildPrompt(context);
  const runtimeResult = await runOpenClawRuntime({
    prompt,
    workdir: normalizeBridgePath(args.bridgeWorkdir),
    agentId: args.bridgeAgentId,
    sessionId: args.bridgeSessionId,
    openclawVersion: args.bridgeOpenclawVersion,
    timeoutMs: args.timeoutMs,
    wslDistro: args.bridgeWslDistro,
  });
  const combinedOutput = `${runtimeResult.stdout ?? ""}\n${runtimeResult.stderr ?? ""}`;
  let selection;
  try {
    selection = parseBridgeSelection(combinedOutput, context);
  } catch (error) {
    const fallback = fallbackSelectionFromContext(context);
    if (!fallback) {
      const reason = error instanceof Error ? error.message : String(error);
      const sample = redactSecrets(String(combinedOutput ?? "").trim()).slice(0, 5000);
      throw new Error(`${reason}${sample ? ` stdout=${sample}` : ""}`);
    }
    selection = {
      ...fallback,
      reason: "모델 응답이 구조화 형식을 벗어나 안전 fallback 적용",
    };
  }
  process.stdout.write(`${JSON.stringify(selection)}\n`);
}

main().catch((error) => {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`openclaw-gamer-bridge failed: ${reason}\n`);
  process.exitCode = 1;
});
