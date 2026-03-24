import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { StateStore } from "../runtime-core/contracts.js";
import {
  RUNTIME_SCHEMA_VERSION,
  type InteractionRouteKey,
  type InteractionRouteRecord,
  type SessionState,
  makeInteractionRouteStorageKey,
} from "../runtime-core/types.js";

type StoreSnapshot = {
  schemaVersion: typeof RUNTIME_SCHEMA_VERSION;
  sessions: Record<string, SessionState>;
  channelIndex: Record<string, string>;
  routes: Record<string, InteractionRouteRecord>;
};

function createDefaultSnapshot(): StoreSnapshot {
  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    sessions: {},
    channelIndex: {},
    routes: {},
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseSnapshot(raw: unknown): StoreSnapshot {
  const root = toRecord(raw);
  const sessions = toRecord(root.sessions) as Record<string, SessionState>;
  const channelIndex = toRecord(root.channelIndex) as Record<string, string>;
  const routes = toRecord(root.routes) as Record<string, InteractionRouteRecord>;

  return {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    sessions,
    channelIndex,
    routes,
  };
}

export class JsonFileStateStore implements StateStore {
  private readonly rootDir: string;
  private readonly storeFilePath: string;
  private writeQueue: Promise<void>;

  constructor(rootDir: string, fileName = "checkpoint0-store.json") {
    this.rootDir = rootDir;
    this.storeFilePath = path.resolve(rootDir, fileName);
    this.writeQueue = Promise.resolve();
  }

  private async readSnapshot(): Promise<StoreSnapshot> {
    let text: string;
    try {
      text = await fs.readFile(this.storeFilePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return createDefaultSnapshot();
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(text) as unknown;
      return parseSnapshot(parsed);
    } catch {
      return createDefaultSnapshot();
    }
  }

  private async writeSnapshot(snapshot: StoreSnapshot): Promise<void> {
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
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
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

  private async withWriteLock<T>(fn: (snapshot: StoreSnapshot) => Promise<T>): Promise<T> {
    const operation = this.writeQueue.then(async () => {
      const snapshot = await this.readSnapshot();
      const result = await fn(snapshot);
      await this.writeSnapshot(snapshot);
      return result;
    });

    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );

    return operation;
  }

  async readSession(sessionId: string): Promise<SessionState | null> {
    const snapshot = await this.readSnapshot();
    return snapshot.sessions[sessionId] ?? null;
  }

  async readActiveSessionByChannel(channelKey: string): Promise<SessionState | null> {
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

  async upsertSession(session: SessionState): Promise<void> {
    await this.withWriteLock(async (snapshot) => {
      snapshot.sessions[session.sessionId] = session;
      if (session.status === "active") {
        snapshot.channelIndex[session.channelKey] = session.sessionId;
      } else if (snapshot.channelIndex[session.channelKey] === session.sessionId) {
        delete snapshot.channelIndex[session.channelKey];
      }
    });
  }

  async upsertInteractionRoute(route: InteractionRouteRecord): Promise<void> {
    await this.withWriteLock(async (snapshot) => {
      const key = makeInteractionRouteStorageKey(route);
      snapshot.routes[key] = route;
    });
  }

  async readInteractionRoute(key: InteractionRouteKey): Promise<InteractionRouteRecord | null> {
    const snapshot = await this.readSnapshot();
    const storageKey = makeInteractionRouteStorageKey(key);
    return snapshot.routes[storageKey] ?? null;
  }

  async consumeInteractionRoute(key: InteractionRouteKey, consumedAt: string): Promise<InteractionRouteRecord | null> {
    return this.withWriteLock(async (snapshot) => {
      const storageKey = makeInteractionRouteStorageKey(key);
      const route = snapshot.routes[storageKey];
      if (!route || route.consumedAt) {
        return null;
      }

      const consumedRoute: InteractionRouteRecord = {
        ...route,
        consumedAt,
      };
      snapshot.routes[storageKey] = consumedRoute;
      return consumedRoute;
    });
  }

  async deleteRoutesForSession(sessionId: string): Promise<number> {
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

  async listRoutesForSession(sessionId: string, uiVersion?: number): Promise<InteractionRouteRecord[]> {
    const snapshot = await this.readSnapshot();
    const routes = Object.values(snapshot.routes)
      .filter((route) => route.sessionId === sessionId)
      .filter((route) => (uiVersion === undefined ? true : route.uiVersion === uiVersion))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return routes;
  }
}
