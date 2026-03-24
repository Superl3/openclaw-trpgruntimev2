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
  const questEconomy = await importFromOut("src/runtime-core/quest-economy.js");
  const panel = await importFromOut("src/runtime-core/panel-mvp.js");
  const runtimeEngine = await importFromOut("src/runtime-core/runtime-engine.js");
  const noopLane = await importFromOut("src/runtime-core/noop-lane.js");
  const pluginModule = await importFromOut("index.js");
  return {
    analyzer,
    sceneLoop,
    questEconomy,
    panel,
    runtimeEngine,
    noopLane,
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

function createMemoryStore() {
  const sessions = new Map();
  const routes = new Map();
  const routeKey = (key) => `${key.sessionId}:${key.uiVersion}:${key.sceneId}:${key.actionId}`;

  return {
    async readSession(sessionId) {
      return sessions.get(sessionId) ?? null;
    },
    async readActiveSessionByChannel(channelKey) {
      for (const session of sessions.values()) {
        if (session.channelKey === channelKey && session.status === "active") {
          return session;
        }
      }
      return null;
    },
    async upsertSession(session) {
      sessions.set(session.sessionId, session);
    },
    async upsertInteractionRoute(route) {
      routes.set(routeKey(route), route);
    },
    async readInteractionRoute(key) {
      return routes.get(routeKey(key)) ?? null;
    },
    async consumeInteractionRoute(key, consumedAt) {
      const current = routes.get(routeKey(key));
      if (!current) {
        return null;
      }
      const consumed = {
        ...current,
        consumedAt,
      };
      routes.set(routeKey(key), consumed);
      return consumed;
    },
    async deleteRoutesForSession(sessionId) {
      let removed = 0;
      for (const [key] of routes.entries()) {
        if (key.startsWith(`${sessionId}:`)) {
          routes.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
    async listRoutesForSession(sessionId, uiVersion) {
      const listed = [];
      for (const route of routes.values()) {
        if (route.sessionId !== sessionId) {
          continue;
        }
        if (typeof uiVersion === "number" && route.uiVersion !== uiVersion) {
          continue;
        }
        listed.push(route);
      }
      return listed;
    },
  };
}

function makeHookReadySession(sceneLoopModule, questEconomyModule, nowIso, urgency = 72) {
  const loop = sceneLoopModule.createInitialDeterministicSceneLoop({
    sceneId: "scene-hook-runtime",
    nowIso,
  });
  loop.scene.locationId = "loc-hook-runtime";

  const economy = questEconomyModule.ensureQuestEconomyState(undefined, nowIso);
  const pressure = economy.worldPressures[0];
  economy.quests = [
    {
      questId: "quest-hook-runtime-001",
      pressureId: pressure.pressureId,
      archetype: pressure.archetype,
      lifecycle: "surfaced",
      locationId: "loc-hook-runtime",
      urgency,
      progress: 0,
      surfacedAtIso: nowIso,
      startedAtIso: null,
      deadlineAtIso: null,
      expiresAtIso: "2026-03-24T00:30:00.000Z",
      lastAdvancedAtIso: nowIso,
      parentQuestId: null,
      successorQuestId: null,
      terminalReason: null,
      cost: { world: 2, attention: 2, narrative: 1 },
      hookType: "witness",
      mutationCount: 0,
      lastMutationAtIso: null,
      stallCount: 0,
    },
  ];
  loop.questEconomy = economy;

  const session = makeSession(sceneLoopModule, nowIso);
  session.sceneId = loop.scene.sceneId;
  session.deterministicLoop = loop;
  session.panels.fixed.sceneId = loop.scene.sceneId;
  session.panels.main.sceneId = loop.scene.sceneId;
  session.panels.sub.sceneId = loop.scene.sceneId;
  return session;
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
  assert.equal(normalText.includes("debug.quest_tuning.raw"), false);
  assert.equal(debugText.includes("debug.quest_tuning.raw"), true);
});

test("hook lane renderer error falls back without breaking action resolution", async () => {
  const { analyzer, noopLane, questEconomy, runtimeEngine, sceneLoop } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";
  const session = makeHookReadySession(sceneLoop, questEconomy, nowIso, 80);

  const engine = runtimeEngine.createCheckpoint0RuntimeEngine({
    store: createMemoryStore(),
    intentAnalyzer: new analyzer.RuleBasedIntentAnalyzer(),
    personaDriftAnalyzer: new analyzer.RuleBasedPersonaDriftAnalyzer(),
    sceneRenderer: new noopLane.NoopSceneRenderer(),
    questHookTextRenderer: {
      render: async () => {
        throw new Error("hook renderer failure");
      },
    },
    richHookTextEnabled: true,
    hookTextTimeoutMs: 200,
    hookTextCacheTtlSec: 300,
  });

  const processed = await engine.processSceneAction({
    session,
    routeActionId: "action.wait",
  });

  assert.ok(processed.session);
  const hookTrace = processed.session.trace.events.find((entry) => entry.type === "engine.quest.hook_text");
  assert.ok(hookTrace);
  assert.equal(hookTrace.data.generationAttempted, true);
  assert.equal(hookTrace.data.result, "fallback");
  assert.equal(hookTrace.data.reason, "renderer_error");
});

test("hook lane timeout falls back immediately with deterministic panel output", async () => {
  const { analyzer, noopLane, panel, questEconomy, runtimeEngine, sceneLoop } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";
  const session = makeHookReadySession(sceneLoop, questEconomy, nowIso, 78);

  const engine = runtimeEngine.createCheckpoint0RuntimeEngine({
    store: createMemoryStore(),
    intentAnalyzer: new analyzer.RuleBasedIntentAnalyzer(),
    personaDriftAnalyzer: new analyzer.RuleBasedPersonaDriftAnalyzer(),
    sceneRenderer: new noopLane.NoopSceneRenderer(),
    questHookTextRenderer: {
      render: async () => new Promise(() => {}),
    },
    richHookTextEnabled: true,
    hookTextTimeoutMs: 80,
    hookTextCacheTtlSec: 300,
  });

  const processed = await engine.processSceneAction({
    session,
    routeActionId: "action.wait",
  });

  const hookTrace = processed.session.trace.events.find((entry) => entry.type === "engine.quest.hook_text");
  assert.ok(hookTrace);
  assert.equal(hookTrace.data.result, "fallback");
  assert.equal(hookTrace.data.reason, "renderer_timeout");

  const panelOut = panel.buildCheckpoint1Panel({
    session: processed.session,
    routes: [],
    mode: "send",
  });
  const panelText = JSON.stringify(panelOut.components);
  assert.ok(panelText.includes("활성 과제:") || panelText.includes("접촉 기회:"));
});

test("hook text cache hit skips regeneration on next action", async () => {
  const { analyzer, noopLane, questEconomy, runtimeEngine, sceneLoop } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";
  const session = makeHookReadySession(sceneLoop, questEconomy, nowIso, 90);

  let renderCallCount = 0;
  const engine = runtimeEngine.createCheckpoint0RuntimeEngine({
    store: createMemoryStore(),
    intentAnalyzer: new analyzer.RuleBasedIntentAnalyzer(),
    personaDriftAnalyzer: new analyzer.RuleBasedPersonaDriftAnalyzer(),
    sceneRenderer: new noopLane.NoopSceneRenderer(),
    questHookTextRenderer: {
      render: async (input) => {
        renderCallCount += 1;
        return {
          contractVersion: 1,
          overrides: input.slots.map((slot) => ({
            slotKey: slot.slotKey,
            shortText: "짧은 후크",
          })),
        };
      },
    },
    richHookTextEnabled: true,
    hookTextTimeoutMs: 120,
    hookTextCacheTtlSec: 600,
  });

  const first = await engine.processSceneAction({
    session,
    routeActionId: "action.wait",
  });
  const firstSlot = first.session.deterministicLoop.questEconomy.presentation.hookSlots[0];
  const firstWorldPulseSlot = first.session.deterministicLoop.questEconomy.presentation.worldPulseSlot;
  assert.ok(firstSlot?.llmShortText || firstWorldPulseSlot?.llmShortText);
  assert.equal(renderCallCount, 1);

  const second = await engine.processSceneAction({
    session: first.session,
    routeActionId: "action.wait",
  });
  assert.equal(renderCallCount, 1);
  const secondHookTrace = second.session.trace.events
    .filter((entry) => entry.type === "engine.quest.hook_text")
    .at(-1);
  assert.ok(secondHookTrace);
  assert.equal(secondHookTrace.data.reason, "cache_hit_only");
});

test("worldPulse slotType override applies through shared hook lane", async () => {
  const { analyzer, noopLane, questEconomy, runtimeEngine, sceneLoop } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";
  const session = makeHookReadySession(sceneLoop, questEconomy, nowIso, 88);

  let seenWorldPulseInput = false;
  const engine = runtimeEngine.createCheckpoint0RuntimeEngine({
    store: createMemoryStore(),
    intentAnalyzer: new analyzer.RuleBasedIntentAnalyzer(),
    personaDriftAnalyzer: new analyzer.RuleBasedPersonaDriftAnalyzer(),
    sceneRenderer: new noopLane.NoopSceneRenderer(),
    questHookTextRenderer: {
      render: async (input) => {
        const worldPulseSlot = input.slots.find((slot) => slot.slotType === "worldPulse");
        seenWorldPulseInput = Boolean(worldPulseSlot);
        return {
          contractVersion: 1,
          overrides: worldPulseSlot
            ? [
                {
                  slotKey: worldPulseSlot.slotKey,
                  shortText: "도시의 압력이 다시 꿈틀거린다.",
                },
              ]
            : [],
        };
      },
    },
    richHookTextEnabled: true,
    hookTextTimeoutMs: 150,
    hookTextCacheTtlSec: 600,
  });

  const processed = await engine.processSceneAction({
    session,
    routeActionId: "action.wait",
  });

  assert.equal(seenWorldPulseInput, true);
  const worldPulseSlot = processed.session.deterministicLoop.questEconomy.presentation.worldPulseSlot;
  assert.ok(worldPulseSlot?.llmShortText);
  const hookTrace = processed.session.trace.events.find((entry) => entry.type === "engine.quest.hook_text");
  assert.ok(hookTrace);
  const slotMetaText = JSON.stringify(hookTrace.data.slotMeta);
  assert.equal(slotMetaText.includes("worldPulse"), true);
});

test("deterministic quest lifecycle and budgets remain identical with hook lane on or off", async () => {
  const { analyzer, noopLane, questEconomy, runtimeEngine, sceneLoop } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";
  const baseSession = makeHookReadySession(sceneLoop, questEconomy, nowIso, 85);
  const actions = ["action.wait", "action.observe", "action.wait", "action.move"];

  const engineOff = runtimeEngine.createCheckpoint0RuntimeEngine({
    store: createMemoryStore(),
    intentAnalyzer: new analyzer.RuleBasedIntentAnalyzer(),
    personaDriftAnalyzer: new analyzer.RuleBasedPersonaDriftAnalyzer(),
    sceneRenderer: new noopLane.NoopSceneRenderer(),
    richHookTextEnabled: false,
  });

  const engineOn = runtimeEngine.createCheckpoint0RuntimeEngine({
    store: createMemoryStore(),
    intentAnalyzer: new analyzer.RuleBasedIntentAnalyzer(),
    personaDriftAnalyzer: new analyzer.RuleBasedPersonaDriftAnalyzer(),
    sceneRenderer: new noopLane.NoopSceneRenderer(),
    questHookTextRenderer: {
      render: async (input) => ({
        contractVersion: 1,
        overrides: input.slots.map((slot) => ({ slotKey: slot.slotKey, shortText: "짧은 후크" })).slice(0, 1),
      }),
    },
    richHookTextEnabled: true,
    hookTextTimeoutMs: 120,
    hookTextCacheTtlSec: 600,
  });

  const run = async (engine, seedSession) => {
    let current = seedSession;
    for (const actionId of actions) {
      const processed = await engine.processSceneAction({
        session: current,
        routeActionId: actionId,
      });
      current = processed.session;
    }
    return current.deterministicLoop.questEconomy;
  };

  const offEconomy = await run(engineOff, structuredClone(baseSession));
  const onEconomy = await run(engineOn, structuredClone(baseSession));

  const projectDeterministic = (economy) => ({
    version: economy.version,
    worldPressures: economy.worldPressures,
    quests: economy.quests,
    budget: economy.budget,
    softQuota: economy.softQuota,
    nextQuestSeq: economy.nextQuestSeq,
  });

  assert.deepEqual(projectDeterministic(onEconomy), projectDeterministic(offEconomy));
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
