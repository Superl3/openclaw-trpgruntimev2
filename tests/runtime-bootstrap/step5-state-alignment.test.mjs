import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ROOT_DIR = process.cwd();
const OUT_DIR = path.resolve(ROOT_DIR, ".tmp-test-dist-step5");

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

async function loadPluginBundle() {
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  run(process.execPath, ["./node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--noEmit", "false", "--outDir", OUT_DIR]);
  const moduleUrl = pathToFileURL(path.resolve(OUT_DIR, "src/index.js")).href;
  const pluginModule = await import(moduleUrl);
  return pluginModule.default;
}

async function writeWorldFile(worldRoot, relPath, content) {
  const absolute = path.resolve(worldRoot, relPath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, "utf8");
}

async function invokeBeforePrompt(plugin, worldRoot, event, configOverrides = {}) {
  const handlers = new Map();
  const toolCtx = {
    agentId: "trpg",
    sessionId: "discord:test",
    userId: "owner-1",
  };
  const api = {
    pluginConfig: {
      worldRoot,
      allowedAgentIds: ["trpg"],
      ...configOverrides,
    },
    resolvePath: (input) => (input === "world" ? worldRoot : path.resolve(input)),
    logger: { info: () => {}, warn: () => {} },
    on: (name, handler) => handlers.set(name, handler),
    registerTool: (factory) => {
      factory(toolCtx);
    },
  };

  plugin.register(api);
  const beforePrompt = handlers.get("before_prompt_build");
  assert.ok(typeof beforePrompt === "function");
  return beforePrompt(event, toolCtx);
}

const pluginPromise = loadPluginBundle();

test("bootstrap completion syncs canon fields into state/player-status", async () => {
  const plugin = await pluginPromise;
  const worldRoot = path.resolve(ROOT_DIR, ".tmp-test-world-bootstrap-status-sync-step5");
  await fs.rm(worldRoot, { recursive: true, force: true });

  await writeWorldFile(worldRoot, "canon/player.yaml", "{}\n");
  await writeWorldFile(
    worldRoot,
    "state/player-status.yaml",
    [
      "meta:",
      "  schema_version: 1",
      "player_status:",
      "  money: 5",
      "  stamina: normal",
      "  condition: healthy",
      "  tags: []",
      "",
    ].join("\n"),
  );

  await invokeBeforePrompt(
    plugin,
    worldRoot,
    {
      prompt: "user: 이름: 리아\n배경: 떠돌이 밀수꾼\n이유: 빚을 갚으려 들어왔다\n비밀: 장부를 숨겼다\n두려움: 바다\n목표: 빚을 갚는다\n준비 완료",
      messages: [{ role: "user", content: "이름: 리아\n배경: 떠돌이 밀수꾼\n이유: 빚을 갚으려 들어왔다\n비밀: 장부를 숨겼다\n두려움: 바다\n목표: 빚을 갚는다\n준비 완료" }],
    },
    { allowPatchApply: true, canonicalWriteBackEnabled: true },
  );

  const statusText = await fs.readFile(path.resolve(worldRoot, "state/player-status.yaml"), "utf8");
  assert.equal(statusText.includes("name: 리아"), true);
  assert.equal(statusText.includes("goal: 빚을 갚는다"), true);
  assert.equal(statusText.includes("character_created: true"), true);
  assert.equal(statusText.includes("bootstrap_complete: true"), true);
});

test("status panel guidance prefers state/player-status profile fields while bootstrap mirror stays canon-synced", async () => {
  const plugin = await pluginPromise;
  const worldRoot = path.resolve(ROOT_DIR, ".tmp-test-world-status-panel-source-step5");
  await fs.rm(worldRoot, { recursive: true, force: true });

  await writeWorldFile(
    worldRoot,
    "canon/player.yaml",
    [
      "player:",
      "  name: CanonName",
      "  goal: CanonGoal",
      "game_state:",
      "  character_created: true",
      "  bootstrap_complete: true",
      "",
    ].join("\n"),
  );
  await writeWorldFile(
    worldRoot,
    "state/player-status.yaml",
    [
      "meta:",
      "  schema_version: 1",
      "  last_updated: 2026-03-28T00:00:00.000Z",
      "player_status:",
      "  name: StateName",
      "  current_goal: StateGoal",
      "  character_created: false",
      "  bootstrap_complete: false",
      "  money: 9",
      "  stamina: normal",
      "  condition: focused",
      "  tags:",
      "    - alert",
      "  bootstrap:",
      "    name: StateName",
      "    goal: StateGoal",
      "    character_created: false",
      "    bootstrap_complete: false",
      "status:",
      "  health:",
      "    current: 12",
      "    max: 12",
      "  stamina:",
      "    current: 10",
      "    max: 10",
      "  stress:",
      "    current: 1",
      "    max: 10",
      "  economy:",
      "    money: 9",
      "    funds: 9",
      "",
    ].join("\n"),
  );
  await writeWorldFile(
    worldRoot,
    "state/current-scene.yaml",
    [
      "scene:",
      "  id: scene-011",
      "  scene_flow:",
      "    player_setup_complete: true",
      "    intro_shown: true",
      "",
    ].join("\n"),
  );

  const result = await invokeBeforePrompt(plugin, worldRoot, {
    prompt: "user: 상태 확인",
    messages: [{ role: "user", content: "상태 확인" }],
  });
  const context = result?.appendSystemContext || "";
  const statusText = await fs.readFile(path.resolve(worldRoot, "state/player-status.yaml"), "utf8");

  assert.equal(statusText.includes("name: StateName"), true);
  assert.equal(statusText.includes("current_goal: StateGoal"), true);
  assert.equal(statusText.includes("goal: CanonGoal"), true);
  assert.equal(statusText.includes("character_created: true"), true);
  assert.equal(statusText.includes("bootstrap_complete: true"), true);
  assert.equal(context.includes("World time: 2026-03-28T00:00:00.000Z"), true);
  assert.equal(context.includes("Profile (state/player-status): StateName | Goal: StateGoal"), true);
  assert.equal(context.includes("Bootstrap flags (state/player-status): character_created=true | bootstrap_complete=true"), true);
  assert.equal(context.includes("[TRPG_RUNTIME_TURN_PIPELINE]"), true);
});
