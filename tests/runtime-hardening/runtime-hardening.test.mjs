import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ROOT_DIR = process.cwd();
const OUT_DIR = path.resolve(ROOT_DIR, ".tmp-test-dist-hardening");

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

async function loadModules() {
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  run(process.execPath, ["./node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--noEmit", "false", "--outDir", OUT_DIR]);

  const importFromOut = async (relativePath) => {
    const fileUrl = pathToFileURL(path.resolve(OUT_DIR, relativePath)).href;
    return import(fileUrl);
  };

  const analyzer = await importFromOut("src/runtime-core/analyzer-lane.js");
  const sceneLoop = await importFromOut("src/runtime-core/scene-loop.js");
  const panel = await importFromOut("src/runtime-core/panel-mvp.js");
  const pluginModule = await importFromOut("index.js");
  return {
    analyzer,
    sceneLoop,
    panel,
    plugin: pluginModule.default,
  };
}

function makeSession(sceneLoopModule, nowIso) {
  const deterministicLoop = sceneLoopModule.createInitialDeterministicSceneLoop({
    sceneId: "scene-001",
    nowIso,
  });

  return {
    schemaVersion: 1,
    sessionId: "sess-test",
    channelKey: "channel:test",
    ownerId: "owner-1",
    status: "active",
    sceneId: deterministicLoop.scene.sceneId,
    uiVersion: 1,
    actionSeq: 0,
    turnIndex: 0,
    lastActionId: null,
    lastActionSummary: null,
    deterministicLoop,
    panelDispatch: {
      pending: null,
      committedDispatchIds: [],
    },
    trace: {
      maxEvents: 120,
      events: [],
    },
    panels: {
      fixed: {
        panelId: "fixed",
        uiVersion: 1,
        sceneId: deterministicLoop.scene.sceneId,
        messageId: null,
        channelMessageRef: null,
        lastRenderedAt: null,
      },
      main: {
        panelId: "main",
        uiVersion: 1,
        sceneId: deterministicLoop.scene.sceneId,
        messageId: null,
        channelMessageRef: null,
        lastRenderedAt: null,
      },
      sub: {
        panelId: "sub",
        uiVersion: 1,
        sceneId: deterministicLoop.scene.sceneId,
        messageId: null,
        channelMessageRef: null,
        lastRenderedAt: null,
      },
    },
    createdAt: nowIso,
    updatedAt: nowIso,
    endedAt: null,
  };
}

const modulesPromise = loadModules();

test("low confidence analyzer keeps conservative fallback", async () => {
  const { analyzer } = await modulesPromise;
  const selected = analyzer.selectStructuredActionIntent({
    deterministicActionId: "action.unknown",
    availableActions: ["action.observe", "action.wait", "action.rush"],
    analyzerOutput: {
      contractVersion: 1,
      intent: "action",
      confidence: 0.2,
      normalizedText: "rush now",
      extractedSignals: ["rush"],
      candidateActions: [{ actionId: "action.rush", score: 1 }],
      riskSignals: ["risk:rush"],
      preResolvedClaim: false,
    },
    inertia: {
      lastMappedActionId: "action.wait",
      streakCount: 2,
      smoothedConfidence: 0.6,
      lastSource: "deterministic",
    },
  });

  assert.equal(selected.actionId, "action.wait");
  assert.equal(selected.fallbackStrategy, "keep_previous");
  assert.equal(selected.source, "deterministic");
});

test("preResolvedClaim is warning-only and capped", async () => {
  const { analyzer } = await modulesPromise;
  const selected = analyzer.selectStructuredActionIntent({
    deterministicActionId: "action.observe",
    availableActions: ["action.observe", "action.rush"],
    analyzerOutput: {
      contractVersion: 1,
      intent: "action",
      confidence: 0.95,
      normalizedText: "already done",
      extractedSignals: ["already", "done"],
      candidateActions: [{ actionId: "action.rush", score: 1 }],
      riskSignals: [],
      preResolvedClaim: true,
    },
    inertia: {
      lastMappedActionId: "action.observe",
      streakCount: 1,
      smoothedConfidence: 0.5,
      lastSource: "deterministic",
    },
  });

  assert.equal(selected.preResolvedClaimUntrusted, true);
  assert.ok(selected.analyzerWeight <= 0.15);
});

test("expired analyzer memory is cleared and deterministic loop continues", async () => {
  const { sceneLoop } = await modulesPromise;
  const nowIso = new Date().toISOString();
  const loop = sceneLoop.createInitialDeterministicSceneLoop({
    sceneId: "scene-001",
    nowIso,
  });

  loop.analyzerMemory.recentFreeInputs = ["dummy"];
  loop.analyzerMemory.recentResolvedActions = ["action.observe"];
  loop.analyzerMemory.recentClassifications = ["possible"];
  loop.analyzerMemory.lastIntentSignals = ["signal"];
  loop.analyzerMemory.expiresAtIso = new Date(Date.now() - 60_000).toISOString();

  const normalized = sceneLoop.ensureDeterministicSceneLoopState(loop, {
    sceneId: "scene-001",
    nowIso,
  });

  assert.deepEqual(normalized.analyzerMemory.recentFreeInputs, []);

  const resolved = sceneLoop.resolveDeterministicSceneAction({
    loop: normalized,
    routeActionId: "action.observe",
    nowIso,
  });

  assert.equal(resolved.classification, "possible");
});

test("default panel hides raw drift and debug panel shows raw drift", async () => {
  const { panel, sceneLoop } = await modulesPromise;
  const nowIso = new Date().toISOString();
  const session = makeSession(sceneLoop, nowIso);

  const normal = panel.buildCheckpoint1Panel({
    session,
    routes: [],
    mode: "send",
  });
  const debug = panel.buildCheckpoint1Panel({
    session,
    routes: [],
    mode: "send",
    debugRuntimeSignals: true,
  });

  const normalText = JSON.stringify(normal.components);
  const debugText = JSON.stringify(debug.components);

  assert.equal(normalText.includes("debug.behavioral_drift.raw"), false);
  assert.equal(debugText.includes("debug.behavioral_drift.raw"), true);
});

test("dispatch commit idempotent and stale interaction gives standardized error", async () => {
  const { plugin } = await modulesPromise;
  const worldRoot = "/tmp/trpg-runtime-v2-hardening-test-world";
  await fs.rm(worldRoot, { recursive: true, force: true });
  await fs.mkdir(path.resolve(worldRoot, "state/runtime-core"), { recursive: true });

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

  const newTool = tools.get("trpg_session_new");
  const commitTool = tools.get("trpg_panel_message_commit");
  const resumeTool = tools.get("trpg_session_resume");
  const interactTool = tools.get("trpg_panel_interact");
  assert.ok(newTool && commitTool && resumeTool && interactTool);

  const parse = (result) => JSON.parse(result.content[0].text);

  const created = parse(await newTool.execute("new", { channelKey: "discord:room-1", ownerId: "owner-1" }));
  const sessionId = created.session.sessionId;
  const dispatchId = created.panelDispatch.dispatchId;
  const actionBlock = created.panelDispatch.components.blocks.find((entry) => entry.type === "actions");
  const firstCustomId = actionBlock.buttons[0].customId;

  const committed = parse(
    await commitTool.execute("commit-1", {
      sessionId,
      actorId: "owner-1",
      dispatchId,
      messageId: "msg-9001",
      uiVersion: created.session.uiVersion,
      sceneId: created.session.sceneId,
    }),
  );
  assert.equal(committed.ok, true);

  const duplicate = parse(
    await commitTool.execute("commit-2", {
      sessionId,
      actorId: "owner-1",
      dispatchId,
      messageId: "msg-9001",
      uiVersion: created.session.uiVersion,
      sceneId: created.session.sceneId,
    }),
  );
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.idempotent, true);

  await resumeTool.execute("resume", { sessionId, actorId: "owner-1" });
  const stale = parse(await interactTool.execute("stale", { customId: firstCustomId, actorId: "owner-1" }));

  assert.equal(stale.ok, false);
  assert.ok(typeof stale.errorCode === "string");
  assert.ok(stale.errorCode === "route_expired" || stale.errorCode === "stale_ui_version");
  assert.ok(typeof stale.recoveryHint === "string");
});
