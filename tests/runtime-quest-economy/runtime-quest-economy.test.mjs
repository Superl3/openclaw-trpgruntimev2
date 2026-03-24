import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ROOT_DIR = process.cwd();
const OUT_DIR = path.resolve(ROOT_DIR, ".tmp-test-dist-quest-economy");

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

  const sceneLoop = await importFromOut("src/runtime-core/scene-loop.js");
  const questEconomy = await importFromOut("src/runtime-core/quest-economy.js");
  const pluginModule = await importFromOut("index.js");

  return {
    sceneLoop,
    questEconomy,
    plugin: pluginModule.default,
  };
}

function isLiveQuest(lifecycle) {
  return lifecycle === "seed" || lifecycle === "surfaced" || lifecycle === "active" || lifecycle === "stalled";
}

const modulesPromise = loadModules();

test("long-run loop keeps live quest pool within hard cap", async () => {
  const { sceneLoop } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";
  let loop = sceneLoop.createInitialDeterministicSceneLoop({
    sceneId: "scene-quest-cap",
    nowIso,
  });
  loop.scene.locationId = "loc-cap";

  const actions = ["action.rush", "action.observe", "action.wait", "action.move", "action.wait"];
  for (let index = 0; index < 90; index += 1) {
    const resolved = sceneLoop.resolveDeterministicSceneAction({
      loop,
      routeActionId: actions[index % actions.length],
      nowIso,
    });
    loop = resolved.nextLoop;
  }

  const liveCount = loop.questEconomy.quests.filter((entry) => isLiveQuest(entry.lifecycle)).length;
  assert.ok(liveCount <= loop.questEconomy.budget.caps.livePool);
});

test("surfaced but not started quest naturally expires to deleted with reason", async () => {
  const { sceneLoop, questEconomy } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";

  let loop = sceneLoop.createInitialDeterministicSceneLoop({
    sceneId: "scene-quest-expire",
    nowIso,
  });
  loop.scene.locationId = "loc-expire";

  const economy = questEconomy.ensureQuestEconomyState(undefined, nowIso);
  const pressureId = economy.worldPressures[0].pressureId;
  economy.quests = [
    {
      questId: "quest-expire-001",
      pressureId,
      archetype: economy.worldPressures[0].archetype,
      lifecycle: "surfaced",
      locationId: "loc-expire",
      urgency: 70,
      progress: 0,
      surfacedAtIso: "2026-03-23T20:00:00.000Z",
      startedAtIso: null,
      deadlineAtIso: null,
      expiresAtIso: "2026-03-23T20:30:00.000Z",
      lastAdvancedAtIso: "2026-03-23T20:00:00.000Z",
      parentQuestId: null,
      successorQuestId: null,
      terminalReason: null,
      cost: { world: 2, attention: 2, narrative: 1 },
      hookType: "incident",
      mutationCount: 0,
      lastMutationAtIso: null,
      stallCount: 0,
    },
  ];
  loop.questEconomy = economy;

  const resolved = sceneLoop.resolveDeterministicSceneAction({
    loop,
    routeActionId: "action.wait",
    nowIso,
  });

  const quest = resolved.nextLoop.questEconomy.quests.find((entry) => entry.questId === "quest-expire-001");
  assert.ok(quest);
  assert.equal(quest.lifecycle, "deleted");
  assert.equal(quest.startedAtIso, null);
  assert.ok(typeof quest.terminalReason === "string" && quest.terminalReason.length > 0);
});

test("started overdue quest never hard-deletes and can mutate to successor", async () => {
  const { sceneLoop, questEconomy } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";

  let loop = sceneLoop.createInitialDeterministicSceneLoop({
    sceneId: "scene-quest-overdue",
    nowIso,
  });
  loop.scene.locationId = "loc-overdue";

  const economy = questEconomy.ensureQuestEconomyState(undefined, nowIso);
  economy.worldPressures[0].intensity = 84;
  economy.worldPressures[0].lastAdvancedAtIso = "2026-03-23T18:00:00.000Z";
  const pressureId = economy.worldPressures[0].pressureId;
  economy.quests = [
    {
      questId: "quest-started-001",
      pressureId,
      archetype: economy.worldPressures[0].archetype,
      lifecycle: "active",
      locationId: "loc-overdue",
      urgency: 82,
      progress: 21,
      surfacedAtIso: "2026-03-23T17:30:00.000Z",
      startedAtIso: "2026-03-23T17:35:00.000Z",
      deadlineAtIso: "2026-03-23T18:10:00.000Z",
      expiresAtIso: null,
      lastAdvancedAtIso: "2026-03-23T18:10:00.000Z",
      parentQuestId: null,
      successorQuestId: null,
      terminalReason: null,
      cost: { world: 3, attention: 3, narrative: 1 },
      hookType: "incident",
      mutationCount: 0,
      lastMutationAtIso: null,
      stallCount: 0,
    },
  ];
  loop.questEconomy = economy;

  const resolved = sceneLoop.resolveDeterministicSceneAction({
    loop,
    routeActionId: "action.wait",
    nowIso,
  });

  const parent = resolved.nextLoop.questEconomy.quests.find((entry) => entry.questId === "quest-started-001");
  assert.ok(parent);
  assert.notEqual(parent.lifecycle, "deleted");
  assert.equal(typeof parent.startedAtIso, "string");

  if (parent.successorQuestId) {
    const successor = resolved.nextLoop.questEconomy.quests.find((entry) => entry.questId === parent.successorQuestId);
    assert.ok(successor);
    assert.equal(successor.parentQuestId, parent.questId);
    assert.equal(parent.terminalReason, "mutated_to_successor");
  } else {
    assert.equal(parent.lifecycle, "failed");
    assert.equal(parent.terminalReason, "overdue_failed");
  }
});

test("temporal signal affects deterministic seed surfacing decision", async () => {
  const { questEconomy } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";

  const base = questEconomy.ensureQuestEconomyState(undefined, nowIso);
  base.worldPressures[0].intensity = 72;
  base.worldPressures[0].lastAdvancedAtIso = "2026-03-23T20:00:00.000Z";
  base.quests = [
    {
      questId: "quest-seed-001",
      pressureId: base.worldPressures[0].pressureId,
      archetype: base.worldPressures[0].archetype,
      lifecycle: "seed",
      locationId: "loc-bridge",
      urgency: 48,
      progress: 0,
      surfacedAtIso: null,
      startedAtIso: null,
      deadlineAtIso: null,
      expiresAtIso: "2026-03-24T03:00:00.000Z",
      lastAdvancedAtIso: "2026-03-24T00:00:00.000Z",
      parentQuestId: null,
      successorQuestId: null,
      terminalReason: null,
      cost: { world: 3, attention: 2, narrative: 1 },
      hookType: "incident",
      mutationCount: 0,
      lastMutationAtIso: null,
      stallCount: 0,
    },
  ];

  const lowSignal = {
    locationId: "loc-bridge",
    locationTension: 30,
    locationAlertness: 28,
    locationAccessibility: 78,
    infoFreshness: 20,
    memoryFamiliarity: 0,
    residualTraceHeat: 8,
    incidentCount: 0,
  };
  const highSignal = {
    ...lowSignal,
    locationTension: 92,
    locationAlertness: 88,
    residualTraceHeat: 95,
    incidentCount: 4,
  };

  const low = questEconomy.runQuestEconomyTick({
    economy: base,
    nowIso,
    deltaTimeSec: 120,
    sceneId: "scene-001",
    locationId: "loc-bridge",
    actionId: "action.wait",
    classification: "possible",
    temporalSignal: lowSignal,
  });

  const high = questEconomy.runQuestEconomyTick({
    economy: base,
    nowIso,
    deltaTimeSec: 120,
    sceneId: "scene-001",
    locationId: "loc-bridge",
    actionId: "action.wait",
    classification: "possible",
    temporalSignal: highSignal,
  });

  const lowSurfaced = low.nextEconomy.quests.filter((entry) => entry.lifecycle === "surfaced").length;
  const highSurfaced = high.nextEconomy.quests.filter((entry) => entry.lifecycle === "surfaced").length;
  assert.ok(highSurfaced >= lowSurfaced);
});

test("severe soft quota can block additional same-axis seed growth", async () => {
  const { questEconomy } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";

  const economy = questEconomy.ensureQuestEconomyState(undefined, nowIso);
  const pressure = economy.worldPressures[0];
  pressure.intensity = 90;
  pressure.lastAdvancedAtIso = "2026-03-23T10:00:00.000Z";
  pressure.lastSeededAtIso = "2026-03-23T10:00:00.000Z";

  economy.quests = [
    {
      questId: "quest-q1",
      pressureId: pressure.pressureId,
      archetype: pressure.archetype,
      lifecycle: "seed",
      locationId: "loc-quota",
      urgency: 70,
      progress: 0,
      surfacedAtIso: null,
      startedAtIso: null,
      deadlineAtIso: null,
      expiresAtIso: "2026-03-24T04:00:00.000Z",
      lastAdvancedAtIso: nowIso,
      parentQuestId: null,
      successorQuestId: null,
      terminalReason: null,
      cost: { world: 3, attention: 2, narrative: 1 },
      hookType: "incident",
      mutationCount: 0,
      lastMutationAtIso: null,
      stallCount: 0,
    },
    {
      questId: "quest-q2",
      pressureId: pressure.pressureId,
      archetype: pressure.archetype,
      lifecycle: "seed",
      locationId: "loc-quota",
      urgency: 68,
      progress: 0,
      surfacedAtIso: null,
      startedAtIso: null,
      deadlineAtIso: null,
      expiresAtIso: "2026-03-24T04:00:00.000Z",
      lastAdvancedAtIso: nowIso,
      parentQuestId: null,
      successorQuestId: null,
      terminalReason: null,
      cost: { world: 3, attention: 2, narrative: 1 },
      hookType: "incident",
      mutationCount: 0,
      lastMutationAtIso: null,
      stallCount: 0,
    },
    {
      questId: "quest-q3",
      pressureId: pressure.pressureId,
      archetype: pressure.archetype,
      lifecycle: "seed",
      locationId: "loc-quota",
      urgency: 67,
      progress: 0,
      surfacedAtIso: null,
      startedAtIso: null,
      deadlineAtIso: null,
      expiresAtIso: "2026-03-24T04:00:00.000Z",
      lastAdvancedAtIso: nowIso,
      parentQuestId: null,
      successorQuestId: null,
      terminalReason: null,
      cost: { world: 3, attention: 2, narrative: 1 },
      hookType: "incident",
      mutationCount: 0,
      lastMutationAtIso: null,
      stallCount: 0,
    },
    {
      questId: "quest-q4",
      pressureId: pressure.pressureId,
      archetype: pressure.archetype,
      lifecycle: "seed",
      locationId: "loc-quota",
      urgency: 66,
      progress: 0,
      surfacedAtIso: null,
      startedAtIso: null,
      deadlineAtIso: null,
      expiresAtIso: "2026-03-24T04:00:00.000Z",
      lastAdvancedAtIso: nowIso,
      parentQuestId: null,
      successorQuestId: null,
      terminalReason: null,
      cost: { world: 3, attention: 2, narrative: 1 },
      hookType: "incident",
      mutationCount: 0,
      lastMutationAtIso: null,
      stallCount: 0,
    },
    {
      questId: "quest-q5",
      pressureId: pressure.pressureId,
      archetype: pressure.archetype,
      lifecycle: "seed",
      locationId: "loc-quota",
      urgency: 65,
      progress: 0,
      surfacedAtIso: null,
      startedAtIso: null,
      deadlineAtIso: null,
      expiresAtIso: "2026-03-24T04:00:00.000Z",
      lastAdvancedAtIso: nowIso,
      parentQuestId: null,
      successorQuestId: null,
      terminalReason: null,
      cost: { world: 3, attention: 2, narrative: 1 },
      hookType: "incident",
      mutationCount: 0,
      lastMutationAtIso: null,
      stallCount: 0,
    },
  ];

  const result = questEconomy.runQuestEconomyTick({
    economy,
    nowIso,
    deltaTimeSec: 300,
    sceneId: "scene-001",
    locationId: "loc-quota",
    actionId: "action.rush",
    classification: "reckless",
    temporalSignal: {
      locationId: "loc-quota",
      locationTension: 95,
      locationAlertness: 92,
      locationAccessibility: 20,
      infoFreshness: 15,
      memoryFamiliarity: 10,
      residualTraceHeat: 96,
      incidentCount: 6,
    },
  });

  assert.equal(result.summary.spawnedSeeds, 0);
  assert.ok(result.summary.debug.severeQuotaBlocks >= 1);
});

test("quest trace events appear and resume preserves quest economy state", async () => {
  const { plugin } = await modulesPromise;
  const worldRoot = "/tmp/trpg-runtime-v2-quest-test-world";
  await fs.rm(worldRoot, { recursive: true, force: true });
  await fs.mkdir(path.resolve(worldRoot, "state/runtime-core"), { recursive: true });

  const tools = new Map();
  const api = {
    pluginConfig: {
      allowedAgentIds: ["trpg"],
      panelDispatchTtlSec: 120,
      traceMaxEvents: 30,
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
  const resumeTool = tools.get("trpg_session_resume");
  const interactTool = tools.get("trpg_panel_interact");
  assert.ok(newTool && resumeTool && interactTool);

  const parse = (result) => JSON.parse(result.content[0].text);

  let current = parse(await newTool.execute("new", { channelKey: "discord:room-quest", ownerId: "owner-1" }));
  const actionBlock = current.panelDispatch.components.blocks.find((entry) => entry.type === "actions");
  const customId = actionBlock.buttons[0].customId;
  current = parse(await interactTool.execute("interact", { customId, actorId: "owner-1" }));
  assert.equal(current.ok, true);

  const traceTypes = current.session.trace.events.map((entry) => entry.type);
  assert.ok(traceTypes.includes("engine.pressure.advanced"));
  assert.ok(traceTypes.includes("engine.quest.lifecycle"));
  assert.ok(current.session.trace.events.length <= current.session.trace.maxEvents);

  const beforeResume = current.session.deterministicLoop.questEconomy;
  const resumed = parse(await resumeTool.execute("resume", { sessionId: current.session.sessionId, actorId: "owner-1" }));
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.session.deterministicLoop.questEconomy, beforeResume);
});

test("quest lifecycle remains deterministic without analyzer lane", async () => {
  const { sceneLoop } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";
  const actions = [
    "action.rush",
    "action.observe",
    "action.wait",
    "action.move",
    "action.wait",
    "action.talk",
    "action.observe",
  ];

  const runSequence = () => {
    let loop = sceneLoop.createInitialDeterministicSceneLoop({
      sceneId: "scene-quest-deterministic",
      nowIso,
    });
    loop.scene.locationId = "loc-deterministic";

    for (const actionId of actions) {
      const resolved = sceneLoop.resolveDeterministicSceneAction({
        loop,
        routeActionId: actionId,
        nowIso,
      });
      loop = resolved.nextLoop;
    }

    return loop.questEconomy;
  };

  const first = runSequence();
  const second = runSequence();
  assert.deepEqual(first, second);
});
