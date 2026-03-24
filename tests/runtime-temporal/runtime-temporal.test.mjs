import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ROOT_DIR = process.cwd();
const OUT_DIR = path.resolve(ROOT_DIR, ".tmp-test-dist-temporal");

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
  const pluginModule = await importFromOut("index.js");
  return {
    sceneLoop,
    plugin: pluginModule.default,
  };
}

function maxTraceIntensity(loop) {
  return loop.temporal.residualTraces.reduce((max, entry) => Math.max(max, entry.intensity), 0);
}

const modulesPromise = loadModules();

test("delta_time decays info freshness without deleting clue state", async () => {
  const { sceneLoop } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";
  const loop = sceneLoop.createInitialDeterministicSceneLoop({
    sceneId: "scene-001",
    nowIso,
  });
  loop.scene.locationId = "loc-square";

  const observed = sceneLoop.resolveDeterministicSceneAction({
    loop,
    routeActionId: "action.observe",
    nowIso,
  });
  const clueBefore = observed.nextLoop.temporal.infoFreshness.find((entry) => entry.clueId.includes("observation"));
  assert.ok(clueBefore);

  const waited = sceneLoop.resolveDeterministicSceneAction({
    loop: observed.nextLoop,
    routeActionId: "action.wait",
    nowIso,
  });
  const clueAfter = waited.nextLoop.temporal.infoFreshness.find((entry) => entry.clueId === clueBefore.clueId);

  assert.ok(clueAfter);
  assert.ok(clueAfter.freshness <= clueBefore.freshness);
});

test("talk updates npc memory and wait decays memory toward neutral", async () => {
  const { sceneLoop } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";
  const loop = sceneLoop.createInitialDeterministicSceneLoop({
    sceneId: "scene-002",
    nowIso,
  });
  loop.scene.locationId = "loc-market";
  loop.scene.npcAvailable = true;

  const talked = sceneLoop.resolveDeterministicSceneAction({
    loop,
    routeActionId: "action.talk",
    nowIso,
  });

  const memoryAfterTalk = talked.nextLoop.temporal.npcMemory.find((entry) => entry.locationId === "loc-market");
  assert.ok(memoryAfterTalk);
  assert.ok(memoryAfterTalk.familiarity > 0);
  assert.ok(memoryAfterTalk.lastSeenAtIso);

  const waited = sceneLoop.resolveDeterministicSceneAction({
    loop: talked.nextLoop,
    routeActionId: "action.wait",
    nowIso,
  });

  const memoryAfterWait = waited.nextLoop.temporal.npcMemory.find((entry) => entry.npcId === memoryAfterTalk.npcId);
  assert.ok(memoryAfterWait);
  assert.ok(memoryAfterWait.familiarity <= memoryAfterTalk.familiarity);
  assert.ok(Math.abs(memoryAfterWait.sentiment) <= Math.abs(memoryAfterTalk.sentiment));
});

test("rush or move leaves residual traces and traces decay or expire over time", async () => {
  const { sceneLoop } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";
  const loop = sceneLoop.createInitialDeterministicSceneLoop({
    sceneId: "scene-003",
    nowIso,
  });
  loop.scene.locationId = "loc-gate";

  const rushed = sceneLoop.resolveDeterministicSceneAction({
    loop,
    routeActionId: "action.rush",
    nowIso,
  });

  const initialTraceCount = rushed.nextLoop.temporal.residualTraces.length;
  assert.ok(initialTraceCount > 0);

  let loopCursor = rushed.nextLoop;
  let sawExpired = false;
  const firstIntensity = maxTraceIntensity(loopCursor);
  for (let index = 0; index < 6; index += 1) {
    const waited = sceneLoop.resolveDeterministicSceneAction({
      loop: loopCursor,
      routeActionId: "action.wait",
      nowIso,
    });
    if (waited.temporalSummary.tracesExpired > 0) {
      sawExpired = true;
    }
    loopCursor = waited.nextLoop;
  }

  const finalIntensity = maxTraceIntensity(loopCursor);
  assert.ok(finalIntensity <= firstIntensity);
  assert.ok(loopCursor.temporal.residualTraces.length <= initialTraceCount);
  assert.ok(sawExpired || loopCursor.temporal.residualTraces.length < initialTraceCount);
});

test("location state reacts to temporal traces and affects scene pressure", async () => {
  const { sceneLoop } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";
  const loop = sceneLoop.createInitialDeterministicSceneLoop({
    sceneId: "scene-004",
    nowIso,
  });
  loop.scene.locationId = "loc-yard";

  const basePressure = loop.scene.pressure;
  const rushed = sceneLoop.resolveDeterministicSceneAction({
    loop,
    routeActionId: "action.rush",
    nowIso,
  });

  const location = rushed.nextLoop.temporal.locationStates.find((entry) => entry.locationId === "loc-yard");
  assert.ok(location);
  assert.ok(location.tension !== 35 || location.alertness !== 30);
  assert.notEqual(rushed.nextLoop.scene.pressure, basePressure);
});

test("temporal updates are deterministic without analyzer lane", async () => {
  const { sceneLoop } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";
  const makeLoop = () => {
    const seed = sceneLoop.createInitialDeterministicSceneLoop({
      sceneId: "scene-005",
      nowIso,
    });
    seed.scene.locationId = "loc-dock";
    return seed;
  };

  const first = sceneLoop.resolveDeterministicSceneAction({
    loop: makeLoop(),
    routeActionId: "action.rush",
    nowIso,
  });
  const second = sceneLoop.resolveDeterministicSceneAction({
    loop: makeLoop(),
    routeActionId: "action.rush",
    nowIso,
  });

  assert.deepEqual(first.nextLoop.temporal, second.nextLoop.temporal);
  assert.deepEqual(first.temporalSummary, second.temporalSummary);
});

test("engine trace records temporal updates and resume keeps temporal state", async () => {
  const { plugin } = await modulesPromise;
  const worldRoot = "/tmp/trpg-runtime-v2-temporal-test-world";
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
  const resumeTool = tools.get("trpg_session_resume");
  const interactTool = tools.get("trpg_panel_interact");
  assert.ok(newTool && resumeTool && interactTool);

  const parse = (result) => JSON.parse(result.content[0].text);

  const created = parse(await newTool.execute("new", { channelKey: "discord:room-2", ownerId: "owner-1" }));
  const actionBlock = created.panelDispatch.components.blocks.find((entry) => entry.type === "actions");
  const firstCustomId = actionBlock.buttons[0].customId;

  const interacted = parse(await interactTool.execute("action", { customId: firstCustomId, actorId: "owner-1" }));
  assert.equal(interacted.ok, true);

  const traceTypes = interacted.session.trace.events.map((entry) => entry.type);
  assert.ok(traceTypes.includes("engine.time.advanced"));
  assert.ok(traceTypes.includes("engine.temporal.updated"));

  const temporalBeforeResume = interacted.session.deterministicLoop.temporal;

  const resumed = parse(await resumeTool.execute("resume", { sessionId: interacted.session.sessionId, actorId: "owner-1" }));
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.deepEqual(resumed.session.deterministicLoop.temporal, temporalBeforeResume);
});
