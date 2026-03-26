#!/usr/bin/env node

import process from "node:process";
import { createOpenClawAgentRuntimeDecisionLane } from "../tests/helpers/openclaw-agent-runtime-decision-lane.mjs";

function readValue(argv, index, flag) {
  const value = String(argv[index + 1] ?? "").trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseArgs(argv) {
  const parsed = {
    agentId: null,
    sessionId: null,
    timeoutMs: null,
    wslDistro: null,
    workdir: null,
    openclawVersion: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "-h" || token === "--help") {
      parsed.help = true;
      continue;
    }
    if (token === "--agent-id") {
      parsed.agentId = readValue(argv, i, "--agent-id");
      i += 1;
      continue;
    }
    if (token === "--session-id") {
      parsed.sessionId = readValue(argv, i, "--session-id");
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
    if (token === "--wsl-distro") {
      parsed.wslDistro = readValue(argv, i, "--wsl-distro");
      i += 1;
      continue;
    }
    if (token === "--workdir") {
      parsed.workdir = readValue(argv, i, "--workdir");
      i += 1;
      continue;
    }
    if (token === "--openclaw-version") {
      parsed.openclawVersion = readValue(argv, i, "--openclaw-version");
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return parsed;
}

function usage() {
  return [
    "Usage: node ./scripts/openclaw-agent-runtime-bridge.mjs [options]",
    "",
    "Reads decision context JSON from stdin and prints selection JSON to stdout.",
    "",
    "Options:",
    "  --agent-id <id>",
    "  --session-id <id>",
    "  --timeout-ms <ms>",
    "  --wsl-distro <name>",
    "  --workdir <path>",
    "  --openclaw-version <version>",
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const stdinText = await readStdinText();
  const context = JSON.parse(stdinText);
  const lane = createOpenClawAgentRuntimeDecisionLane({
    ...(args.agentId ? { agentId: args.agentId } : {}),
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
    ...(args.wslDistro ? { wslDistro: args.wslDistro } : {}),
    ...(args.workdir ? { workdir: args.workdir } : {}),
    ...(args.openclawVersion ? { openclawVersion: args.openclawVersion } : {}),
  });
  const selection = await lane(context);
  process.stdout.write(`${JSON.stringify(selection)}\n`);
}

main().catch((error) => {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`openclaw-agent-runtime-bridge failed: ${reason}\n`);
  process.exitCode = 1;
});
