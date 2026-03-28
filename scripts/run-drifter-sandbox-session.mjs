#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  createDrifterSandbox,
  inspectDrifterSandbox,
} from "./lib/drifter-sandbox.mjs";

function readValue(argv, index, flag) {
  const value = String(argv[index + 1] ?? "").trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseArgs(argv) {
  const parsed = {
    repo: process.cwd(),
    world: null,
    sandbox: null,
    parent: null,
    label: null,
    profile: "drifter-live",
    lane: "deterministic",
    scenario: "happy",
    turns: 4,
    improve: "shadow",
    agentPath: null,
    agentProfile: null,
    noWorktree: false,
    ref: null,
    keepSandbox: false,
    help: false,
    passthrough: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "-h" || token === "--help") {
      parsed.help = true;
      continue;
    }
    if (token === "--repo") {
      parsed.repo = readValue(argv, i, "--repo");
      i += 1;
      continue;
    }
    if (token === "--world") {
      parsed.world = readValue(argv, i, "--world");
      i += 1;
      continue;
    }
    if (token === "--sandbox") {
      parsed.sandbox = readValue(argv, i, "--sandbox");
      i += 1;
      continue;
    }
    if (token === "--parent") {
      parsed.parent = readValue(argv, i, "--parent");
      i += 1;
      continue;
    }
    if (token === "--label") {
      parsed.label = readValue(argv, i, "--label");
      i += 1;
      continue;
    }
    if (token === "--profile") {
      parsed.profile = readValue(argv, i, "--profile");
      i += 1;
      continue;
    }
    if (token === "--lane") {
      parsed.lane = readValue(argv, i, "--lane");
      i += 1;
      continue;
    }
    if (token === "--scenario") {
      parsed.scenario = readValue(argv, i, "--scenario");
      i += 1;
      continue;
    }
    if (token === "--turns") {
      parsed.turns = Number.parseInt(readValue(argv, i, "--turns"), 10);
      i += 1;
      continue;
    }
    if (token === "--improve") {
      parsed.improve = readValue(argv, i, "--improve");
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
    if (token === "--ref") {
      parsed.ref = readValue(argv, i, "--ref");
      i += 1;
      continue;
    }
    if (token === "--no-worktree") {
      parsed.noWorktree = true;
      continue;
    }
    if (token === "--keep-sandbox") {
      parsed.keepSandbox = true;
      continue;
    }
    if (token === "--") {
      parsed.passthrough = argv.slice(i + 1);
      break;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return parsed;
}

function usage() {
  return [
    "Usage: node ./scripts/run-drifter-sandbox-session.mjs [options] [-- <extra run-gamer-smoke-live args>]",
    "",
    "Creates or reuses a drifter sandbox, then runs a live gamer/drifter session against sandbox-local world + output paths.",
    "",
    "Options:",
    "  --repo <path>            Source trpg-runtime-v2 repo (default: cwd)",
    "  --world <path>           Canonical world root to copy into sandbox",
    "  --sandbox <path>         Reuse an existing sandbox instead of creating one",
    "  --parent <path>          Sandbox parent dir when creating",
    "  --label <name>           Sandbox label when creating",
    "  --profile <name>         Session profile label recorded in sandbox metadata",
    "  --lane <name>            run-gamer-smoke-live lane (default: deterministic)",
    "  --scenario <list>        Comma-separated scenarios (default: happy)",
    "  --turns <n>              Turns per scenario (default: 4)",
    "  --improve <mode>         off|shadow|auto (default: shadow)",
    "  --agent-path <path>      External OpenClaw agent dir for openclaw/bridge lanes",
    "  --agent-profile <path>   Explicit profile path (default: sandbox session profile)",
    "  --ref <git-ref>          Detached ref for sandbox worktree",
    "  --no-worktree            Create sandbox without git worktree",
    "  --keep-sandbox           Keep sandbox after failures/success for inspection",
    "  -h, --help",
  ].join("\n");
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureSandbox(args) {
  if (args.sandbox) {
    return inspectDrifterSandbox({ sandboxRoot: path.resolve(args.sandbox) });
  }

  return createDrifterSandbox({
    sourceRepoRoot: path.resolve(args.repo),
    worldSourceRoot: args.world ? path.resolve(args.world) : null,
    sandboxParentRoot: args.parent ? path.resolve(args.parent) : undefined,
    label: args.label || `drifter-${args.lane}`,
    sessionProfile: args.profile,
    createWorktree: args.noWorktree ? false : true,
    headRef: args.ref ? args.ref : undefined,
  });
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: "pipe",
    env: options.env || process.env,
  });
}

async function scaffoldDefaultProfile(profilePath) {
  const profile = {
    profileName: "drifter-sandbox-live",
    version: 1,
    lane: "openclaw",
    description: "Sandbox-local drifter session profile for live smoke/session runs.",
    llm: {
      systemPrompt:
        "You are a TRPG player action selector for a sandboxed drifter session. Choose exactly one visible valid action only. Prefer stable identifiers over labels. Return exactly one strict JSON object only.",
      temperature: 0,
      topP: 0.05,
      maxTokens: 180,
      timeoutMs: 12000,
    },
  };
  await writeJson(profilePath, profile);
  return profilePath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const manifest = await ensureSandbox(args);
  const sandboxRoot = path.resolve(manifest.layout.sandboxRoot);
  const runWorkdir = manifest.worktree?.path ? path.resolve(manifest.worktree.path) : path.resolve(manifest.source.repoRoot);
  const worldRoot = path.resolve(manifest.layout.worldBaseRoot);
  const reportsRoot = path.resolve(manifest.layout.reportsRoot);
  const transcriptsRoot = path.resolve(manifest.layout.sessionRoot, "transcripts");
  const artifactsRoot = path.resolve(manifest.layout.artifactsRoot);
  const launchStatePath = path.resolve(manifest.layout.sessionRoot, "launch-result.json");
  const defaultAgentProfilePath = path.resolve(manifest.layout.sessionRoot, "drifter-sandbox.profile.json");
  const agentProfilePath = args.agentProfile ? path.resolve(args.agentProfile) : defaultAgentProfilePath;

  if (!(await pathExists(agentProfilePath))) {
    await scaffoldDefaultProfile(agentProfilePath);
  }

  const runArgs = [
    path.resolve(runWorkdir, "scripts", "run-gamer-smoke-live.mjs"),
    "--lane", args.lane,
    "--scenario", args.scenario,
    "--turns", String(args.turns),
    "--world-root", worldRoot,
    "--preserve-world-root",
    "--transcript-dir", transcriptsRoot,
    "--transcript-prefix", "drifter-session",
    "--improve", args.improve,
    "--improve-report-dir", reportsRoot,
    "--improve-report-prefix", "drifter-session",
    "--agent-profile", agentProfilePath,
  ];

  if (args.agentPath) {
    runArgs.push("--agent-path", path.resolve(args.agentPath));
  }
  runArgs.push(...args.passthrough);

  const result = run(process.execPath, runArgs, { cwd: runWorkdir });

  await fs.mkdir(artifactsRoot, { recursive: true });
  const stdoutPath = path.resolve(artifactsRoot, "run-gamer-smoke-live.stdout.log");
  const stderrPath = path.resolve(artifactsRoot, "run-gamer-smoke-live.stderr.log");
  await fs.writeFile(stdoutPath, result.stdout || "", "utf8");
  await fs.writeFile(stderrPath, result.stderr || "", "utf8");

  const launchSummary = {
    ok: result.status === 0,
    exitCode: result.status,
    signal: result.signal || null,
    launchedAt: new Date().toISOString(),
    sandboxRoot,
    runWorkdir,
    worldRoot,
    reportsRoot,
    transcriptsRoot,
    artifactsRoot,
    stdoutPath,
    stderrPath,
    agentProfilePath,
    command: [process.execPath, ...runArgs],
  };
  await writeJson(launchStatePath, launchSummary);

  process.stdout.write(`${JSON.stringify({ ok: launchSummary.ok, manifest, launchSummary }, null, 2)}\n`);
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || "drifter sandbox session failed\n");
    process.exitCode = result.status || 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`run-drifter-sandbox-session failed: ${message}\n`);
  process.exitCode = 1;
});
