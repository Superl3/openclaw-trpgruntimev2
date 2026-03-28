import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runSmokeSessionValidation,
  validateSmokeMirrorContract,
  validateSmokeReport,
} from "../../scripts/validate-smoke-session.mjs";
import {
  copySectionData,
  deleteSectionDataFromWorkspace,
  ensureSessionWorkspace,
} from "../../src/runtime-core/session-workspaces.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const SAMPLE_REPORT = path.join(
  ROOT,
  "runtime/reports/drifter-human-runtime-shadow-20260327-031206/report.machine.json",
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("smoke report validator accepts existing sample report", async () => {
  const result = await runSmokeSessionValidation(SAMPLE_REPORT);
  assert.equal(result.ok, true);
  assert.equal(result.summary.errors, 0);
});

test("smoke report validator catches route/session drift", async () => {
  const base = clone(JSON.parse(await (await import("node:fs/promises")).readFile(SAMPLE_REPORT, "utf8")));
  base.turnTranscripts[0].sent.customId = "trpg:v1:sess-other:1:scene-bootstrap:action.wait";

  const result = validateSmokeReport(base);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "turn.route_session_mismatch"));
});

test("smoke report validator catches modal/button routing mismatch", async () => {
  const base = clone(JSON.parse(await (await import("node:fs/promises")).readFile(SAMPLE_REPORT, "utf8")));
  const modalTurn = base.turnTranscripts.find((entry) => entry.sent?.type === "modal");
  assert.ok(modalTurn, "sample report must contain a modal turn");
  modalTurn.sent.customId = `trpg:v1:${modalTurn.received.sessionId}:${modalTurn.received.uiVersion}:${modalTurn.received.sceneId}:action.wait`;

  const result = validateSmokeReport(base);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "turn.modal_route"));
});

test("smoke mirror contract is still in expected shape", async () => {
  const result = await validateSmokeMirrorContract();
  assert.equal(result.issues.length, 0);
});

test("session workspace isolation keeps canonical files unchanged", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "trpg-smoke-isolation-"));
  const canonicalWorldRoot = path.join(tempRoot, "world");

  await fs.mkdir(path.join(canonicalWorldRoot, "canon"), { recursive: true });
  await fs.mkdir(path.join(canonicalWorldRoot, "state"), { recursive: true });
  await fs.writeFile(path.join(canonicalWorldRoot, "canon/player.yaml"), "name: Canon Hero\n", "utf8");
  await fs.writeFile(path.join(canonicalWorldRoot, "state/player-status.yaml"), "hp: 10\n", "utf8");
  await fs.writeFile(path.join(canonicalWorldRoot, "state/inventory.yaml"), "gold: 3\n", "utf8");
  await fs.writeFile(path.join(canonicalWorldRoot, "state/current-scene.yaml"), "scene: intro\n", "utf8");

  const record = await ensureSessionWorkspace({
    canonicalWorldRoot,
    sessionContextId: "discord:chan-1:user-1",
    sessionId: "sess-1",
  });

  await fs.writeFile(path.join(record.workspaceRoot, "canon/player.yaml"), "name: Sandbox Hero\n", "utf8");
  await deleteSectionDataFromWorkspace({
    workspaceRoot: record.workspaceRoot,
    sections: ["inventory"],
  });
  await copySectionData({
    fromWorldRoot: canonicalWorldRoot,
    toWorldRoot: record.workspaceRoot,
    sections: ["status"],
  });

  const canonicalPlayer = await fs.readFile(path.join(canonicalWorldRoot, "canon/player.yaml"), "utf8");
  const canonicalInventory = await fs.readFile(path.join(canonicalWorldRoot, "state/inventory.yaml"), "utf8");
  const sandboxPlayer = await fs.readFile(path.join(record.workspaceRoot, "canon/player.yaml"), "utf8");

  assert.equal(canonicalPlayer, "name: Canon Hero\n");
  assert.equal(canonicalInventory, "gold: 3\n");
  assert.equal(sandboxPlayer, "name: Sandbox Hero\n");
});
