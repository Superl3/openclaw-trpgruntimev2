import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

function nowIso() {
  return new Date().toISOString();
}

function slugify(value, fallback = "drifter") {
  const trimmed = String(value || "").trim().toLowerCase();
  const normalized = trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function shortHash(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 8);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`.trim());
  }
  return result;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, value.endsWith("\n") ? value : `${value}\n`, "utf8");
}

function resolveDefaultSandboxParentRoot() {
  return path.resolve(os.tmpdir(), "trpg-runtime-v2", "sandboxes");
}

export function buildSandboxId(label) {
  const base = slugify(label, "drifter").slice(0, 48);
  return `${base}-${shortHash(`${label}:${randomUUID()}`)}`;
}

export function buildSandboxLayout({ sandboxRoot }) {
  return {
    sandboxRoot,
    manifestPath: path.resolve(sandboxRoot, "sandbox-manifest.json"),
    repoRoot: path.resolve(sandboxRoot, "repo"),
    repoWorktreeRoot: path.resolve(sandboxRoot, "repo", "worktree"),
    worldRoot: path.resolve(sandboxRoot, "world"),
    worldBaseRoot: path.resolve(sandboxRoot, "world", "base"),
    sessionRoot: path.resolve(sandboxRoot, "session"),
    sessionLiveRoot: path.resolve(sandboxRoot, "session", "live"),
    reportsRoot: path.resolve(sandboxRoot, "reports"),
    artifactsRoot: path.resolve(sandboxRoot, "artifacts"),
    tmpRoot: path.resolve(sandboxRoot, "tmp"),
  };
}

async function createWorldCopy(worldSourceRoot, worldBaseRoot) {
  if (!worldSourceRoot) {
    return { mode: "empty", source: null };
  }
  await fs.cp(worldSourceRoot, worldBaseRoot, { recursive: true, force: true });
  return { mode: "copy", source: path.resolve(worldSourceRoot) };
}

function resolveGitHead(repoRoot) {
  const result = run("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  return result.stdout.trim();
}

function resolveGitBranch(repoRoot) {
  const result = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot });
  return result.stdout.trim();
}

function createGitWorktree(repoRoot, repoWorktreeRoot, headRef) {
  run("git", ["worktree", "add", "--detach", repoWorktreeRoot, headRef], { cwd: repoRoot });
}

async function seedSessionSkeleton(layout, options) {
  const createdAt = nowIso();
  const sessionState = {
    schemaVersion: 1,
    createdAt,
    mode: "drifter-sandbox",
    status: "bootstrapped",
    profile: options.sessionProfile || "default",
    worldMode: options.worldSourceRoot ? "copied" : "empty",
  };

  await writeJson(path.resolve(layout.sessionRoot, "session.json"), sessionState);
  await writeText(
    path.resolve(layout.reportsRoot, "README.md"),
    [
      "# Reports",
      "",
      "Put run summaries, experiment notes, and evaluation output here.",
      "This directory is disposable with the sandbox.",
    ].join("\n"),
  );
  await writeText(
    path.resolve(layout.artifactsRoot, "README.md"),
    [
      "# Artifacts",
      "",
      "Transient outputs belong here: traces, screenshots, generated data, and exports.",
    ].join("\n"),
  );
  await writeText(
    path.resolve(layout.sandboxRoot, ".gitignore"),
    ["artifacts/**", "tmp/**", "reports/**/*.tmp", "repo/worktree/.openclaw/**"].join("\n"),
  );
}

export async function createDrifterSandbox(input = {}) {
  const sourceRepoRoot = path.resolve(input.sourceRepoRoot || process.cwd());
  const sandboxParentRoot = path.resolve(input.sandboxParentRoot || resolveDefaultSandboxParentRoot());
  const label = input.label || path.basename(sourceRepoRoot);
  const sandboxId = input.sandboxId || buildSandboxId(label);
  const sandboxRoot = path.resolve(sandboxParentRoot, sandboxId);
  const layout = buildSandboxLayout({ sandboxRoot });
  const worldSourceRoot = input.worldSourceRoot ? path.resolve(input.worldSourceRoot) : null;
  const headRef = input.headRef || resolveGitHead(sourceRepoRoot);
  const branch = resolveGitBranch(sourceRepoRoot);

  if (await pathExists(sandboxRoot)) {
    throw new Error(`Sandbox already exists: ${sandboxRoot}`);
  }

  await Promise.all([
    ensureDir(layout.repoRoot),
    ensureDir(layout.worldBaseRoot),
    ensureDir(layout.sessionLiveRoot),
    ensureDir(layout.reportsRoot),
    ensureDir(layout.artifactsRoot),
    ensureDir(layout.tmpRoot),
  ]);

  const world = await createWorldCopy(worldSourceRoot, layout.worldBaseRoot);

  let worktree = null;
  if (input.createWorktree !== false) {
    createGitWorktree(sourceRepoRoot, layout.repoWorktreeRoot, headRef);
    worktree = {
      mode: "git-worktree",
      headRef,
      branch,
      path: layout.repoWorktreeRoot,
    };
  }

  await seedSessionSkeleton(layout, {
    sessionProfile: input.sessionProfile,
    worldSourceRoot,
  });

  const manifest = {
    schemaVersion: 1,
    kind: "drifter-sandbox",
    sandboxId,
    label,
    createdAt: nowIso(),
    status: "ready",
    disposal: {
      disposable: true,
      destroyCommand: `node ./scripts/drifter-sandbox.mjs destroy --sandbox ${sandboxRoot}`,
    },
    source: {
      repoRoot: sourceRepoRoot,
      headRef,
      branch,
      worldSourceRoot,
    },
    layout,
    world,
    worktree,
  };

  await writeJson(layout.manifestPath, manifest);
  return manifest;
}

export async function inspectDrifterSandbox({ sandboxRoot }) {
  const manifestPath = path.resolve(sandboxRoot, "sandbox-manifest.json");
  const raw = await fs.readFile(manifestPath, "utf8");
  return JSON.parse(raw);
}

export async function destroyDrifterSandbox({ sandboxRoot, force = false }) {
  const manifest = await inspectDrifterSandbox({ sandboxRoot });
  const repoRoot = manifest.source?.repoRoot ? path.resolve(manifest.source.repoRoot) : null;
  const repoWorktreeRoot = manifest.layout?.repoWorktreeRoot ? path.resolve(manifest.layout.repoWorktreeRoot) : null;

  if (repoRoot && repoWorktreeRoot && (await pathExists(repoWorktreeRoot))) {
    const args = ["worktree", "remove", repoWorktreeRoot];
    if (force) {
      args.push("--force");
    }
    run("git", args, { cwd: repoRoot });
  }

  await fs.rm(path.resolve(sandboxRoot), { recursive: true, force: true });
  return {
    ok: true,
    sandboxRoot: path.resolve(sandboxRoot),
    removedWorktree: Boolean(repoWorktreeRoot),
  };
}
