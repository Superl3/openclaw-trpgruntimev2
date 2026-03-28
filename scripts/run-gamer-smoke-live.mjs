#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { BlackboxGamerAgent, isStaleInteractionError } from "../tests/helpers/blackbox-gamer-agent.mjs";
import { GamerLiveImprover, applyTuningToProfile } from "../tests/helpers/gamer-live-improver.mjs";
import { buildDrifterFeedbackAudit } from "../tests/helpers/drifter-feedback-audit.mjs";
import { createOpenAiChatDecisionLane } from "../tests/helpers/llm-gamer-decision-lane.mjs";
import {
  createOpenClawConfigDecisionLane,
  resolveOpenClawDecisionLaneConfig,
} from "../tests/helpers/openclaw-config-decision-lane.mjs";
import { createProcessBridgeDecisionLane } from "../tests/helpers/process-bridge-decision-lane.mjs";

const ROOT_DIR = process.cwd();
const OUT_DIR = path.resolve(ROOT_DIR, ".tmp-test-dist-gamer-agent-live");
const VALID_LANES = new Set(["deterministic", "openai", "openclaw", "bridge"]);
const VALID_SCENARIOS = new Set(["happy", "modal", "stale"]);
const VALID_IMPROVE_MODES = new Set(["off", "shadow", "auto"]);
const VALID_BRIDGE_SESSION_SCOPES = new Set(["global", "run", "cycle", "scenario"]);
const MAX_TURNS = 100;
const DEFAULT_IMPROVE_WINDOW = 3;
const DEFAULT_WATCH_INTERVAL_MS = 1000;
const DEFAULT_IMPROVE_REPORT_DIR = "./runtime/reports";
const DEFAULT_IMPROVE_REPORT_PREFIX = "gamer-improve";
const DEFAULT_DISCORD_WORKDIR = "/home/superl3/S3OpenClaw";
const DEFAULT_DISCORD_MIRROR_TEMPLATE_PATH = "./scripts/templates/discord-smoke-mirror.template.txt";
const DEFAULT_OPENCLAW_CONFIG_PATH = "/home/superl3/.openclaw/openclaw.json";
const DEFAULT_DIRECT_INPUT_FALLBACK_TEXT = "이름은 레온. 변방 사냥꾼이며 실종된 동생을 찾고 있어.";
const DISCORD_MIRROR_MAX_CHARS = 1800;
const ACTION_KO_LABELS = new Map([
  ["investigate", "조사"],
  ["move", "이동"],
  ["wait", "대기"],
  ["force", "강행"],
]);
const BUILTIN_DISCORD_MIRROR_TEMPLATE = [
  "[TRPG Mirror] run={{runId}} scenario={{scenario}} turn={{turn}}",
  "",
  "보이는 정보",
  "- 장면: {{visible.scene}}",
  "- Beat: {{visible.beat}}",
  "- 압력: {{visible.pressure}}",
  "- 가능 버튼: {{visible.choices}}",
  "- 추천 버튼: {{visible.recommendation}}",
  "- 모달: {{visible.modal}}",
  "- 제약: {{visible.constraints}}",
  "",
  "Drifter 행동",
  "- 선택 행동: {{drifter.actionName}} ({{drifter.actionCode}})",
  "- 결정 출처: {{drifter.decisionSource}}",
  "- 입력 내용: {{drifter.inputText}}",
  "- 선택 이유: {{drifter.humanReason}}",
].join("\n");

function readValue(argv, index, flag) {
  const value = String(argv[index + 1] ?? "").trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function sanitizeForCli(input) {
  const text = typeof input === "string" ? input : String(input ?? "");
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_\-]{10,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(?:api[-_ ]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED_CREDENTIAL]");
}

function usage() {
  return [
    "Usage: node ./scripts/run-gamer-smoke-live.mjs [options]",
    "",
    "Options:",
    "  --lane <deterministic|openai|openclaw|bridge>",
    "  --scenario <happy,modal,stale>",
    "  --turns <1-100>",
    "  --provider <provider-id>       (openclaw lane)",
    "  --agent-path <path>            (openclaw lane, external agent directory)",
    "  --openclaw-home <path>         (openclaw lane, alternate ~/.openclaw root)",
    "  --agent-id <id>                (openclaw lane fallback if --agent-path unset)",
    "  --agent-profile <path>         (openclaw/bridge lane profile JSON)",
    "  --bridge-script <path>         (bridge lane script path)",
    "  --bridge-workdir <path>        (bridge lane, default: /home/superl3/S3OpenClaw)",
    "  --bridge-agent-id <id>         (bridge lane, default: drifter)",
    "  --bridge-session-id <id>       (bridge lane, default: gamer-bridge)",
    "  --bridge-session-scope <scope> (bridge lane, global|run|cycle|scenario; default: scenario)",
    "  --bridge-openclaw-version <v>  (bridge lane, default: 2026.3.24)",
    "  --bridge-wsl-distro <name>     (bridge lane, default: Ubuntu-24.04)",
    "  --print-lane-config            (openclaw/bridge lane, prints non-secret resolved config)",
    "  --skip-preflight               (openclaw/bridge lane, bypass infra connectivity check)",
    "  --discord-mirror               (mirror each successful turn to Discord)",
    "  --discord-channel-id <id>      (default: resolved from ~/.openclaw/openclaw.json trpg-v2 binding)",
    `  --discord-workdir <path>       (default: ${DEFAULT_DISCORD_WORKDIR})`,
    `  --discord-mirror-template <path> (default: ${DEFAULT_DISCORD_MIRROR_TEMPLATE_PATH})`,
    "  --force-direct-input           (force preferModal flow for all playTurn calls)",
    `  --direct-input-fallback-text <text> (default: ${DEFAULT_DIRECT_INPUT_FALLBACK_TEXT})`,
    "  --improve <off|shadow|auto>    (default: off)",
    "  --improve-window <N>           (default: 3 turns)",
    "  --improve-report-dir <path>    (default: ./runtime/reports)",
    "  --improve-report-prefix <name> (default: gamer-improve)",
    "  --watch                        (repeat cycles until Ctrl+C)",
    "  --watch-interval-ms <N>        (default: 1000)",
    "  --max-cycles <N>               (default: 1 unless --watch)",
    "  --model <model-id>",
    "  --verbose",
    "  --no-color",
    "  -h, --help",
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = {
    lane: "deterministic",
    scenarios: ["happy", "modal", "stale"],
    turns: 4,
    verbose: false,
    color: true,
    provider: null,
    agentPath: null,
    openclawHome: null,
    agentId: null,
    agentProfile: null,
    bridgeScript: "./scripts/openclaw-gamer-bridge.mjs",
    bridgeWorkdir: "/home/superl3/S3OpenClaw",
    bridgeAgentId: "drifter",
    bridgeSessionId: "gamer-bridge",
    bridgeSessionScope: "scenario",
    bridgeOpenclawVersion: "2026.3.24",
    bridgeWslDistro: "Ubuntu-24.04",
    model: null,
    printLaneConfig: false,
    skipPreflight: false,
    improve: "off",
    improveWindow: DEFAULT_IMPROVE_WINDOW,
    improveReportDir: DEFAULT_IMPROVE_REPORT_DIR,
    improveReportPrefix: DEFAULT_IMPROVE_REPORT_PREFIX,
    watch: false,
    watchIntervalMs: DEFAULT_WATCH_INTERVAL_MS,
    maxCycles: null,
    discordMirror: false,
    discordChannelId: null,
    discordWorkdir: DEFAULT_DISCORD_WORKDIR,
    discordMirrorTemplate: DEFAULT_DISCORD_MIRROR_TEMPLATE_PATH,
    discordMirrorTemplateFallbackNotified: false,
    discordMirrorTemplateCache: null,
    forceDirectInput: false,
    directInputFallbackText: DEFAULT_DIRECT_INPUT_FALLBACK_TEXT,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "-h" || token === "--help") {
      parsed.help = true;
      continue;
    }
    if (token === "--verbose") {
      parsed.verbose = true;
      continue;
    }
    if (token === "--no-color") {
      parsed.color = false;
      continue;
    }
    if (token === "--lane") {
      parsed.lane = readValue(argv, i, "--lane");
      i += 1;
      continue;
    }
    if (token === "--scenario") {
      const raw = readValue(argv, i, "--scenario");
      i += 1;
      if (raw.length > 0) {
        parsed.scenarios = Array.from(new Set(raw.split(",").map((entry) => entry.trim()).filter(Boolean)));
      }
      continue;
    }
    if (token === "--turns") {
      const value = Number.parseInt(readValue(argv, i, "--turns"), 10);
      i += 1;
      if (Number.isFinite(value) && value > 0 && value <= MAX_TURNS) {
        parsed.turns = value;
      } else {
        throw new Error(`Invalid --turns '${value}'. Expected integer in range 1-${MAX_TURNS}`);
      }
      continue;
    }
    if (token === "--provider") {
      parsed.provider = readValue(argv, i, "--provider");
      i += 1;
      continue;
    }
    if (token === "--agent-path") {
      parsed.agentPath = readValue(argv, i, "--agent-path");
      i += 1;
      continue;
    }
    if (token === "--openclaw-home") {
      parsed.openclawHome = readValue(argv, i, "--openclaw-home");
      i += 1;
      continue;
    }
    if (token === "--agent-id") {
      parsed.agentId = readValue(argv, i, "--agent-id");
      i += 1;
      continue;
    }
    if (token === "--agent-profile") {
      parsed.agentProfile = readValue(argv, i, "--agent-profile");
      i += 1;
      continue;
    }
    if (token === "--bridge-script") {
      parsed.bridgeScript = readValue(argv, i, "--bridge-script");
      i += 1;
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
    if (token === "--bridge-session-scope") {
      parsed.bridgeSessionScope = readValue(argv, i, "--bridge-session-scope");
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
    if (token === "--print-lane-config") {
      parsed.printLaneConfig = true;
      continue;
    }
    if (token === "--skip-preflight") {
      parsed.skipPreflight = true;
      continue;
    }
    if (token === "--discord-mirror") {
      parsed.discordMirror = true;
      continue;
    }
    if (token === "--discord-channel-id") {
      parsed.discordChannelId = readValue(argv, i, "--discord-channel-id");
      i += 1;
      continue;
    }
    if (token === "--discord-workdir") {
      parsed.discordWorkdir = readValue(argv, i, "--discord-workdir");
      i += 1;
      continue;
    }
    if (token === "--discord-mirror-template") {
      parsed.discordMirrorTemplate = readValue(argv, i, "--discord-mirror-template");
      i += 1;
      continue;
    }
    if (token === "--force-direct-input") {
      parsed.forceDirectInput = true;
      continue;
    }
    if (token === "--direct-input-fallback-text") {
      parsed.directInputFallbackText = readValue(argv, i, "--direct-input-fallback-text");
      i += 1;
      continue;
    }
    if (token === "--improve") {
      parsed.improve = readValue(argv, i, "--improve");
      i += 1;
      continue;
    }
    if (token === "--improve-window") {
      const value = Number.parseInt(readValue(argv, i, "--improve-window"), 10);
      i += 1;
      if (Number.isFinite(value) && value > 0) {
        parsed.improveWindow = value;
      } else {
        throw new Error("Invalid --improve-window. Expected positive integer");
      }
      continue;
    }
    if (token === "--watch") {
      parsed.watch = true;
      continue;
    }
    if (token === "--improve-report-dir") {
      parsed.improveReportDir = readValue(argv, i, "--improve-report-dir");
      i += 1;
      continue;
    }
    if (token === "--improve-report-prefix") {
      parsed.improveReportPrefix = readValue(argv, i, "--improve-report-prefix");
      i += 1;
      continue;
    }
    if (token === "--watch-interval-ms") {
      const value = Number.parseInt(readValue(argv, i, "--watch-interval-ms"), 10);
      i += 1;
      if (Number.isFinite(value) && value > 0) {
        parsed.watchIntervalMs = value;
      } else {
        throw new Error("Invalid --watch-interval-ms. Expected positive integer");
      }
      continue;
    }
    if (token === "--max-cycles") {
      const value = Number.parseInt(readValue(argv, i, "--max-cycles"), 10);
      i += 1;
      if (Number.isFinite(value) && value > 0) {
        parsed.maxCycles = value;
      } else {
        throw new Error("Invalid --max-cycles. Expected positive integer");
      }
      continue;
    }
    if (token === "--model") {
      parsed.model = readValue(argv, i, "--model");
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!VALID_LANES.has(parsed.lane)) {
    throw new Error(`Invalid --lane '${parsed.lane}'. Expected one of: ${Array.from(VALID_LANES).join(", ")}`);
  }
  if (parsed.scenarios.length === 0) {
    throw new Error("At least one scenario is required for --scenario");
  }
  for (const scenario of parsed.scenarios) {
    if (!VALID_SCENARIOS.has(scenario)) {
      throw new Error(`Invalid scenario '${scenario}'. Expected: ${Array.from(VALID_SCENARIOS).join(", ")}`);
    }
  }
  if (!VALID_IMPROVE_MODES.has(parsed.improve)) {
    throw new Error(`Invalid --improve '${parsed.improve}'. Expected: ${Array.from(VALID_IMPROVE_MODES).join(", ")}`);
  }
  if (!VALID_BRIDGE_SESSION_SCOPES.has(parsed.bridgeSessionScope)) {
    throw new Error(
      `Invalid --bridge-session-scope '${parsed.bridgeSessionScope}'. Expected: ${Array.from(VALID_BRIDGE_SESSION_SCOPES).join(", ")}`,
    );
  }
  if (!parsed.watch && parsed.maxCycles === null) {
    parsed.maxCycles = 1;
  }
  return parsed;
}

function buildBridgeSessionId(args, context = {}) {
  const base = String(args.bridgeSessionId || "gamer-bridge").trim() || "gamer-bridge";
  const scope = args.bridgeSessionScope || "scenario";
  if (scope === "global") {
    return base;
  }

  const runId = typeof context.runId === "string" && context.runId.trim() ? context.runId.trim() : "run-unknown";
  if (scope === "run") {
    return `${base}:${runId}`;
  }

  const cycle = Number.isFinite(context.cycleNumber) ? Math.max(1, Math.trunc(context.cycleNumber)) : 0;
  if (scope === "cycle") {
    return `${base}:${runId}:c${cycle}`;
  }

  const scenario = typeof context.scenarioName === "string" && context.scenarioName.trim()
    ? context.scenarioName.trim()
    : "scenario";
  return `${base}:${runId}:c${cycle}:${scenario}`;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return null;
}

function pickDiscordChannelIdFromBinding(binding) {
  if (!binding || typeof binding !== "object") {
    return null;
  }
  return firstNonEmptyString(
    binding?.match?.peer?.id,
    binding?.match?.target?.id,
    binding?.discord?.channelId,
    binding?.discord?.channel_id,
    binding?.discordChannelId,
    binding?.discord_channel_id,
    binding?.channelId,
    binding?.channel_id,
    binding?.target,
  );
}

function resolveDiscordChannelIdFromConfigObject(configRoot) {
  if (!configRoot || typeof configRoot !== "object") {
    return null;
  }

  const directCandidates = [
    configRoot?.bindings?.["trpg-v2"],
    configRoot?.binding?.["trpg-v2"],
    configRoot?.agents?.["trpg-v2"],
    configRoot?.trpg?.["v2"],
    configRoot?.trpgV2,
  ];
  for (const candidate of directCandidates) {
    const channelId = pickDiscordChannelIdFromBinding(candidate);
    if (channelId) {
      return channelId;
    }
  }

  const bindings = Array.isArray(configRoot?.bindings) ? configRoot.bindings : [];
  for (const binding of bindings) {
    const agentId = typeof binding?.agentId === "string" ? binding.agentId.trim() : "";
    const channel = typeof binding?.match?.channel === "string" ? binding.match.channel.trim() : "";
    if (agentId !== "trpg-v2" || channel !== "discord") {
      continue;
    }
    const channelId = pickDiscordChannelIdFromBinding(binding);
    if (channelId) {
      return channelId;
    }
  }

  const visited = new Set();
  const queue = [configRoot];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (
      (typeof current?.id === "string" && current.id.trim() === "trpg-v2") ||
      (typeof current?.name === "string" && current.name.trim() === "trpg-v2") ||
      (typeof current?.key === "string" && current.key.trim() === "trpg-v2")
    ) {
      const channelId = pickDiscordChannelIdFromBinding(current);
      if (channelId) {
        return channelId;
      }
    }

    if (Object.prototype.hasOwnProperty.call(current, "trpg-v2")) {
      const channelId = pickDiscordChannelIdFromBinding(current["trpg-v2"]);
      if (channelId) {
        return channelId;
      }
    }

    for (const value of Object.values(current)) {
      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }

  return null;
}

async function resolveDefaultDiscordChannelIdFromOpenClawConfig(configPath = DEFAULT_OPENCLAW_CONFIG_PATH) {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return resolveDiscordChannelIdFromConfigObject(parsed);
  } catch {
    return null;
  }
}

function extractPanelRawTextFromTurn(turnData, turnTranscript = null) {
  const receivedOriginalText = firstNonEmptyString(
    turnData?.received?.originalText,
    turnData?.result?.received?.originalText,
    turnTranscript?.received?.originalText,
  );
  const receivedTextSummary = firstNonEmptyString(
    turnData?.received?.textSummary,
    turnData?.result?.received?.textSummary,
    turnTranscript?.received?.textSummary,
  );
  const panelRawFallback = firstNonEmptyString(
    turnData?.result?.originalText,
    turnData?.result?.panel?.originalText,
    turnData?.originalText,
    turnTranscript?.originalText,
  );
  return firstNonEmptyString(
    receivedOriginalText,
    receivedTextSummary,
    panelRawFallback,
  );
}

function parseInlineList(value) {
  if (typeof value !== "string") {
    return [];
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }
  return trimmed
    .split(/[|,\/]/g)
    .map((entry) => entry.trim().replace(/^[\-•·\s]+/, ""))
    .filter(Boolean);
}

function parseVisibleMirrorFields(rawText) {
  const panelText = typeof rawText === "string" ? rawText : "";
  const lines = panelText.split(/\r?\n/);
  const visible = {
    scene: "없음",
    beat: "없음",
    pressure: "없음",
    choices: "없음",
    recommendation: "없음",
    modal: "없음",
    constraints: "없음",
  };

  const normalizeMirrorLine = (rawLine) => {
    let line = typeof rawLine === "string" ? rawLine.trim() : "";
    if (!line) {
      return "";
    }

    line = line.replace(/^[\-*•]\s+/, "").trim();

    const unwrapSimpleMarkdownPrefix = (input) => {
      if (input.startsWith("**")) {
        const endIndex = input.indexOf("**", 2);
        if (endIndex > 1) {
          return `${input.slice(2, endIndex)}${input.slice(endIndex + 2)}`.trim();
        }
      }
      if (input.startsWith("`")) {
        const endIndex = input.indexOf("`", 1);
        if (endIndex > 0) {
          return `${input.slice(1, endIndex)}${input.slice(endIndex + 1)}`.trim();
        }
      }
      return input;
    };

    line = unwrapSimpleMarkdownPrefix(line).replace(/^[\-*•]\s+/, "").trim();
    return line;
  };

  for (const rawLine of lines) {
    const line = normalizeMirrorLine(rawLine);
    if (!line) {
      continue;
    }
    if (line.startsWith("장면:")) {
      visible.scene = firstNonEmptyString(line.slice("장면:".length).trim(), visible.scene) || "없음";
      continue;
    }
    if (/^Beat(?:\s+\d+)?\s*:/i.test(line)) {
      const beatValue = line.replace(/^Beat(?:\s+\d+)?\s*:\s*/i, "").trim();
      visible.beat = firstNonEmptyString(beatValue, visible.beat) || "없음";
      continue;
    }
    if (line.startsWith("압력:")) {
      visible.pressure = firstNonEmptyString(line.slice("압력:".length).trim(), visible.pressure) || "없음";
      continue;
    }
    if (line.startsWith("가능 버튼:")) {
      const choices = parseInlineList(line.slice("가능 버튼:".length));
      visible.choices = choices.length > 0 ? choices.join(", ") : "없음";
      continue;
    }
    if (line.startsWith("추천 버튼:")) {
      visible.recommendation = firstNonEmptyString(line.slice("추천 버튼:".length).trim(), visible.recommendation) || "없음";
      continue;
    }
    if (line.startsWith("모달:")) {
      visible.modal = firstNonEmptyString(line.slice("모달:".length).trim(), visible.modal) || "없음";
      continue;
    }
    if (line.startsWith("제약:")) {
      const constraints = parseInlineList(line.slice("제약:".length));
      visible.constraints = constraints.length > 0 ? constraints.join(", ") : "없음";
    }
  }

  return visible;
}

function getActionCodeKey(actionCode) {
  if (typeof actionCode !== "string") {
    return "";
  }
  const trimmed = actionCode.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("action.") ? trimmed.slice("action.".length) : trimmed;
}

function mapActionCodeToKoreanLabel(actionCode) {
  const key = getActionCodeKey(actionCode);
  return key ? ACTION_KO_LABELS.get(key) ?? null : null;
}

function parseActionCodeFromReference(...values) {
  const known = new Set(Array.from(ACTION_KO_LABELS.keys()));
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const explicit = trimmed.match(/\b(action\.[a-z0-9._-]+)\b/i);
    if (explicit?.[1]) {
      return explicit[1].toLowerCase();
    }
    const segments = trimmed
      .split(/[:/#]/g)
      .map((entry) => entry.trim().toLowerCase().replace(/[^a-z0-9._-]/g, ""))
      .filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const segment = segments[i];
      if (segment.startsWith("action.")) {
        return segment;
      }
      if (known.has(segment)) {
        return `action.${segment}`;
      }
    }
  }
  return null;
}

function canonicalActionIdentity(value) {
  if (typeof value !== "string") {
    return null;
  }
  const parsedCode = parseActionCodeFromReference(value);
  if (parsedCode) {
    return parsedCode;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

function reasonLooksLikeNoise(value) {
  if (typeof value !== "string") {
    return true;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return true;
  }
  if (/(choice_type|choice_label|choice_value|free_input)\s*[:=]/i.test(trimmed)) {
    return true;
  }
  return false;
}

function resolveRecommendationActionId(turnData, turnTranscript) {
  return firstNonEmptyString(
    turnTranscript?.received?.recommendation?.actionId,
    turnData?.received?.recommendation?.actionId,
    turnData?.result?.received?.recommendation?.actionId,
    turnData?.result?.visible?.recommendation?.actionId,
    turnData?.visible?.recommendation?.actionId,
    turnData?.context?.visible?.recommendation?.actionId,
  );
}

function hasFreeInputMarker(...values) {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    if (/(^|[.:/_-])free[_-]?input($|[.:/_-])/i.test(trimmed)) {
      return true;
    }
  }
  return false;
}

function resolveInputTextFromSelection(sent, selection) {
  return firstNonEmptyString(
    sent?.freeInput,
    selection?.freeInput,
    sent?.inputText,
    selection?.inputText,
  );
}

function resolveDrifterActionSummary({ turnData, turnTranscript }) {
  const sent = turnTranscript?.sent;
  const selection = turnData?.selection;
  const actionType = firstNonEmptyString(sent?.type, selection?.type, "unknown") || "unknown";
  const actionNameFromLabel = firstNonEmptyString(sent?.label, selection?.label);
  const actionCode = parseActionCodeFromReference(
    sent?.actionId,
    sent?.customId,
    selection?.actionId,
    selection?.customId,
  );
  const mappedActionName = mapActionCodeToKoreanLabel(actionCode);
  const isModalFreeInput = actionType === "modal" && hasFreeInputMarker(
    actionCode,
    sent?.customId,
    selection?.customId,
    sent?.actionId,
    selection?.actionId,
  );
  const inputTextRaw = resolveInputTextFromSelection(sent, selection);
  return {
    actionName: isModalFreeInput
      ? "직접 입력"
      : (firstNonEmptyString(actionNameFromLabel, mappedActionName, "알 수 없음") || "알 수 없음"),
    actionCode: firstNonEmptyString(actionCode, "unknown") || "unknown",
    selectedActionIdentity: firstNonEmptyString(
      canonicalActionIdentity(sent?.actionId),
      canonicalActionIdentity(selection?.actionId),
      canonicalActionIdentity(sent?.customId),
      canonicalActionIdentity(selection?.customId),
    ),
    rawReason: firstNonEmptyString(sent?.reason, selection?.reason),
    inputTextRaw,
  };
}

function resolveHumanReason({ rawReason, selectedActionIdentity, recommendationActionId, inputTextRaw }) {
  if (!reasonLooksLikeNoise(rawReason)) {
    return rawReason.trim();
  }
  if (selectedActionIdentity && canonicalActionIdentity(recommendationActionId) === selectedActionIdentity) {
    return "추천 버튼 근거를 따라 선택";
  }
  if (typeof inputTextRaw === "string" && inputTextRaw.trim()) {
    return "자유 입력으로 의도를 전달";
  }
  return "보이는 선택지 중 진행 가능한 행동을 선택";
}

function resolveDecisionSource(turnData, turnTranscript) {
  const allowed = new Set(["drifter", "fallback", "unknown"]);
  const explicitSource = firstNonEmptyString(
    turnData?.selection?.decisionSource,
    turnData?.result?.selection?.decisionSource,
    turnTranscript?.sent?.decisionSource,
  );
  const normalizedExplicit = typeof explicitSource === "string" ? explicitSource.trim().toLowerCase() : "";
  if (allowed.has(normalizedExplicit)) {
    return normalizedExplicit;
  }

  const contractStatus = firstNonEmptyString(
    turnTranscript?.sent?.audit?.contractStatus,
    turnData?.selection?.audit?.contractStatus,
    turnData?.result?.selection?.audit?.contractStatus,
  );
  if (contractStatus === "fallback_unambiguous") {
    return "fallback";
  }
  if (contractStatus === "valid_json" || contractStatus === "valid_kv") {
    return "drifter";
  }

  const reasonText = firstNonEmptyString(
    turnTranscript?.sent?.reason,
    turnData?.selection?.reason,
    turnData?.result?.selection?.reason,
  );
  if (typeof reasonText === "string" && /fallback|안전 fallback/i.test(reasonText)) {
    return "fallback";
  }
  return "unknown";
}

function buildDiscordMirrorPayload({ runId, scenarioName, turnNumber, turnData, turnTranscript }) {
  const panelRawText = extractPanelRawTextFromTurn(turnData, turnTranscript);
  const actionSummary = resolveDrifterActionSummary({ turnData, turnTranscript });
  const recommendationActionId = resolveRecommendationActionId(turnData, turnTranscript);
  const humanReason = resolveHumanReason({
    rawReason: actionSummary.rawReason,
    selectedActionIdentity: actionSummary.selectedActionIdentity,
    recommendationActionId,
    inputTextRaw: actionSummary.inputTextRaw,
  });
  return {
    runId: firstNonEmptyString(runId, "run-unknown") || "run-unknown",
    scenario: firstNonEmptyString(scenarioName, "unknown") || "unknown",
    turn: Number.isFinite(turnNumber) ? Math.max(1, Math.trunc(turnNumber)) : 1,
    visible: parseVisibleMirrorFields(panelRawText),
    drifter: {
      actionType: firstNonEmptyString(
        turnTranscript?.sent?.type,
        turnData?.selection?.type,
        "unknown",
      ) || "unknown",
      actionRef: firstNonEmptyString(
        turnTranscript?.sent?.customId,
        turnTranscript?.sent?.actionId,
        turnTranscript?.sent?.label,
        turnData?.selection?.customId,
        turnData?.selection?.actionId,
        turnData?.selection?.label,
        "없음",
      ) || "없음",
      inputText: firstNonEmptyString(
        resolveInputTextFromSelection(turnTranscript?.sent, turnData?.selection),
        "없음",
      ) || "없음",
      reason: firstNonEmptyString(
        turnTranscript?.sent?.reason,
        turnData?.selection?.reason,
        "없음",
      ) || "없음",
      actionName: actionSummary.actionName,
      actionCode: actionSummary.actionCode,
      humanReason,
      decisionSource: resolveDecisionSource(turnData, turnTranscript),
      contractStatus: firstNonEmptyString(
        turnTranscript?.sent?.audit?.contractStatus,
        turnData?.selection?.audit?.contractStatus,
        "unknown",
      ) || "unknown",
    },
  };
}

function resolveTemplateValue(payload, token) {
  const pathParts = token.split(".");
  let current = payload;
  for (const part of pathParts) {
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, part)) {
      return "";
    }
    current = current[part];
  }
  if (Array.isArray(current)) {
    return current.length > 0 ? current.join(", ") : "";
  }
  if (current === null || current === undefined) {
    return "";
  }
  if (typeof current === "object") {
    return JSON.stringify(current);
  }
  return String(current);
}

function renderDiscordMirrorTemplate(templateText, payload) {
  return String(templateText ?? "").replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, token) => {
    const resolved = resolveTemplateValue(payload, token);
    return resolved.trim() ? resolved : "-";
  });
}

async function resolveDiscordMirrorTemplate(args, ui) {
  if (typeof args.discordMirrorTemplateCache === "string" && args.discordMirrorTemplateCache.trim()) {
    return args.discordMirrorTemplateCache;
  }
  const templatePath = typeof args.discordMirrorTemplate === "string" ? args.discordMirrorTemplate.trim() : "";
  if (!templatePath) {
    args.discordMirrorTemplateCache = BUILTIN_DISCORD_MIRROR_TEMPLATE;
    return args.discordMirrorTemplateCache;
  }

  try {
    const loaded = await fs.readFile(templatePath, "utf8");
    const template = typeof loaded === "string" ? loaded : String(loaded ?? "");
    if (!template.trim()) {
      throw new Error("empty-template");
    }
    args.discordMirrorTemplateCache = template;
    return template;
  } catch {
    if (!args.discordMirrorTemplateFallbackNotified) {
      ui.warn(`discord-mirror template fallback path=${templatePath}`);
      args.discordMirrorTemplateFallbackNotified = true;
    }
    args.discordMirrorTemplateCache = BUILTIN_DISCORD_MIRROR_TEMPLATE;
    return args.discordMirrorTemplateCache;
  }
}

function splitMessageChunks(message, maxLength = DISCORD_MIRROR_MAX_CHARS) {
  const safeMessage = typeof message === "string" ? message : String(message ?? "");
  if (!safeMessage) {
    return [""];
  }
  if (safeMessage.length <= maxLength) {
    return [safeMessage];
  }

  const chunks = [];
  let remaining = safeMessage;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt <= 0) {
      splitAt = maxLength;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

function shellQuoteSingle(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function sendDiscordMessageChunk({ message, channelId, workdir, wslDistro }) {
  if (process.platform === "win32") {
    const script = `cd ${shellQuoteSingle(workdir)} && node openclaw.mjs message send --channel discord --target ${shellQuoteSingle(`channel:${channelId}`)} --message ${shellQuoteSingle(message)}`;
    const result = spawnSync("wsl.exe", ["-d", wslDistro, "bash", "-lc", script], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
      stderr: typeof result.stderr === "string" ? result.stderr.trim() : "",
      error: result.error instanceof Error ? result.error.message : null,
    };
  }

  const result = spawnSync("node", [
    "openclaw.mjs",
    "message",
    "send",
    "--channel",
    "discord",
    "--target",
    `channel:${channelId}`,
    "--message",
    message,
  ], {
    cwd: workdir,
    encoding: "utf8",
    stdio: "pipe",
  });

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
    stderr: typeof result.stderr === "string" ? result.stderr.trim() : "",
    error: result.error instanceof Error ? result.error.message : null,
  };
}

async function mirrorTurnToDiscord({ args, ui, runId, scenarioName, turnNumber, turnData, turnTranscript }) {
  if (!args.discordMirror) {
    return;
  }
  const channelId = typeof args.discordChannelId === "string" ? args.discordChannelId.trim() : "";
  if (!channelId) {
    ui.warn(`discord-mirror skip scenario=${scenarioName} turn=${turnNumber} reason=missing-channel-id`);
    return;
  }

  const payload = buildDiscordMirrorPayload({
    runId,
    scenarioName,
    turnNumber,
    turnData,
    turnTranscript,
  });
  const template = await resolveDiscordMirrorTemplate(args, ui);
  const message = renderDiscordMirrorTemplate(template, payload);
  const chunks = splitMessageChunks(message, DISCORD_MIRROR_MAX_CHARS);

  let sentCount = 0;
  for (const chunk of chunks) {
    const result = sendDiscordMessageChunk({
      message: chunk,
      channelId,
      workdir: args.discordWorkdir,
      wslDistro: args.bridgeWslDistro,
    });
    if (!result.ok) {
      const reason = sanitizeForCli(firstNonEmptyString(result.error, result.stderr, result.stdout, `exit:${result.status}`) || "unknown");
      ui.warn(`discord-mirror failed scenario=${scenarioName} turn=${turnNumber} chunk=${sentCount + 1}/${chunks.length} reason=${reason}`);
      return;
    }
    sentCount += 1;
  }

  ui.ok(`discord-mirror sent scenario=${scenarioName} turn=${turnNumber} chunks=${sentCount}`);
}

function ansi(color, enabled) {
  return enabled ? color : "";
}

function createUi(options) {
  const colors = {
    reset: ansi("\u001b[0m", options.color),
    dim: ansi("\u001b[2m", options.color),
    green: ansi("\u001b[32m", options.color),
    yellow: ansi("\u001b[33m", options.color),
    red: ansi("\u001b[31m", options.color),
    cyan: ansi("\u001b[36m", options.color),
  };

  const stamp = () => new Date().toISOString().slice(11, 19);
  const print = (line) => {
    process.stdout.write(`${line}\n`);
  };

  return {
    info: (line) => print(`${colors.cyan}[${stamp()}]${colors.reset} ${line}`),
    ok: (line) => print(`${colors.green}[${stamp()}]${colors.reset} ${line}`),
    warn: (line) => print(`${colors.yellow}[${stamp()}]${colors.reset} ${line}`),
    error: (line) => print(`${colors.red}[${stamp()}]${colors.reset} ${line}`),
    dim: (line) => print(`${colors.dim}${line}${colors.reset}`),
  };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(
      sanitizeForCli(`Command failed: ${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`),
    );
  }
}

async function loadPlugin() {
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  run(process.execPath, ["./node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--noEmit", "false", "--outDir", OUT_DIR]);
  const moduleUrl = pathToFileURL(path.resolve(OUT_DIR, "index.js")).href;
  const pluginModule = await import(moduleUrl);
  return pluginModule.default;
}

function createToolMap(plugin, worldRoot) {
  const tools = new Map();
  const api = {
    pluginConfig: {
      allowedAgentIds: ["trpg"],
      panelDispatchTtlSec: 120,
      debugRuntimeSignals: false,
    },
    resolvePath: (input) => (input === "world" ? worldRoot : path.resolve(input)),
    logger: { info: () => {}, warn: () => {} },
    on: () => {},
    registerTool: (factory, config) => {
      tools.set(config.name, factory({ agentId: "trpg", sessionId: "discord-channel", userId: "owner-1" }));
    },
  };
  plugin.register(api);
  return tools;
}

async function createIsolatedWorldRoot(prefix) {
  const worldRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  await fs.mkdir(path.resolve(worldRoot, "state/runtime-core"), { recursive: true });
  return worldRoot;
}

function createScenarioLogger(ui, options, scenarioName) {
  const formatEventDetail = (payload) => {
    const event = payload?.event;
    if (event === "llm_choice_invalid") {
      if (typeof payload?.error === "string" && payload.error.trim()) {
        return ` error=${sanitizeForCli(payload.error.trim())}`;
      }
      if (payload?.laneSelection !== undefined) {
        return ` laneSelection=${sanitizeForCli(JSON.stringify(payload.laneSelection))}`;
      }
      return "";
    }
    if (event === "llm_lane_error") {
      const errorText = typeof payload?.error === "string" ? payload.error : "unknown";
      const category = typeof payload?.category === "string" ? payload.category : "unknown";
      return ` category=${category} error=${sanitizeForCli(errorText)}`;
    }
    if (event === "llm_lane_disabled" || event === "llm_lane_skipped") {
      const reason = typeof payload?.reason === "string" ? payload.reason : "n/a";
      const category = typeof payload?.category === "string" ? payload.category : null;
      return `${category ? ` category=${category}` : ""} reason=${sanitizeForCli(reason)}`;
    }
    if (event === "interact_request") {
      const reason = typeof payload?.reason === "string" ? payload.reason.trim() : "";
      return reason ? ` reason=${sanitizeForCli(reason)}` : "";
    }
    return "";
  };

  const show = (level, payload) => {
    const event = payload?.event || "event";
    const turn = Number.isFinite(payload?.turn) ? ` turn=${payload.turn}` : "";
    const ok = Object.prototype.hasOwnProperty.call(payload || {}, "ok") ? ` ok=${payload.ok}` : "";
    const selection = payload?.selectionType ? ` selection=${payload.selectionType}` : "";
    const decisionSource = payload?.decisionSource ? ` decisionSource=${payload.decisionSource}` : "";
    const extra = options.verbose ? formatEventDetail(payload) : "";
    const detail = `${scenarioName} ${event}${turn}${ok}${selection}${decisionSource}${extra}`;

    if (!options.verbose) {
      const important = new Set([
        "session_ready",
        "turn_begin",
        "turn_end",
        "stale_recover_attempt",
        "stale_recover_result",
        "llm_choice_invalid",
        "llm_lane_error",
        "llm_lane_disabled",
        "llm_lane_skipped",
        "llm_choice_fallback",
      ]);
      if (!important.has(event)) {
        return;
      }
    }

    if (level === "warn") {
      ui.warn(detail);
      return;
    }
    ui.info(detail);
  };

  return {
    info: (payload) => {
      if (typeof options.onEvent === "function") {
        options.onEvent(payload);
      }
      show("info", payload);
    },
    warn: (payload) => {
      if (typeof options.onEvent === "function") {
        options.onEvent(payload);
      }
      show("warn", payload);
    },
    debug: (payload) => {
      if (typeof options.onEvent === "function") {
        options.onEvent(payload);
      }
      show("debug", payload);
    },
  };
}

function toFiniteNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeProfileOverrides(profile) {
  const llm = profile?.llm && typeof profile.llm === "object" ? profile.llm : {};
  const overrides = {};
  if (typeof llm.systemPrompt === "string" && llm.systemPrompt.trim()) {
    overrides.systemPrompt = llm.systemPrompt;
  }
  const temperature = toFiniteNumber(llm.temperature);
  if (temperature !== null) {
    overrides.temperature = temperature;
  }
  const topP = toFiniteNumber(llm.topP);
  if (topP !== null) {
    overrides.topP = topP;
  }
  const maxTokens = toFiniteNumber(llm.maxTokens);
  if (maxTokens !== null && maxTokens > 0) {
    overrides.maxTokens = Math.trunc(maxTokens);
  }
  const timeoutMs = toFiniteNumber(llm.timeoutMs);
  if (timeoutMs !== null && timeoutMs > 0) {
    overrides.timeoutMs = Math.trunc(timeoutMs);
  }
  return overrides;
}

function resolveOpenClawLaneConfig(args) {
  return resolveOpenClawDecisionLaneConfig({
    ...(args.provider ? { provider: args.provider } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.agentPath ? { agentPath: args.agentPath } : {}),
    ...(args.openclawHome ? { openclawHome: args.openclawHome } : {}),
    ...(args.agentId ? { agentId: args.agentId } : {}),
    ...(args.agentProfile ? { profilePath: args.agentProfile } : {}),
  });
}

function printResolvedLaneConfig(args, resolved) {
  const printPayload = {
    lane: args.lane,
    agentRoot: resolved.agentRoot,
    openclawHome: resolved.openclawHome,
    agentId: resolved.agentId,
    providerId: resolved.providerId,
    modelId: resolved.modelId,
    baseUrl: resolved.baseUrl,
    credentialSource: resolved.apiKeySource,
    authType: resolved.authType,
    allowNoAuth: resolved.allowNoAuth === true,
  };
  process.stdout.write(`${JSON.stringify(printPayload)}\n`);
}

function buildLanePreflightContext() {
  return {
    visible: {
      textSummary: "Preflight connectivity check. Select the only visible route.",
      buttons: [
        {
          customId: "preflight:ok",
          label: "Continue",
          actionId: "preflight.ok",
        },
      ],
      recommendation: {
        actionId: "preflight.ok",
      },
    },
  };
}

async function runLanePreflight(args, runtimeState, ui) {
  if (args.skipPreflight) {
    ui.warn("lane preflight skipped by --skip-preflight");
    return;
  }
  if (!(args.lane === "openclaw" || args.lane === "bridge")) {
    return;
  }
  const lane = await createDecisionLane(args, runtimeState);
  const selection = await lane(buildLanePreflightContext());
  if (!selection || selection.type !== "button" || selection.customId !== "preflight:ok") {
    throw new Error(`unexpected preflight selection: ${sanitizeForCli(JSON.stringify(selection ?? null))}`);
  }
  ui.ok(`lane preflight passed lane=${args.lane}`);
}

async function createDecisionLane(args, runtimeState = {}, context = {}) {
  const profileOverrides = safeProfileOverrides(runtimeState.profile);
  if (args.lane === "deterministic") {
    return null;
  }
  if (args.lane === "openai") {
    return createOpenAiChatDecisionLane({
      ...(args.model ? { model: args.model } : {}),
      ...profileOverrides,
    });
  }
  if (args.lane === "bridge") {
    const bridgeArgs = [path.resolve(args.bridgeScript)];
    if (args.agentPath) {
      bridgeArgs.push("--agent-path", args.agentPath);
    }
    if (args.openclawHome) {
      bridgeArgs.push("--openclaw-home", args.openclawHome);
    }
    if (args.agentId) {
      bridgeArgs.push("--agent-id", args.agentId);
    }
    if (args.provider) {
      bridgeArgs.push("--provider", args.provider);
    }
    if (args.model) {
      bridgeArgs.push("--model", args.model);
    }
    if (args.agentProfile) {
      bridgeArgs.push("--agent-profile", args.agentProfile);
    }
    if (args.bridgeWorkdir) {
      bridgeArgs.push("--bridge-workdir", args.bridgeWorkdir);
    }
    if (args.bridgeAgentId) {
      bridgeArgs.push("--bridge-agent-id", args.bridgeAgentId);
    }
    const effectiveBridgeSessionId = buildBridgeSessionId(args, context);
    if (effectiveBridgeSessionId) {
      bridgeArgs.push("--bridge-session-id", effectiveBridgeSessionId);
    }
    if (args.bridgeOpenclawVersion) {
      bridgeArgs.push("--bridge-openclaw-version", args.bridgeOpenclawVersion);
    }
    if (args.bridgeWslDistro) {
      bridgeArgs.push("--bridge-wsl-distro", args.bridgeWslDistro);
    }

    const bridgeEnv = {
      ...(typeof profileOverrides.systemPrompt === "string" ? { GAMER_LLM_SYSTEM_PROMPT: profileOverrides.systemPrompt } : {}),
      ...(Number.isFinite(profileOverrides.temperature) ? { GAMER_LLM_TEMPERATURE: String(profileOverrides.temperature) } : {}),
      ...(Number.isFinite(profileOverrides.topP) ? { GAMER_LLM_TOP_P: String(profileOverrides.topP) } : {}),
      ...(Number.isFinite(profileOverrides.maxTokens) ? { GAMER_LLM_MAX_TOKENS: String(profileOverrides.maxTokens) } : {}),
      ...(Number.isFinite(profileOverrides.timeoutMs) ? { GAMER_LLM_TIMEOUT_MS: String(profileOverrides.timeoutMs) } : {}),
    };

    return createProcessBridgeDecisionLane({
      command: process.execPath,
      args: bridgeArgs,
      cwd: ROOT_DIR,
      timeoutMs: Number.isFinite(profileOverrides.timeoutMs) ? Math.max(30_000, profileOverrides.timeoutMs) : 120_000,
      ...(Object.keys(bridgeEnv).length > 0 ? { env: bridgeEnv } : {}),
    });
  }
  return createOpenClawConfigDecisionLane({
    ...(args.provider ? { provider: args.provider } : {}),
    ...(args.agentPath ? { agentPath: args.agentPath } : {}),
    ...(args.openclawHome ? { openclawHome: args.openclawHome } : {}),
    ...(args.agentId ? { agentId: args.agentId } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.agentProfile ? { profilePath: args.agentProfile } : {}),
    ...profileOverrides,
  });
}

async function readProfileOrDefault(profilePath) {
  if (!profilePath) {
    return {
      profileName: "gamer-smoke-live",
      version: 1,
      lane: "openclaw",
      llm: {},
    };
  }
  try {
    const raw = await fs.readFile(profilePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {
        profileName: "gamer-smoke-live",
        version: 1,
        lane: "openclaw",
        llm: {},
      };
    }
    return parsed;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {
        profileName: "gamer-smoke-live",
        version: 1,
        lane: "openclaw",
        llm: {},
      };
    }
    throw error;
  }
}

async function safeWriteJson(filePath, obj) {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const tempPath = `${resolved}.tmp`;
  const payload = `${JSON.stringify(obj, null, 2)}\n`;
  await fs.writeFile(tempPath, payload, "utf8");
  await fs.rename(tempPath, resolved);
}

function formatProposal(proposal) {
  const reasons = Array.isArray(proposal?.reasons) ? proposal.reasons.join("; ") : "n/a";
  const settings = proposal?.suggestedSettings && typeof proposal.suggestedSettings === "object"
    ? proposal.suggestedSettings
    : {};
  return `reasons=${reasons} settings=${JSON.stringify(settings)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatReportTimestamp(date) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

function createRunId() {
  return `run-${formatReportTimestamp(new Date())}-${process.pid}`;
}

function buildScenarioFeedback(turnTranscripts) {
  const feedbackMap = new Map();
  const transcripts = Array.isArray(turnTranscripts) ? turnTranscripts : [];
  for (const transcript of transcripts) {
    const scenario = typeof transcript?.scenario === "string" ? transcript.scenario.trim() : "";
    if (!scenario) {
      continue;
    }
    const reason = typeof transcript?.sent?.reason === "string" ? transcript.sent.reason.trim() : "";
    if (!reason) {
      continue;
    }
    if (!feedbackMap.has(scenario)) {
      feedbackMap.set(scenario, new Set());
    }
    feedbackMap.get(scenario).add(reason);
  }

  const scenarioFeedback = [];
  for (const [scenario, reasons] of feedbackMap.entries()) {
    scenarioFeedback.push({ scenario, reasonSamples: Array.from(reasons) });
  }
  return scenarioFeedback;
}

function buildContractAuditSummary(turnTranscripts) {
  const transcripts = Array.isArray(turnTranscripts) ? turnTranscripts : [];
  const summary = {
    totalTurns: transcripts.length,
    validJsonCount: 0,
    validKvCount: 0,
    fallbackCount: 0,
    unknownCount: 0,
    contractComplianceRate: 0,
  };

  for (const transcript of transcripts) {
    const status = typeof transcript?.sent?.audit?.contractStatus === "string"
      ? transcript.sent.audit.contractStatus
      : null;
    if (status === "valid_json") {
      summary.validJsonCount += 1;
      continue;
    }
    if (status === "valid_kv") {
      summary.validKvCount += 1;
      continue;
    }
    if (status === "fallback_unambiguous") {
      summary.fallbackCount += 1;
      continue;
    }
    summary.unknownCount += 1;
  }

  if (summary.totalTurns > 0) {
    summary.contractComplianceRate = (summary.validJsonCount + summary.validKvCount) / summary.totalTurns;
  }

  return summary;
}

function buildContractSamples(turnTranscripts, limit = 3) {
  const transcripts = Array.isArray(turnTranscripts) ? turnTranscripts : [];
  const samples = [];
  for (const transcript of transcripts) {
    if (samples.length >= limit) {
      break;
    }
    const status = typeof transcript?.sent?.audit?.contractStatus === "string"
      ? transcript.sent.audit.contractStatus
      : "unknown";
    const rawOutputPreview = typeof transcript?.sent?.audit?.rawOutputPreview === "string"
      ? transcript.sent.audit.rawOutputPreview
      : "";
    samples.push({
      scenario: typeof transcript?.scenario === "string" ? transcript.scenario : "unknown",
      cycle: Number.isFinite(transcript?.cycle) ? transcript.cycle : null,
      turn: Number.isFinite(transcript?.turn) ? transcript.turn : null,
      status,
      rawOutputPreview,
    });
  }
  return samples;
}

function listIssuesFromProposals(proposals) {
  const reasons = new Set();
  for (const proposal of proposals) {
    const nextReasons = Array.isArray(proposal?.reasons) ? proposal.reasons : [];
    for (const reason of nextReasons) {
      if (typeof reason === "string" && reason.trim()) {
        reasons.add(reason.trim());
      }
    }
  }
  return Array.from(reasons);
}

function listLaneIssueReasons(laneIssues) {
  const reasons = new Set();
  const safeIssues = Array.isArray(laneIssues) ? laneIssues : [];
  for (const issue of safeIssues) {
    const reason = typeof issue?.reason === "string" ? issue.reason.trim() : "";
    if (reason) {
      reasons.add(reason);
    }
  }
  return Array.from(reasons);
}

function inferIssueTags(proposal) {
  const tags = new Set();
  const reasons = Array.isArray(proposal?.reasons) ? proposal.reasons : [];
  for (const reason of reasons) {
    const text = typeof reason === "string" ? reason : "";
    if (text.includes("llm invalid/fallback observed")) {
      tags.add("invalid_fallback");
    }
    if (text.includes("stale recover observed")) {
      tags.add("stale_recover");
    }
    if (text.includes("repeated route streak observed")) {
      tags.add("repetition");
    }
    if (text.includes("llm lane errors observed")) {
      tags.add("lane_error");
    }
  }
  return tags;
}

function buildHumanDiscomfort(tags) {
  if (tags.has("stale_recover") && tags.has("invalid_fallback")) {
    return "버튼을 눌렀는데 반응이 늦거나 실패하고, 이어서 선택도 빗나가 흐름이 자주 끊기는 체감이 있습니다.";
  }
  if (tags.has("stale_recover")) {
    return "이미 눌렀던 버튼이 만료된 것처럼 보여 다시 시도해야 하고, 몰입이 끊기는 불편이 있습니다.";
  }
  if (tags.has("invalid_fallback")) {
    return "의도한 행동 대신 안전한 기본 선택으로 돌아가, '내가 원하는 플레이가 안 먹힌다'는 답답함이 생깁니다.";
  }
  if (tags.has("lane_error")) {
    return "모델 자체 문제가 아닌 인증/크레딧/네트워크/브리지 상태 문제로 응답이 흔들려, 플레이 흐름이 불안정하게 느껴질 수 있습니다.";
  }
  if (tags.has("repetition")) {
    return "비슷한 선택이 반복되어 전개가 단조롭고, 플레이가 답답하게 느껴질 수 있습니다.";
  }
  return "체감 이슈가 관찰되었지만 원인이 복합적이라 추가 관찰이 필요합니다.";
}

function buildExpectedEffect(tags) {
  if (tags.has("stale_recover") && tags.has("invalid_fallback")) {
    return "상호작용 실패와 빗나간 선택이 함께 줄어들어, 턴 진행이 더 매끄럽고 예측 가능해집니다.";
  }
  if (tags.has("stale_recover")) {
    return "만료/지연 체감이 줄어들어 버튼-결과 연결이 빨라지고 플레이 몰입이 좋아집니다.";
  }
  if (tags.has("invalid_fallback")) {
    return "선택 정확도가 높아져 사용자가 의도한 행동이 더 자주 반영됩니다.";
  }
  if (tags.has("lane_error")) {
    return "인프라/인증 이슈를 먼저 정리해 불필요한 fallback을 줄이고 턴 응답 안정성을 높일 수 있습니다.";
  }
  if (tags.has("repetition")) {
    return "행동 다양성이 늘어 장면 전개가 덜 단조롭게 느껴집니다.";
  }
  return "원인 분해 후 미세조정을 적용하면 안정성과 체감 품질을 함께 개선할 수 있습니다.";
}

function formatEvidenceCounters(counters) {
  const safeCounters = counters && typeof counters === "object" ? counters : {};
  const invalid = Number.isFinite(safeCounters.llmInvalidCount) ? safeCounters.llmInvalidCount : 0;
  const fallback = Number.isFinite(safeCounters.llmFallbackCount) ? safeCounters.llmFallbackCount : 0;
  const stale = Number.isFinite(safeCounters.staleRecoverCount) ? safeCounters.staleRecoverCount : 0;
  const repetition = Number.isFinite(safeCounters.repeatedSelectionStreak) ? safeCounters.repeatedSelectionStreak : 0;
  return `invalid=${invalid}, fallback=${fallback}, staleRecover=${stale}, repetitionStreak=${repetition}`;
}

function classifyProposalPriority(proposal) {
  const counters = proposal?.counters && typeof proposal.counters === "object" ? proposal.counters : {};
  const invalid = Number.isFinite(counters.llmInvalidCount) ? counters.llmInvalidCount : 0;
  const fallback = Number.isFinite(counters.llmFallbackCount) ? counters.llmFallbackCount : 0;
  const stale = Number.isFinite(counters.staleRecoverCount) ? counters.staleRecoverCount : 0;
  const repetition = Number.isFinite(counters.repeatedSelectionStreak) ? counters.repeatedSelectionStreak : 0;
  const invalidTotal = invalid + fallback;

  if ((stale > 0 && invalidTotal >= 2) || stale >= 2 || invalidTotal >= 3) {
    return "즉시 적용";
  }
  if (stale > 0 || invalidTotal > 0 || repetition >= 3) {
    return "다음 관찰 후 적용";
  }
  return "보류";
}

function proposalActionLabel(proposal) {
  const settings = proposal?.suggestedSettings && typeof proposal.suggestedSettings === "object"
    ? proposal.suggestedSettings
    : {};
  const keys = Object.keys(settings);
  return keys.length > 0 ? `settings 조정 (${keys.join(", ")})` : "추가 조정안 없음";
}

function buildImproveMarkdownReport(report) {
  const config = report?.runnerConfig || {};
  const summary = report?.summary || {};
  const proposals = Array.isArray(report?.proposals) ? report.proposals : [];
  const scenarioSummaries = Array.isArray(report?.scenarioSummaries) ? report.scenarioSummaries : [];
  const scenarioFeedback = Array.isArray(report?.scenarioFeedback) ? report.scenarioFeedback : [];
  const latest = proposals.length > 0 ? proposals[proposals.length - 1] : null;
  const observedIssues = listIssuesFromProposals(proposals);
  const laneIssueReasons = listLaneIssueReasons(report?.laneIssues);
  const contractAuditSummary = report?.contractAuditSummary && typeof report.contractAuditSummary === "object"
    ? report.contractAuditSummary
    : null;
  const contractSamples = Array.isArray(report?.contractSamples) ? report.contractSamples : [];
  const feedbackQualityAudit = report?.feedbackQualityAudit && typeof report.feedbackQualityAudit === "object"
    ? report.feedbackQualityAudit
    : null;

  const lines = [];
  lines.push("# 🎮 Gamer Smoke Improve Report");
  lines.push("");
  lines.push(`**Generated at:** \`${report.generatedAt}\``);
  lines.push("");
  
  lines.push("## ⚙️ Run Config");
  lines.push("| 옵션 | 값 |");
  lines.push("| --- | --- |");
  lines.push(`| **Lane** | \`${config.lane}\` |`);
  lines.push(`| **Scenarios** | ${(Array.isArray(config.scenarios) ? config.scenarios : []).join(", ")} |`);
  lines.push(`| **Turns** | ${config.turns} |`);
  lines.push(`| **Improve Mode** | \`${config.improveMode}\` |`);
  lines.push(`| **Improve Window**| ${config.improveWindow} |`);
  lines.push(`| **Watch** | ${config.watch} |`);
  lines.push(`| **Max Cycles** | ${config.maxCycles === null ? "unbounded" : config.maxCycles} |`);
  lines.push(`| **Cycles Exec** | ${config.cyclesExecuted} |`);
  lines.push("");

  lines.push("## 📊 Outcome Summary");
  lines.push("| 결과 | 수치 |");
  lines.push("| --- | --- |");
  lines.push(`| ✅ **Passed** | ${summary.passed} |`);
  lines.push(`| ❌ **Failed** | ${summary.failed} |`);
  lines.push(`| 🔄 **Turns** | ${summary.turns} |`);
  lines.push(`| 💡 **Proposals** | ${proposals.length} |`);
  lines.push("");

  lines.push("## 📝 개별 시나리오 요약");
  if (scenarioSummaries.length === 0) {
    lines.push("> [!NOTE]");
    lines.push("> 수집된 시나리오 요약이 없습니다.");
  } else {
    lines.push("| Cycle | Scenario | Result | Turns | Duration (ms) | Error Reason |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const entry of scenarioSummaries) {
      const cycle = Number.isFinite(entry?.cycle) ? entry.cycle : "n/a";
      const scenario = typeof entry?.scenario === "string" && entry.scenario.trim() ? entry.scenario : "n/a";
      const ok = entry?.ok === true;
      const turnsPlayed = Number.isFinite(entry?.turnsPlayed) ? entry.turnsPlayed : 0;
      const durationMs = Number.isFinite(entry?.durationMs) ? entry.durationMs : 0;
      const errorReason = typeof entry?.errorReason === "string" && entry.errorReason.trim() ? entry.errorReason.trim() : "-";
      lines.push(`| ${cycle} | **${scenario}** | ${ok ? "✅ PASS" : "❌ FAIL"} | ${turnsPlayed} | ${durationMs} | ${errorReason} |`);
    }
  }
  lines.push("");

  lines.push("## 🤖 에이전트 피드백");
  if (scenarioFeedback.length === 0) {
    lines.push("> [!NOTE]");
    lines.push("> 수집된 reason 샘플이 없습니다.");
  } else {
    for (const feedback of scenarioFeedback) {
      const scenario = typeof feedback?.scenario === "string" && feedback.scenario.trim() ? feedback.scenario : "n/a";
      const samples = Array.isArray(feedback?.reasonSamples)
        ? feedback.reasonSamples.filter((sample) => typeof sample === "string" && sample.trim())
        : [];
      lines.push(`### ${scenario}`);
      if (samples.length === 0) {
        lines.push("- reason 샘플 없음");
      } else {
        for (const sample of samples) {
          lines.push(`- ${sample}`);
        }
      }
    }
  }
  lines.push("");

  lines.push("## 계약 준수 감사");
  if (!contractAuditSummary) {
    lines.push("> [!NOTE]");
    lines.push("> 계약 감사 데이터가 없습니다.");
  } else {
    const totalTurns = Number.isFinite(contractAuditSummary.totalTurns) ? contractAuditSummary.totalTurns : 0;
    const validJsonCount = Number.isFinite(contractAuditSummary.validJsonCount) ? contractAuditSummary.validJsonCount : 0;
    const validKvCount = Number.isFinite(contractAuditSummary.validKvCount) ? contractAuditSummary.validKvCount : 0;
    const fallbackCount = Number.isFinite(contractAuditSummary.fallbackCount) ? contractAuditSummary.fallbackCount : 0;
    const unknownCount = Number.isFinite(contractAuditSummary.unknownCount) ? contractAuditSummary.unknownCount : 0;
    const complianceRateRaw = Number.isFinite(contractAuditSummary.contractComplianceRate)
      ? contractAuditSummary.contractComplianceRate
      : 0;
    const complianceRate = `${(complianceRateRaw * 100).toFixed(1)}%`;
    const fallbackRate = totalTurns > 0 ? fallbackCount / totalTurns : 0;
    const gate = fallbackRate > 0.2
      ? "품질판정: FAIL(구조화 응답 안정성 부족)"
      : "품질판정: PASS";

    lines.push(`- totalTurns: ${totalTurns}`);
    lines.push(`- validJsonCount: ${validJsonCount}`);
    lines.push(`- validKvCount: ${validKvCount}`);
    lines.push(`- fallbackCount: ${fallbackCount}`);
    lines.push(`- unknownCount: ${unknownCount}`);
    lines.push(`- contractComplianceRate: ${complianceRate}`);
    lines.push(`- ${gate}`);

    if (contractSamples.length > 0) {
      lines.push("");
      lines.push("샘플:");
      for (const sample of contractSamples.slice(0, 3)) {
        const scenario = typeof sample?.scenario === "string" ? sample.scenario : "unknown";
        const cycle = Number.isFinite(sample?.cycle) ? sample.cycle : "n/a";
        const turn = Number.isFinite(sample?.turn) ? sample.turn : "n/a";
        const status = typeof sample?.status === "string" ? sample.status : "unknown";
        const rawOutputPreview = typeof sample?.rawOutputPreview === "string" ? sample.rawOutputPreview : "";
        lines.push(`- [${scenario} c${cycle} t${turn}] status=${status} preview=${rawOutputPreview || "(empty)"}`);
      }
    }
  }
  lines.push("");

  lines.push("## 🧭 Drifter Feedback Quality Audit");
  if (!feedbackQualityAudit) {
    lines.push("> [!NOTE]");
    lines.push("> 피드백 품질 감사 데이터가 없습니다.");
  } else {
    const auditSummary = feedbackQualityAudit.summary && typeof feedbackQualityAudit.summary === "object"
      ? feedbackQualityAudit.summary
      : {};
    lines.push(`- overallScore: ${auditSummary.overallScore ?? "n/a"}`);
    lines.push(`- gate: ${auditSummary.gate ?? "n/a"}`);
    const findings = Array.isArray(auditSummary.topFindings) ? auditSummary.topFindings : [];
    if (findings.length > 0) {
      lines.push("- topFindings:");
      for (const finding of findings) {
        lines.push(`  - ${finding}`);
      }
    }
    lines.push("");
    lines.push("세부 차원:");
    for (const dimension of Array.isArray(feedbackQualityAudit.dimensions) ? feedbackQualityAudit.dimensions : []) {
      lines.push(`- ${dimension.name}: ${dimension.status} (${dimension.score}) — ${dimension.focus}`);
    }
  }
  lines.push("");

  lines.push("## ⚠️ Observed Issues");
  if (observedIssues.length === 0) {
    lines.push("> [!SUCCESS]");
    lines.push("> 관찰된 이슈 없음");
  } else {
    for (const issue of observedIssues) {
      lines.push(`- ${issue}`);
    }
  }
  if (laneIssueReasons.length > 0) {
    lines.push("");
    lines.push("> [!WARNING]\n> **Lane Error 관찰됨**");
    for (const reason of laneIssueReasons) {
      lines.push(`> - ${reason}`);
    }
  }
  lines.push("");

  lines.push("## 💡 Recommended Changes");
  if (!latest) {
    lines.push("> [!NOTE]");
    lines.push("> No proposals observed in this run.");
  } else {
    lines.push(`> **Latest proposal** (${latest.at} | cycle=${latest.context?.cycle ?? "n/a"} | scenario=${latest.context?.scenario ?? "n/a"})`);
    lines.push(`> - **Reasons:** ${(Array.isArray(latest.reasons) ? latest.reasons : []).join("; ") || "n/a"}`);
    lines.push(`> - **Suggested Settings:** \`${JSON.stringify(latest.suggestedSettings || {})}\``);
  }
  lines.push("");

  lines.push("## 👥 UX 개선 리포트 (사람 관점)");
  if (proposals.length === 0) {
    lines.push("> [!NOTE]");
    lines.push("> 관찰된 개선 제안이 없어 UX 이슈 섹션을 생성하지 않았습니다.");
  } else {
    for (const [index, proposal] of proposals.entries()) {
      const tags = inferIssueTags(proposal);
      const context = proposal?.context && typeof proposal.context === "object" ? proposal.context : {};
      const settings = proposal?.suggestedSettings && typeof proposal.suggestedSettings === "object"
        ? proposal.suggestedSettings
        : {};
      const promptInstruction = typeof settings.systemPromptAppend === "string" && settings.systemPromptAppend.trim()
        ? settings.systemPromptAppend.trim()
        : "없음";

      lines.push(`### 🚩 이슈 ${index + 1}: 불편 징후`);
      lines.push(`- **불편 징후:** ${(Array.isArray(proposal?.reasons) ? proposal.reasons : []).join("; ") || "n/a"}`);
      lines.push(
        `- **상황:** scenario=${context.scenario ?? "n/a"}, cycle=${context.cycle ?? "n/a"}, turn=${context.scenarioTurnsPlayed ?? "n/a"}, improveWindow=${config.improveWindow ?? "n/a"}`,
      );
      lines.push(`- **사용자 체감 불편:** ${buildHumanDiscomfort(tags)}`);
      lines.push(`- **근거 지표:** \`${formatEvidenceCounters(proposal?.counters)}\``);
      lines.push(`- **개선 방법:**`);
      lines.push(`  - \`settings=${JSON.stringify(settings)}\``);
      lines.push(`  - \`prompt instruction=${promptInstruction}\``);
      lines.push(`- **기대 효과:** ${buildExpectedEffect(tags)}`);
      if (tags.has("lane_error")) {
        lines.push("");
        lines.push("> [!CAUTION]");
        lines.push("> **운영 점검 필요:** provider/auth/credits/bridge 네트워크 상태를 우선 점검하세요.");
      }
      lines.push("");
    }
  }

  if (laneIssueReasons.length > 0) {
    lines.push("### 🚨 LLM Lane 인프라 이슈 (별도)");
    for (const reason of laneIssueReasons) {
      lines.push(`- ${reason}`);
    }
    lines.push("");
  }

  lines.push("## 🔥 우선순위 액션 플랜");
  lines.push("> **규칙:** `staleRecover > 0` 이면서 `(invalid + fallback) >= 2` 이면 `즉시 적용`. 그 외 신호가 있으면 `다음 관찰 후 적용`, 없으면 `보류`.");
  lines.push("");

  const buckets = {
    "즉시 적용": [],
    "다음 관찰 후 적용": [],
    "보류": [],
  };
  for (const proposal of proposals) {
    const priority = classifyProposalPriority(proposal);
    buckets[priority].push(proposal);
  }

  for (const title of ["즉시 적용", "다음 관찰 후 적용", "보류"]) {
    lines.push(`### ${title}`);
    if (buckets[title].length === 0) {
      lines.push("- 없음");
      continue;
    }
    for (const proposal of buckets[title]) {
      const context = proposal?.context && typeof proposal.context === "object" ? proposal.context : {};
      lines.push(
        `- **[${proposal.at}]** scenario=${context.scenario ?? "n/a"} cycle=${context.cycle ?? "n/a"}: **${proposalActionLabel(proposal)}** / 근거(\`${formatEvidenceCounters(proposal?.counters)}\`)`,
      );
    }
  }
  lines.push("");

  lines.push("<details>");
  lines.push("<summary><strong>All proposals (Click to expand)</strong></summary>\n");
  if (proposals.length === 0) {
    lines.push("- none");
  } else {
    for (const proposal of proposals) {
      lines.push(
        `- **[${proposal.at}]** cycle=${proposal.context?.cycle ?? "n/a"} scenario=${proposal.context?.scenario ?? "n/a"} force=${proposal.context?.force === true}`,
      );
      lines.push(`  - **Reasons:** ${(Array.isArray(proposal.reasons) ? proposal.reasons : []).join("; ") || "n/a"}`);
      lines.push(`  - **Suggested Settings:** \`${JSON.stringify(proposal.suggestedSettings || {})}\``);
      lines.push(`  - **Counters:** \`${JSON.stringify(proposal.counters || {})}\``);
    }
  }
  lines.push("</details>\n");

  lines.push("## 💬 턴별 메시지/응답 로그");
  const turnTranscripts = Array.isArray(report?.turnTranscripts) ? report.turnTranscripts : [];
  if (turnTranscripts.length === 0) {
    lines.push("> [!NOTE]");
    lines.push("> 수집된 턴별 로그가 없습니다.");
  } else {
    for (const transcript of turnTranscripts) {
      const cycle = Number.isFinite(transcript?.cycle) ? transcript.cycle : "n/a";
      const scenario = typeof transcript?.scenario === "string" && transcript.scenario.trim() ? transcript.scenario : "n/a";
      const turn = Number.isFinite(transcript?.turn) ? transcript.turn : "n/a";
      const receivedRaw = typeof transcript?.received?.originalText === "string" && transcript.received.originalText.trim()
        ? transcript.received.originalText.trim()
        : typeof transcript?.received?.textSummary === "string" && transcript.received.textSummary.trim()
        ? transcript.received.textSummary.trim()
        : "(요약 없음)";
      const sentType = transcript?.sent?.type ?? "n/a";
      const sentCustomId = transcript?.sent?.customId ?? "n/a";
      const sentLabel = transcript?.sent?.label ?? "n/a";
      const sentActionId = transcript?.sent?.actionId ?? "n/a";
      const sentReason = transcript?.sent?.reason ?? null;
      const sentFreeInput = transcript?.sent?.freeInput ?? null;
      const responseOk = transcript?.response?.ok === true;
      const responseErrorCode = transcript?.response?.errorCode ?? null;
      const recovered = transcript?.recovered === true;

      lines.push(`<details>`);
      lines.push(`<summary><strong>Cycle ${cycle} | Scenario: ${scenario} | Turn: ${turn}</strong></summary>\n`);
      lines.push("#### 📥 받은 메시지 (원문)");
      lines.push("```text");
      lines.push(receivedRaw);
      lines.push("```");
      lines.push("#### 📤 선택 응답");
      lines.push(`- **Type:** \`${sentType}\``);
      lines.push(`- **Action ID:** \`${sentActionId}\``);
      lines.push(`- **Custom ID:** \`${sentCustomId}\``);
      lines.push(`- **Label:** \`${sentLabel}\``);
      if (sentReason !== null) lines.push(`- **Reason:** \`${sentReason}\``);
      if (sentFreeInput !== null) lines.push(`- **Free Input:** \`${sentFreeInput}\``);
      lines.push("");
      lines.push("#### ⚙️ 처리 결과");
      lines.push(`- **OK:** \`${responseOk}\``);
      lines.push(`- **Error Code:** \`${responseErrorCode ?? "n/a"}\``);
      lines.push(`- **Recovered:** \`${recovered}\``);
      lines.push("</details>");
      lines.push("");
    }
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

async function writeImproveReports(args, ui, report) {
  const reportDir = path.resolve(args.improveReportDir || DEFAULT_IMPROVE_REPORT_DIR);
  const reportPrefix = args.improveReportPrefix || DEFAULT_IMPROVE_REPORT_PREFIX;
  const timestamp = formatReportTimestamp(new Date());
  const runtimeReportDir = path.resolve(reportDir, `${reportPrefix}-${args.improve}-${timestamp}`);
  const jsonPath = path.resolve(runtimeReportDir, "report.machine.json");
  const mdPath = path.resolve(runtimeReportDir, "report.user.md");

  try {
    await fs.mkdir(runtimeReportDir, { recursive: true });
  } catch (error) {
    ui.warn(`improve report: failed to create directory '${runtimeReportDir}' (${sanitizeForCli(error instanceof Error ? error.message : String(error))})`);
    return { folder: runtimeReportDir, files: [] };
  }

  const written = [];
  try {
    await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    written.push(jsonPath);
  } catch (error) {
    ui.warn(`improve report: failed to write JSON '${jsonPath}' (${sanitizeForCli(error instanceof Error ? error.message : String(error))})`);
  }

  try {
    const markdown = buildImproveMarkdownReport(report);
    await fs.writeFile(mdPath, markdown, "utf8");
    written.push(mdPath);
  } catch (error) {
    ui.warn(`improve report: failed to write Markdown '${mdPath}' (${sanitizeForCli(error instanceof Error ? error.message : String(error))})`);
  }

  for (const filePath of written) {
    ui.ok(`improve report written ${filePath}`);
  }
  ui.ok(`improve report folder ${runtimeReportDir}`);
  return { folder: runtimeReportDir, files: written };
}

async function runScenario({ name, plugin, args, ui, runtimeState, cycleNumber, reportCollector }) {
  const worldRoot = await createIsolatedWorldRoot(`trpg-runtime-v2-live-${name}`);
  let turnsPlayed = 0;
  let latestTurnTranscript = null;
  const improver = args.improve !== "off" ? new GamerLiveImprover() : null;
  const createTurnOptions = (base = {}) => {
    if (args.forceDirectInput !== true) {
      return base;
    }
    return {
      ...base,
      preferModal: true,
      freeInput: args.directInputFallbackText,
    };
  };

  const maybeImprove = async (force = false) => {
    if (!improver) {
      return;
    }
    const proposal = improver.evaluateProposal({
      windowTurns: args.improveWindow,
      force,
    });
    if (!proposal) {
      return;
    }
    if (args.improve === "shadow") {
      ui.info(`[improve] proposal ${formatProposal(proposal)}`);
    } else {
      runtimeState.profile = applyTuningToProfile(runtimeState.profile, proposal);
      if (args.agentProfile) {
        await safeWriteJson(args.agentProfile, runtimeState.profile);
      }
      ui.ok(`[improve] applied ${formatProposal(proposal)}`);
    }

    if (reportCollector && Array.isArray(reportCollector.proposals)) {
      reportCollector.proposals.push({
        at: new Date().toISOString(),
        mode: args.improve,
        reasons: Array.isArray(proposal?.reasons) ? proposal.reasons : [],
        suggestedSettings:
          proposal?.suggestedSettings && typeof proposal.suggestedSettings === "object" ? proposal.suggestedSettings : {},
        context: {
          cycle: cycleNumber,
          scenario: name,
          force,
          scenarioTurnsPlayed: turnsPlayed,
        },
        counters: improver.snapshot(),
      });
    }
  };

  try {
    const tools = createToolMap(plugin, worldRoot);
    const decisionContext = {
      runId: runtimeState.runId,
      cycleNumber,
      scenarioName: name,
    };
    const effectiveBridgeSessionId = buildBridgeSessionId(args, decisionContext);
    const decisionLane = await createDecisionLane(args, runtimeState, decisionContext);
    const channelKey = `discord:live-${runtimeState.runId}:c${cycleNumber}:${name}`;
    if (args.verbose && args.lane === "bridge") {
      ui.dim(`bridge session effective scenario=${name} cycle=${cycleNumber} scope=${args.bridgeSessionScope} sessionId=${effectiveBridgeSessionId}`);
    }
    const agent = new BlackboxGamerAgent({
      tools,
      ownerId: "owner-1",
      channelKey,
      defaultFreeInput: "강행 돌파한다",
      ...(decisionLane ? { decisionLane } : {}),
      logger: createScenarioLogger(ui, {
        ...args,
        onEvent: (payload) => {
          if (improver) {
            improver.observe(payload);
          }
          if (reportCollector && Array.isArray(reportCollector.turnTranscripts) && payload?.event === "turn_transcript") {
            reportCollector.turnTranscripts.push({
              cycle: cycleNumber,
              scenario: name,
              turn: Number.isFinite(payload?.turn) ? payload.turn : null,
              received: payload?.received && typeof payload.received === "object" ? payload.received : {},
              sent: payload?.sent && typeof payload.sent === "object" ? payload.sent : {},
              response: payload?.response && typeof payload.response === "object" ? payload.response : {},
              recovered: payload?.recovered === true,
            });
          }
          if (payload?.event === "turn_transcript") {
            latestTurnTranscript = {
              cycle: cycleNumber,
              scenario: name,
              turn: Number.isFinite(payload?.turn) ? payload.turn : null,
              received: payload?.received && typeof payload.received === "object" ? payload.received : {},
              sent: payload?.sent && typeof payload.sent === "object" ? payload.sent : {},
              response: payload?.response && typeof payload.response === "object" ? payload.response : {},
              recovered: payload?.recovered === true,
            };
          }
          if (reportCollector && Array.isArray(reportCollector.laneIssues)) {
            if (payload?.event === "llm_lane_error") {
              reportCollector.laneIssues.push({
                at: new Date().toISOString(),
                cycle: cycleNumber,
                scenario: name,
                event: payload.event,
                reason: typeof payload?.error === "string" ? payload.error : "unknown",
                category: typeof payload?.category === "string" ? payload.category : null,
              });
            }
            if (payload?.event === "llm_lane_disabled" || payload?.event === "llm_lane_skipped") {
              reportCollector.laneIssues.push({
                at: new Date().toISOString(),
                cycle: cycleNumber,
                scenario: name,
                event: payload.event,
                reason: typeof payload?.reason === "string" ? payload.reason : "unknown",
                category: typeof payload?.category === "string" ? payload.category : null,
              });
            }
          }
        },
      }, name),
      traceLabel: name,
    });

    const started = await agent.startSession();
    if (started?.ok !== true) {
      throw new Error(`startSession failed: ${JSON.stringify(started)}`);
    }

    if (name === "happy") {
      for (let i = 0; i < args.turns; i += 1) {
        const played = await agent.playTurn(createTurnOptions());
        if (played?.result?.ok !== true) {
          throw new Error(`happy turn failed at ${i + 1}: ${JSON.stringify(played?.result)}`);
        }
        const commit = await agent.commitDispatch();
        if (commit?.ok !== true) {
          throw new Error(`happy commit failed at ${i + 1}: ${JSON.stringify(commit)}`);
        }
        turnsPlayed += 1;
        await mirrorTurnToDiscord({
          args,
          ui,
          runId: runtimeState.runId,
          scenarioName: name,
          turnNumber: Number.isFinite(latestTurnTranscript?.turn) ? latestTurnTranscript.turn : turnsPlayed,
          turnData: played,
          turnTranscript: latestTurnTranscript,
        });
        await maybeImprove(false);
      }
      await maybeImprove(true);
      return { ok: true, turnsPlayed };
    }

    if (name === "modal") {
      const firstTurn = await agent.playTurn(createTurnOptions({ preferModal: true }));
      if (firstTurn?.result?.ok !== true) {
        throw new Error(`modal first turn failed: ${JSON.stringify(firstTurn?.result)}`);
      }
      if (firstTurn?.selection?.type !== "modal") {
        throw new Error(`modal scenario expected modal selection, received '${firstTurn?.selection?.type || "unknown"}'`);
      }
      const firstCommit = await agent.commitDispatch();
      if (firstCommit?.ok !== true) {
        throw new Error(`modal first commit failed: ${JSON.stringify(firstCommit)}`);
      }
      turnsPlayed += 1;
      await mirrorTurnToDiscord({
        args,
        ui,
        runId: runtimeState.runId,
        scenarioName: name,
        turnNumber: Number.isFinite(latestTurnTranscript?.turn) ? latestTurnTranscript.turn : turnsPlayed,
        turnData: firstTurn,
        turnTranscript: latestTurnTranscript,
      });
      await maybeImprove(false);

      for (let i = 1; i < args.turns; i += 1) {
        const played = await agent.playTurn(createTurnOptions());
        if (played?.result?.ok !== true) {
          throw new Error(`modal turn failed at ${i + 1}: ${JSON.stringify(played?.result)}`);
        }
        const commit = await agent.commitDispatch();
        if (commit?.ok !== true) {
          throw new Error(`modal commit failed at ${i + 1}: ${JSON.stringify(commit)}`);
        }
        turnsPlayed += 1;
        await mirrorTurnToDiscord({
          args,
          ui,
          runId: runtimeState.runId,
          scenarioName: name,
          turnNumber: Number.isFinite(latestTurnTranscript?.turn) ? latestTurnTranscript.turn : turnsPlayed,
          turnData: played,
          turnTranscript: latestTurnTranscript,
        });
        await maybeImprove(false);
      }
      await maybeImprove(true);
      return { ok: true, turnsPlayed };
    }

    const firstSelection = await agent.pickNextAction(createTurnOptions());
    const firstInteraction = await agent.interact(firstSelection);
    if (firstInteraction?.ok !== true) {
      throw new Error(`stale setup first interaction failed: ${JSON.stringify(firstInteraction)}`);
    }
    const setupCommit = await agent.commitDispatch();
    if (setupCommit?.ok !== true) {
      throw new Error(`stale setup commit failed: ${JSON.stringify(setupCommit)}`);
    }

    const staleAttempt = await agent.interact(firstSelection);
    if (!isStaleInteractionError(staleAttempt)) {
      throw new Error(`stale scenario expected stale error, received: ${JSON.stringify(staleAttempt)}`);
    }

    const resumed = await agent.recoverFromStaleOrExpiredRoute(staleAttempt);
    if (resumed?.ok !== true) {
      throw new Error(`stale resume failed: ${JSON.stringify(resumed)}`);
    }

    const recoveredTurn = await agent.playTurn(createTurnOptions());
    if (recoveredTurn?.result?.ok !== true) {
      throw new Error(`stale recovered turn failed: ${JSON.stringify(recoveredTurn?.result)}`);
    }
    const recoveredCommit = await agent.commitDispatch();
    if (recoveredCommit?.ok !== true) {
      throw new Error(`stale recovered commit failed: ${JSON.stringify(recoveredCommit)}`);
    }
    turnsPlayed += 1;
    await mirrorTurnToDiscord({
      args,
      ui,
      runId: runtimeState.runId,
      scenarioName: name,
      turnNumber: Number.isFinite(latestTurnTranscript?.turn) ? latestTurnTranscript.turn : turnsPlayed,
      turnData: recoveredTurn,
      turnTranscript: latestTurnTranscript,
    });
    await maybeImprove(false);

    for (let i = 1; i < args.turns; i += 1) {
      const played = await agent.playTurn(createTurnOptions());
      if (played?.result?.ok !== true) {
        throw new Error(`stale extra turn failed at ${i + 1}: ${JSON.stringify(played?.result)}`);
      }
      const commit = await agent.commitDispatch();
      if (commit?.ok !== true) {
        throw new Error(`stale extra commit failed at ${i + 1}: ${JSON.stringify(commit)}`);
      }
      turnsPlayed += 1;
      await mirrorTurnToDiscord({
        args,
        ui,
        runId: runtimeState.runId,
        scenarioName: name,
        turnNumber: Number.isFinite(latestTurnTranscript?.turn) ? latestTurnTranscript.turn : turnsPlayed,
        turnData: played,
        turnTranscript: latestTurnTranscript,
      });
      await maybeImprove(false);
    }

    await maybeImprove(true);
    return { ok: true, turnsPlayed };
  } finally {
    await fs.rm(worldRoot, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const runId = createRunId();
  const ui = createUi(args);
  ui.info(`gamer-smoke-live runId=${runId} lane=${args.lane} scenarios=${args.scenarios.join(",")} turns=${args.turns}`);
  if (args.provider) {
    ui.dim(`provider override=${args.provider}`);
  }
  if (args.agentPath) {
    ui.dim(`agent path override=${args.agentPath}`);
  }
  if (args.openclawHome) {
    ui.dim(`openclaw home override=${args.openclawHome}`);
  }
  if (args.agentId) {
    ui.dim(`agent id override=${args.agentId}`);
  }
  if (args.agentProfile) {
    ui.dim(`agent profile override=${args.agentProfile}`);
  }
  if (args.lane === "bridge") {
    ui.dim(`bridge script=${args.bridgeScript}`);
    ui.dim(`bridge runtime workdir=${args.bridgeWorkdir} agentId=${args.bridgeAgentId} sessionId=${args.bridgeSessionId} scope=${args.bridgeSessionScope} version=${args.bridgeOpenclawVersion} wslDistro=${args.bridgeWslDistro}`);
  }
  if (args.model) {
    ui.dim(`model override=${args.model}`);
  }
  if (args.skipPreflight) {
    ui.dim("preflight skipped (--skip-preflight)");
  }
  if (args.improve !== "off") {
    ui.dim(`improve mode=${args.improve} window=${args.improveWindow}`);
    ui.dim(`improve report dir=${args.improveReportDir} prefix=${args.improveReportPrefix}`);
  }
  if (args.discordMirror) {
    ui.dim(`discord mirror requested workdir=${args.discordWorkdir}`);
    ui.dim(`discord mirror template=${args.discordMirrorTemplate}`);
  }
  if (args.forceDirectInput) {
    ui.dim(`force-direct-input enabled fallbackText=${JSON.stringify(args.directInputFallbackText)}`);
  }
  if (args.watch) {
    ui.dim(`watch enabled intervalMs=${args.watchIntervalMs}${args.maxCycles !== null ? ` maxCycles=${args.maxCycles}` : ""}`);
  } else {
    ui.dim(`maxCycles=${args.maxCycles}`);
  }

  const runtimeState = {
    runId,
    profile: args.improve === "auto" ? await readProfileOrDefault(args.agentProfile) : null,
  };

  const plugin = await loadPlugin();
  if (args.printLaneConfig && (args.lane === "openclaw" || args.lane === "bridge")) {
    const resolved = resolveOpenClawLaneConfig(args);
    printResolvedLaneConfig(args, resolved);
  }
  try {
    await runLanePreflight(args, runtimeState, ui);
  } catch (error) {
    const reason = sanitizeForCli(error instanceof Error ? error.message : String(error));
    ui.error(`infra:preflight-failed lane=${args.lane} reason=${reason}`);
    process.exitCode = 1;
    return;
  }

  if (args.discordMirror) {
    if (!args.discordChannelId) {
      const resolvedChannelId = await resolveDefaultDiscordChannelIdFromOpenClawConfig(DEFAULT_OPENCLAW_CONFIG_PATH);
      if (resolvedChannelId) {
        args.discordChannelId = resolvedChannelId;
        ui.dim(`discord mirror channel auto-resolved from ${DEFAULT_OPENCLAW_CONFIG_PATH}`);
      }
    }
    if (!args.discordChannelId) {
      ui.error("discord mirror requires --discord-channel-id (or resolvable trpg-v2 discord binding in ~/.openclaw/openclaw.json)");
      process.exitCode = 1;
      return;
    }
    ui.dim(`discord mirror enabled channel=${args.discordChannelId} workdir=${args.discordWorkdir}`);
  }

  const summary = {
    cycles: 0,
    passed: 0,
    failed: 0,
    turnsPlayed: 0,
  };
  const scenarioSummaries = [];
  const improveReportCollector = args.improve === "off"
    ? null
    : {
      proposals: [],
      turnTranscripts: [],
      laneIssues: [],
    };

  let continueWatch = true;
  process.on("SIGINT", () => {
    continueWatch = false;
    ui.warn("received SIGINT, stopping after current cycle");
  });

  const cycleLimit = args.maxCycles;
  while (continueWatch && (cycleLimit === null || summary.cycles < cycleLimit)) {
    summary.cycles += 1;
    ui.info(`cycle:start ${summary.cycles}`);
    for (const scenarioName of args.scenarios) {
      ui.info(`scenario:start ${scenarioName}`);
      const startedAt = new Date();
      try {
        const result = await runScenario({
          name: scenarioName,
          plugin,
          args,
          ui,
          runtimeState,
          cycleNumber: summary.cycles,
          reportCollector: improveReportCollector,
        });
        const endedAt = new Date();
        summary.passed += 1;
        summary.turnsPlayed += result.turnsPlayed;
        scenarioSummaries.push({
          cycle: summary.cycles,
          scenario: scenarioName,
          ok: true,
          turnsPlayed: result.turnsPlayed,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs: endedAt.getTime() - startedAt.getTime(),
        });
        ui.ok(`scenario:pass ${scenarioName} turns=${result.turnsPlayed}`);
      } catch (error) {
        const endedAt = new Date();
        summary.failed += 1;
        const reason = sanitizeForCli(error instanceof Error ? error.message : String(error));
        scenarioSummaries.push({
          cycle: summary.cycles,
          scenario: scenarioName,
          ok: false,
          turnsPlayed: 0,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs: endedAt.getTime() - startedAt.getTime(),
          errorReason: reason,
        });
        ui.error(`scenario:fail ${scenarioName} reason=${reason}`);
      }
    }
    if (!args.watch) {
      break;
    }
    if (!continueWatch) {
      break;
    }
    if (cycleLimit !== null && summary.cycles >= cycleLimit) {
      break;
    }
    await sleep(args.watchIntervalMs);
  }

  const total = summary.passed + summary.failed;
  ui.info(
    `summary cycles=${summary.cycles} total=${total} passed=${summary.passed} failed=${summary.failed} turns=${summary.turnsPlayed}`,
  );

  const scenarioFeedback = improveReportCollector
    ? buildScenarioFeedback(improveReportCollector.turnTranscripts)
    : [];
  const contractAuditSummary = improveReportCollector
    ? buildContractAuditSummary(improveReportCollector.turnTranscripts)
    : null;
  const contractSamples = improveReportCollector
    ? buildContractSamples(improveReportCollector.turnTranscripts, 3)
    : [];
  const feedbackQualityAudit = improveReportCollector
    ? buildDrifterFeedbackAudit({
        turnTranscripts: improveReportCollector.turnTranscripts,
        proposals: improveReportCollector.proposals,
        laneIssues: improveReportCollector.laneIssues,
      })
    : null;

  const machineSummary = {
    runId,
    passed: summary.passed,
    failed: summary.failed,
    scenarios: scenarioSummaries.map((entry) => ({
      cycle: entry.cycle,
      scenario: entry.scenario,
      ok: entry.ok,
    })),
  };
  process.stdout.write(`MACHINE_SUMMARY ${JSON.stringify(machineSummary)}\n`);

  if (args.improve !== "off" && improveReportCollector) {
    const improveReport = {
      runId,
      generatedAt: new Date().toISOString(),
      runnerConfig: {
        lane: args.lane,
        scenarios: args.scenarios,
        turns: args.turns,
        improveMode: args.improve,
        improveWindow: args.improveWindow,
        watch: args.watch,
        maxCycles: args.maxCycles,
        cyclesExecuted: summary.cycles,
      },
      summary: {
        passed: summary.passed,
        failed: summary.failed,
        turns: summary.turnsPlayed,
      },
      proposals: improveReportCollector.proposals,
      turnTranscripts: improveReportCollector.turnTranscripts,
      laneIssues: improveReportCollector.laneIssues,
      scenarioSummaries,
      scenarioFeedback,
      contractAuditSummary,
      contractSamples,
      feedbackQualityAudit,
    };
    await writeImproveReports(args, ui, improveReport);
  }

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const reason = sanitizeForCli(error instanceof Error ? error.message : String(error));
  process.stderr.write(`run-gamer-smoke-live fatal: ${reason}\n`);
  process.exitCode = 1;
});
