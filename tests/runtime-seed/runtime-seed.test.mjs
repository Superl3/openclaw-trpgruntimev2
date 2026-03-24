import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

const ROOT_DIR = process.cwd();
const OUT_DIR = path.resolve(ROOT_DIR, ".tmp-test-dist-seed");

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

function runCapture(command, args) {
  return spawnSync(command, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: "pipe",
  });
}

function parseHelperPayload(output) {
  const trimmed = output.trim();
  const index = trimmed.indexOf("{");
  if (index < 0) {
    throw new Error(`No JSON payload found in output:\n${output}`);
  }
  return JSON.parse(trimmed.slice(index));
}

async function loadModules() {
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  run(process.execPath, ["./node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--noEmit", "false", "--outDir", OUT_DIR]);

  const importFromOut = async (relativePath) => {
    const fileUrl = pathToFileURL(path.resolve(OUT_DIR, relativePath)).href;
    return import(fileUrl);
  };

  const worldSeed = await importFromOut("src/runtime-core/world-seed.js");
  const sceneLoop = await importFromOut("src/runtime-core/scene-loop.js");
  const pluginModule = await importFromOut("index.js");

  return {
    worldSeed,
    sceneLoop,
    plugin: pluginModule.default,
  };
}

function makeValidSeed() {
  return {
    schemaVersion: 1,
    worldId: "world-seed-alpha",
    seedValue: "alpha-seed-001",
    createdAtIso: "2026-03-24T00:00:00.000Z",
    generationProfile: {
      profileId: "baseline",
      pressureScalePercent: 100,
      locationVolatility: "mixed",
    },
    locations: [
      {
        locationId: "loc-a",
        tags: ["market", "trade"],
        baseline: {
          tension: 40,
          alertness: 35,
          accessibility: 60,
        },
        pressureAffinityIds: ["pressure-a"],
      },
      {
        locationId: "loc-b",
        tags: ["harbor"],
        baseline: {
          tension: 38,
          alertness: 32,
          accessibility: 66,
        },
        pressureAffinityIds: ["pressure-b"],
      },
      {
        locationId: "loc-c",
        tags: ["old-town"],
        baseline: {
          tension: 42,
          alertness: 36,
          accessibility: 58,
        },
        pressureAffinityIds: ["pressure-a", "pressure-b"],
      },
    ],
    pressures: [
      {
        pressureId: "pressure-a",
        archetype: "smuggling",
        intensity: 40,
        momentum: 2,
        cadenceSec: 240,
        targetLocationIds: ["loc-a", "loc-c"],
      },
      {
        pressureId: "pressure-b",
        archetype: "public_order",
        intensity: 62,
        momentum: 1,
        cadenceSec: 180,
        targetLocationIds: ["loc-b"],
      },
    ],
    factions: [
      {
        factionId: "faction-watch",
        homeLocationId: "loc-b",
        agendaTags: ["security"],
        pressureBiasRefs: ["pressure-b"],
      },
      {
        factionId: "faction-guild",
        homeLocationId: "loc-a",
        agendaTags: ["trade"],
        pressureBiasRefs: ["pressure-a"],
      },
    ],
    npcPool: [
      {
        npcArchetypeId: "npc-a",
        factionId: "faction-watch",
        locationAffinityIds: ["loc-b"],
        roleTags: ["guard"],
      },
      {
        npcArchetypeId: "npc-b",
        factionId: "faction-watch",
        locationAffinityIds: ["loc-b", "loc-c"],
        roleTags: ["patrol"],
      },
      {
        npcArchetypeId: "npc-c",
        factionId: "faction-guild",
        locationAffinityIds: ["loc-a"],
        roleTags: ["broker"],
      },
      {
        npcArchetypeId: "npc-d",
        factionId: "faction-guild",
        locationAffinityIds: ["loc-a", "loc-c"],
        roleTags: ["porter"],
      },
      {
        npcArchetypeId: "npc-e",
        factionId: null,
        locationAffinityIds: ["loc-c"],
        roleTags: ["witness"],
      },
      {
        npcArchetypeId: "npc-f",
        factionId: null,
        locationAffinityIds: ["loc-a", "loc-b"],
        roleTags: ["civilian"],
      },
    ],
  };
}

async function setupPluginTools(plugin, worldRoot) {
  const tools = new Map();
  const api = {
    pluginConfig: {
      allowedAgentIds: ["trpg"],
      panelDispatchTtlSec: 120,
      traceMaxEvents: 60,
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

const modulesPromise = loadModules();

test("same world seed yields deterministic bootstrap projection", async () => {
  const { worldSeed } = await modulesPromise;
  const seed = makeValidSeed();
  const validated = worldSeed.validateWorldSeed(seed);
  assert.equal(validated.ok, true);

  const first = worldSeed.buildRuntimeBootstrapInput(validated.seed);
  const second = worldSeed.buildRuntimeBootstrapInput(validated.seed);

  assert.deepEqual(first, second);
  assert.equal(typeof first.seedFingerprint, "string");
  assert.equal(typeof first.determinismKey, "string");
});

test("broken references or minimum count violations return structured validation errors", async () => {
  const { worldSeed } = await modulesPromise;
  const invalid = makeValidSeed();
  invalid.locations = invalid.locations.slice(0, 2);
  invalid.factions[0].homeLocationId = "loc-missing";
  invalid.factions[0].pressureBiasRefs = ["pressure-missing"];
  invalid.npcPool[0].locationAffinityIds = ["loc-missing"];

  const validated = worldSeed.validateWorldSeed(invalid);
  assert.equal(validated.ok, false);
  const codes = validated.issues.map((entry) => entry.code);

  assert.equal(codes.includes("locations_too_few"), true);
  assert.equal(codes.includes("faction_home_location_invalid"), true);
  assert.equal(codes.includes("faction_pressure_bias_invalid"), true);
  assert.equal(codes.includes("npc_location_affinity_invalid"), true);
});

test("no bootstrap keeps current deterministic defaults", async () => {
  const { sceneLoop } = await modulesPromise;
  const nowIso = "2026-03-24T00:00:00.000Z";
  const loop = sceneLoop.createInitialDeterministicSceneLoop({
    sceneId: "scene-seed-default",
    nowIso,
  });

  assert.deepEqual(loop.questEconomy.worldPressures.map((entry) => entry.pressureId).slice().sort(), [
    "pressure-artifact-race",
    "pressure-public-order",
    "pressure-smuggling",
  ]);
  assert.equal(loop.temporal.locationStates.length, 0);
});

test("valid world seed bootstrap projects pressure and location baselines", async () => {
  const { worldSeed, sceneLoop } = await modulesPromise;
  const seed = makeValidSeed();
  seed.generationProfile.pressureScalePercent = 120;
  seed.generationProfile.locationVolatility = "stable";

  const validated = worldSeed.validateWorldSeed(seed);
  assert.equal(validated.ok, true);
  const bootstrap = worldSeed.buildRuntimeBootstrapInput(validated.seed);

  const loop = sceneLoop.createInitialDeterministicSceneLoop({
    sceneId: "scene-seed-bootstrap",
    nowIso: "2026-03-24T00:00:00.000Z",
    bootstrap,
  });

  const pressureA = loop.questEconomy.worldPressures.find((entry) => entry.pressureId === "pressure-a");
  assert.ok(pressureA);
  assert.equal(pressureA.intensity, 48);

  const locA = loop.temporal.locationStates.find((entry) => entry.locationId === "loc-a");
  assert.ok(locA);
  assert.equal(locA.tension, 36);
  assert.equal(locA.alertness, 31);
  assert.equal(locA.accessibility, 66);
});

test("runtime updates do not mutate canonical world seed object", async () => {
  const { worldSeed, sceneLoop } = await modulesPromise;
  const seed = makeValidSeed();
  const snapshot = structuredClone(seed);
  const validated = worldSeed.validateWorldSeed(seed);
  assert.equal(validated.ok, true);

  const bootstrap = worldSeed.buildRuntimeBootstrapInput(validated.seed);
  const loop = sceneLoop.createInitialDeterministicSceneLoop({
    sceneId: "scene-seed-non-mutation",
    nowIso: "2026-03-24T00:00:00.000Z",
    bootstrap,
  });

  sceneLoop.resolveDeterministicSceneAction({
    loop,
    routeActionId: "action.rush",
    nowIso: "2026-03-24T00:00:00.000Z",
  });

  assert.deepEqual(seed, snapshot);
});

test("template fixture validates and projects bootstrap", async () => {
  const { worldSeed } = await modulesPromise;
  const templatePath = path.resolve(ROOT_DIR, "examples/world-seed.template.yaml");
  const raw = await fs.readFile(templatePath, "utf8");
  const parsed = YAML.parse(raw);

  const validated = worldSeed.validateWorldSeed(parsed);
  assert.equal(validated.ok, true);
  const bootstrap = worldSeed.buildRuntimeBootstrapInput(validated.seed);

  assert.equal(bootstrap.worldId, "harbor-reach");
  assert.equal(bootstrap.questEconomy.worldPressures.length >= 2, true);
  assert.equal(bootstrap.temporal.locationBaselines.length >= 3, true);
});

test("preflight helper reports valid template file", () => {
  const result = runCapture(process.execPath, ["./scripts/validate-world-seed.mjs", "examples/world-seed.template.yaml"]);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /world seed valid/);

  const payload = parseHelperPayload(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.status, "valid");
  assert.equal(payload.counts.locations >= 3, true);
});

test("preflight helper returns structured failure for missing path", () => {
  const result = runCapture(process.execPath, ["./scripts/validate-world-seed.mjs", "examples/not-found-world-seed.yaml"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /world seed invalid/);

  const payload = parseHelperPayload(result.stderr);
  assert.equal(payload.ok, false);
  assert.equal(payload.status, "invalid");
  assert.equal(Array.isArray(payload.diagnostics), true);
  assert.equal(payload.diagnostics.some((entry) => entry.code === "seed_file_not_found"), true);
});

test("invalid world seed file falls back safely to default bootstrap", async () => {
  const { plugin } = await modulesPromise;
  const worldRoot = "/tmp/trpg-runtime-v2-seed-invalid-world";
  await fs.rm(worldRoot, { recursive: true, force: true });
  await fs.mkdir(path.resolve(worldRoot, "canon"), { recursive: true });
  await fs.mkdir(path.resolve(worldRoot, "state/runtime-core"), { recursive: true });
  await fs.writeFile(
    path.resolve(worldRoot, "canon/world-seed.json"),
    `${JSON.stringify({ schemaVersion: 1, worldId: "broken" }, null, 2)}\n`,
    "utf8",
  );

  const tools = await setupPluginTools(plugin, worldRoot);
  const newTool = tools.get("trpg_session_new");
  assert.ok(newTool);

  const created = JSON.parse((await newTool.execute("new", { channelKey: "discord:seed-invalid", ownerId: "owner-1" })).content[0].text);
  assert.equal(created.ok, true);
  assert.equal(created.seedBootstrap.status, "invalid");
  assert.equal(created.session.runtimeMetadata.bootstrap.source, "default");
  assert.ok(created.session.runtimeMetadata.bootstrap.diagnostics.length > 0);
});

test("resume keeps runtime state and ignores changed world seed file", async () => {
  const { plugin } = await modulesPromise;
  const worldRoot = "/tmp/trpg-runtime-v2-seed-resume-world";
  await fs.rm(worldRoot, { recursive: true, force: true });
  await fs.mkdir(path.resolve(worldRoot, "canon"), { recursive: true });
  await fs.mkdir(path.resolve(worldRoot, "state/runtime-core"), { recursive: true });

  const initialSeed = makeValidSeed();
  await fs.writeFile(
    path.resolve(worldRoot, "canon/world-seed.json"),
    `${JSON.stringify(initialSeed, null, 2)}\n`,
    "utf8",
  );

  const tools = await setupPluginTools(plugin, worldRoot);
  const newTool = tools.get("trpg_session_new");
  const resumeTool = tools.get("trpg_session_resume");
  assert.ok(newTool && resumeTool);

  const created = JSON.parse((await newTool.execute("new", { channelKey: "discord:seed-resume", ownerId: "owner-1" })).content[0].text);
  assert.equal(created.ok, true);
  assert.equal(created.seedBootstrap.status, "used");
  assert.equal(created.session.runtimeMetadata.bootstrap.source, "worldSeed");

  const beforeFingerprint = created.session.runtimeMetadata.bootstrap.seed.seedFingerprint;
  const beforeEconomy = created.session.deterministicLoop.questEconomy;

  const changedSeed = makeValidSeed();
  changedSeed.seedValue = "alpha-seed-updated";
  changedSeed.pressures[0].intensity = 88;
  await fs.writeFile(
    path.resolve(worldRoot, "canon/world-seed.json"),
    `${JSON.stringify(changedSeed, null, 2)}\n`,
    "utf8",
  );

  const resumed = JSON.parse((await resumeTool.execute("resume", { sessionId: created.session.sessionId, actorId: "owner-1" })).content[0].text);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.session.runtimeMetadata.bootstrap.source, "worldSeed");
  assert.equal(resumed.session.runtimeMetadata.bootstrap.seed.seedFingerprint, beforeFingerprint);
  assert.deepEqual(resumed.session.deterministicLoop.questEconomy, beforeEconomy);
});
