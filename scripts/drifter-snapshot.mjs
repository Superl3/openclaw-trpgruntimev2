#!/usr/bin/env node
import path from "node:path";
import {
  createDrifterSnapshot,
  getDrifterSnapshotDir,
  listDrifterSnapshots,
  loadDrifterSnapshotManifest,
  readDiagnosticsPreview,
  replayDrifterSnapshot,
  restoreDrifterSnapshot,
} from "../src/runtime-core/drifter-snapshot.ts";

function usage() {
  console.log(`Usage:
  node ./scripts/drifter-snapshot.mjs create --workspace <path> [--session-id <id>] [--label <name>] [--report <path> ...]
  node ./scripts/drifter-snapshot.mjs restore --workspace <path> --snapshot <path>
  node ./scripts/drifter-snapshot.mjs replay --workspace <path> --snapshot <path> [--output-dir-name <name>]
  node ./scripts/drifter-snapshot.mjs list --workspace <path>
  node ./scripts/drifter-snapshot.mjs inspect --snapshot <path>
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    if (args[key] === undefined) {
      args[key] = value;
    } else if (Array.isArray(args[key])) {
      args[key].push(value);
    } else {
      args[key] = [args[key], value];
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

if (!command || args.help || args.h) {
  usage();
  process.exit(command ? 0 : 1);
}

if (command === "create") {
  if (!args.workspace) throw new Error("--workspace is required");
  const reportPaths = Array.isArray(args.report) ? args.report : args.report ? [args.report] : [];
  const manifest = await createDrifterSnapshot({
    workspaceRoot: path.resolve(String(args.workspace)),
    sessionId: args["session-id"] ? String(args["session-id"]) : undefined,
    label: args.label ? String(args.label) : undefined,
    reportPaths: reportPaths.map((item) => path.resolve(String(item))),
  });
  console.log(JSON.stringify({
    ok: true,
    snapshotRoot: manifest.snapshotRoot,
    snapshotId: manifest.snapshotId,
    sessionId: manifest.sessionId,
    capturedFiles: manifest.capturedFiles.length,
    replaySteps: manifest.replay.steps.length,
  }, null, 2));
} else if (command === "restore") {
  if (!args.workspace || !args.snapshot) throw new Error("--workspace and --snapshot are required");
  const result = await restoreDrifterSnapshot({
    workspaceRoot: path.resolve(String(args.workspace)),
    snapshotRoot: path.resolve(String(args.snapshot)),
  });
  console.log(JSON.stringify({ ok: true, restoredFiles: result.restoredFiles, sessionId: result.manifest.sessionId }, null, 2));
} else if (command === "replay") {
  if (!args.workspace || !args.snapshot) throw new Error("--workspace and --snapshot are required");
  const result = await replayDrifterSnapshot({
    workspaceRoot: path.resolve(String(args.workspace)),
    snapshotRoot: path.resolve(String(args.snapshot)),
    outputDirName: args["output-dir-name"] ? String(args["output-dir-name"]) : undefined,
  });
  console.log(JSON.stringify({
    ok: true,
    replayRoot: result.replayRoot,
    replayManifestPath: result.replayManifestPath,
    replaySteps: result.manifest.replay.steps.length,
  }, null, 2));
} else if (command === "list") {
  if (!args.workspace) throw new Error("--workspace is required");
  const workspaceRoot = path.resolve(String(args.workspace));
  const [manifests, diagnosticsPreview] = await Promise.all([
    listDrifterSnapshots(workspaceRoot),
    readDiagnosticsPreview(workspaceRoot),
  ]);
  console.log(JSON.stringify({
    ok: true,
    snapshotDir: getDrifterSnapshotDir(workspaceRoot),
    snapshots: manifests.map((item) => ({
      snapshotId: item.snapshotId,
      label: item.label,
      createdAt: item.createdAt,
      sessionId: item.sessionId,
      replaySteps: item.replay.steps.length,
      capturedFiles: item.capturedFiles.length,
      snapshotRoot: item.snapshotRoot,
    })),
    diagnosticsPreview,
  }, null, 2));
} else if (command === "inspect") {
  if (!args.snapshot) throw new Error("--snapshot is required");
  const manifest = await loadDrifterSnapshotManifest(path.resolve(String(args.snapshot)));
  console.log(JSON.stringify(manifest, null, 2));
} else {
  usage();
  throw new Error(`unknown command: ${command}`);
}
