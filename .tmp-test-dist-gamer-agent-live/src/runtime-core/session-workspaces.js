import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
export const SESSION_DATA_SECTIONS = ["player", "status", "inventory", "scene"];
const SESSION_WORKSPACES_REGISTRY_RELATIVE_PATH = "state/runtime-core/session-workspaces.json";
const SESSION_CONFIRM_REGISTRY_RELATIVE_PATH = "state/runtime-core/session-new-confirmations.json";
const SESSION_WORKSPACES_DIR_RELATIVE_PATH = "state/runtime-core/session-workspaces";
const SECTION_PATHS = {
    player: "canon/player.yaml",
    status: "state/player-status.yaml",
    inventory: "state/inventory.yaml",
    scene: "state/current-scene.yaml",
};
function toObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function readString(value) {
    return typeof value === "string" ? value.trim() : "";
}
function createDefaultWorkspaceRegistry(nowIso) {
    return {
        schemaVersion: 1,
        updatedAt: nowIso,
        mappings: {},
    };
}
function parseWorkspaceRegistry(raw, nowIso) {
    const root = toObject(raw);
    const mappingsRaw = toObject(root.mappings);
    const mappings = {};
    for (const [key, value] of Object.entries(mappingsRaw)) {
        const item = toObject(value);
        const sessionContextId = readString(item.sessionContextId) || key;
        const workspaceRoot = readString(item.workspaceRoot);
        if (!sessionContextId || !workspaceRoot) {
            continue;
        }
        const createdAt = readString(item.createdAt) || nowIso;
        const updatedAt = readString(item.updatedAt) || createdAt;
        const lastSessionId = readString(item.lastSessionId) || null;
        mappings[sessionContextId] = {
            sessionContextId,
            workspaceRoot,
            createdAt,
            updatedAt,
            lastSessionId,
        };
    }
    return {
        schemaVersion: 1,
        updatedAt: readString(root.updatedAt) || nowIso,
        mappings,
    };
}
function createDefaultConfirmationRegistry(nowIso) {
    return {
        schemaVersion: 1,
        updatedAt: nowIso,
        confirmations: {},
    };
}
function parseConfirmationRegistry(raw, nowIso) {
    const root = toObject(raw);
    const confirmationsRaw = toObject(root.confirmations);
    const confirmations = {};
    for (const [key, value] of Object.entries(confirmationsRaw)) {
        const item = toObject(value);
        const token = readString(item.token) || key;
        const sessionContextId = readString(item.sessionContextId);
        const channelKey = readString(item.channelKey);
        const ownerId = readString(item.ownerId);
        const expiresAt = readString(item.expiresAt);
        if (!token || !sessionContextId || !channelKey || !ownerId || !expiresAt) {
            continue;
        }
        confirmations[token] = {
            token,
            sessionContextId,
            channelKey,
            ownerId,
            createdAt: readString(item.createdAt) || nowIso,
            expiresAt,
        };
    }
    return {
        schemaVersion: 1,
        updatedAt: readString(root.updatedAt) || nowIso,
        confirmations,
    };
}
function workspaceRegistryAbsolutePath(canonicalWorldRoot) {
    return path.resolve(canonicalWorldRoot, SESSION_WORKSPACES_REGISTRY_RELATIVE_PATH);
}
function confirmationRegistryAbsolutePath(canonicalWorldRoot) {
    return path.resolve(canonicalWorldRoot, SESSION_CONFIRM_REGISTRY_RELATIVE_PATH);
}
async function readWorkspaceRegistry(canonicalWorldRoot) {
    const nowIso = new Date().toISOString();
    const absolute = workspaceRegistryAbsolutePath(canonicalWorldRoot);
    try {
        const text = await fsp.readFile(absolute, "utf8");
        return parseWorkspaceRegistry(JSON.parse(text), nowIso);
    }
    catch {
        return createDefaultWorkspaceRegistry(nowIso);
    }
}
async function writeWorkspaceRegistry(canonicalWorldRoot, registry) {
    const absolute = workspaceRegistryAbsolutePath(canonicalWorldRoot);
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.writeFile(absolute, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}
async function readConfirmationRegistry(canonicalWorldRoot) {
    const nowIso = new Date().toISOString();
    const absolute = confirmationRegistryAbsolutePath(canonicalWorldRoot);
    try {
        const text = await fsp.readFile(absolute, "utf8");
        return parseConfirmationRegistry(JSON.parse(text), nowIso);
    }
    catch {
        return createDefaultConfirmationRegistry(nowIso);
    }
}
async function writeConfirmationRegistry(canonicalWorldRoot, registry) {
    const absolute = confirmationRegistryAbsolutePath(canonicalWorldRoot);
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.writeFile(absolute, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}
function cleanupExpiredConfirmations(registry, nowMs) {
    for (const [token, record] of Object.entries(registry.confirmations)) {
        if (Date.parse(record.expiresAt) <= nowMs) {
            delete registry.confirmations[token];
        }
    }
}
function normalizeWorkspaceSessionSlug(sessionContextId) {
    const normalized = sessionContextId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 48) || "session";
    const digest = createHash("sha256").update(sessionContextId).digest("hex").slice(0, 8);
    return `${normalized}-${digest}`;
}
async function copyFileIfExists(fromAbsolute, toAbsolute) {
    try {
        await fsp.access(fromAbsolute);
    }
    catch {
        return "missing";
    }
    await fsp.mkdir(path.dirname(toAbsolute), { recursive: true });
    await fsp.copyFile(fromAbsolute, toAbsolute);
    return "copied";
}
export function resolveEffectiveWorldRootForSessionSync(params) {
    const sessionContextId = readString(params.sessionContextId);
    if (!sessionContextId) {
        return params.canonicalWorldRoot;
    }
    const absolute = workspaceRegistryAbsolutePath(params.canonicalWorldRoot);
    try {
        const text = fs.readFileSync(absolute, "utf8");
        const parsed = parseWorkspaceRegistry(JSON.parse(text), new Date().toISOString());
        const found = parsed.mappings[sessionContextId];
        if (!found?.workspaceRoot) {
            return params.canonicalWorldRoot;
        }
        const workspaceRoot = path.resolve(found.workspaceRoot);
        if (!fs.existsSync(workspaceRoot)) {
            return params.canonicalWorldRoot;
        }
        return workspaceRoot;
    }
    catch {
        return params.canonicalWorldRoot;
    }
}
export async function readSessionWorkspaceRecord(params) {
    const registry = await readWorkspaceRegistry(params.canonicalWorldRoot);
    return registry.mappings[params.sessionContextId] ?? null;
}
export async function ensureSessionWorkspace(params) {
    const nowIso = new Date().toISOString();
    const registry = await readWorkspaceRegistry(params.canonicalWorldRoot);
    const existing = registry.mappings[params.sessionContextId];
    const workspaceRoot = existing?.workspaceRoot
        ? path.resolve(existing.workspaceRoot)
        : path.resolve(params.canonicalWorldRoot, SESSION_WORKSPACES_DIR_RELATIVE_PATH, normalizeWorkspaceSessionSlug(params.sessionContextId));
    await fsp.mkdir(path.resolve(workspaceRoot, "state/runtime-core"), { recursive: true });
    await copySectionData({ fromWorldRoot: params.canonicalWorldRoot, toWorldRoot: workspaceRoot, sections: SESSION_DATA_SECTIONS });
    const record = {
        sessionContextId: params.sessionContextId,
        workspaceRoot,
        createdAt: existing?.createdAt || nowIso,
        updatedAt: nowIso,
        lastSessionId: params.sessionId || null,
    };
    registry.mappings[params.sessionContextId] = record;
    registry.updatedAt = nowIso;
    await writeWorkspaceRegistry(params.canonicalWorldRoot, registry);
    return record;
}
export async function wipeSessionWorkspace(params) {
    const registry = await readWorkspaceRegistry(params.canonicalWorldRoot);
    const existing = registry.mappings[params.sessionContextId] ?? null;
    if (!existing) {
        return { removedWorkspace: false, removedMapping: false };
    }
    await fsp.rm(existing.workspaceRoot, { recursive: true, force: true });
    delete registry.mappings[params.sessionContextId];
    registry.updatedAt = new Date().toISOString();
    await writeWorkspaceRegistry(params.canonicalWorldRoot, registry);
    return {
        removedWorkspace: true,
        removedMapping: true,
    };
}
export async function issueSessionResetConfirmation(params) {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const registry = await readConfirmationRegistry(params.canonicalWorldRoot);
    cleanupExpiredConfirmations(registry, now);
    const token = randomUUID().replace(/-/g, "").slice(0, 12);
    const expiresAt = new Date(now + Math.max(30_000, params.ttlMs)).toISOString();
    registry.confirmations[token] = {
        token,
        sessionContextId: params.sessionContextId,
        channelKey: params.channelKey,
        ownerId: params.ownerId,
        createdAt: nowIso,
        expiresAt,
    };
    registry.updatedAt = nowIso;
    await writeConfirmationRegistry(params.canonicalWorldRoot, registry);
    return { token, expiresAt };
}
export async function consumeSessionResetConfirmation(params) {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const registry = await readConfirmationRegistry(params.canonicalWorldRoot);
    cleanupExpiredConfirmations(registry, now);
    const record = registry.confirmations[params.token];
    if (!record) {
        registry.updatedAt = nowIso;
        await writeConfirmationRegistry(params.canonicalWorldRoot, registry);
        return { ok: false, reason: "invalid_or_expired" };
    }
    if (record.sessionContextId !== params.sessionContextId ||
        record.channelKey !== params.channelKey ||
        record.ownerId !== params.ownerId) {
        return { ok: false, reason: "token_context_mismatch" };
    }
    delete registry.confirmations[params.token];
    registry.updatedAt = nowIso;
    await writeConfirmationRegistry(params.canonicalWorldRoot, registry);
    return { ok: true };
}
export async function copySectionData(params) {
    const outcomes = [];
    for (const section of params.sections) {
        const relativePath = SECTION_PATHS[section];
        const fromAbsolute = path.resolve(params.fromWorldRoot, relativePath);
        const toAbsolute = path.resolve(params.toWorldRoot, relativePath);
        const result = await copyFileIfExists(fromAbsolute, toAbsolute);
        outcomes.push({
            section,
            path: relativePath,
            result,
        });
    }
    return outcomes;
}
export async function deleteSectionDataFromWorkspace(params) {
    const outcomes = [];
    for (const section of params.sections) {
        const relativePath = SECTION_PATHS[section];
        const absolute = path.resolve(params.workspaceRoot, relativePath);
        let result = "deleted";
        try {
            await fsp.rm(absolute);
        }
        catch {
            result = "missing";
        }
        outcomes.push({
            section,
            path: relativePath,
            result,
        });
    }
    return outcomes;
}
