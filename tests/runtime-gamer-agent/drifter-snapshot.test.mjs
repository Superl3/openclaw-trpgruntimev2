import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDrifterSnapshot,
  replayDrifterSnapshot,
  restoreDrifterSnapshot,
} from "../../src/runtime-core/drifter-snapshot.ts";

async function seedWorkspace(root) {
  await fs.mkdir(path.join(root, "canon"), { recursive: true });
  await fs.mkdir(path.join(root, "state/runtime-core"), { recursive: true });
  await fs.writeFile(path.join(root, "canon/player.yaml"), "name: Drifter\n", "utf8");
  await fs.writeFile(path.join(root, "state/player-status.yaml"), "hp: 9\n", "utf8");
  await fs.writeFile(path.join(root, "state/inventory.yaml"), "gold: 4\n", "utf8");
  await fs.writeFile(path.join(root, "state/current-scene.yaml"), "scene: gate\n", "utf8");
  await fs.writeFile(
    path.join(root, "state/runtime-core/checkpoint0-store.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      sessions: {
        "sess-1": {
          schemaVersion: 1,
          sessionId: "sess-1",
          channelKey: "sandbox:drifter",
          ownerId: "drifter",
          status: "active",
          sceneId: "scene-gate",
          uiVersion: 3,
          actionSeq: 2,
          turnIndex: 2,
          lastActionId: "action.wait",
          lastActionSummary: "waited at gate",
          deterministicLoop: {},
          runtimeMetadata: { bootstrap: { source: "default", seed: null, diagnostics: [] }, canonicalSync: {} },
          presentation: { verboseMode: false },
          panelDispatch: { pending: null, committedDispatchIds: [] },
          trace: {
            maxEvents: 10,
            events: [
              {
                traceId: "t1",
                tsIso: "2026-03-28T10:00:00.000Z",
                lane: "engine",
                type: "engine.action.resolved",
                severity: "info",
                data: { actionId: "action.wait", resultSummary: "waited at gate" },
              },
            ],
          },
          panels: {},
          createdAt: "2026-03-28T09:59:00.000Z",
          updatedAt: "2026-03-28T10:00:00.000Z",
          endedAt: null,
        },
      },
      channelIndex: {},
      routes: {},
    }, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(root, "state/runtime-core/diagnostics.jsonl"), '{"event":"ok"}\n', "utf8");
}

test("create snapshot captures sandbox world/runtime state and replay manifest", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "trpg-drifter-snapshot-"));
  await seedWorkspace(workspaceRoot);

  const reportPath = path.join(workspaceRoot, "report.machine.json");
  await fs.writeFile(
    reportPath,
    `${JSON.stringify({
      generatedAt: "2026-03-28T10:01:00.000Z",
      turnTranscripts: [
        {
          received: { sessionId: "sess-1", textSummary: "panel" },
          sent: { actionId: "action.wait", label: "Wait" },
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  const manifest = await createDrifterSnapshot({
    workspaceRoot,
    sessionId: "sess-1",
    label: "gate-checkpoint",
    reportPaths: [reportPath],
  });

  assert.equal(manifest.sessionId, "sess-1");
  assert.equal(manifest.sessionStateFound, true);
  assert.ok(manifest.capturedFiles.some((item) => item.sourceRelativePath === "canon/player.yaml"));
  assert.ok(manifest.capturedFiles.some((item) => item.sourceRelativePath === "state/runtime-core/checkpoint0-store.json"));
  assert.equal(manifest.replay.lastActionId, "action.wait");
  assert.equal(manifest.replay.steps.length, 1);
});

test("restore snapshot reapplies captured sandbox files", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "trpg-drifter-restore-"));
  await seedWorkspace(workspaceRoot);
  const manifest = await createDrifterSnapshot({ workspaceRoot, sessionId: "sess-1" });

  await fs.writeFile(path.join(workspaceRoot, "canon/player.yaml"), "name: Mutated\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "state/player-status.yaml"), "hp: 1\n", "utf8");

  const result = await restoreDrifterSnapshot({ workspaceRoot, snapshotRoot: manifest.snapshotRoot });
  const player = await fs.readFile(path.join(workspaceRoot, "canon/player.yaml"), "utf8");
  const status = await fs.readFile(path.join(workspaceRoot, "state/player-status.yaml"), "utf8");

  assert.ok(result.restoredFiles.includes("canon/player.yaml"));
  assert.equal(player, "name: Drifter\n");
  assert.equal(status, "hp: 9\n");
});

test("replay snapshot materializes payload into isolated replay directory", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "trpg-drifter-replay-"));
  await seedWorkspace(workspaceRoot);
  const manifest = await createDrifterSnapshot({ workspaceRoot, sessionId: "sess-1" });

  const replay = await replayDrifterSnapshot({
    workspaceRoot,
    snapshotRoot: manifest.snapshotRoot,
    outputDirName: "replay-test",
  });

  const replayPlayer = await fs.readFile(path.join(replay.replayRoot, "canon/player.yaml"), "utf8");
  const replayDoc = JSON.parse(await fs.readFile(replay.replayManifestPath, "utf8"));

  assert.equal(replayPlayer, "name: Drifter\n");
  assert.equal(replayDoc.snapshotId, manifest.snapshotId);
  assert.equal(replayDoc.replay.steps.length, 1);
});
