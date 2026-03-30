import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const ROOT_DIR = process.cwd();

async function importSandboxModule() {
  const moduleUrl = pathToFileURL(path.resolve(ROOT_DIR, "scripts/lib/drifter-sandbox.mjs")).href;
  return import(moduleUrl);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function makeFixtureRepo(name) {
  const repoRoot = await fs.mkdtemp(path.resolve(os.tmpdir(), `${name}-repo-`));
  run("git", ["init", "-b", "main"], repoRoot);
  run("git", ["config", "user.name", "Test User"], repoRoot);
  run("git", ["config", "user.email", "test@example.com"], repoRoot);
  await fs.writeFile(path.resolve(repoRoot, "README.md"), "# fixture\n", "utf8");
  await fs.mkdir(path.resolve(repoRoot, "world", "state"), { recursive: true });
  await fs.writeFile(path.resolve(repoRoot, "world", "state", "player-status.yaml"), "hp: 10\n", "utf8");
  run("git", ["add", "."], repoRoot);
  run("git", ["commit", "-m", "fixture"], repoRoot);
  return repoRoot;
}

test("createDrifterSandbox creates disposable layout with worktree and world copy", async () => {
  const repoRoot = await makeFixtureRepo("drifter-sandbox-layout");
  const sandboxParentRoot = await fs.mkdtemp(path.resolve(os.tmpdir(), "drifter-sandbox-parent-"));
  const worldSourceRoot = path.resolve(repoRoot, "world");
  const mod = await importSandboxModule();

  const manifest = await mod.createDrifterSandbox({
    sourceRepoRoot: repoRoot,
    worldSourceRoot,
    sandboxParentRoot,
    label: "alpha-run",
  });

  assert.equal(manifest.kind, "drifter-sandbox");
  assert.equal(manifest.status, "ready");
  assert.equal(manifest.world.mode, "copy");
  assert.equal(manifest.worktree.mode, "git-worktree");

  const copiedStatus = await fs.readFile(path.resolve(manifest.layout.worldBaseRoot, "state", "player-status.yaml"), "utf8");
  assert.match(copiedStatus, /hp:\s*10/);

  const worktreeReadme = await fs.readFile(path.resolve(manifest.layout.repoWorktreeRoot, "README.md"), "utf8");
  assert.match(worktreeReadme, /fixture/i);

  const sessionRaw = await fs.readFile(path.resolve(manifest.layout.sessionRoot, "session.json"), "utf8");
  const session = JSON.parse(sessionRaw);
  assert.equal(session.mode, "drifter-sandbox");
});

test("destroyDrifterSandbox removes worktree and sandbox root", async () => {
  const repoRoot = await makeFixtureRepo("drifter-sandbox-destroy");
  const sandboxParentRoot = await fs.mkdtemp(path.resolve(os.tmpdir(), "drifter-sandbox-parent-"));
  const mod = await importSandboxModule();

  const manifest = await mod.createDrifterSandbox({
    sourceRepoRoot: repoRoot,
    sandboxParentRoot,
    label: "destroy-run",
    createWorktree: true,
  });

  const before = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  assert.equal(before.status, 0);
  assert.match(before.stdout, new RegExp(manifest.layout.repoWorktreeRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const result = await mod.destroyDrifterSandbox({ sandboxRoot: manifest.layout.sandboxRoot, force: true });
  assert.equal(result.ok, true);

  await assert.rejects(() => fs.access(manifest.layout.sandboxRoot));

  const after = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  assert.equal(after.status, 0);
  assert.doesNotMatch(after.stdout, new RegExp(manifest.layout.repoWorktreeRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("CLI create/inspect/destroy roundtrip works", async () => {
  const repoRoot = await makeFixtureRepo("drifter-sandbox-cli");
  const sandboxParentRoot = await fs.mkdtemp(path.resolve(os.tmpdir(), "drifter-sandbox-parent-"));
  const cliPath = path.resolve(ROOT_DIR, "scripts", "drifter-sandbox.mjs");

  const created = spawnSync(process.execPath, [cliPath, "create", "--repo", repoRoot, "--parent", sandboxParentRoot, "--label", "cli-run", "--no-worktree"], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: "pipe",
  });
  assert.equal(created.status, 0, `stdout:\n${created.stdout}\nstderr:\n${created.stderr}`);
  const createPayload = JSON.parse(created.stdout);
  assert.equal(createPayload.ok, true);
  assert.equal(createPayload.manifest.worktree, null);

  const sandboxRoot = createPayload.manifest.layout.sandboxRoot;
  const inspected = spawnSync(process.execPath, [cliPath, "inspect", "--sandbox", sandboxRoot], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: "pipe",
  });
  assert.equal(inspected.status, 0);
  const inspectPayload = JSON.parse(inspected.stdout);
  assert.equal(inspectPayload.manifest.sandboxId, createPayload.manifest.sandboxId);

  const destroyed = spawnSync(process.execPath, [cliPath, "destroy", "--sandbox", sandboxRoot], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: "pipe",
  });
  assert.equal(destroyed.status, 0);
  const destroyPayload = JSON.parse(destroyed.stdout);
  assert.equal(destroyPayload.ok, true);
});
