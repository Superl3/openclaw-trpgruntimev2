import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { RUNTIME_SCHEMA_VERSION, makeInteractionRouteStorageKey, } from "../runtime-core/types.js";
function createDefaultSnapshot() {
    return {
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        sessions: {},
        channelIndex: {},
        routes: {},
    };
}
function toRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function parseSnapshot(raw) {
    const root = toRecord(raw);
    const sessions = toRecord(root.sessions);
    const channelIndex = toRecord(root.channelIndex);
    const routes = toRecord(root.routes);
    return {
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        sessions,
        channelIndex,
        routes,
    };
}
export class JsonFileStateStore {
    rootDir;
    storeFilePath;
    writeQueue;
    constructor(rootDir, fileName = "checkpoint0-store.json") {
        this.rootDir = rootDir;
        this.storeFilePath = path.resolve(rootDir, fileName);
        this.writeQueue = Promise.resolve();
    }
    async readSnapshot() {
        let text;
        try {
            text = await fs.readFile(this.storeFilePath, "utf8");
        }
        catch (error) {
            if (error.code === "ENOENT") {
                return createDefaultSnapshot();
            }
            throw error;
        }
        try {
            const parsed = JSON.parse(text);
            return parseSnapshot(parsed);
        }
        catch {
            return createDefaultSnapshot();
        }
    }
    async writeSnapshot(snapshot) {
        await fs.mkdir(this.rootDir, { recursive: true });
        const tempPath = `${this.storeFilePath}.tmp-${randomUUID()}`;
        const body = `${JSON.stringify(snapshot, null, 2)}\n`;
        await fs.writeFile(tempPath, body, "utf8");
        const retryableCodes = new Set(["EPERM", "EBUSY", "EACCES"]);
        const maxRenameAttempts = 5;
        for (let attempt = 1; attempt <= maxRenameAttempts; attempt += 1) {
            try {
                await fs.rename(tempPath, this.storeFilePath);
                return;
            }
            catch (error) {
                const code = error.code ?? "";
                const retryable = retryableCodes.has(code);
                if (!retryable || attempt >= maxRenameAttempts) {
                    await fs.rm(tempPath, { force: true });
                    throw error;
                }
                await new Promise((resolve) => {
                    setTimeout(resolve, 20 * attempt);
                });
            }
        }
    }
    async withWriteLock(fn) {
        const operation = this.writeQueue.then(async () => {
            const snapshot = await this.readSnapshot();
            const result = await fn(snapshot);
            await this.writeSnapshot(snapshot);
            return result;
        });
        this.writeQueue = operation.then(() => undefined, () => undefined);
        return operation;
    }
    async readSession(sessionId) {
        const snapshot = await this.readSnapshot();
        return snapshot.sessions[sessionId] ?? null;
    }
    async readActiveSessionByChannel(channelKey) {
        const snapshot = await this.readSnapshot();
        const indexedSessionId = snapshot.channelIndex[channelKey];
        if (indexedSessionId) {
            const indexedSession = snapshot.sessions[indexedSessionId];
            if (indexedSession && indexedSession.status === "active") {
                return indexedSession;
            }
        }
        const candidates = Object.values(snapshot.sessions)
            .filter((session) => session.channelKey === channelKey && session.status === "active")
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
        return candidates[0] ?? null;
    }
    async upsertSession(session) {
        await this.withWriteLock(async (snapshot) => {
            snapshot.sessions[session.sessionId] = session;
            if (session.status === "active") {
                snapshot.channelIndex[session.channelKey] = session.sessionId;
            }
            else if (snapshot.channelIndex[session.channelKey] === session.sessionId) {
                delete snapshot.channelIndex[session.channelKey];
            }
        });
    }
    async upsertInteractionRoute(route) {
        await this.withWriteLock(async (snapshot) => {
            const key = makeInteractionRouteStorageKey(route);
            snapshot.routes[key] = route;
        });
    }
    async readInteractionRoute(key) {
        const snapshot = await this.readSnapshot();
        const storageKey = makeInteractionRouteStorageKey(key);
        return snapshot.routes[storageKey] ?? null;
    }
    async consumeInteractionRoute(key, consumedAt) {
        return this.withWriteLock(async (snapshot) => {
            const storageKey = makeInteractionRouteStorageKey(key);
            const route = snapshot.routes[storageKey];
            if (!route || route.consumedAt) {
                return null;
            }
            const consumedRoute = {
                ...route,
                consumedAt,
            };
            snapshot.routes[storageKey] = consumedRoute;
            return consumedRoute;
        });
    }
    async deleteRoutesForSession(sessionId) {
        return this.withWriteLock(async (snapshot) => {
            let removed = 0;
            for (const key of Object.keys(snapshot.routes)) {
                if (snapshot.routes[key]?.sessionId !== sessionId) {
                    continue;
                }
                delete snapshot.routes[key];
                removed += 1;
            }
            return removed;
        });
    }
    async listRoutesForSession(sessionId, uiVersion) {
        const snapshot = await this.readSnapshot();
        const routes = Object.values(snapshot.routes)
            .filter((route) => route.sessionId === sessionId)
            .filter((route) => (uiVersion === undefined ? true : route.uiVersion === uiVersion))
            .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        return routes;
    }
}
