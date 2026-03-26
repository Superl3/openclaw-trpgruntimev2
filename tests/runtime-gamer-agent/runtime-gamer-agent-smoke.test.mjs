import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { BlackboxGamerAgent, isStaleInteractionError } from "../helpers/blackbox-gamer-agent.mjs";
import { createOpenAiChatDecisionLane } from "../helpers/llm-gamer-decision-lane.mjs";

const ROOT_DIR = process.cwd();
const OUT_DIR = path.resolve(ROOT_DIR, ".tmp-test-dist-gamer-agent");
const TRACE_ENABLED = process.env.GAMER_TRACE === "1";

function createTraceLogger(label) {
  const write = (level, payload) => {
    if (!TRACE_ENABLED) {
      return;
    }
    const event = payload?.event || "event";
    const turn = Number.isFinite(payload?.turn) ? ` turn=${payload.turn}` : "";
    const ok = payload && Object.prototype.hasOwnProperty.call(payload, "ok") ? ` ok=${payload.ok}` : "";
    const suffix = payload?.selectionType ? ` selection=${payload.selectionType}` : "";
    console.log(`[${label}] ${level} ${event}${turn}${ok}${suffix}`);
  };
  return {
    info: (payload) => write("info", payload),
    warn: (payload) => write("warn", payload),
    debug: (payload) => write("debug", payload),
  };
}

function traceTurnSummary(label, turn, played) {
  if (!TRACE_ENABLED) {
    return;
  }
  const selectionType = played?.selection?.type || "unknown";
  const customId = played?.selection?.customId || "n/a";
  const ok = played?.result?.ok === true;
  const errorCode = played?.result?.errorCode || "none";
  console.log(`[${label}] turn=${turn} selection=${selectionType} customId=${customId} ok=${ok} error=${errorCode}`);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
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
    registerTool: (factory, options) => {
      tools.set(options.name, factory({ agentId: "trpg", sessionId: "discord-channel", userId: "owner-1" }));
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

const pluginPromise = loadPlugin();

test("black-box gamer agent plays multi-turn happy path via action buttons", async (t) => {
  const plugin = await pluginPromise;
  const worldRoot = await createIsolatedWorldRoot("trpg-runtime-v2-gamer-agent-happy");
  t.after(async () => {
    await fs.rm(worldRoot, { recursive: true, force: true });
  });

  const tools = createToolMap(plugin, worldRoot);
  const agent = new BlackboxGamerAgent({
    tools,
    ownerId: "owner-1",
    channelKey: "discord:gamer-happy",
    logger: createTraceLogger("happy"),
    traceLabel: "happy",
  });

  const started = await agent.startSession();
  assert.equal(started.ok, true);

  for (let turn = 0; turn < 4; turn += 1) {
    const played = await agent.playTurn();
    traceTurnSummary("happy", turn + 1, played);
    assert.equal(played.result.ok, true, JSON.stringify(played.result));
    assert.equal(played.selection.type, "button");
    const turnCommit = await agent.commitDispatch();
    assert.equal(turnCommit.ok, true);
  }
});

test("black-box gamer agent supports modal submit path with freeInput fallback", async (t) => {
  const plugin = await pluginPromise;
  const worldRoot = await createIsolatedWorldRoot("trpg-runtime-v2-gamer-agent-modal");
  t.after(async () => {
    await fs.rm(worldRoot, { recursive: true, force: true });
  });

  const tools = createToolMap(plugin, worldRoot);
  const agent = new BlackboxGamerAgent({
    tools,
    ownerId: "owner-1",
    channelKey: "discord:gamer-modal",
    defaultFreeInput: "강행 돌파한다",
    logger: createTraceLogger("modal"),
    traceLabel: "modal",
  });

  const started = await agent.startSession();
  assert.equal(started.ok, true);

  const played = await agent.playTurn({
    preferModal: true,
  });
  traceTurnSummary("modal", 1, played);
  assert.equal(played.result.ok, true, JSON.stringify(played.result));
  assert.equal(played.selection.type, "modal");
  assert.equal(played.selection.freeInput, "강행 돌파한다");
  assert.equal(typeof played.result?.consumedRoute?.actionId, "string");
});

test("black-box gamer agent recovers from stale customId via resume and continues", async (t) => {
  const plugin = await pluginPromise;
  const worldRoot = await createIsolatedWorldRoot("trpg-runtime-v2-gamer-agent-stale");
  t.after(async () => {
    await fs.rm(worldRoot, { recursive: true, force: true });
  });

  const tools = createToolMap(plugin, worldRoot);
  const agent = new BlackboxGamerAgent({
    tools,
    ownerId: "owner-1",
    channelKey: "discord:gamer-stale",
    logger: createTraceLogger("stale"),
    traceLabel: "stale",
  });

  const started = await agent.startSession();
  assert.equal(started.ok, true);

  const firstSelection = agent.pickNextAction();
  assert.equal(firstSelection.type, "button");

  const firstInteraction = await agent.interact(firstSelection);
  assert.equal(firstInteraction.ok, true);
  await agent.commitDispatch();

  const staleInteraction = await agent.interact(firstSelection);
  assert.equal(staleInteraction.ok, false);
  assert.equal(isStaleInteractionError(staleInteraction), true);

  const resumed = await agent.recoverFromStaleOrExpiredRoute(staleInteraction);
  assert.equal(resumed.ok, true);

  const continued = await agent.playTurn();
  traceTurnSummary("stale", 1, continued);
  assert.equal(continued.result.ok, true, JSON.stringify(continued.result));
});

test("black-box gamer agent optionally exercises OpenAI decision lane", async (t) => {
  const hasApiKey = typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.length > 0;
  const explicitSmoke = process.env.GAMER_LLM_SMOKE === "1";
  if (!hasApiKey && !explicitSmoke) {
    t.skip("Set OPENAI_API_KEY (or GAMER_LLM_SMOKE=1 with OPENAI_API_KEY) to run LLM smoke");
    return;
  }
  if (!hasApiKey) {
    t.skip("OPENAI_API_KEY is required for LLM smoke");
    return;
  }

  const plugin = await pluginPromise;
  const worldRoot = await createIsolatedWorldRoot("trpg-runtime-v2-gamer-agent-llm");
  t.after(async () => {
    await fs.rm(worldRoot, { recursive: true, force: true });
  });

  const tools = createToolMap(plugin, worldRoot);
  const decisionLane = createOpenAiChatDecisionLane();
  const agent = new BlackboxGamerAgent({
    tools,
    ownerId: "owner-1",
    channelKey: "discord:gamer-llm",
    decisionLane,
    logger: createTraceLogger("llm"),
    traceLabel: "llm",
  });

  const started = await agent.startSession();
  assert.equal(started.ok, true);

  for (let turn = 0; turn < 3; turn += 1) {
    const played = await agent.playTurn();
    traceTurnSummary("llm", turn + 1, played);
    assert.equal(played.result.ok, true, JSON.stringify(played.result));
    assert.ok(["button", "modal"].includes(played.selection.type));
    const turnCommit = await agent.commitDispatch();
    assert.equal(turnCommit.ok, true);
  }
});
