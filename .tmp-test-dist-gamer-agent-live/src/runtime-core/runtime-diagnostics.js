import fs from "node:fs/promises";
import path from "node:path";
const DIAGNOSTICS_RELATIVE_PATH = "state/runtime-core/diagnostics.jsonl";
const MAX_STRING_LENGTH = 280;
const MAX_ARRAY_ITEMS = 12;
const MAX_OBJECT_KEYS = 20;
const MAX_DEPTH = 3;
function clip(value, max) {
    if (value.length <= max) {
        return value;
    }
    return `${value.slice(0, max)}…`;
}
function sanitizeDiagnosticDetails(value, depth = 0) {
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value === "string") {
        return clip(value, MAX_STRING_LENGTH);
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    if (depth >= MAX_DEPTH) {
        if (Array.isArray(value)) {
            return `[array:${value.length}]`;
        }
        return "[object]";
    }
    if (Array.isArray(value)) {
        return value.slice(0, MAX_ARRAY_ITEMS).map((entry) => sanitizeDiagnosticDetails(entry, depth + 1));
    }
    if (typeof value === "object") {
        const obj = value;
        const normalized = {};
        const keys = Object.keys(obj).slice(0, MAX_OBJECT_KEYS);
        for (const key of keys) {
            normalized[key] = sanitizeDiagnosticDetails(obj[key], depth + 1);
        }
        return normalized;
    }
    return String(value);
}
export async function emitRuntimeDiagnostic(params) {
    if (params.cfg.diagnosticsEnabled === false) {
        return;
    }
    const payload = {
        time: new Date().toISOString(),
        event: clip(params.event, 80),
        severity: params.severity ?? "info",
        sessionId: params.sessionId || undefined,
        worldRoot: params.worldRoot ? clip(path.resolve(params.worldRoot), MAX_STRING_LENGTH) : undefined,
        runtimePhase: params.runtimePhase || undefined,
        route: params.route || undefined,
        gate: params.gate || undefined,
        result: params.result || undefined,
        details: sanitizeDiagnosticDetails(params.details ?? {}),
    };
    const line = `${JSON.stringify(payload)}\n`;
    if (params.cfg.diagnosticsConsoleMirror !== false) {
        console.info(`[trpg-runtime][diag] ${line.trim()}`);
    }
    if (!params.worldRoot) {
        return;
    }
    try {
        const absolute = path.resolve(params.worldRoot, DIAGNOSTICS_RELATIVE_PATH);
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.appendFile(absolute, line, "utf8");
    }
    catch (error) {
        console.warn(`[trpg-runtime] runtime diagnostics write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}
