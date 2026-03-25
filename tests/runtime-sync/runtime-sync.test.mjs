import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

const ROOT_DIR = process.cwd();
const OUT_DIR = path.resolve(ROOT_DIR, ".tmp-test-dist-sync");

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

function parseJsonPayload(output) {
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
  const factionCanon = await importFromOut("src/faction-canon.js");
  const pluginModule = await importFromOut("index.js");

  return {
    worldSeed,
    factionCanon,
    plugin: pluginModule.default,
  };
}

function makeValidSeed() {
  return {
    schemaVersion: 1,
    worldId: "world-sync-alpha",
    seedValue: "sync-seed-001",
    createdAtIso: "2026-03-24T00:00:00.000Z",
    generationProfile: {
      profileId: "baseline",
      pressureScalePercent: 100,
      locationVolatility: "mixed",
    },
    locations: [
      {
        locationId: "loc-a",
        tags: ["market"],
        baseline: { tension: 40, alertness: 35, accessibility: 60 },
        pressureAffinityIds: ["pressure-a"],
      },
      {
        locationId: "loc-b",
        tags: ["harbor"],
        baseline: { tension: 38, alertness: 32, accessibility: 66 },
        pressureAffinityIds: ["pressure-b"],
      },
      {
        locationId: "loc-c",
        tags: ["old-town"],
        baseline: { tension: 42, alertness: 36, accessibility: 58 },
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
      traceMaxEvents: 80,
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

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeYaml(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const rendered = YAML.stringify(value);
  await fs.writeFile(filePath, rendered.endsWith("\n") ? rendered : `${rendered}\n`, "utf8");
}

const modulesPromise = loadModules();

test("same seed + canon yields deterministic fingerprints and aligned drift", async () => {
  const { worldSeed, factionCanon } = await modulesPromise;
  const seed = makeValidSeed();
  const validatedSeed = worldSeed.validateWorldSeed(seed);
  assert.equal(validatedSeed.ok, true);

  const projected = factionCanon.projectFactionCanonFromWorldSeed(validatedSeed.seed);
  const firstSeedFp = worldSeed.buildWorldSeedFingerprint(validatedSeed.seed);
  const secondSeedFp = worldSeed.buildWorldSeedFingerprint(validatedSeed.seed);
  const firstCanonFp = factionCanon.buildFactionCanonFingerprint(projected);
  const secondCanonFp = factionCanon.buildFactionCanonFingerprint(projected);
  assert.equal(firstSeedFp, secondSeedFp);
  assert.equal(firstCanonFp, secondCanonFp);

  const drift = factionCanon.detectFactionCanonScaffoldDrift({
    seed: validatedSeed.seed,
    canon: projected,
  });
  assert.equal(drift.status, "aligned");
  assert.equal(drift.summary.changedScaffold, 0);
});

test("drift helper returns structured missing result when canon is absent", async () => {
  const worldRoot = "/tmp/trpg-runtime-v2-sync-missing-canon";
  await fs.rm(worldRoot, { recursive: true, force: true });
  const seed = makeValidSeed();
  await writeYaml(path.resolve(worldRoot, "canon/world-seed.yaml"), seed);

  const result = runCapture(process.execPath, [
    "./scripts/diff-factions-vs-seed.mjs",
    path.resolve(worldRoot, "canon/world-seed.yaml"),
    path.resolve(worldRoot, "canon/factions.yaml"),
  ]);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const payload = parseJsonPayload(result.stdout);
  assert.equal(payload.status, "missing_canon");
});

test("drift helper reports scaffold drift separately from operational divergence", async () => {
  const worldRoot = "/tmp/trpg-runtime-v2-sync-drift";
  await fs.rm(worldRoot, { recursive: true, force: true });

  const { worldSeed, factionCanon } = await modulesPromise;
  const seed = makeValidSeed();
  const validatedSeed = worldSeed.validateWorldSeed(seed);
  assert.equal(validatedSeed.ok, true);
  const canon = factionCanon.projectFactionCanonFromWorldSeed(validatedSeed.seed);
  canon.factions[0].posture = "assertive";
  canon.factions[0].resources = 91;
  canon.factions[0].heat = 15;

  await writeYaml(path.resolve(worldRoot, "canon/world-seed.yaml"), seed);
  await writeYaml(path.resolve(worldRoot, "canon/factions.yaml"), canon);

  const result = runCapture(process.execPath, [
    "./scripts/diff-factions-vs-seed.mjs",
    path.resolve(worldRoot, "canon/world-seed.yaml"),
    path.resolve(worldRoot, "canon/factions.yaml"),
  ]);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const payload = parseJsonPayload(result.stdout);
  assert.equal(payload.status, "drifted");
  assert.equal(payload.drift.summary.changedScaffold >= 1, true);
  assert.equal(payload.drift.summary.operationalDivergence >= 1, true);
});

test("sync helper dry-run does not mutate canonical file", async () => {
  const worldRoot = "/tmp/trpg-runtime-v2-sync-dry-run";
  await fs.rm(worldRoot, { recursive: true, force: true });
  await fs.mkdir(path.resolve(worldRoot, "canon"), { recursive: true });

  const seed = makeValidSeed();
  await writeYaml(path.resolve(worldRoot, "canon/world-seed.yaml"), seed);
  const initialCanon = {
    schemaVersion: 1,
    worldId: seed.worldId,
    factions: [
      {
        factionId: "faction-watch",
        name: "Faction Watch",
        enabled: true,
        homeLocationIds: ["loc-b"],
        pressureAffinityIds: ["pressure-b"],
        resources: 81,
        heat: 12,
        posture: "assertive",
      },
      {
        factionId: "faction-guild",
        name: "Faction Guild",
        enabled: true,
        homeLocationIds: ["loc-a"],
        pressureAffinityIds: ["pressure-a"],
        resources: 55,
        heat: 40,
        posture: "balanced",
      },
    ],
  };
  await writeYaml(path.resolve(worldRoot, "canon/factions.yaml"), initialCanon);
  const before = await fs.readFile(path.resolve(worldRoot, "canon/factions.yaml"), "utf8");

  const result = runCapture(process.execPath, [
    "./scripts/scaffold-factions-from-seed.mjs",
    path.resolve(worldRoot, "canon/world-seed.yaml"),
    path.resolve(worldRoot, "canon/factions.yaml"),
  ]);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const payload = parseJsonPayload(result.stdout);
  assert.equal(payload.status, "dry_run");
  assert.equal(payload.writeApplied, false);

  const after = await fs.readFile(path.resolve(worldRoot, "canon/factions.yaml"), "utf8");
  assert.equal(after, before);
});

test("sync helper apply updates scaffold fields and preserves resources/heat by default", async () => {
  const worldRoot = "/tmp/trpg-runtime-v2-sync-apply";
  await fs.rm(worldRoot, { recursive: true, force: true });
  await fs.mkdir(path.resolve(worldRoot, "canon"), { recursive: true });

  const { worldSeed, factionCanon } = await modulesPromise;
  const seed = makeValidSeed();
  const validatedSeed = worldSeed.validateWorldSeed(seed);
  assert.equal(validatedSeed.ok, true);
  const projected = factionCanon.projectFactionCanonFromWorldSeed(validatedSeed.seed);
  const legacyWatch = projected.factions.find((entry) => entry.factionId === "faction-watch");
  assert.ok(legacyWatch);
  legacyWatch.name = "Legacy Custom Name";
  legacyWatch.posture = "assertive";
  legacyWatch.resources = 93;
  legacyWatch.heat = 7;

  await writeYaml(path.resolve(worldRoot, "canon/world-seed.yaml"), seed);
  await writeYaml(path.resolve(worldRoot, "canon/factions.yaml"), projected);

  const result = runCapture(process.execPath, [
    "./scripts/scaffold-factions-from-seed.mjs",
    path.resolve(worldRoot, "canon/world-seed.yaml"),
    path.resolve(worldRoot, "canon/factions.yaml"),
    "--apply",
    "--force",
  ]);
  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const payload = parseJsonPayload(result.stdout);
  assert.equal(payload.status, "applied");
  assert.equal(payload.policy, "preserve_operational");

  const syncedRaw = await fs.readFile(path.resolve(worldRoot, "canon/factions.yaml"), "utf8");
  const syncedCanon = YAML.parse(syncedRaw);
  const syncedWatch = syncedCanon.factions.find((entry) => entry.factionId === "faction-watch");
  const projectedWatch = factionCanon.projectFactionCanonFromWorldSeed(validatedSeed.seed).factions.find((entry) => entry.factionId === "faction-watch");
  assert.ok(syncedWatch);
  assert.ok(projectedWatch);
  assert.equal(syncedWatch.name, projectedWatch.name);
  assert.equal(syncedWatch.posture, projectedWatch.posture);
  assert.equal(syncedWatch.resources, 93);
  assert.equal(syncedWatch.heat, 7);
});

test("runtime canonical provenance persists across new + resume", async () => {
  const { plugin, worldSeed, factionCanon } = await modulesPromise;
  const worldRoot = "/tmp/trpg-runtime-v2-sync-runtime-provenance";
  await fs.rm(worldRoot, { recursive: true, force: true });
  await fs.mkdir(path.resolve(worldRoot, "canon"), { recursive: true });
  await fs.mkdir(path.resolve(worldRoot, "state/runtime-core"), { recursive: true });

  const seed = makeValidSeed();
  const validatedSeed = worldSeed.validateWorldSeed(seed);
  assert.equal(validatedSeed.ok, true);
  const canon = factionCanon.projectFactionCanonFromWorldSeed(validatedSeed.seed);

  await writeJson(path.resolve(worldRoot, "canon/world-seed.json"), seed);
  await writeJson(path.resolve(worldRoot, "canon/factions.json"), canon);
  await writeYaml(path.resolve(worldRoot, "canon/factions.yaml"), canon);

  const tools = await setupPluginTools(plugin, worldRoot);
  const newTool = tools.get("trpg_session_new");
  const resumeTool = tools.get("trpg_session_resume");
  assert.ok(newTool && resumeTool);

  const created = JSON.parse((await newTool.execute("new", {
    channelKey: "discord:sync-provenance",
    ownerId: "owner-1",
  })).content[0].text);

  assert.equal(created.ok, true);
  const canonicalSync = created.session.runtimeMetadata.canonicalSync;
  assert.ok(canonicalSync);
  assert.equal(typeof canonicalSync.seedFingerprint, "string");
  assert.equal(typeof canonicalSync.canonFingerprint, "string");
  assert.equal(canonicalSync.sourcePolicy, "canon_authoritative");

  const resumed = JSON.parse((await resumeTool.execute("resume", {
    sessionId: created.session.sessionId,
    actorId: "owner-1",
  })).content[0].text);
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.session.runtimeMetadata.canonicalSync, canonicalSync);
});
