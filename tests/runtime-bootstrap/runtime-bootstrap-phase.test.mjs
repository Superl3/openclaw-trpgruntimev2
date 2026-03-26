import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ROOT_DIR = process.cwd();
const OUT_DIR = path.resolve(ROOT_DIR, ".tmp-test-dist-bootstrap");

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
  return {
    plugin: pluginModule.default,
    testHooks: pluginModule.__internalTestHooks,
  };
}

async function writeWorldFile(worldRoot, relPath, content) {
  const absolute = path.resolve(worldRoot, relPath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, "utf8");
}

async function readRuntimeDiagnostics(worldRoot) {
  const diagnosticsPath = path.resolve(worldRoot, "state/runtime-core/diagnostics.jsonl");
  const raw = await fs.readFile(diagnosticsPath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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

async function invokeTool(plugin, worldRoot, toolName, params, configOverrides = {}) {
  const handlers = new Map();
  const tools = new Map();
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
    registerTool: (factory, meta) => {
      const spec = factory(toolCtx);
      const name = meta?.name || spec.name;
      tools.set(name, spec);
    },
  };

  plugin.register(api);
  const tool = tools.get(toolName);
  assert.ok(tool && typeof tool.execute === "function", `tool '${toolName}' must be registered`);
  return tool.execute("tc-1", params);
}

const pluginBundlePromise = loadPluginBundle();
const pluginPromise = pluginBundlePromise.then((bundle) => bundle.plugin);

test("bootstrap/ready/in-game phase branching injects component-first guidance", async () => {
  const plugin = await pluginPromise;
  const worldRoot = path.resolve(ROOT_DIR, ".tmp-test-world-bootstrap-abc");
  await fs.rm(worldRoot, { recursive: true, force: true });

  await writeWorldFile(worldRoot, "canon/player.yaml", "{}\n");
  let result = await invokeBeforePrompt(plugin, worldRoot, { prompt: "", messages: [] });
  let context = result?.appendSystemContext || "";
  assert.equal(context.includes("character_created=false"), true);
  assert.equal(context.includes("TRPG_DISCORD_COMPONENTS_BOOTSTRAP"), true);
  assert.equal(/PART\s*A/i.test(context), false);
  assert.equal(/PART\s*B/i.test(context), false);
  assert.equal(context.includes("이름 입력"), true);
  assert.equal(context.includes("TRPG_RUNTIME_STATUS_PANEL_V1"), false);
  assert.equal(context.includes("TRPG_RUNTIME_FREEFORM_RULE"), false);

  await writeWorldFile(
    worldRoot,
    "canon/player.yaml",
    [
      "player:",
      "  name: Aria",
      "game_state:",
      "  character_created: true",
      "  bootstrap_complete: false",
      "",
    ].join("\n"),
  );
  result = await invokeBeforePrompt(plugin, worldRoot, { prompt: "", messages: [] });
  context = result?.appendSystemContext || "";
  assert.equal(context.includes("character_created=true AND bootstrap_complete=false"), true);
  assert.equal(context.includes("TRPG_DISCORD_COMPONENTS_BOOTSTRAP"), true);
  assert.equal(/PART\s*A/i.test(context), false);
  assert.equal(context.includes("완료/다음 단계"), true);
  assert.equal(context.includes("TRPG_RUNTIME_STATUS_PANEL_V1"), false);

  await writeWorldFile(
    worldRoot,
    "canon/player.yaml",
    [
      "player:",
      "  name: Aria",
      "game_state:",
      "  character_created: true",
      "  bootstrap_complete: true",
      "",
    ].join("\n"),
  );
  await writeWorldFile(
    worldRoot,
    "state/current-scene.yaml",
    [
      "meta:",
      "  last_updated: 2026-03-25T08:30:00.000Z",
      "scene:",
      "  id: scene-001",
      "  scene_flow:",
      "    player_setup_complete: true",
      "    intro_shown: true",
      "",
    ].join("\n"),
  );

  result = await invokeBeforePrompt(plugin, worldRoot, {
    prompt: "user: 진행",
    messages: [{ role: "user", content: "진행" }],
  });
  context = result?.appendSystemContext || "";
  assert.equal(context.includes("TRPG_RUNTIME_STATUS_PANEL_V1"), true);
  assert.equal(context.includes("TRPG_DISCORD_COMPONENTS"), true);
  assert.equal(context.includes("TRPG_DISCORD_COMPONENTS_BOOTSTRAP"), false);
});

test("D/E in-game seed recovery and date priority", async () => {
  const plugin = await pluginPromise;
  const worldRoot = path.resolve(ROOT_DIR, ".tmp-test-world-bootstrap-recovery");
  await fs.rm(worldRoot, { recursive: true, force: true });

  await writeWorldFile(
    worldRoot,
    "canon/player.yaml",
    [
      "player:",
      "  name: Mina",
      "game_state:",
      "  character_created: true",
      "  bootstrap_complete: true",
      "",
    ].join("\n"),
  );
  await writeWorldFile(
    worldRoot,
    "state/current-scene.yaml",
    [
      "meta:",
      "  last_updated: 2026-03-25T09:00:00.000Z",
      "scene:",
      "  id: scene-002",
      "  scene_flow:",
      "    player_setup_complete: true",
      "    intro_shown: true",
      "",
    ].join("\n"),
  );

  await writeWorldFile(worldRoot, "state/player-status.yaml", ":::broken_yaml:::[\n");
  await writeWorldFile(worldRoot, "state/inventory.yaml", "inventory: [\n");

  const result = await invokeBeforePrompt(plugin, worldRoot, {
    prompt: "user: 상태 확인",
    messages: [{ role: "user", content: "상태 확인" }],
  });
  const context = result?.appendSystemContext || "";
  assert.equal(context.includes("World time:"), true);

  const statusText = await fs.readFile(path.resolve(worldRoot, "state/player-status.yaml"), "utf8");
  const inventoryText = await fs.readFile(path.resolve(worldRoot, "state/inventory.yaml"), "utf8");
  assert.equal(statusText.includes("health:"), true);
  assert.equal(statusText.includes("money:"), true);
  assert.equal(statusText.includes("stamina_state:"), true);
  assert.equal(inventoryText.includes("carried:"), true);
  assert.equal(inventoryText.includes("notes:"), true);

  await writeWorldFile(
    worldRoot,
    "state/player-status.yaml",
    [
      "meta:",
      "  last_updated: 2026-03-25T10:11:12.000Z",
      "player_status:",
      "  money: 33",
      "  stamina_state: normal",
      "  tags: []",
      "  condition: healthy",
      "status:",
      "  health:",
      "    current: 12",
      "    max: 12",
      "  stamina:",
      "    current: 10",
      "    max: 10",
      "  stress:",
      "    current: 0",
      "    max: 10",
      "  economy:",
      "    money: 33",
      "    funds: 33",
      "",
    ].join("\n"),
  );

  const resultPriority = await invokeBeforePrompt(plugin, worldRoot, {
    prompt: "user: 상태",
    messages: [{ role: "user", content: "상태" }],
  });
  const contextPriority = resultPriority?.appendSystemContext || "";
  assert.equal(contextPriority.includes("World time: 2026-03-25T10:11:12.000Z"), true);
});

test("scene components enforce system-phase UI in bootstrap", async () => {
  const plugin = await pluginPromise;
  const worldRoot = path.resolve(ROOT_DIR, ".tmp-test-world-bootstrap-components");
  await fs.rm(worldRoot, { recursive: true, force: true });
  await writeWorldFile(worldRoot, "canon/player.yaml", "{}\n");

  const toolResult = await invokeTool(plugin, worldRoot, "trpg_scene_components", {
    scene: "exploration",
    description: "아직 캐릭터를 만드는 중이다.",
    buttons: [
      { label: "🎯 성향 추천 선택", style: "secondary" },
      { label: "🆕 새 캐릭터 시작", style: "primary" },
    ],
    includeInput: false,
  });

  const payload = toolResult?.details ?? JSON.parse(toolResult?.content?.[0]?.text ?? "{}");
  assert.equal(payload.ok, true);
  assert.equal(payload.runtimePhase, "BOOTSTRAP");
  assert.equal(payload.components?.embeds?.[0]?.title, "⚙️ 시스템 안내");
  const buttons = (payload.components?.blocks ?? []).flatMap((entry) => entry?.buttons ?? []);
  const labels = buttons.map((entry) => entry.label);
  assert.equal(labels.includes("🎯 성향 추천 선택"), false);
  assert.equal(labels.includes("🔍 조사"), false);
  assert.equal(labels.includes("🪪 이름 입력"), true);
  assert.equal(labels.includes("🌍 배경/출신 입력"), true);
  assert.equal(labels.includes("🎯 현재 목표 입력"), true);
  assert.equal(labels.includes("✅ 완료/다음 단계"), true);
  const nonGameAllowedLabels = new Set(["🆕 새 캐릭터 시작", "📂 캐릭터 불러오기", "🧷 초기 정보 유지", "❌ 닫기"]);
  ["🪪 이름 입력", "🌍 배경/출신 입력", "🎯 현재 목표 입력", "✍️ 자유서술 입력", "✅ 완료/다음 단계"].forEach(
    (label) => nonGameAllowedLabels.add(label),
  );
  assert.equal(labels.every((label) => nonGameAllowedLabels.has(label)), true);
  const hasInventorySelect = (payload.components?.blocks ?? []).some((block) => Boolean(block?.select));
  assert.equal(hasInventorySelect, false);
  assert.equal(Boolean(payload.components?.modal), true);
  const modalFieldLabels = (payload.components?.modal?.fields ?? []).map((field) => field?.label ?? "");
  assert.equal(modalFieldLabels.includes("이름 입력"), true);
  assert.equal(modalFieldLabels.includes("배경/출신 입력"), true);
  assert.equal(modalFieldLabels.includes("현재 목표 입력"), true);
  assert.equal(modalFieldLabels.includes("자유서술 입력"), true);
});

test("bootstrap freeform extraction filters wrapper metadata/untrusted context", async () => {
  const { testHooks } = await pluginBundlePromise;
  assert.ok(testHooks && typeof testHooks.extractLatestUserMessageFromPrompt === "function");
  assert.ok(typeof testHooks.extractBootstrapFreeform === "function");

  const extracted = testHooks.extractLatestUserMessageFromPrompt(
    [
      "System: wrapper",
      "User: 나는 북부 항구에서 떠돌이 생활을 했어.",
      "지금은 길드 의뢰를 받아 정착하고 싶어.",
      "Current time: 2026-03-25T00:00:00Z",
      "Untrusted context: wrapper payload",
      "<pxml><meta><doc_id>doc_x</doc_id></meta></pxml>",
    ].join("\n"),
  );
  const freeform = testHooks.extractBootstrapFreeform(extracted);

  assert.equal(freeform.includes("북부 항구"), true);
  assert.equal(freeform.includes("길드 의뢰"), true);
  assert.equal(freeform.includes("Current time"), false);
  assert.equal(freeform.includes("Untrusted context"), false);
  assert.equal(freeform.includes("doc_id"), false);
});

test("non-game bootstrap template text is sanitized to safe guidance", async () => {
  const plugin = await pluginPromise;
  const worldRoot = path.resolve(ROOT_DIR, ".tmp-test-world-bootstrap-template-sanitize");
  await fs.rm(worldRoot, { recursive: true, force: true });
  await writeWorldFile(worldRoot, "canon/player.yaml", "{}\n");

  const toolResult = await invokeTool(plugin, worldRoot, "trpg_scene_components", {
    scene: "system",
    description:
      "좋아요, 새 캐릭터 생성을 시작할게요. PART A 먼저 진행합니다. PART B로 넘어갑니다. 1) 이름 2) 배경 3) 이유 4) 숨기고 있는 비밀 5) 두려움 6) 목표",
    includeInput: false,
  });

  const payload = toolResult?.details ?? JSON.parse(toolResult?.content?.[0]?.text ?? "{}");
  const desc = payload.components?.embeds?.[0]?.description ?? "";
  assert.equal(payload.ok, true);
  assert.equal(/PART\s*A/i.test(desc), false);
  assert.equal(/숨기고\s*있는\s*비밀/i.test(desc), false);
  assert.equal(/\b1\s*[\).:：-]/.test(desc), false);
  assert.equal(desc.includes("캐릭터 준비"), true);
});

test("non-game select allows safe dropdown and rejects invalid options", async () => {
  const plugin = await pluginPromise;
  const worldRoot = path.resolve(ROOT_DIR, ".tmp-test-world-bootstrap-select-normalization");
  await fs.rm(worldRoot, { recursive: true, force: true });
  await writeWorldFile(worldRoot, "canon/player.yaml", "{}\n");

  const safeResult = await invokeTool(plugin, worldRoot, "trpg_scene_components", {
    scene: "choice",
    description: "배경을 선택해 주세요.",
    choices: [
      { label: "항구 노동자", value: "bg_dock_worker" },
      { label: "길드 견습생", value: "bg_guild_apprentice" },
      { label: "변방 정찰병", value: "bg_scout" },
    ],
    includeInput: false,
  });
  const safePayload = safeResult?.details ?? JSON.parse(safeResult?.content?.[0]?.text ?? "{}");
  const safeSelectBlock = (safePayload.components?.blocks ?? []).find((block) => Boolean(block?.select));
  assert.ok(safeSelectBlock);
  assert.equal(Array.isArray(safeSelectBlock.select.options), true);
  assert.equal(safeSelectBlock.select.options.length, 3);

  const invalidResult = await invokeTool(plugin, worldRoot, "trpg_scene_components", {
    scene: "choice",
    description: "배경을 선택해 주세요.",
    choices: [
      { label: "x".repeat(90), value: "bg_invalid_label" },
      { label: "정상 옵션", value: "bg_valid" },
    ],
    includeInput: false,
  });
  const invalidPayload = invalidResult?.details ?? JSON.parse(invalidResult?.content?.[0]?.text ?? "{}");
  const invalidHasSelect = (invalidPayload.components?.blocks ?? []).some((block) => Boolean(block?.select));
  const invalidButtons = (invalidPayload.components?.blocks ?? []).flatMap((block) => block?.buttons ?? []);
  assert.equal(invalidHasSelect, false);
  assert.equal(invalidButtons.some((button) => button.label === "🆕 새 캐릭터 시작"), true);
});

test("stored polluted freeform_description is sanitized on read path immediately", async () => {
  const plugin = await pluginPromise;
  const worldRoot = path.resolve(ROOT_DIR, ".tmp-test-world-bootstrap-freeform-read-sanitize");
  await fs.rm(worldRoot, { recursive: true, force: true });

  await writeWorldFile(
    worldRoot,
    "canon/player.yaml",
    [
      "player:",
      "  name: Aria",
      "  freeform_description: |",
      "    좋아요, 새 캐릭터 생성을 시작할게요. PART A",
      "    1) 이름 2) 배경 3) 이유 4) 숨기고 있는 비밀 5) 두려움 6) 목표",
      "game_state:",
      "  character_created: true",
      "  bootstrap_complete: false",
      "",
    ].join("\n"),
  );

  await invokeBeforePrompt(
    plugin,
    worldRoot,
    {
      prompt: "",
      messages: [],
    },
    { allowPatchApply: true, canonicalWriteBackEnabled: true },
  );

  const persisted = await fs.readFile(path.resolve(worldRoot, "canon/player.yaml"), "utf8");
  assert.equal(/PART\s*A/i.test(persisted), false);
  assert.equal(/숨기고\s*있는\s*비밀/i.test(persisted), false);
});

test("final component output guard sanitizes forbidden bootstrap template in in-game path", async () => {
  const plugin = await pluginPromise;
  const worldRoot = path.resolve(ROOT_DIR, ".tmp-test-world-bootstrap-final-output-guard");
  await fs.rm(worldRoot, { recursive: true, force: true });

  await writeWorldFile(
    worldRoot,
    "canon/player.yaml",
    [
      "player:",
      "  name: Mina",
      "game_state:",
      "  character_created: true",
      "  bootstrap_complete: true",
      "",
    ].join("\n"),
  );
  await writeWorldFile(
    worldRoot,
    "state/current-scene.yaml",
    [
      "scene:",
      "  id: scene-guard-001",
      "  scene_flow:",
      "    player_setup_complete: true",
      "    intro_shown: true",
      "",
    ].join("\n"),
  );

  const toolResult = await invokeTool(plugin, worldRoot, "trpg_scene_components", {
    scene: "exploration",
    description:
      "좋아요, 새 캐릭터 생성을 시작할게요. PART A/B 진행. 1) 이름 2) 배경 3) 이유 4) 숨기고 있는 비밀 5) 두려움 6) 목표",
    includeInput: false,
  });

  const payload = toolResult?.details ?? JSON.parse(toolResult?.content?.[0]?.text ?? "{}");
  const desc = payload.components?.embeds?.[0]?.description ?? "";
  assert.equal(payload.runtimePhase, "IN_GAME");
  assert.equal(/PART\s*A/i.test(desc), false);
  assert.equal(/숨기고\s*있는\s*비밀/i.test(desc), false);
  assert.equal(desc.includes("캐릭터 준비"), true);
});

test("stale intro_shown does not force IN_GAME phase", async () => {
  const plugin = await pluginPromise;
  const worldRoot = path.resolve(ROOT_DIR, ".tmp-test-world-bootstrap-stale-intro");
  await fs.rm(worldRoot, { recursive: true, force: true });

  await writeWorldFile(
    worldRoot,
    "canon/player.yaml",
    [
      "player:",
      "  name: Aria",
      "game_state:",
      "  character_created: true",
      "  bootstrap_complete: false",
      "",
    ].join("\n"),
  );
  await writeWorldFile(
    worldRoot,
    "state/current-scene.yaml",
    [
      "scene:",
      "  id: scene-010",
      "  scene_flow:",
      "    player_setup_complete: false",
      "    intro_shown: true",
      "",
    ].join("\n"),
  );

  const result = await invokeBeforePrompt(plugin, worldRoot, {
    prompt: "user: 진행",
    messages: [{ role: "user", content: "진행" }],
  });
  const context = result?.appendSystemContext || "";
  assert.equal(context.includes("character_created=true AND bootstrap_complete=false"), true);
  assert.equal(context.includes("TRPG_RUNTIME_STATUS_PANEL_V1"), false);
  assert.equal(context.includes("TRPG_DISCORD_COMPONENTS_BOOTSTRAP"), true);
});

test("before_prompt_build uses session workspace as effective worldRoot", async () => {
  const plugin = await pluginPromise;
  const worldRoot = path.resolve(ROOT_DIR, ".tmp-test-world-effective-root");
  const workspaceRoot = path.resolve(worldRoot, "state/runtime-core/session-workspaces/discord-test");
  await fs.rm(worldRoot, { recursive: true, force: true });

  await writeWorldFile(
    worldRoot,
    "canon/player.yaml",
    [
      "player:",
      "  name: CanonBootstrap",
      "game_state:",
      "  character_created: false",
      "  bootstrap_complete: false",
      "",
    ].join("\n"),
  );

  await writeWorldFile(
    workspaceRoot,
    "canon/player.yaml",
    [
      "player:",
      "  name: WorkspaceHero",
      "game_state:",
      "  character_created: true",
      "  bootstrap_complete: true",
      "",
    ].join("\n"),
  );
  await writeWorldFile(
    workspaceRoot,
    "state/current-scene.yaml",
    [
      "scene:",
      "  id: scene-workspace-001",
      "  scene_flow:",
      "    player_setup_complete: true",
      "    intro_shown: true",
      "",
    ].join("\n"),
  );
  await writeWorldFile(
    worldRoot,
    "state/runtime-core/session-workspaces.json",
    JSON.stringify(
      {
        schemaVersion: 1,
        updatedAt: "2026-03-26T00:00:00.000Z",
        mappings: {
          "discord:test": {
            sessionContextId: "discord:test",
            workspaceRoot,
            createdAt: "2026-03-26T00:00:00.000Z",
            updatedAt: "2026-03-26T00:00:00.000Z",
            lastSessionId: "sess-workspace",
          },
        },
      },
      null,
      2,
    ) + "\n",
  );

  const result = await invokeBeforePrompt(plugin, worldRoot, {
    prompt: "user: 진행",
    messages: [{ role: "user", content: "진행" }],
  });
  const context = result?.appendSystemContext || "";

  assert.equal(context.includes("TRPG_RUNTIME_STATUS_PANEL_V1"), true);
  assert.equal(context.includes("TRPG_DISCORD_COMPONENTS_BOOTSTRAP"), false);
});

test("runtime diagnostics writes bootstrap + scene-component core events", async () => {
  const plugin = await pluginPromise;
  const worldRoot = path.resolve(ROOT_DIR, ".tmp-test-world-runtime-diagnostics");
  await fs.rm(worldRoot, { recursive: true, force: true });
  await writeWorldFile(worldRoot, "canon/player.yaml", "{}\n");

  await invokeBeforePrompt(plugin, worldRoot, {
    prompt: "user: 캐릭터 준비",
    messages: [{ role: "user", content: "캐릭터 준비" }],
  });

  await invokeTool(plugin, worldRoot, "trpg_scene_components", {
    scene: "exploration",
    description: "준비 단계",
    buttons: [{ label: "🔍 조사", style: "secondary" }],
  });

  const diagnosticsPath = path.resolve(worldRoot, "state/runtime-core/diagnostics.jsonl");
  await fs.access(diagnosticsPath);
  const diagnostics = await readRuntimeDiagnostics(worldRoot);
  const events = diagnostics.map((entry) => entry.event);

  assert.equal(events.includes("before_prompt_build_start"), true);
  assert.equal(events.includes("before_prompt_build_branch_selected"), true);
  assert.equal(events.includes("bootstrap_phase_judgement"), true);
  assert.equal(events.includes("scene_components_normalized"), true);
});

test("runtime diagnostics write failure does not break scene component flow", async () => {
  const plugin = await pluginPromise;
  const worldRoot = path.resolve(ROOT_DIR, ".tmp-test-world-runtime-diagnostics-write-fail");
  await fs.rm(worldRoot, { recursive: true, force: true });
  await writeWorldFile(worldRoot, "canon/player.yaml", "{}\n");
  await writeWorldFile(worldRoot, "state/runtime-core", "blocked-as-file\n");

  const originalWarn = console.warn;
  let warnCount = 0;
  console.warn = () => {
    warnCount += 1;
  };

  try {
    const toolResult = await invokeTool(plugin, worldRoot, "trpg_scene_components", {
      scene: "system",
      description: "진단 로그 실패 허용",
    });
    const payload = toolResult?.details ?? JSON.parse(toolResult?.content?.[0]?.text ?? "{}");
    assert.equal(payload.ok, true);
    assert.equal(warnCount > 0, true);
  } finally {
    console.warn = originalWarn;
  }
});
