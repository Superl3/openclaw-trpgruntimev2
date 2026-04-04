import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ROOT_DIR = process.cwd();
const OUT_DIR = path.resolve(ROOT_DIR, ".tmp-test-dist-tool-governance-guard");

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

async function loadModule() {
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  run(process.execPath, ["./node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--noEmit", "false", "--outDir", OUT_DIR]);
  const fileUrl = pathToFileURL(path.resolve(OUT_DIR, "src/runtime-adapter/openclaw/tool-governance-guard.js")).href;
  return import(fileUrl);
}

function createMemoryIdempotencyStore() {
  const map = new Map();
  const keyOf = (params) => `${params.sessionId}::${params.toolName}::${params.key}`;
  return {
    async get(params) {
      return map.get(keyOf(params)) ?? null;
    },
    async putProcessing(params) {
      map.set(keyOf(params), {
        payloadHash: params.payloadHash,
        status: "processing",
      });
    },
    async putDone(params) {
      map.set(keyOf(params), {
        payloadHash: params.payloadHash,
        status: "done",
        response: params.response,
      });
    },
  };
}

const modulePromise = loadModule();

test("mutating tool rejects missing idempotency key", async () => {
  const { runGovernedTool } = await modulePromise;
  let executed = 0;

  const result = await runGovernedTool({
    req: {
      toolName: "trpg_patch_apply",
      requestId: "req-1",
      actor: { id: "agent:trpg-v2", scope: "system" },
      input: { audit: { approved: true } },
      sessionId: "sess-1",
    },
    meta: {
      mutatesState: true,
      requiresSessionStates: ["ACTIVE"],
      allowedScopes: ["system"],
      requiresIdempotencyKey: true,
    },
    resolvers: {
      resolveSessionState: async () => "ACTIVE",
    },
    idempotencyStore: createMemoryIdempotencyStore(),
    execute: async () => {
      executed += 1;
      return { ok: true, applied: true };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "E_IDEMPOTENCY_KEY_REQUIRED");
  assert.equal(executed, 0);
});

test("same idempotency key replays cached result", async () => {
  const { runGovernedTool } = await modulePromise;
  const idempotencyStore = createMemoryIdempotencyStore();
  let executed = 0;

  const params = {
    req: {
      toolName: "trpg_panel_message_commit",
      requestId: "req-2",
      actor: { id: "agent:trpg-v2", scope: "system" },
      input: { sessionId: "sess-2", dispatchId: "dispatch-1" },
      sessionId: "sess-2",
      idempotencyKey: "idem-commit-1",
    },
    meta: {
      mutatesState: true,
      requiresSessionStates: ["ACTIVE"],
      allowedScopes: ["system"],
      requiresIdempotencyKey: true,
    },
    resolvers: {
      resolveSessionState: async () => "ACTIVE",
    },
    idempotencyStore,
    execute: async () => {
      executed += 1;
      return { ok: true, commitId: "commit-1" };
    },
  };

  const first = await runGovernedTool(params);
  const second = await runGovernedTool(params);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(first, second);
  assert.equal(executed, 1);
});

test("state version conflict returns standardized error", async () => {
  const { runGovernedTool } = await modulePromise;
  let executed = 0;

  const result = await runGovernedTool({
    req: {
      toolName: "trpg_panel_message_commit",
      requestId: "req-3",
      actor: { id: "agent:trpg-v2", scope: "system" },
      input: { sessionId: "sess-3", uiVersion: 7 },
      sessionId: "sess-3",
      idempotencyKey: "idem-commit-2",
      expectedStateVersion: 7,
    },
    meta: {
      mutatesState: true,
      requiresSessionStates: ["ACTIVE"],
      allowedScopes: ["system"],
      requiresIdempotencyKey: true,
      requiresExpectedStateVersion: true,
    },
    resolvers: {
      resolveSessionState: async () => "ACTIVE",
      resolveStateVersion: async () => 8,
    },
    idempotencyStore: createMemoryIdempotencyStore(),
    execute: async () => {
      executed += 1;
      return { ok: true, commitId: "commit-2" };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "E_STATE_VERSION_CONFLICT");
  assert.equal(executed, 0);
});
