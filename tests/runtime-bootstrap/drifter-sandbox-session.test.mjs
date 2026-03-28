import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT_DIR = process.cwd();
const RUN_GAMER_SCRIPT = path.resolve(ROOT_DIR, "scripts", "run-gamer-smoke-live.mjs");
const RUN_SANDBOX_SESSION_SCRIPT = path.resolve(ROOT_DIR, "scripts", "run-drifter-sandbox-session.mjs");

function runNode(scriptPath, args, cwd = ROOT_DIR) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
}

test("run-gamer-smoke-live can target a provided world root and emit transcript artifacts", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "trpg-drifter-world-root-"));
  const worldRoot = path.join(tempRoot, "world");
  const transcriptDir = path.join(tempRoot, "transcripts");
  await fs.mkdir(path.join(worldRoot, "state", "runtime-core"), { recursive: true });

  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const result = runNode(RUN_GAMER_SCRIPT, [
    "--lane", "deterministic",
    "--scenario", "happy",
    "--turns", "1",
    "--world-root", worldRoot,
    "--preserve-world-root",
    "--transcript-dir", transcriptDir,
    "--transcript-prefix", "smoke",
  ]);

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  const transcriptFiles = await fs.readdir(transcriptDir);
  assert.equal(transcriptFiles.length, 1);
  assert.match(transcriptFiles[0], /^smoke-.*\.json$/);

  const transcript = JSON.parse(await fs.readFile(path.join(transcriptDir, transcriptFiles[0]), "utf8"));
  assert.equal(transcript.summary.passed, 1);
  assert.equal(Array.isArray(transcript.turnTranscripts), true);
  assert.equal(transcript.turnTranscripts.length, 1);

  await fs.access(worldRoot);
  await fs.access(path.join(worldRoot, "state", "runtime-core"));
});

test("run-drifter-sandbox-session writes world, reports, transcripts, and logs into sandbox", async (t) => {
  const worldSourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "trpg-drifter-world-source-"));
  await fs.mkdir(path.join(worldSourceRoot, "canon"), { recursive: true });
  await fs.writeFile(path.join(worldSourceRoot, "canon", "player.yaml"), "name: sandbox-runner\n", "utf8");

  t.after(async () => {
    await fs.rm(worldSourceRoot, { recursive: true, force: true });
  });

  const result = runNode(RUN_SANDBOX_SESSION_SCRIPT, [
    "--repo", ROOT_DIR,
    "--world", worldSourceRoot,
    "--lane", "deterministic",
    "--scenario", "happy",
    "--turns", "1",
    "--improve", "shadow",
    "--no-worktree",
  ]);

  assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);

  const sandboxRoot = payload.manifest.layout.sandboxRoot;
  const reportsRoot = payload.launchSummary.reportsRoot;
  const transcriptsRoot = payload.launchSummary.transcriptsRoot;
  const artifactsRoot = payload.launchSummary.artifactsRoot;
  const worldRoot = payload.launchSummary.worldRoot;

  const reportEntries = await fs.readdir(reportsRoot);
  assert.ok(reportEntries.some((entry) => entry.startsWith("drifter-session-shadow-")));

  const transcriptEntries = await fs.readdir(transcriptsRoot);
  assert.ok(transcriptEntries.some((entry) => entry.startsWith("drifter-session-")));

  await fs.access(path.join(artifactsRoot, "run-gamer-smoke-live.stdout.log"));
  await fs.access(path.join(artifactsRoot, "run-gamer-smoke-live.stderr.log"));

  const copiedPlayer = await fs.readFile(path.join(worldRoot, "canon", "player.yaml"), "utf8");
  assert.match(copiedPlayer, /sandbox-runner/);

  const launchResult = JSON.parse(await fs.readFile(path.join(sandboxRoot, "session", "launch-result.json"), "utf8"));
  assert.equal(launchResult.ok, true);
});
