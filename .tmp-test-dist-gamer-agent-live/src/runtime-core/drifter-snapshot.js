import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
const SNAPSHOT_SCHEMA_VERSION = 1;
const SNAPSHOT_DIR_RELATIVE = "state/runtime-core/drifter-snapshots";
const WORLD_CAPTURE_PATHS = [
    "canon/player.yaml",
    "state/player-status.yaml",
    "state/inventory.yaml",
    "state/current-scene.yaml",
];
const RUNTIME_CORE_DIR_RELATIVE = "state/runtime-core";
const STORE_FILE_RELATIVE = "state/runtime-core/checkpoint0-store.json";
const DIAGNOSTICS_FILE_RELATIVE = "state/runtime-core/diagnostics.jsonl";
async function pathExists(target) {
    try {
        await fs.access(target);
        return true;
    }
    catch {
        return false;
    }
}
async function ensureDir(target) {
    await fs.mkdir(target, { recursive: true });
}
async function sha256File(filePath) {
    const buf = await fs.readFile(filePath);
    return createHash("sha256").update(buf).digest("hex");
}
async function copyFileAndDescribe(params) {
    if (!(await pathExists(params.sourceAbsolute))) {
        return null;
    }
    const destAbsolute = path.resolve(params.snapshotRoot, params.snapshotRelativePath);
    await ensureDir(path.dirname(destAbsolute));
    await fs.copyFile(params.sourceAbsolute, destAbsolute);
    const stat = await fs.stat(destAbsolute);
    return {
        kind: params.kind,
        sourceRelativePath: params.sourceRelativePath,
        snapshotRelativePath: params.snapshotRelativePath,
        bytes: stat.size,
        sha256: await sha256File(destAbsolute),
    };
}
async function walkFiles(root, current = root) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const absolute = path.resolve(current, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await walkFiles(root, absolute)));
            continue;
        }
        if (entry.isFile()) {
            files.push(path.relative(root, absolute));
        }
    }
    return files.sort();
}
async function captureRuntimeCore(params) {
    const runtimeRoot = path.resolve(params.workspaceRoot, RUNTIME_CORE_DIR_RELATIVE);
    if (!(await pathExists(runtimeRoot))) {
        return [];
    }
    const files = await walkFiles(runtimeRoot);
    const captured = [];
    for (const relative of files) {
        if (relative.startsWith("drifter-snapshots/")) {
            continue;
        }
        const sourceRelativePath = path.posix.join(RUNTIME_CORE_DIR_RELATIVE, relative.split(path.sep).join(path.posix.sep));
        const record = await copyFileAndDescribe({
            sourceAbsolute: path.resolve(runtimeRoot, relative),
            sourceRelativePath,
            snapshotRoot: params.snapshotRoot,
            snapshotRelativePath: path.posix.join("payload", sourceRelativePath),
            kind: "runtime",
        });
        if (record)
            captured.push(record);
    }
    return captured;
}
async function readJsonIfExists(target) {
    if (!(await pathExists(target)))
        return null;
    try {
        return JSON.parse(await fs.readFile(target, "utf8"));
    }
    catch {
        return null;
    }
}
function buildReplayStepsFromSession(session) {
    const events = Array.isArray(session?.trace?.events) ? session.trace.events : [];
    return events.map((event, index) => ({
        seq: index + 1,
        tsIso: typeof event?.tsIso === "string" ? event.tsIso : new Date(0).toISOString(),
        type: typeof event?.type === "string" ? event.type : "unknown",
        lane: typeof event?.lane === "string" ? event.lane : "unknown",
        severity: typeof event?.severity === "string" ? event.severity : "info",
        actionId: typeof event?.data?.actionId === "string" ? event.data.actionId : null,
        summary: typeof event?.data?.summary === "string"
            ? event.data.summary
            : typeof event?.data?.resultSummary === "string"
                ? event.data.resultSummary
                : null,
    }));
}
function buildReplayStepsFromReports(reportDocs, sessionId) {
    const steps = [];
    for (const report of reportDocs) {
        const transcripts = Array.isArray(report?.turnTranscripts) ? report.turnTranscripts : [];
        for (const entry of transcripts) {
            if (sessionId && entry?.received?.sessionId !== sessionId)
                continue;
            steps.push({
                seq: steps.length + 1,
                tsIso: typeof report?.generatedAt === "string" ? report.generatedAt : new Date(0).toISOString(),
                type: "report.turn",
                lane: "report",
                severity: "info",
                actionId: typeof entry?.sent?.actionId === "string" ? entry.sent.actionId : null,
                summary: typeof entry?.sent?.label === "string"
                    ? entry.sent.label
                    : typeof entry?.sent?.freeInput === "string"
                        ? entry.sent.freeInput
                        : typeof entry?.received?.textSummary === "string"
                            ? entry.received.textSummary.slice(0, 160)
                            : null,
            });
        }
    }
    return steps;
}
async function loadSessionState(workspaceRoot, sessionId) {
    const store = await readJsonIfExists(path.resolve(workspaceRoot, STORE_FILE_RELATIVE));
    const sessions = store && typeof store === "object" ? store.sessions : null;
    if (!sessions || typeof sessions !== "object")
        return null;
    if (sessionId && sessions[sessionId])
        return sessions[sessionId];
    const ids = Object.keys(sessions);
    if (ids.length === 1)
        return sessions[ids[0]];
    return null;
}
export async function createDrifterSnapshot(options) {
    const workspaceRoot = path.resolve(options.workspaceRoot);
    const session = await loadSessionState(workspaceRoot, options.sessionId);
    const sessionId = typeof session?.sessionId === "string" ? session.sessionId : options.sessionId ?? null;
    const label = (options.label || sessionId || "snapshot").replace(/[^a-zA-Z0-9._-]+/g, "-");
    const snapshotId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}-${randomUUID().slice(0, 8)}`;
    const snapshotRoot = path.resolve(workspaceRoot, SNAPSHOT_DIR_RELATIVE, snapshotId);
    await ensureDir(snapshotRoot);
    const capturedFiles = [];
    for (const relative of WORLD_CAPTURE_PATHS) {
        const record = await copyFileAndDescribe({
            sourceAbsolute: path.resolve(workspaceRoot, relative),
            sourceRelativePath: relative,
            snapshotRoot,
            snapshotRelativePath: path.posix.join("payload", relative),
            kind: "world",
        });
        if (record)
            capturedFiles.push(record);
    }
    capturedFiles.push(...(await captureRuntimeCore({ workspaceRoot, snapshotRoot })));
    const reportPaths = (options.reportPaths || []).map((item) => path.resolve(item));
    const reportDocs = [];
    for (let index = 0; index < reportPaths.length; index += 1) {
        const sourceAbsolute = reportPaths[index];
        const base = path.basename(sourceAbsolute);
        const sourceRelativePath = path.relative(workspaceRoot, sourceAbsolute);
        const record = await copyFileAndDescribe({
            sourceAbsolute,
            sourceRelativePath: sourceRelativePath.startsWith("..") ? sourceAbsolute : sourceRelativePath,
            snapshotRoot,
            snapshotRelativePath: path.posix.join("payload", "reports", `${index + 1}-${base}`),
            kind: "report",
        });
        if (record) {
            capturedFiles.push(record);
            const doc = await readJsonIfExists(sourceAbsolute);
            if (doc)
                reportDocs.push(doc);
        }
    }
    const traceSteps = buildReplayStepsFromSession(session);
    const reportSteps = buildReplayStepsFromReports(reportDocs, sessionId);
    const replay = {
        source: traceSteps.length && reportSteps.length ? "mixed" : traceSteps.length ? "session-trace" : reportSteps.length ? "report-turn-transcripts" : "minimal",
        sessionId,
        sceneId: typeof session?.sceneId === "string" ? session.sceneId : null,
        uiVersion: typeof session?.uiVersion === "number" ? session.uiVersion : null,
        actionSeq: typeof session?.actionSeq === "number" ? session.actionSeq : null,
        lastActionId: typeof session?.lastActionId === "string" ? session.lastActionId : null,
        lastActionSummary: typeof session?.lastActionSummary === "string" ? session.lastActionSummary : null,
        steps: traceSteps.length ? traceSteps : reportSteps,
        reportReferences: reportPaths,
    };
    const manifest = {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        kind: "drifter-sandbox-snapshot",
        snapshotId,
        label,
        createdAt: new Date().toISOString(),
        workspaceRoot,
        snapshotRoot,
        sessionId,
        sessionStateFound: Boolean(session),
        capturedFiles,
        replay,
    };
    await fs.writeFile(path.resolve(snapshotRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
}
export async function loadDrifterSnapshotManifest(snapshotRoot) {
    const absolute = path.resolve(snapshotRoot, "manifest.json");
    return JSON.parse(await fs.readFile(absolute, "utf8"));
}
export async function restoreDrifterSnapshot(options) {
    const workspaceRoot = path.resolve(options.workspaceRoot);
    const manifest = await loadDrifterSnapshotManifest(options.snapshotRoot);
    const restoredFiles = [];
    for (const file of manifest.capturedFiles) {
        if (file.kind === "report")
            continue;
        const sourceAbsolute = path.resolve(manifest.snapshotRoot, file.snapshotRelativePath);
        const destAbsolute = path.resolve(workspaceRoot, file.sourceRelativePath);
        await ensureDir(path.dirname(destAbsolute));
        await fs.copyFile(sourceAbsolute, destAbsolute);
        restoredFiles.push(file.sourceRelativePath);
    }
    return { restoredFiles, manifest };
}
export async function replayDrifterSnapshot(options) {
    const manifest = await loadDrifterSnapshotManifest(options.snapshotRoot);
    const replayId = options.outputDirName || `replay-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const replayRoot = path.resolve(options.workspaceRoot, SNAPSHOT_DIR_RELATIVE, replayId);
    const payloadRoot = path.resolve(manifest.snapshotRoot, "payload");
    if (await pathExists(payloadRoot)) {
        const files = await walkFiles(payloadRoot);
        for (const relative of files) {
            const sourceAbsolute = path.resolve(payloadRoot, relative);
            const destAbsolute = path.resolve(replayRoot, relative);
            await ensureDir(path.dirname(destAbsolute));
            await fs.copyFile(sourceAbsolute, destAbsolute);
        }
    }
    const replayDocument = {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        kind: "drifter-sandbox-replay",
        createdAt: new Date().toISOString(),
        snapshotId: manifest.snapshotId,
        sessionId: manifest.sessionId,
        replay: manifest.replay,
        filesMaterializedUnder: replayRoot,
    };
    const replayManifestPath = path.resolve(replayRoot, "replay.json");
    await ensureDir(replayRoot);
    await fs.writeFile(replayManifestPath, `${JSON.stringify(replayDocument, null, 2)}\n`, "utf8");
    return { replayRoot, replayManifestPath, manifest };
}
export function getDrifterSnapshotDir(workspaceRoot) {
    return path.resolve(workspaceRoot, SNAPSHOT_DIR_RELATIVE);
}
export async function listDrifterSnapshots(workspaceRoot) {
    const dir = getDrifterSnapshotDir(workspaceRoot);
    if (!(await pathExists(dir)))
        return [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const manifests = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith("replay-"))
            continue;
        const manifestPath = path.resolve(dir, entry.name, "manifest.json");
        if (!(await pathExists(manifestPath)))
            continue;
        manifests.push(JSON.parse(await fs.readFile(manifestPath, "utf8")));
    }
    return manifests.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function readDiagnosticsPreview(workspaceRoot) {
    const diagnosticsPath = path.resolve(workspaceRoot, DIAGNOSTICS_FILE_RELATIVE);
    if (!(await pathExists(diagnosticsPath)))
        return null;
    const text = await fs.readFile(diagnosticsPath, "utf8");
    return text.trim().split(/\r?\n/).slice(-10).join("\n") || null;
}
