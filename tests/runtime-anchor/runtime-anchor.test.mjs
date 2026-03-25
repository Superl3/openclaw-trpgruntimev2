import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ROOT_DIR = process.cwd();
const OUT_DIR = path.resolve(ROOT_DIR, ".tmp-test-dist-anchor");

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
  const anchorLayer = await importFromOut("src/runtime-core/anchor-layer.js");
  const panel = await importFromOut("src/runtime-core/panel-mvp.js");
  const analyzer = await importFromOut("src/runtime-core/analyzer-lane.js");
  const noopLane = await importFromOut("src/runtime-core/noop-lane.js");
  const runtimeEngine = await importFromOut("src/runtime-core/runtime-engine.js");
  const pluginModule = await importFromOut("index.js");
  return {
    sceneLoop,
    anchorLayer,
    panel,
    analyzer,
    noopLane,
    runtimeEngine,
    plugin: pluginModule.default,
  };
}

function makeSession(loop, nowIso) {
  return {
    schemaVersion: 1,
    sessionId: "sess-anchor-test",
    channelKey: "channel:anchor",
    ownerId: "owner-1",
    status: "active",
    sceneId: loop.scene.sceneId,
    uiVersion: 1,
    actionSeq: 0,
    turnIndex: 0,
    lastActionId: null,
    lastActionSummary: null,
    deterministicLoop: loop,
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
        sceneId: loop.scene.sceneId,
        messageId: null,
        channelMessageRef: null,
        lastRenderedAt: null,
      },
      main: {
        panelId: "main",
        uiVersion: 1,
        sceneId: loop.scene.sceneId,
        messageId: null,
        channelMessageRef: null,
        lastRenderedAt: null,
      },
      sub: {
        panelId: "sub",
        uiVersion: 1,
        sceneId: loop.scene.sceneId,
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

test("anchor forms from candidate pressure and stays deterministic in scene loop", async () => {
  const { sceneLoop } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";

  const bootstrap = {
    source: "worldSeed",
    worldId: "world-anchor",
    schemaVersion: 1,
    seedValue: "seed-anchor",
    seedFingerprint: "abc123",
    determinismKey: "det-key",
    generationProfile: {
      profileId: "default",
      pressureScalePercent: 100,
      locationVolatility: "mixed",
    },
    questEconomy: {
      worldPressures: [
        {
          pressureId: "pressure-anchor-01",
          archetype: "power_struggle",
          intensity: 84,
          momentum: 2,
          cadenceSec: 180,
          targetLocations: ["loc-anchor"],
          anchorCandidate: true,
        },
      ],
    },
    temporal: {
      locationBaselines: [],
    },
    scaffold: {
      factionIds: [],
      npcArchetypeIds: [],
    },
  };

  const runOnce = () => {
    let loop = sceneLoop.createInitialDeterministicSceneLoop({
      sceneId: "scene-anchor-001",
      nowIso,
      bootstrap,
    });
    loop.scene.locationId = "loc-anchor";
    const resolved = sceneLoop.resolveDeterministicSceneAction({
      loop,
      routeActionId: "action.wait",
      nowIso,
    });
    return resolved;
  };

  const first = runOnce();
  const second = runOnce();

  assert.ok(first.anchorSummary.formedNow >= 1);
  assert.ok(first.nextLoop.anchor.anchors.length >= 1);
  assert.ok(first.nextLoop.anchor.anchors.some((entry) => entry.lifecycle === "active" || entry.lifecycle === "candidate"));
  assert.deepEqual(first.nextLoop.anchor, second.nextLoop.anchor);
});

test("runAnchorTick handles lifecycle transitions, cap, and no-hard-delete guard", async () => {
  const { anchorLayer, sceneLoop } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";

  const loop = sceneLoop.createInitialDeterministicSceneLoop({
    sceneId: "scene-anchor-cap",
    nowIso,
  });

  const economyBefore = loop.questEconomy;
  const economyAfter = {
    ...economyBefore,
    worldPressures: economyBefore.worldPressures.map((entry, index) => ({
      ...entry,
      pressureId: `pressure-cap-${String(index).padStart(2, "0")}`,
      anchorCandidate: true,
      intensity: 70 + (index % 20),
    })),
  };

  const overfilledAnchor = {
    version: 1,
    nextAnchorSeq: 60,
    anchors: [
      {
        anchorId: "anchor-started-keep",
        pressureId: "pressure-cap-00",
        archetype: "public_order",
        lifecycle: "active",
        title: "keep-active",
        intensity: 88,
        createdAtIso: "2026-03-23T00:00:00.000Z",
        startedAtIso: "2026-03-23T00:05:00.000Z",
        terminalAtIso: null,
        archivedAtIso: null,
        lastAdvancedAtIso: nowIso,
        terminalReason: null,
        linkedQuestIds: [],
        recentEventRefs: [],
        sourceRefs: [],
        escalationCount: 0,
      },
      {
        anchorId: "anchor-terminal-keep",
        pressureId: "pressure-cap-01",
        archetype: "smuggling",
        lifecycle: "failed",
        title: "keep-failed",
        intensity: 95,
        createdAtIso: "2026-03-23T00:00:00.000Z",
        startedAtIso: "2026-03-23T00:05:00.000Z",
        terminalAtIso: "2026-03-23T22:00:00.000Z",
        archivedAtIso: null,
        lastAdvancedAtIso: nowIso,
        terminalReason: "pressure_overrun",
        linkedQuestIds: [],
        recentEventRefs: [],
        sourceRefs: [],
        escalationCount: 1,
      },
      ...Array.from({ length: 40 }, (_, index) => ({
        anchorId: `anchor-candidate-${String(index).padStart(2, "0")}`,
        pressureId: `pressure-candidate-${String(index).padStart(2, "0")}`,
        archetype: "artifact_race",
        lifecycle: "candidate",
        title: "candidate",
        intensity: 62 + (index % 25),
        createdAtIso: "2026-03-23T00:00:00.000Z",
        startedAtIso: null,
        terminalAtIso: null,
        archivedAtIso: null,
        lastAdvancedAtIso: nowIso,
        terminalReason: null,
        linkedQuestIds: [],
        recentEventRefs: [],
        sourceRefs: [],
        escalationCount: 0,
      })),
    ],
  };

  const result = anchorLayer.runAnchorTick({
    anchor: overfilledAnchor,
    economyBefore,
    economyAfter,
    questSummary: {
      pressureAdvancedCount: 0,
      pressureTop: null,
      transitionCount: 1,
      transitions: [
        {
          questId: "quest-1",
          from: "active",
          to: "failed",
          reason: "test",
          parentQuestId: null,
          successorQuestId: null,
        },
      ],
      spawnedSeeds: 0,
      surfacedNow: 0,
      expiredDeleted: 0,
      failedNow: 1,
      mutatedNow: 0,
      archivedNow: 0,
      budget: economyAfter.budget,
      softQuota: economyAfter.softQuota,
      panelSummary: {
        actionable: {
          activeCount: 0,
          surfacedCount: 0,
          activeTop: null,
          surfacedTop: [],
          activeText: "",
          surfacedText: "",
        },
        worldPulse: {
          topPressure: null,
          defaultText: "",
          llmShortText: null,
          text: "",
        },
        recentOutcomes: {
          items: [],
          text: "",
        },
        debug: {
          liveQuestCount: 0,
          budget: economyAfter.budget,
          softQuota: economyAfter.softQuota,
          hookText: {
            lastEvaluatedAtIso: null,
            generationAttempted: false,
            result: "skipped",
            reason: null,
            cacheHitCount: 0,
            cacheMissCount: 0,
            slotMeta: [],
          },
          tuning: {
            sampleCount: 0,
            surfacingRate: 0,
            expirationRate: 0,
            mutationRate: 0,
            successorRate: 0,
            budgetUtilization: { live: 0, world: 0, attention: 0, narrative: 0 },
            quotaSaturation: { location: 0, pressure: 0, archetype: 0 },
            averageUrgency: 0,
            activeVsSurfacedRatio: 0,
          },
          averageUrgency: 0,
          activeVsSurfacedRatio: 0,
          topPressureIntensity: 0,
        },
      },
      tuningSnapshot: {
        sampleCount: 0,
        surfacingRate: 0,
        expirationRate: 0,
        mutationRate: 0,
        successorRate: 0,
        budgetUtilization: { live: 0, world: 0, attention: 0, narrative: 0 },
        quotaSaturation: { location: 0, pressure: 0, archetype: 0 },
        averageUrgency: 0,
        activeVsSurfacedRatio: 0,
      },
      debug: {
        severeQuotaBlocks: 0,
        budgetBlocked: false,
      },
    },
    nowIso,
    deltaTimeSec: 120,
    actionId: "action.rush",
    classification: "reckless",
    sceneId: "scene-anchor-cap",
    factionSignal: { pressureBoostById: [{ pressureId: "pressure-cap-00", delta: 5 }] },
  });

  assert.ok(result.nextAnchor.anchors.length <= 24);
  assert.equal(result.nextAnchor.anchors.some((entry) => entry.anchorId === "anchor-started-keep"), true);
  assert.equal(result.nextAnchor.anchors.some((entry) => entry.anchorId === "anchor-terminal-keep"), true);
});

test("runAnchorTick degrades safely for missing/invalid/noop faction signal", async () => {
  const { anchorLayer, sceneLoop } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";
  const loop = sceneLoop.createInitialDeterministicSceneLoop({
    sceneId: "scene-anchor-signal",
    nowIso,
  });

  const baseInput = {
    anchor: loop.anchor,
    economyBefore: loop.questEconomy,
    economyAfter: loop.questEconomy,
    questSummary: {
      pressureAdvancedCount: 0,
      pressureTop: null,
      transitionCount: 0,
      transitions: [],
      spawnedSeeds: 0,
      surfacedNow: 0,
      expiredDeleted: 0,
      failedNow: 0,
      mutatedNow: 0,
      archivedNow: 0,
      budget: loop.questEconomy.budget,
      softQuota: loop.questEconomy.softQuota,
      panelSummary: loop.questEconomy.presentation ? {
        actionable: { activeCount: 0, surfacedCount: 0, activeTop: null, surfacedTop: [], activeText: "", surfacedText: "" },
        worldPulse: { topPressure: null, defaultText: "", llmShortText: null, text: "" },
        recentOutcomes: { items: [], text: "" },
        debug: {
          liveQuestCount: 0,
          budget: loop.questEconomy.budget,
          softQuota: loop.questEconomy.softQuota,
          hookText: {
            lastEvaluatedAtIso: null,
            generationAttempted: false,
            result: "skipped",
            reason: null,
            cacheHitCount: 0,
            cacheMissCount: 0,
            slotMeta: [],
          },
          tuning: {
            sampleCount: 0,
            surfacingRate: 0,
            expirationRate: 0,
            mutationRate: 0,
            successorRate: 0,
            budgetUtilization: { live: 0, world: 0, attention: 0, narrative: 0 },
            quotaSaturation: { location: 0, pressure: 0, archetype: 0 },
            averageUrgency: 0,
            activeVsSurfacedRatio: 0,
          },
          averageUrgency: 0,
          activeVsSurfacedRatio: 0,
          topPressureIntensity: 0,
        },
      } : null,
      tuningSnapshot: {
        sampleCount: 0,
        surfacingRate: 0,
        expirationRate: 0,
        mutationRate: 0,
        successorRate: 0,
        budgetUtilization: { live: 0, world: 0, attention: 0, narrative: 0 },
        quotaSaturation: { location: 0, pressure: 0, archetype: 0 },
        averageUrgency: 0,
        activeVsSurfacedRatio: 0,
      },
      debug: { severeQuotaBlocks: 0, budgetBlocked: false },
    },
    nowIso,
    deltaTimeSec: 60,
    actionId: "action.wait",
    classification: "possible",
    sceneId: "scene-anchor-signal",
  };

  const missing = anchorLayer.runAnchorTick(baseInput);
  const invalid = anchorLayer.runAnchorTick({ ...baseInput, factionSignal: { foo: "bar" } });
  const noop = anchorLayer.runAnchorTick({ ...baseInput, factionSignal: { pressureBoostById: [] } });

  assert.equal(missing.summary.debug.signalMode, "missing");
  assert.equal(invalid.summary.debug.signalMode, "invalid");
  assert.equal(noop.summary.debug.signalMode, "noop");
});

test("panel shows anchor qualitative text for player and raw anchor debug in debug mode", async () => {
  const { panel, sceneLoop } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";

  const loop = sceneLoop.createInitialDeterministicSceneLoop({
    sceneId: "scene-anchor-panel",
    nowIso,
  });
  loop.anchor.anchors = [
    {
      anchorId: "anchor-panel-001",
      pressureId: "pressure-panel",
      archetype: "public_order",
      lifecycle: "active",
      title: "치안 붕괴 축",
      intensity: 76,
      createdAtIso: nowIso,
      startedAtIso: nowIso,
      terminalAtIso: null,
      archivedAtIso: null,
      lastAdvancedAtIso: nowIso,
      terminalReason: null,
      linkedQuestIds: [],
      recentEventRefs: [],
      sourceRefs: [],
      escalationCount: 0,
    },
  ];

  const session = makeSession(loop, nowIso);
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
  assert.equal(playerText.includes("앵커 축:"), true);
  assert.equal(playerText.includes("debug.anchor.raw"), false);
  assert.equal(debugText.includes("debug.anchor.raw"), true);
});

test("engine emits anchor trace events when anchor lifecycle changes", async () => {
  const { analyzer, noopLane, runtimeEngine, sceneLoop } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";
  const store = {
    async readSession() {
      return null;
    },
    async readActiveSessionByChannel() {
      return null;
    },
    async upsertSession() {},
    async upsertInteractionRoute() {},
    async readInteractionRoute() {
      return null;
    },
    async consumeInteractionRoute() {
      return null;
    },
    async deleteRoutesForSession() {
      return 0;
    },
    async listRoutesForSession() {
      return [];
    },
  };

  const engine = runtimeEngine.createCheckpoint0RuntimeEngine({
    store,
    intentAnalyzer: new analyzer.RuleBasedIntentAnalyzer(),
    personaDriftAnalyzer: new analyzer.RuleBasedPersonaDriftAnalyzer(),
    sceneRenderer: new noopLane.NoopSceneRenderer(),
  });

  const bootstrap = {
    source: "worldSeed",
    worldId: "world-anchor-engine",
    schemaVersion: 1,
    seedValue: "seed-anchor-engine",
    seedFingerprint: "fp-anchor-engine",
    determinismKey: "det-anchor-engine",
    generationProfile: {
      profileId: "default",
      pressureScalePercent: 100,
      locationVolatility: "mixed",
    },
    questEconomy: {
      worldPressures: [
        {
          pressureId: "pressure-anchor-engine",
          archetype: "power_struggle",
          intensity: 90,
          momentum: 3,
          cadenceSec: 160,
          targetLocations: ["loc-anchor-engine"],
          anchorCandidate: true,
        },
      ],
    },
    temporal: {
      locationBaselines: [],
    },
    scaffold: {
      factionIds: [],
      npcArchetypeIds: [],
    },
  };

  const created = await engine.startNewSession({
    channelKey: "discord:anchor-engine",
    ownerId: "owner-1",
    initialSceneId: "scene-anchor-engine",
    runtimeBootstrap: bootstrap,
  });
  const session = created.session;
  session.deterministicLoop.scene.locationId = "loc-anchor-engine";
  session.deterministicLoop = sceneLoop.ensureDeterministicSceneLoopState(session.deterministicLoop, {
    sceneId: session.sceneId,
    nowIso,
  });

  const processed = await engine.processSceneAction({
    session,
    routeActionId: "action.rush",
  });

  const traceTypes = processed.session.trace.events.map((entry) => entry.type);
  const hasAnchorTrace = traceTypes.some((entry) => entry.startsWith("engine.anchor."));
  assert.equal(hasAnchorTrace, true);
});
