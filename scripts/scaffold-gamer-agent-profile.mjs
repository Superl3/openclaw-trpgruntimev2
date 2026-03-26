#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const PROFILE_FILE = "gamer-smoke.profile.json";

function usage() {
  return [
    "Usage: node ./scripts/scaffold-gamer-agent-profile.mjs --agent-path <dir> [--force] [--stdout]",
    "",
    "Options:",
    "  --agent-path <dir>   Path to OpenClaw agent root directory",
    "  --force              Overwrite existing profile file",
    "  --stdout             Print profile JSON only and do not write",
    "  -h, --help",
  ].join("\n");
}

function readValue(argv, index, flag) {
  const value = String(argv[index + 1] ?? "").trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseArgs(argv) {
  const parsed = {
    agentPath: null,
    force: false,
    stdout: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "-h" || token === "--help") {
      parsed.help = true;
      continue;
    }
    if (token === "--force") {
      parsed.force = true;
      continue;
    }
    if (token === "--stdout") {
      parsed.stdout = true;
      continue;
    }
    if (token === "--agent-path") {
      parsed.agentPath = readValue(argv, i, "--agent-path");
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!parsed.help && !parsed.agentPath) {
    throw new Error("--agent-path is required");
  }

  return parsed;
}

function buildProfile() {
  return {
    profileName: "gamer-smoke",
    version: 1,
    lane: "openclaw",
    description: "Recommended black-box gamer smoke settings for low-variance TRPG action selection.",
    llm: {
      systemPrompt:
        "You are a TRPG player action selector for smoke tests, not a narrator. Choose exactly one visible valid action only. Never hallucinate fields, hidden facts, or unavailable actions. Prefer stable identifiers (customId/actionId/value) over labels. Prefer interesting but progress-safe choices and avoid chaos-only griefing. Return exactly one strict JSON object only (no markdown, no prose): {\"type\":\"button\",\"customId\":\"...\"} OR {\"type\":\"modal\",\"customId\":\"...\",\"freeInput\":\"...\"}.",
      temperature: 0,
      topP: 0.05,
      maxTokens: 180,
      timeoutMs: 12000,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const profile = buildProfile();
  const payload = `${JSON.stringify(profile, null, 2)}\n`;

  if (args.stdout) {
    process.stdout.write(payload);
    return;
  }

  const agentPath = path.resolve(args.agentPath);
  const profilePath = path.join(agentPath, PROFILE_FILE);

  await fs.mkdir(agentPath, { recursive: true });

  try {
    await fs.access(profilePath);
    if (!args.force) {
      throw new Error(`Refusing to overwrite existing profile without --force: ${profilePath}`);
    }
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw error;
    }
  }

  await fs.writeFile(profilePath, payload, "utf8");
  process.stdout.write(`${profilePath}\n`);
}

main().catch((error) => {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`scaffold-gamer-agent-profile failed: ${reason}\n`);
  process.exitCode = 1;
});
