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
  const panel = await importFromOut("src/runtime-core/panel-mvp.js");
  const pluginModule = await importFromOut("index.js");

  return {
    sceneLoop,
    questEconomy,
    panel,
    plugin: pluginModule.default,
  };
}

function makeSession(sceneLoopModule, deterministicLoop, nowIso) {
  return {
    schemaVersion: 1,
    sessionId: "sess-quest-ui-test",
    channelKey: "channel:quest-ui",
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

test("panel clearly separates active and surfaced quest summaries", async () => {
  const { sceneLoop, questEconomy, panel } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";

  const loop = sceneLoop.createInitialDeterministicSceneLoop({
    sceneId: "scene-quest-ui-split",
    nowIso,
  });
  loop.scene.locationId = "loc-ui";

  const economy = questEconomy.ensureQuestEconomyState(undefined, nowIso);
  const pressure = economy.worldPressures[0];
  economy.quests = [
    {
      questId: "quest-active-ui",
      pressureId: pressure.pressureId,
      archetype: pressure.archetype,
      lifecycle: "active",
      locationId: "loc-ui",
      urgency: 81,
      progress: 38,
      surfacedAtIso: "2026-03-23T23:20:00.000Z",
      startedAtIso: "2026-03-23T23:21:00.000Z",
      deadlineAtIso: "2026-03-24T00:40:00.000Z",
      expiresAtIso: null,
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
      questId: "quest-surfaced-ui-1",
      pressureId: pressure.pressureId,
      archetype: pressure.archetype,
      lifecycle: "surfaced",
      locationId: "loc-ui",
      urgency: 70,
      progress: 0,
      surfacedAtIso: nowIso,
      startedAtIso: null,
      deadlineAtIso: null,
      expiresAtIso: "2026-03-24T01:20:00.000Z",
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
    {
      questId: "quest-surfaced-ui-2",
      pressureId: pressure.pressureId,
      archetype: pressure.archetype,
      lifecycle: "surfaced",
      locationId: "loc-ui",
      urgency: 62,
      progress: 0,
      surfacedAtIso: nowIso,
      startedAtIso: null,
      deadlineAtIso: null,
      expiresAtIso: "2026-03-24T01:20:00.000Z",
      lastAdvancedAtIso: nowIso,
      parentQuestId: null,
      successorQuestId: null,
      terminalReason: null,
      cost: { world: 2, attention: 2, narrative: 1 },
      hookType: "rumor",
      mutationCount: 0,
      lastMutationAtIso: null,
      stallCount: 0,
    },
  ];
  loop.questEconomy = questEconomy.ensureQuestEconomyState(economy, nowIso);

  const session = makeSession(sceneLoop, loop, nowIso);
  const playerPanel = panel.buildCheckpoint1Panel({
    session,
    routes: [],
    mode: "send",
  });
  const debugPanel = panel.buildCheckpoint1Panel({
    session,
    routes: [],
    mode: "send",
    debugRuntimeSignals: true,
  });

  const playerText = JSON.stringify(playerPanel.components);
  const debugText = JSON.stringify(debugPanel.components);

  assert.ok(playerText.includes("활성 과제:"));
  assert.ok(playerText.includes("접촉 기회:"));
  assert.ok(playerText.includes("퀘스트(진행):"));
  assert.ok(playerText.includes("퀘스트(기회):"));
  assert.equal(playerText.includes("debug.quest_tuning.raw"), false);
  assert.equal(playerText.includes("debug.quest_hook_text.raw"), false);
  assert.equal(playerText.includes("budget_used=live"), false);
  assert.equal(debugText.includes("debug.quest_tuning.raw"), true);
  assert.equal(debugText.includes("debug.quest_hook_text.raw"), true);
});

test("recent lifecycle changes appear as player-facing natural phrases", async () => {
  const { sceneLoop, questEconomy, panel } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";

  let loop = sceneLoop.createInitialDeterministicSceneLoop({
    sceneId: "scene-quest-recent",
    nowIso,
  });
  loop.scene.locationId = "loc-recent";

  const economy = questEconomy.ensureQuestEconomyState(undefined, nowIso);
  economy.worldPressures[0].intensity = 84;
  const pressureId = economy.worldPressures[0].pressureId;
  economy.quests = [
    {
      questId: "quest-recent-001",
      pressureId,
      archetype: economy.worldPressures[0].archetype,
      lifecycle: "active",
      locationId: "loc-recent",
      urgency: 88,
      progress: 12,
      surfacedAtIso: "2026-03-23T18:00:00.000Z",
      startedAtIso: "2026-03-23T18:05:00.000Z",
      deadlineAtIso: "2026-03-23T18:15:00.000Z",
      expiresAtIso: null,
      lastAdvancedAtIso: "2026-03-23T18:15:00.000Z",
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
  assert.ok(resolved.nextLoop.questEconomy.presentation.recentOutcomes.length > 0);

  const session = makeSession(sceneLoop, resolved.nextLoop, nowIso);
  const panelOut = panel.buildCheckpoint1Panel({
    session,
    routes: [],
    mode: "send",
  });
  const panelText = JSON.stringify(panelOut.components);

  assert.ok(panelText.includes("최근 변화:"));
  assert.equal(panelText.includes("overdue_failed"), false);
  assert.equal(panelText.includes("mutated_to_successor"), false);
});

test("telemetry ring and snapshot remain bounded", async () => {
  const { questEconomy } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";

  let economy = questEconomy.ensureQuestEconomyState(undefined, nowIso);
  let cursorIso = nowIso;

  for (let index = 0; index < 80; index += 1) {
    const result = questEconomy.runQuestEconomyTick({
      economy,
      nowIso: cursorIso,
      deltaTimeSec: 180,
      sceneId: "scene-001",
      locationId: "loc-tuning",
      actionId: index % 3 === 0 ? "action.rush" : "action.observe",
      classification: index % 4 === 0 ? "reckless" : "possible",
      temporalSignal: {
        locationId: "loc-tuning",
        locationTension: 70,
        locationAlertness: 60,
        locationAccessibility: 45,
        infoFreshness: 35,
        memoryFamiliarity: 22,
        residualTraceHeat: 64,
        incidentCount: 2,
      },
    });
    economy = result.nextEconomy;
    cursorIso = new Date(Date.parse(cursorIso) + 180 * 1000).toISOString();
  }

  assert.ok(economy.presentation.telemetryRing.length <= questEconomy.QUEST_TUNING_RING_MAX);
  assert.ok(economy.presentation.tuning.sampleCount <= questEconomy.QUEST_TUNING_RING_MAX);
});

test("hook text overrides apply only to matching slots and expose debug metadata", async () => {
  const { questEconomy } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";

  let economy = questEconomy.ensureQuestEconomyState(undefined, nowIso);
  const pressure = economy.worldPressures[0];
  economy.quests = [
    {
      questId: "quest-hook-001",
      pressureId: pressure.pressureId,
      archetype: pressure.archetype,
      lifecycle: "surfaced",
      locationId: "loc-hook",
      urgency: 72,
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

  const tick = questEconomy.runQuestEconomyTick({
    economy,
    nowIso,
    deltaTimeSec: 60,
    sceneId: "scene-hook",
    locationId: "loc-hook",
    actionId: "action.wait",
    classification: "possible",
    temporalSignal: {
      locationId: "loc-hook",
      locationTension: 58,
      locationAlertness: 44,
      locationAccessibility: 60,
      infoFreshness: 65,
      memoryFamiliarity: 55,
      residualTraceHeat: 20,
      incidentCount: 1,
    },
  });

  const slot = tick.nextEconomy.presentation.hookSlots[0];
  assert.ok(slot);

  const applied = questEconomy.applyQuestHookTextOverrides({
    economy: tick.nextEconomy,
    nowIso,
    cacheTtlSec: 300,
    overrides: [
      {
        slotKey: slot.slotKey,
        shortText: `${slot.defaultText} 추가 설명은 잘려야 한다.`,
      },
      {
        slotKey: "hook-unknown",
        shortText: "무시되어야 함",
      },
    ],
  });

  const target = applied.nextEconomy.presentation.hookSlots.find((entry) => entry.slotKey === slot.slotKey);
  assert.ok(target);
  assert.ok(typeof target.llmShortText === "string" && target.llmShortText.length > 0);
  assert.ok(target.llmShortText.length <= target.defaultText.length);
  assert.ok(typeof target.llmSourceHash === "string" && target.llmSourceHash.length > 0);
  assert.ok(typeof target.llmExpiresAtIso === "string" && target.llmExpiresAtIso.length > 0);
  assert.equal(applied.appliedSlotKeys.includes(slot.slotKey), true);
  assert.equal(applied.ignoredSlotKeys.includes("hook-unknown"), true);

  const withDebug = questEconomy.setQuestHookTextDebugState({
    economy: applied.nextEconomy,
    nowIso,
    generationAttempted: true,
    result: "applied",
    reason: null,
    cacheHitCount: 0,
    cacheMissCount: 1,
    slotMeta: [
      {
        slotKey: slot.slotKey,
        source: "llm",
        cacheHit: false,
        skipReason: null,
      },
    ],
  });

  const summary = questEconomy.buildQuestEconomyQualitativeSummary({
    economy: withDebug,
    locationId: "loc-hook",
  });

  assert.equal(summary.debug.hookText.result, "applied");
  assert.equal(summary.debug.hookText.slotMeta[0].source, "llm");
});

test("worldPulse rich text applies as single-line replacement only", async () => {
  const { panel, questEconomy, sceneLoop } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";

  let economy = questEconomy.ensureQuestEconomyState(undefined, nowIso);
  const tick = questEconomy.runQuestEconomyTick({
    economy,
    nowIso,
    deltaTimeSec: 90,
    sceneId: "scene-world-pulse",
    locationId: "loc-world-pulse",
    actionId: "action.wait",
    classification: "possible",
    temporalSignal: {
      locationId: "loc-world-pulse",
      locationTension: 62,
      locationAlertness: 47,
      locationAccessibility: 58,
      infoFreshness: 64,
      memoryFamiliarity: 41,
      residualTraceHeat: 21,
      incidentCount: 1,
    },
  });

  const worldPulseSlot = tick.nextEconomy.presentation.worldPulseSlot;
  assert.ok(worldPulseSlot);

  const applied = questEconomy.applyQuestHookTextOverrides({
    economy: tick.nextEconomy,
    nowIso,
    cacheTtlSec: 300,
    overrides: [
      {
        slotKey: worldPulseSlot.slotKey,
        shortText: `${worldPulseSlot.defaultText}\n추가 줄은 제거되어야 한다.`,
      },
    ],
  });

  const summary = questEconomy.buildQuestEconomyQualitativeSummary({
    economy: applied.nextEconomy,
    locationId: "loc-world-pulse",
  });
  const expected = worldPulseSlot.defaultText;
  const expectedOneLine = expected.replace(/\s+/g, " ").trim();

  assert.equal(typeof summary.worldPulse.llmShortText, "string");
  assert.equal(summary.worldPulse.text, expectedOneLine);
  assert.equal(summary.worldPulse.text.includes("\n"), false);

  const loop = sceneLoop.createInitialDeterministicSceneLoop({
    sceneId: "scene-world-pulse",
    nowIso,
  });
  loop.scene.locationId = "loc-world-pulse";
  loop.questEconomy = applied.nextEconomy;
  const session = makeSession(sceneLoop, loop, nowIso);
  const panelOut = panel.buildCheckpoint1Panel({
    session,
    routes: [],
    mode: "send",
  });
  const panelText = JSON.stringify(panelOut.components);
  assert.equal((panelText.match(/세계 동향:/g) ?? []).length, 1);

  const debugPanelOut = panel.buildCheckpoint1Panel({
    session,
    routes: [],
    mode: "send",
    debugRuntimeSignals: true,
  });
  const debugText = JSON.stringify(debugPanelOut.components);
  assert.equal(debugText.includes("worldPulse"), true);
});

test("worldPulse invalid or unknown output keeps deterministic fallback", async () => {
  const { questEconomy } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";

  const tick = questEconomy.runQuestEconomyTick({
    economy: questEconomy.ensureQuestEconomyState(undefined, nowIso),
    nowIso,
    deltaTimeSec: 90,
    sceneId: "scene-world-pulse-fallback",
    locationId: "loc-world-pulse-fallback",
    actionId: "action.observe",
    classification: "possible",
    temporalSignal: {
      locationId: "loc-world-pulse-fallback",
      locationTension: 48,
      locationAlertness: 42,
      locationAccessibility: 60,
      infoFreshness: 62,
      memoryFamiliarity: 44,
      residualTraceHeat: 18,
      incidentCount: 0,
    },
  });

  const beforeSummary = questEconomy.buildQuestEconomyQualitativeSummary({
    economy: tick.nextEconomy,
    locationId: "loc-world-pulse-fallback",
  });
  const worldPulseSlot = tick.nextEconomy.presentation.worldPulseSlot;
  assert.ok(worldPulseSlot);

  const applied = questEconomy.applyQuestHookTextOverrides({
    economy: tick.nextEconomy,
    nowIso,
    cacheTtlSec: 300,
    overrides: [
      {
        slotKey: "hook-unknown",
        shortText: "무시되어야 함",
      },
      {
        slotKey: worldPulseSlot.slotKey,
        shortText: "",
      },
    ],
  });

  const afterSummary = questEconomy.buildQuestEconomyQualitativeSummary({
    economy: applied.nextEconomy,
    locationId: "loc-world-pulse-fallback",
  });

  assert.equal(afterSummary.worldPulse.llmShortText, null);
  assert.equal(afterSummary.worldPulse.text, beforeSummary.worldPulse.defaultText);
  assert.equal(applied.ignoredSlotKeys.includes("hook-unknown"), true);
});

test("hook text cache invalidates by TTL and source hash", async () => {
  const { questEconomy } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";

  let economy = questEconomy.ensureQuestEconomyState(undefined, nowIso);
  const pressure = economy.worldPressures[0];
  economy.quests = [
    {
      questId: "quest-hook-cache-001",
      pressureId: pressure.pressureId,
      archetype: pressure.archetype,
      lifecycle: "surfaced",
      locationId: "loc-hook-cache",
      urgency: 66,
      progress: 0,
      surfacedAtIso: nowIso,
      startedAtIso: null,
      deadlineAtIso: null,
      expiresAtIso: "2026-03-24T00:30:00.000Z",
      lastAdvancedAtIso: nowIso,
      parentQuestId: null,
      successorQuestId: null,
      terminalReason: null,
      cost: { world: 2, attention: 1, narrative: 1 },
      hookType: "rumor",
      mutationCount: 0,
      lastMutationAtIso: null,
      stallCount: 0,
    },
  ];

  const tick = questEconomy.runQuestEconomyTick({
    economy,
    nowIso,
    deltaTimeSec: 45,
    sceneId: "scene-hook-cache",
    locationId: "loc-hook-cache",
    actionId: "action.observe",
    classification: "possible",
    temporalSignal: {
      locationId: "loc-hook-cache",
      locationTension: 50,
      locationAlertness: 40,
      locationAccessibility: 62,
      infoFreshness: 62,
      memoryFamiliarity: 48,
      residualTraceHeat: 24,
      incidentCount: 1,
    },
  });

  const slot = tick.nextEconomy.presentation.hookSlots[0];
  assert.ok(slot);

  const applied = questEconomy.applyQuestHookTextOverrides({
    economy: tick.nextEconomy,
    nowIso,
    cacheTtlSec: 120,
    overrides: [
      {
        slotKey: slot.slotKey,
        shortText: "짧은 후크",
      },
    ],
  });

  const cached = applied.nextEconomy.presentation.hookSlots.find((entry) => entry.slotKey === slot.slotKey);
  assert.ok(cached);
  assert.equal(questEconomy.isQuestHookTextCacheValid(cached, nowIso), true);

  const expiredIso = new Date(Date.parse(nowIso) + 121 * 1000).toISOString();
  assert.equal(questEconomy.isQuestHookTextCacheValid(cached, expiredIso), false);

  const sourceChanged = {
    ...cached,
    defaultText: `${cached.defaultText} 변경`,
  };
  assert.equal(questEconomy.isQuestHookTextCacheValid(sourceChanged, nowIso), false);
});

test("worldPulse cache invalidates on trend/intensityBand/location hint changes", async () => {
  const { questEconomy } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";

  const tick = questEconomy.runQuestEconomyTick({
    economy: questEconomy.ensureQuestEconomyState(undefined, nowIso),
    nowIso,
    deltaTimeSec: 60,
    sceneId: "scene-world-pulse-cache",
    locationId: "loc-world-a",
    actionId: "action.wait",
    classification: "possible",
    temporalSignal: {
      locationId: "loc-world-a",
      locationTension: 60,
      locationAlertness: 52,
      locationAccessibility: 57,
      infoFreshness: 63,
      memoryFamiliarity: 42,
      residualTraceHeat: 22,
      incidentCount: 1,
    },
  });

  const worldPulseSlot = tick.nextEconomy.presentation.worldPulseSlot;
  assert.ok(worldPulseSlot);

  const applied = questEconomy.applyQuestHookTextOverrides({
    economy: tick.nextEconomy,
    nowIso,
    cacheTtlSec: 300,
    overrides: [
      {
        slotKey: worldPulseSlot.slotKey,
        shortText: "현장 긴장 신호가 꿈틀거린다.",
      },
    ],
  });
  const cachedWorldPulse = applied.nextEconomy.presentation.worldPulseSlot;
  assert.ok(cachedWorldPulse);
  assert.equal(questEconomy.isQuestHookTextCacheValid(cachedWorldPulse, nowIso), true);

  const trendChanged = {
    ...cachedWorldPulse,
    defaultText: `${cachedWorldPulse.defaultText} 변동`,
  };
  assert.equal(questEconomy.isQuestHookTextCacheValid(trendChanged, nowIso), false);

  const intensityBandChanged = {
    ...cachedWorldPulse,
    urgencyBand: cachedWorldPulse.urgencyBand === "critical" ? "high" : "critical",
  };
  assert.equal(questEconomy.isQuestHookTextCacheValid(intensityBandChanged, nowIso), false);

  const locationHintChanged = {
    ...cachedWorldPulse,
    locationId: "loc-world-b",
  };
  assert.equal(questEconomy.isQuestHookTextCacheValid(locationHintChanged, nowIso), false);
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
  assert.ok(traceTypes.includes("engine.quest.hook_text"));
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
