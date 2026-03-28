import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

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

async function readJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, value.endsWith("\n") ? value : `${value}\n`, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileDigest(filePath) {
  const data = await fs.readFile(filePath);
  return {
    size: data.byteLength,
    sha256: sha256(data),
  };
}

async function collectFiles(rootPath) {
  const resolvedRoot = path.resolve(rootPath);
  if (!(await pathExists(resolvedRoot))) {
    return [];
  }

  const files = [];
  async function walk(currentPath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.resolve(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const digest = await fileDigest(fullPath);
      files.push({
        path: fullPath,
        relativePath: path.relative(resolvedRoot, fullPath) || path.basename(fullPath),
        ...digest,
      });
    }
  }

  await walk(resolvedRoot);
  return files;
}

function diffFileLists(sourceFiles, sandboxFiles) {
  const sourceByRelative = new Map(sourceFiles.map((entry) => [entry.relativePath, entry]));
  const sandboxByRelative = new Map(sandboxFiles.map((entry) => [entry.relativePath, entry]));
  const allRelativePaths = [...new Set([...sourceByRelative.keys(), ...sandboxByRelative.keys()])].sort();

  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];

  for (const relativePath of allRelativePaths) {
    const source = sourceByRelative.get(relativePath) || null;
    const sandbox = sandboxByRelative.get(relativePath) || null;
    if (!source && sandbox) {
      added.push({ relativePath, sandbox });
      continue;
    }
    if (source && !sandbox) {
      removed.push({ relativePath, source });
      continue;
    }
    if (source && sandbox && (source.sha256 !== sandbox.sha256 || source.size !== sandbox.size)) {
      changed.push({ relativePath, source, sandbox });
      continue;
    }
    unchanged.push({ relativePath, source, sandbox });
  }

  return { added, removed, changed, unchanged };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

async function summarizeDirectory(rootPath, maxFiles = 12) {
  const files = await collectFiles(rootPath);
  return {
    rootPath,
    exists: await pathExists(rootPath),
    fileCount: files.length,
    totalBytes: files.reduce((sum, entry) => sum + entry.size, 0),
    sampleFiles: files.slice(0, maxFiles).map((entry) => ({
      relativePath: entry.relativePath,
      size: entry.size,
    })),
  };
}

function extractReportSignals(machineReport) {
  const summary = machineReport?.summary || {};
  const proposals = Array.isArray(machineReport?.proposals) ? machineReport.proposals : [];
  return {
    runId: machineReport?.runId || null,
    passed: Number(summary.passed || 0),
    failed: Number(summary.failed || 0),
    turns: Number(summary.turns || 0),
    proposalCount: proposals.length,
    latestProposal: proposals.length ? proposals[proposals.length - 1] : null,
    reasons: proposals.flatMap((proposal) => proposal?.reasons || []),
  };
}

function buildPromotionCandidates({ worldDiff, repoStatus, inventory }) {
  const candidates = [];

  for (const entry of worldDiff.changed) {
    candidates.push({
      kind: "world-change",
      relativePath: entry.relativePath,
      sourcePath: entry.sourcePath,
      sandboxPath: entry.sandboxPath,
      reason: "sandbox world file diverged from canonical world snapshot",
      recommendedAction: "review-and-copy",
      confidence: "medium",
    });
  }

  for (const entry of worldDiff.added) {
    candidates.push({
      kind: "world-addition",
      relativePath: entry.relativePath,
      sourcePath: null,
      sandboxPath: entry.sandboxPath,
      reason: "sandbox created a new world file with no canonical counterpart",
      recommendedAction: "review-and-copy",
      confidence: "medium",
    });
  }

  for (const file of repoStatus.changedFiles) {
    candidates.push({
      kind: "repo-change",
      relativePath: file.relativePath,
      sourcePath: path.resolve(repoStatus.repoRoot, file.relativePath),
      sandboxPath: path.resolve(repoStatus.repoWorktreeRoot, file.relativePath),
      reason: `sandbox worktree git status=${file.statusCode}`,
      recommendedAction: "review-and-cherry-pick",
      confidence: "medium",
    });
  }

  if (inventory.reports.fileCount > 0 || inventory.transcripts.fileCount > 0) {
    candidates.push({
      kind: "evidence-bundle",
      relativePath: "reports+transcripts",
      sourcePath: null,
      sandboxPath: inventory.reports.rootPath,
      reason: "sandbox produced operator evidence that should be reviewed before promotion",
      recommendedAction: "review-only",
      confidence: "high",
    });
  }

  return candidates;
}

function formatMarkdownList(items, fallback = "- 없음") {
  if (!items.length) {
    return fallback;
  }
  return items.map((item) => `- ${item}`).join("\n");
}

export async function summarizeDrifterSandbox({ sandboxRoot, outputPrefix = "sandbox-diff-summary" }) {
  const manifestPath = path.resolve(sandboxRoot, "sandbox-manifest.json");
  const manifest = await readJson(manifestPath);
  if (!manifest) {
    throw new Error(`Sandbox manifest not found: ${manifestPath}`);
  }

  const sourceWorldRoot = manifest?.source?.worldSourceRoot ? path.resolve(manifest.source.worldSourceRoot) : null;
  const sandboxWorldRoot = path.resolve(manifest.layout.worldBaseRoot);
  const reportsRoot = path.resolve(manifest.layout.reportsRoot);
  const transcriptsRoot = path.resolve(manifest.layout.sessionRoot, "transcripts");
  const artifactsRoot = path.resolve(manifest.layout.artifactsRoot);
  const launchResultPath = path.resolve(manifest.layout.sessionRoot, "launch-result.json");
  const launchResult = await readJson(launchResultPath, null);

  const sourceWorldFiles = sourceWorldRoot ? await collectFiles(sourceWorldRoot) : [];
  const sandboxWorldFiles = await collectFiles(sandboxWorldRoot);
  const worldDiff = diffFileLists(sourceWorldFiles, sandboxWorldFiles);

  const reportFiles = (await collectFiles(reportsRoot)).filter((entry) => entry.relativePath.endsWith(".json") || entry.relativePath.endsWith(".md"));
  const machineReports = [];
  for (const reportFile of reportFiles) {
    if (!reportFile.relativePath.endsWith(".json")) {
      continue;
    }
    const report = await readJson(reportFile.path, null);
    if (!report?.summary) {
      continue;
    }
    machineReports.push({
      relativePath: reportFile.relativePath,
      ...extractReportSignals(report),
    });
  }

  let repoStatus = {
    repoRoot: manifest?.source?.repoRoot ? path.resolve(manifest.source.repoRoot) : null,
    repoWorktreeRoot: manifest?.worktree?.path ? path.resolve(manifest.worktree.path) : null,
    changedFiles: [],
    stdout: "",
    stderr: "",
  };

  if (repoStatus.repoWorktreeRoot && (await pathExists(repoStatus.repoWorktreeRoot))) {
    const gitStatus = run("git", ["status", "--short"], repoStatus.repoWorktreeRoot);
    const changedFiles = gitStatus.stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => ({
        statusCode: line.slice(0, 2).trim() || "??",
        relativePath: line.slice(3).trim(),
      }));
    repoStatus = {
      ...repoStatus,
      changedFiles,
      stdout: gitStatus.stdout,
      stderr: gitStatus.stderr,
    };
  }

  const inventory = {
    reports: await summarizeDirectory(reportsRoot),
    transcripts: await summarizeDirectory(transcriptsRoot),
    artifacts: await summarizeDirectory(artifactsRoot),
  };

  const summary = {
    schemaVersion: 1,
    kind: "drifter-sandbox-diff-summary",
    generatedAt: new Date().toISOString(),
    sandboxRoot: path.resolve(sandboxRoot),
    launchResult,
    source: {
      repoRoot: manifest?.source?.repoRoot || null,
      worldSourceRoot: sourceWorldRoot,
    },
    worldDiff: {
      sourceFileCount: sourceWorldFiles.length,
      sandboxFileCount: sandboxWorldFiles.length,
      changed: worldDiff.changed.map((entry) => ({
        relativePath: entry.relativePath,
        sourcePath: entry.source.path,
        sandboxPath: entry.sandbox.path,
        sourceSha256: entry.source.sha256,
        sandboxSha256: entry.sandbox.sha256,
      })),
      added: worldDiff.added.map((entry) => ({
        relativePath: entry.relativePath,
        sandboxPath: entry.sandbox.path,
        sandboxSha256: entry.sandbox.sha256,
      })),
      removed: worldDiff.removed.map((entry) => ({
        relativePath: entry.relativePath,
        sourcePath: entry.source.path,
        sourceSha256: entry.source.sha256,
      })),
    },
    repoStatus,
    inventory,
    machineReports,
  };

  summary.promotionCandidates = buildPromotionCandidates({ worldDiff: summary.worldDiff, repoStatus, inventory });

  const mdLines = [
    "# Drifter Sandbox Diff / Promotion Summary",
    "",
    `Generated at: ${summary.generatedAt}`,
    `Sandbox: ${summary.sandboxRoot}`,
    "",
    "## World diff vs canonical",
    `- changed: ${summary.worldDiff.changed.length}`,
    `- added: ${summary.worldDiff.added.length}`,
    `- removed: ${summary.worldDiff.removed.length}`,
    formatMarkdownList(summary.worldDiff.changed.slice(0, 20).map((entry) => `changed world file: ${entry.relativePath}`)),
    "",
    "## Sandbox-local outputs",
    `- reports: ${inventory.reports.fileCount} files / ${inventory.reports.totalBytes} bytes`,
    `- transcripts: ${inventory.transcripts.fileCount} files / ${inventory.transcripts.totalBytes} bytes`,
    `- artifacts: ${inventory.artifacts.fileCount} files / ${inventory.artifacts.totalBytes} bytes`,
    "",
    "## Machine report summary",
    machineReports.length
      ? machineReports
          .map(
            (report) =>
              `- ${report.relativePath}: passed=${report.passed} failed=${report.failed} turns=${report.turns} proposals=${report.proposalCount}`,
          )
          .join("\n")
      : "- machine reports not found",
    "",
    "## Repo worktree changes",
    repoStatus.changedFiles.length
      ? repoStatus.changedFiles.map((file) => `- ${file.statusCode} ${file.relativePath}`).join("\n")
      : "- none",
    "",
    "## Promotion candidates",
    summary.promotionCandidates.length
      ? summary.promotionCandidates
          .map(
            (candidate) =>
              `- [${candidate.kind}] ${candidate.relativePath} -> ${candidate.recommendedAction} (${candidate.reason})`,
          )
          .join("\n")
      : "- none",
  ];

  const jsonPath = path.resolve(reportsRoot, `${outputPrefix}.json`);
  const markdownPath = path.resolve(reportsRoot, `${outputPrefix}.md`);
  await writeJson(jsonPath, summary);
  await writeText(markdownPath, mdLines.join("\n"));

  return {
    summary,
    output: {
      jsonPath,
      markdownPath,
    },
  };
}

