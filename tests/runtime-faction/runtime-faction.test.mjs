import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

const ROOT_DIR = process.cwd();
const OUT_DIR = path.resolve(ROOT_DIR, ".tmp-test-dist-faction");

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

  const factionCanon = await importFromOut("src/faction-canon.js");
  const worldSeed = await importFromOut("src/runtime-core/world-seed.js");
  const pluginModule = await importFromOut("index.js");

  return {
    factionCanon,
    worldSeed,
    plugin: pluginModule.default,
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

async function writeYaml(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const rendered = YAML.stringify(value);
  await fs.writeFile(filePath, rendered.endsWith("\n") ? rendered : `${rendered}\n`, "utf8");
}

function makeValidFactionCanon() {
  return {
    schemaVersion: 1,
    worldId: "harbor-reach",
    factions: [
      {
        factionId: "tide-union",
        name: "Tide Union",
        enabled: true,
        homeLocationIds: ["dock-ward"],
        pressureAffinityIds: ["contraband-flow"],
        resources: 58,
        heat: 44,
        posture: "balanced",
      },
      {
        factionId: "hill-wardens",
        name: "Hill Wardens",
        enabled: true,
        homeLocationIds: ["iron-hill"],
        pressureAffinityIds: ["harbor-fever"],
        resources: 62,
        heat: 37,
        posture: "low_profile",
      },
    ],
  };
}

const modulesPromise = loadModules();

test("factions template fixture validates against world seed references", async () => {
  const { factionCanon, worldSeed } = await modulesPromise;
  const factionsRaw = await fs.readFile(path.resolve(ROOT_DIR, "examples/factions.template.yaml"), "utf8");
  const seedRaw = await fs.readFile(path.resolve(ROOT_DIR, "examples/world-seed.template.yaml"), "utf8");

  const validatedSeed = worldSeed.validateWorldSeed(YAML.parse(seedRaw));
  assert.equal(validatedSeed.ok, true);
  const references = factionCanon.buildFactionCanonReferenceIndexFromWorldSeed(validatedSeed.seed);

  const validatedFaction = factionCanon.validateFactionCanon(YAML.parse(factionsRaw), {
    references: {
      worldId: references.worldId,
      locationIds: references.locationIds,
      pressureIds: references.pressureIds,
    },
  });
  assert.equal(validatedFaction.ok, true);
});

test("missing canon/factions.yaml returns structured no-op fallback", async () => {
  const { plugin } = await modulesPromise;
  const worldRoot = "/tmp/trpg-runtime-v2-faction-missing-world";
  await fs.rm(worldRoot, { recursive: true, force: true });
  await fs.mkdir(worldRoot, { recursive: true });

  const tools = await setupPluginTools(plugin, worldRoot);
  const factionTick = tools.get("trpg_faction_tick");
  assert.ok(factionTick);

  const result = JSON.parse((await factionTick.execute("tick", { mode: "read-only", trigger: "scene_transition" })).content[0].text);
  assert.equal(result.ok, true);
  assert.equal(result.no_op, true);
  assert.equal(result.canonical_scaffold.status, "missing");
  assert.equal(result.canonical_scaffold.diagnostics.some((entry) => entry.code === "faction_canon_missing"), true);
});

test("invalid faction canon returns structured diagnostics without throwing", async () => {
  const { plugin } = await modulesPromise;
  const worldRoot = "/tmp/trpg-runtime-v2-faction-invalid-world";
  await fs.rm(worldRoot, { recursive: true, force: true });
  await fs.mkdir(path.resolve(worldRoot, "canon"), { recursive: true });

  await writeYaml(path.resolve(worldRoot, "canon/factions.yaml"), {
    schemaVersion: 1,
    worldId: "harbor-reach",
    factions: [
      {
        factionId: "dup-faction",
        name: "One",
        enabled: true,
        homeLocationIds: [],
        pressureAffinityIds: ["pressure-a"],
        resources: 50,
        heat: 40,
        posture: "balanced",
      },
      {
        factionId: "dup-faction",
        name: "Two",
        enabled: true,
        homeLocationIds: ["loc-a"],
        pressureAffinityIds: [],
        resources: 55,
        heat: 35,
        posture: "assertive",
      },
    ],
  });

  const tools = await setupPluginTools(plugin, worldRoot);
  const factionTick = tools.get("trpg_faction_tick");
  assert.ok(factionTick);

  const result = JSON.parse((await factionTick.execute("tick", { mode: "read-only", trigger: "scene_transition" })).content[0].text);
  assert.equal(result.ok, true);
  assert.equal(result.no_op, true);
  assert.equal(result.canonical_scaffold.status, "invalid");
  const codes = result.canonical_scaffold.diagnostics.map((entry) => entry.code);
  assert.equal(codes.includes("duplicate_faction_id"), true);
  assert.equal(codes.includes("faction_home_locations_empty"), true);
  assert.equal(codes.includes("faction_pressure_affinity_empty"), true);
});

test("enabled faction count zero returns no-op success", async () => {
  const { plugin } = await modulesPromise;
  const worldRoot = "/tmp/trpg-runtime-v2-faction-disabled-world";
  await fs.rm(worldRoot, { recursive: true, force: true });
  await fs.mkdir(path.resolve(worldRoot, "canon"), { recursive: true });

  const canon = makeValidFactionCanon();
  canon.factions[0].enabled = false;
  canon.factions[1].enabled = false;
  await writeYaml(path.resolve(worldRoot, "canon/factions.yaml"), canon);

  const tools = await setupPluginTools(plugin, worldRoot);
  const factionTick = tools.get("trpg_faction_tick");
  assert.ok(factionTick);

  const result = JSON.parse((await factionTick.execute("tick", { mode: "read-only", trigger: "scene_transition" })).content[0].text);
  assert.equal(result.ok, true);
  assert.equal(result.no_op, true);
  assert.equal(result.canonical_scaffold.status, "used");
  assert.equal(result.canonical_scaffold.enabled_factions, 0);
});

test("seed sync helper supports dry-run/apply and blocks overwrite without force", async () => {
  const { factionCanon, worldSeed } = await modulesPromise;
  const worldRoot = "/tmp/trpg-runtime-v2-faction-projector-world";
  await fs.rm(worldRoot, { recursive: true, force: true });
  await fs.mkdir(path.resolve(worldRoot, "canon"), { recursive: true });

  const seedSource = await fs.readFile(path.resolve(ROOT_DIR, "examples/world-seed.template.yaml"), "utf8");
  await fs.writeFile(path.resolve(worldRoot, "canon/world-seed.yaml"), seedSource, "utf8");

  const firstRun = runCapture(process.execPath, [
    "./scripts/scaffold-factions-from-seed.mjs",
    path.resolve(worldRoot, "canon/world-seed.yaml"),
    path.resolve(worldRoot, "canon/factions.yaml"),
  ]);
  assert.equal(firstRun.status, 0, `stdout:\n${firstRun.stdout}\nstderr:\n${firstRun.stderr}`);
  assert.match(firstRun.stdout, /factions scaffold sync dry-run completed/);
  const firstPayload = parseJsonPayload(firstRun.stdout);
  assert.equal(firstPayload.status, "dry_run");

  const maybeMissingAfterDryRun = await fs.stat(path.resolve(worldRoot, "canon")).catch(() => null);
  assert.ok(maybeMissingAfterDryRun);

  const applyRun = runCapture(process.execPath, [
    "./scripts/scaffold-factions-from-seed.mjs",
    path.resolve(worldRoot, "canon/world-seed.yaml"),
    path.resolve(worldRoot, "canon/factions.yaml"),
    "--apply",
  ]);
  assert.equal(applyRun.status, 0, `stdout:\n${applyRun.stdout}\nstderr:\n${applyRun.stderr}`);
  assert.match(applyRun.stdout, /factions scaffold sync applied/);

  const projectedRaw = await fs.readFile(path.resolve(worldRoot, "canon/factions.yaml"), "utf8");
  const projected = YAML.parse(projectedRaw);
  const validatedSeed = worldSeed.validateWorldSeed(YAML.parse(seedSource));
  assert.equal(validatedSeed.ok, true);
  const references = factionCanon.buildFactionCanonReferenceIndexFromWorldSeed(validatedSeed.seed);
  const validatedCanon = factionCanon.validateFactionCanon(projected, {
    references: {
      worldId: references.worldId,
      locationIds: references.locationIds,
      pressureIds: references.pressureIds,
    },
  });
  assert.equal(validatedCanon.ok, true);

  const secondRun = runCapture(process.execPath, [
    "./scripts/scaffold-factions-from-seed.mjs",
    path.resolve(worldRoot, "canon/world-seed.yaml"),
    path.resolve(worldRoot, "canon/factions.yaml"),
    "--apply",
  ]);
  assert.notEqual(secondRun.status, 0);
  assert.match(secondRun.stderr, /factions scaffold sync failed/);
  const payload = parseJsonPayload(secondRun.stderr);
  assert.equal(payload.status, "output_exists");
});

test("faction preflight helper validates template and reports missing file", () => {
  const validRun = runCapture(process.execPath, ["./scripts/validate-factions-canon.mjs", "examples/factions.template.yaml"]);
  assert.equal(validRun.status, 0, `stdout:\n${validRun.stdout}\nstderr:\n${validRun.stderr}`);
  assert.match(validRun.stdout, /factions canon valid/);
  const validPayload = parseJsonPayload(validRun.stdout);
  assert.equal(validPayload.ok, true);
  assert.equal(validPayload.status, "valid");

  const invalidRun = runCapture(process.execPath, ["./scripts/validate-factions-canon.mjs", "examples/not-found-factions.yaml"]);
  assert.notEqual(invalidRun.status, 0);
  assert.match(invalidRun.stderr, /factions canon invalid/);
  const invalidPayload = parseJsonPayload(invalidRun.stderr);
  assert.equal(invalidPayload.ok, false);
  assert.equal(invalidPayload.status, "invalid");
  assert.equal(invalidPayload.diagnostics.some((entry) => entry.code === "faction_canon_file_not_found"), true);
});

test("valid canonical factions enables minimum tick execution", async () => {
  const { plugin } = await modulesPromise;
  const worldRoot = "/tmp/trpg-runtime-v2-faction-valid-world";
  await fs.rm(worldRoot, { recursive: true, force: true });
  await fs.mkdir(path.resolve(worldRoot, "canon"), { recursive: true });
  await writeYaml(path.resolve(worldRoot, "canon/factions.yaml"), makeValidFactionCanon());

  const tools = await setupPluginTools(plugin, worldRoot);
  const factionTick = tools.get("trpg_faction_tick");
  assert.ok(factionTick);

  const result = JSON.parse((await factionTick.execute("tick", { mode: "read-only", trigger: "scene_transition" })).content[0].text);
  assert.equal(result.ok, true);
  assert.equal(result.canonical_scaffold.status, "used");
  assert.equal(result.no_op, false);
  assert.equal(Array.isArray(result.generated_events), true);
  assert.equal(result.generated_events.length >= 1, true);
  assert.equal(result.canonical_scaffold.provenance.seed_fingerprint, null);
  assert.equal(typeof result.canonical_scaffold.provenance.canon_fingerprint, "string");
  assert.equal(result.canonical_scaffold.provenance.drift_status, "missing_seed");
});
