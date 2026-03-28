#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { createOpenAiChatDecisionLane } from "../tests/helpers/llm-gamer-decision-lane.mjs";
import { createOpenClawConfigDecisionLane, resolveOpenClawDecisionLaneConfig } from "../tests/helpers/openclaw-config-decision-lane.mjs";
import { createProcessBridgeDecisionLane } from "../tests/helpers/process-bridge-decision-lane.mjs";
import {
  CHARACTER_PERSONALITY_PROFILES,
  DIVERGENCE_SCENARIOS,
  DRIFTER_STYLE_PRESETS,
  buildDivergenceSystemPrompt,
  buildScenarioDecisionContext,
  summarizeDivergenceResults,
} from "../tests/helpers/drifter-divergence.mjs";

const VALID_LANES = new Set(["deterministic", "openai", "openclaw", "bridge"]);
const VALID_RICHNESS = new Set(["thin", "rich"]);
const DEFAULT_OUT_DIR = path.resolve(process.cwd(), "runtime/reports/drifter-divergence");

function readValue(argv, index, flag) {
  const value = String(argv[index + 1] ?? "").trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseList(raw, fallback) {
  const items = String(raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return items.length > 0 ? Array.from(new Set(items)) : fallback;
}

function parseArgs(argv) {
  const parsed = {
    lane: "deterministic",
    scenarioIds: DIVERGENCE_SCENARIOS.map((entry) => entry.id),
    personalityIds: CHARACTER_PERSONALITY_PROFILES.map((entry) => entry.id),
    drifterStyleIds: [DRIFTER_STYLE_PRESETS[0].id],
    richness: ["thin", "rich"],
    repeats: 1,
    outDir: DEFAULT_OUT_DIR,
    provider: null,
    model: null,
    openclawHome: null,
    agentId: null,
    agentPath: null,
    agentProfile: null,
    bridgeWorkdir: "/home/superl3/S3OpenClaw",
    bridgeAgentId: "drifter",
    bridgeSessionId: "drifter-divergence",
    bridgeOpenclawVersion: "2026.3.24",
    bridgeWslDistro: "Ubuntu-24.04",
    timeoutMs: 30000,
    printLaneConfig: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "-h" || token === "--help") {
      parsed.help = true;
      continue;
    }
    if (token === "--lane") {
      parsed.lane = readValue(argv, i, "--lane");
      i += 1;
      continue;
    }
    if (token === "--scenarios") {
      parsed.scenarioIds = parseList(readValue(argv, i, "--scenarios"), parsed.scenarioIds);
      i += 1;
      continue;
    }
    if (token === "--personalities") {
      parsed.personalityIds = parseList(readValue(argv, i, "--personalities"), parsed.personalityIds);
      i += 1;
      continue;
    }
    if (token === "--drifter-styles") {
      parsed.drifterStyleIds = parseList(readValue(argv, i, "--drifter-styles"), parsed.drifterStyleIds);
      i += 1;
      continue;
    }
    if (token === "--richness") {
      parsed.richness = parseList(readValue(argv, i, "--richness"), parsed.richness);
      i += 1;
      continue;
    }
    if (token === "--repeats") {
      parsed.repeats = Number.parseInt(readValue(argv, i, "--repeats"), 10);
      i += 1;
      continue;
    }
    if (token === "--out-dir") {
      parsed.outDir = path.resolve(readValue(argv, i, "--out-dir"));
      i += 1;
      continue;
    }
    if (token === "--provider") {
      parsed.provider = readValue(argv, i, "--provider");
      i += 1;
      continue;
    }
    if (token === "--model") {
      parsed.model = readValue(argv, i, "--model");
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
    if (token === "--agent-path") {
      parsed.agentPath = readValue(argv, i, "--agent-path");
      i += 1;
      continue;
    }
    if (token === "--agent-profile") {
      parsed.agentProfile = readValue(argv, i, "--agent-profile");
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
    if (token === "--timeout-ms") {
      parsed.timeoutMs = Number.parseInt(readValue(argv, i, "--timeout-ms"), 10);
      i += 1;
      continue;
    }
    if (token === "--print-lane-config") {
      parsed.printLaneConfig = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!VALID_LANES.has(parsed.lane)) {
    throw new Error(`Invalid --lane '${parsed.lane}'`);
  }
  if (!Number.isFinite(parsed.repeats) || parsed.repeats <= 0 || parsed.repeats > 10) {
    throw new Error("--repeats must be an integer between 1 and 10");
  }
  for (const entry of parsed.richness) {
    if (!VALID_RICHNESS.has(entry)) {
      throw new Error(`Invalid richness '${entry}'`);
    }
  }

  return parsed;
}

function usage() {
  return [
    "Usage: node ./scripts/run-drifter-divergence.mjs [options]",
    "",
    "Options:",
    "  --lane <deterministic|openai|openclaw|bridge>",
    "  --scenarios <id,id,...>",
    "  --personalities <id,id,...>",
    "  --drifter-styles <id,id,...>",
    "  --richness <thin,rich>",
    "  --repeats <1-10>",
    "  --out-dir <path>",
    "  --provider <id>              (openclaw lane)",
    "  --model <id>                 (openai/openclaw lane)",
    "  --openclaw-home <path>       (openclaw lane)",
    "  --agent-id <id>              (openclaw lane)",
    "  --agent-path <path>          (openclaw lane)",
    "  --agent-profile <path>       (openclaw lane)",
    "  --bridge-workdir <path>      (bridge lane)",
    "  --bridge-agent-id <id>       (bridge lane)",
    "  --bridge-session-id <id>     (bridge lane)",
    "  --bridge-openclaw-version <v>(bridge lane)",
    "  --bridge-wsl-distro <name>   (bridge lane)",
    "  --timeout-ms <ms>",
    "  --print-lane-config",
    "  -h, --help",
  ].join("\n");
}

function resolveScenario(id) {
  const found = DIVERGENCE_SCENARIOS.find((entry) => entry.id === id);
  if (!found) throw new Error(`Unknown scenario '${id}'`);
  return found;
}

function resolvePersonality(id) {
  const found = CHARACTER_PERSONALITY_PROFILES.find((entry) => entry.id === id);
  if (!found) throw new Error(`Unknown personality '${id}'`);
  return found;
}

function resolveDrifterStyle(id) {
  const found = DRIFTER_STYLE_PRESETS.find((entry) => entry.id === id);
  if (!found) throw new Error(`Unknown drifter style '${id}'`);
  return found;
}

function createDeterministicLane() {
  return async function decisionLane(context) {
    const visible = context?.visible || {};
    const recommendationActionId = visible?.recommendation?.actionId || null;
    const buttons = Array.isArray(visible.buttons) ? visible.buttons : [];
    const preferred = recommendationActionId
      ? buttons.find((entry) => entry?.actionId === recommendationActionId)
      : null;
    if (context?.metadata?.preferModal === true && visible?.modal?.customId) {
      return {
        type: "modal",
        customId: visible.modal.customId,
        freeInput: "상황을 더 읽고 의도를 드러낸다.",
      };
    }
    const picked = preferred || buttons[0];
    if (!picked) {
      throw new Error("No visible actions for deterministic lane");
    }
    return {
      type: "button",
      customId: picked.customId,
    };
  };
}

function createLane(args, systemPrompt) {
  if (args.lane === "deterministic") {
    return { decisionLane: createDeterministicLane(), laneConfig: { lane: "deterministic" } };
  }
  if (args.lane === "openai") {
    return {
      decisionLane: createOpenAiChatDecisionLane({
        ...(args.model ? { model: args.model } : {}),
        systemPrompt,
        timeoutMs: args.timeoutMs,
      }),
      laneConfig: { lane: "openai", model: args.model || process.env.GAMER_LLM_MODEL || "default" },
    };
  }
  if (args.lane === "openclaw") {
    const resolved = resolveOpenClawDecisionLaneConfig({
      ...(args.provider ? { provider: args.provider } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.openclawHome ? { openclawHome: args.openclawHome } : {}),
      ...(args.agentId ? { agentId: args.agentId } : {}),
      ...(args.agentPath ? { agentPath: args.agentPath } : {}),
      ...(args.agentProfile ? { agentProfile: args.agentProfile } : {}),
    });
    return {
      decisionLane: createOpenClawConfigDecisionLane({
        ...(args.provider ? { provider: args.provider } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(args.openclawHome ? { openclawHome: args.openclawHome } : {}),
        ...(args.agentId ? { agentId: args.agentId } : {}),
        ...(args.agentPath ? { agentPath: args.agentPath } : {}),
        ...(args.agentProfile ? { agentProfile: args.agentProfile } : {}),
        systemPrompt,
        timeoutMs: args.timeoutMs,
      }),
      laneConfig: {
        lane: "openclaw",
        providerId: resolved.providerId,
        modelId: resolved.modelId,
        agentId: resolved.agentId,
        profilePath: resolved.profilePath,
      },
    };
  }
  return {
    decisionLane: createProcessBridgeDecisionLane({
      command: process.execPath,
      args: [
        path.resolve(process.cwd(), "scripts/openclaw-gamer-bridge.mjs"),
        "--bridge-workdir", args.bridgeWorkdir,
        "--bridge-agent-id", args.bridgeAgentId,
        "--bridge-session-id", args.bridgeSessionId,
        "--bridge-openclaw-version", args.bridgeOpenclawVersion,
        "--bridge-wsl-distro", args.bridgeWslDistro,
        "--timeout-ms", String(args.timeoutMs),
      ],
      cwd: process.cwd(),
      timeoutMs: args.timeoutMs + 5000,
    }),
    laneConfig: {
      lane: "bridge",
      bridgeWorkdir: args.bridgeWorkdir,
      bridgeAgentId: args.bridgeAgentId,
      bridgeSessionId: args.bridgeSessionId,
    },
  };
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function toMarkdown(summary, runMeta) {
  const lines = [
    "# Drifter Behavior Divergence Report",
    "",
    `- lane: ${runMeta.lane}`,
    `- timestamp: ${runMeta.timestamp}`,
    `- scenarios: ${runMeta.scenarioIds.join(", ")}`,
    `- personalities: ${runMeta.personalityIds.join(", ")}`,
    `- drifter styles: ${runMeta.drifterStyleIds.join(", ")}`,
    `- richness: ${runMeta.richness.join(", ")}`,
    `- repeats: ${runMeta.repeats}`,
    "",
    "## Verdict",
    "",
    `- ${summary.verdict}`,
    `- actionChangeRate: ${summary.totals.actionChangeRate}`,
    `- lexicalChangeRate: ${summary.totals.lexicalChangeRate}`,
    `- richnessActionSetDistance: ${summary.totals.richnessActionSetDistance}`,
    `- richnessLexicalSetDistance: ${summary.totals.richnessLexicalSetDistance}`,
    "",
    "## By richness",
    "",
  ];

  for (const entry of summary.richnessSummary) {
    lines.push(`### ${entry.richness}`);
    lines.push(`- samples: ${entry.samples}`);
    lines.push(`- uniqueActions: ${entry.uniqueActions}`);
    lines.push(`- uniqueLexicalOutputs: ${entry.uniqueLexicalOutputs}`);
    lines.push(`- actionEntropy: ${entry.actionEntropy}`);
    lines.push(`- lexicalEntropy: ${entry.lexicalEntropy}`);
    lines.push(`- recommendationAcceptanceRate: ${entry.recommendationAcceptanceRate}`);
    lines.push("");
  }

  lines.push("## Pairwise thin→rich changes");
  lines.push("");
  for (const entry of summary.pairwise) {
    lines.push(`- ${entry.scenarioId} / ${entry.personalityId}: actionChanged=${entry.actionChanged} lexicalChanged=${entry.lexicalChanged} | thin=${entry.thinAction} | rich=${entry.richAction}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const scenarios = args.scenarioIds.map(resolveScenario);
  const personalities = args.personalityIds.map(resolvePersonality);
  const drifterStyles = args.drifterStyleIds.map(resolveDrifterStyle);
  const timestamp = nowStamp();
  const runRoot = path.join(args.outDir, `${args.lane}-${timestamp}`);
  await fs.mkdir(runRoot, { recursive: true });

  const systemPrompt = buildDivergenceSystemPrompt({ drifterStyle: drifterStyles[0] });
  const { decisionLane, laneConfig } = createLane(args, systemPrompt);
  if (args.printLaneConfig) {
    process.stdout.write(`${JSON.stringify(laneConfig, null, 2)}\n`);
  }

  const results = [];
  for (const drifterStyle of drifterStyles) {
    for (let repeat = 0; repeat < args.repeats; repeat += 1) {
      for (const scenario of scenarios) {
        for (const personality of personalities) {
          for (const richness of args.richness) {
            const context = buildScenarioDecisionContext({
              scenario,
              personality,
              richness,
              drifterStyle,
              preferModal: true,
            });
            const selection = await decisionLane(context);
            results.push({
              repeat,
              lane: args.lane,
              scenarioId: scenario.id,
              personalityId: personality.id,
              drifterStyleId: drifterStyle.id,
              richness,
              recommendationActionId: scenario.recommendationActionId,
              selection,
              context,
            });
          }
        }
      }
    }
  }

  const summary = summarizeDivergenceResults(results);
  const runMeta = {
    lane: args.lane,
    timestamp,
    scenarioIds: args.scenarioIds,
    personalityIds: args.personalityIds,
    drifterStyleIds: args.drifterStyleIds,
    richness: args.richness,
    repeats: args.repeats,
    laneConfig,
  };

  await fs.writeFile(path.join(runRoot, "results.json"), JSON.stringify({ runMeta, results, summary }, null, 2));
  await fs.writeFile(path.join(runRoot, "report.md"), toMarkdown(summary, runMeta));
  process.stdout.write(`${JSON.stringify({ ok: true, runRoot, summary }, null, 2)}\n`);
}

main().catch((error) => {
  const reason = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`run-drifter-divergence fatal: ${reason}`);
  process.exitCode = 1;
});
