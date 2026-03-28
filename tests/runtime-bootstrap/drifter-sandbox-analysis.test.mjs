import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ROOT_DIR = process.cwd();

async function importAnalysisModule() {
  const moduleUrl = pathToFileURL(path.resolve(ROOT_DIR, "scripts/lib/drifter-sandbox-analysis.mjs")).href;
  return import(moduleUrl);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("summarizeDrifterSandbox emits diff summary with promotion candidates", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "drifter-analysis-"));
  const sourceRepoRoot = path.join(tempRoot, "repo-source");
  const sourceWorldRoot = path.join(tempRoot, "world-source");
  const sandboxRoot = path.join(tempRoot, "sandbox");
  const reportsRoot = path.join(sandboxRoot, "reports");
  const artifactsRoot = path.join(sandboxRoot, "artifacts");
  const transcriptsRoot = path.join(sandboxRoot, "session", "transcripts");
  const sandboxWorldRoot = path.join(sandboxRoot, "world", "base");

  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  await fs.mkdir(path.join(sourceWorldRoot, "canon"), { recursive: true });
  await fs.writeFile(path.join(sourceWorldRoot, "canon", "player.yaml"), "hp: 10\n", "utf8");
  await fs.mkdir(sandboxWorldRoot, { recursive: true });
  await fs.mkdir(path.join(sandboxWorldRoot, "canon"), { recursive: true });
  await fs.writeFile(path.join(sandboxWorldRoot, "canon", "player.yaml"), "hp: 11\n", "utf8");
  await fs.writeFile(path.join(sandboxWorldRoot, "canon", "quest.yaml"), "quest: opened\n", "utf8");
  await fs.mkdir(reportsRoot, { recursive: true });
  await fs.mkdir(artifactsRoot, { recursive: true });
  await fs.mkdir(transcriptsRoot, { recursive: true });
  await fs.writeFile(path.join(artifactsRoot, "run-gamer-smoke-live.stderr.log"), "timed out once\n", "utf8");
  await fs.writeFile(path.join(artifactsRoot, "run-gamer-smoke-live.stdout.log"), "ok\n", "utf8");
  await fs.writeFile(path.join(transcriptsRoot, "drifter-session-1.json"), "{}\n", "utf8");
  await writeJson(path.join(reportsRoot, "report.machine.json"), {
    runId: "run-1",
    summary: { passed: 0, failed: 1, turns: 1 },
    proposals: [
      {
        reasons: ["llm invalid/fallback observed (invalid=1, fallback=1)"],
        suggestedSettings: { temperature: 0 },
      },
    ],
  });
  await writeJson(path.join(sandboxRoot, "session", "launch-result.json"), {
    ok: false,
    agentProfilePath: path.join(sandboxRoot, "session", "drifter-sandbox.profile.json"),
    stderrPath: path.join(artifactsRoot, "run-gamer-smoke-live.stderr.log"),
    stdoutPath: path.join(artifactsRoot, "run-gamer-smoke-live.stdout.log"),
  });
  await writeJson(path.join(sandboxRoot, "sandbox-manifest.json"), {
    source: {
      repoRoot: sourceRepoRoot,
      worldSourceRoot: sourceWorldRoot,
    },
    layout: {
      sandboxRoot,
      worldBaseRoot: sandboxWorldRoot,
      reportsRoot,
      artifactsRoot,
      sessionRoot: path.join(sandboxRoot, "session"),
    },
    worktree: null,
  });

  const mod = await importAnalysisModule();
  const result = await mod.summarizeDrifterSandbox({ sandboxRoot });

  assert.equal(result.summary.worldDiff.changed.length, 1);
  assert.equal(result.summary.worldDiff.added.length, 1);
  assert.ok(result.summary.promotionCandidates.some((entry) => entry.kind === "world-change"));
  assert.ok(result.summary.promotionCandidates.some((entry) => entry.kind === "evidence-bundle"));
  await fs.access(result.output.jsonPath);
  await fs.access(result.output.markdownPath);
});
