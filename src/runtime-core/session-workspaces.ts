import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

export type SessionDataSection = "player" | "status" | "inventory" | "scene";

export const SESSION_DATA_SECTIONS: SessionDataSection[] = ["player", "status", "inventory", "scene"];

const SESSION_WORKSPACES_REGISTRY_RELATIVE_PATH = "state/runtime-core/session-workspaces.json";
const SESSION_CONFIRM_REGISTRY_RELATIVE_PATH = "state/runtime-core/session-new-confirmations.json";
const SESSION_WORKSPACES_DIR_RELATIVE_PATH = "state/runtime-core/session-workspaces";

type SessionWorkspaceRecord = {
  sessionContextId: string;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
  lastSessionId: string | null;
};

type SessionWorkspaceRegistry = {
  schemaVersion: 1;
  updatedAt: string;
  mappings: Record<string, SessionWorkspaceRecord>;
};

type SessionConfirmationRecord = {
  token: string;
  sessionContextId: string;
  channelKey: string;
  ownerId: string;
  createdAt: string;
  expiresAt: string;
};

type SessionConfirmationRegistry = {
  schemaVersion: 1;
  updatedAt: string;
  confirmations: Record<string, SessionConfirmationRecord>;
};

const SECTION_PATHS: Record<SessionDataSection, string> = {
  player: "canon/player.yaml",
  status: "state/player-status.yaml",
  inventory: "state/inventory.yaml",
  scene: "state/current-scene.yaml",
};

function toObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function createDefaultWorkspaceRegistry(nowIso: string): SessionWorkspaceRegistry {
  return {
    schemaVersion: 1,
    updatedAt: nowIso,
    mappings: {},
  };
}

function parseWorkspaceRegistry(raw: unknown, nowIso: string): SessionWorkspaceRegistry {
  const root = toObject(raw);
  const mappingsRaw = toObject(root.mappings);
  const mappings: Record<string, SessionWorkspaceRecord> = {};

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

function createDefaultConfirmationRegistry(nowIso: string): SessionConfirmationRegistry {
  return {
    schemaVersion: 1,
    updatedAt: nowIso,
    confirmations: {},
  };
}

function parseConfirmationRegistry(raw: unknown, nowIso: string): SessionConfirmationRegistry {
  const root = toObject(raw);
  const confirmationsRaw = toObject(root.confirmations);
  const confirmations: Record<string, SessionConfirmationRecord> = {};

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

function workspaceRegistryAbsolutePath(canonicalWorldRoot: string): string {
  return path.resolve(canonicalWorldRoot, SESSION_WORKSPACES_REGISTRY_RELATIVE_PATH);
}

function confirmationRegistryAbsolutePath(canonicalWorldRoot: string): string {
  return path.resolve(canonicalWorldRoot, SESSION_CONFIRM_REGISTRY_RELATIVE_PATH);
}

async function readWorkspaceRegistry(canonicalWorldRoot: string): Promise<SessionWorkspaceRegistry> {
  const nowIso = new Date().toISOString();
  const absolute = workspaceRegistryAbsolutePath(canonicalWorldRoot);
  try {
    const text = await fsp.readFile(absolute, "utf8");
    return parseWorkspaceRegistry(JSON.parse(text) as unknown, nowIso);
  } catch {
    return createDefaultWorkspaceRegistry(nowIso);
  }
}

async function writeWorkspaceRegistry(canonicalWorldRoot: string, registry: SessionWorkspaceRegistry): Promise<void> {
  const absolute = workspaceRegistryAbsolutePath(canonicalWorldRoot);
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  await fsp.writeFile(absolute, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

async function readConfirmationRegistry(canonicalWorldRoot: string): Promise<SessionConfirmationRegistry> {
  const nowIso = new Date().toISOString();
  const absolute = confirmationRegistryAbsolutePath(canonicalWorldRoot);
  try {
    const text = await fsp.readFile(absolute, "utf8");
    return parseConfirmationRegistry(JSON.parse(text) as unknown, nowIso);
  } catch {
    return createDefaultConfirmationRegistry(nowIso);
  }
}

async function writeConfirmationRegistry(canonicalWorldRoot: string, registry: SessionConfirmationRegistry): Promise<void> {
  const absolute = confirmationRegistryAbsolutePath(canonicalWorldRoot);
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  await fsp.writeFile(absolute, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

function cleanupExpiredConfirmations(registry: SessionConfirmationRegistry, nowMs: number): void {
  for (const [token, record] of Object.entries(registry.confirmations)) {
    if (Date.parse(record.expiresAt) <= nowMs) {
      delete registry.confirmations[token];
    }
  }
}

function normalizeWorkspaceSessionSlug(sessionContextId: string): string {
  const normalized = sessionContextId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 48) || "session";
  const digest = createHash("sha256").update(sessionContextId).digest("hex").slice(0, 8);
  return `${normalized}-${digest}`;
}

async function copyFileIfExists(fromAbsolute: string, toAbsolute: string): Promise<"copied" | "missing"> {
  try {
    await fsp.access(fromAbsolute);
  } catch {
    return "missing";
  }

  await fsp.mkdir(path.dirname(toAbsolute), { recursive: true });
  await fsp.copyFile(fromAbsolute, toAbsolute);
  return "copied";
}

export function resolveEffectiveWorldRootForSessionSync(params: {
  canonicalWorldRoot: string;
  sessionContextId?: string;
}): string {
  const sessionContextId = readString(params.sessionContextId);
  if (!sessionContextId) {
    return params.canonicalWorldRoot;
  }

  const absolute = workspaceRegistryAbsolutePath(params.canonicalWorldRoot);
  try {
    const text = fs.readFileSync(absolute, "utf8");
    const parsed = parseWorkspaceRegistry(JSON.parse(text) as unknown, new Date().toISOString());
    const found = parsed.mappings[sessionContextId];
    if (!found?.workspaceRoot) {
      return params.canonicalWorldRoot;
    }
    const workspaceRoot = path.resolve(found.workspaceRoot);
    if (!fs.existsSync(workspaceRoot)) {
      return params.canonicalWorldRoot;
    }
    return workspaceRoot;
  } catch {
    return params.canonicalWorldRoot;
  }
}

export async function readSessionWorkspaceRecord(params: {
  canonicalWorldRoot: string;
  sessionContextId: string;
}): Promise<SessionWorkspaceRecord | null> {
  const registry = await readWorkspaceRegistry(params.canonicalWorldRoot);
  return registry.mappings[params.sessionContextId] ?? null;
}

export async function ensureSessionWorkspace(params: {
  canonicalWorldRoot: string;
  sessionContextId: string;
  sessionId: string;
}): Promise<SessionWorkspaceRecord> {
  const nowIso = new Date().toISOString();
  const registry = await readWorkspaceRegistry(params.canonicalWorldRoot);
  const existing = registry.mappings[params.sessionContextId];

  const workspaceRoot = existing?.workspaceRoot
    ? path.resolve(existing.workspaceRoot)
    : path.resolve(
        params.canonicalWorldRoot,
        SESSION_WORKSPACES_DIR_RELATIVE_PATH,
        normalizeWorkspaceSessionSlug(params.sessionContextId),
      );

  await fsp.mkdir(path.resolve(workspaceRoot, "state/runtime-core"), { recursive: true });
  await copySectionData({ fromWorldRoot: params.canonicalWorldRoot, toWorldRoot: workspaceRoot, sections: SESSION_DATA_SECTIONS });

  const record: SessionWorkspaceRecord = {
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

export async function wipeSessionWorkspace(params: {
  canonicalWorldRoot: string;
  sessionContextId: string;
}): Promise<{ removedWorkspace: boolean; removedMapping: boolean }> {
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

export async function issueSessionResetConfirmation(params: {
  canonicalWorldRoot: string;
  sessionContextId: string;
  channelKey: string;
  ownerId: string;
  ttlMs: number;
}): Promise<{ token: string; expiresAt: string }> {
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

export async function consumeSessionResetConfirmation(params: {
  canonicalWorldRoot: string;
  token: string;
  sessionContextId: string;
  channelKey: string;
  ownerId: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
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

  if (
    record.sessionContextId !== params.sessionContextId ||
    record.channelKey !== params.channelKey ||
    record.ownerId !== params.ownerId
  ) {
    return { ok: false, reason: "token_context_mismatch" };
  }

  delete registry.confirmations[params.token];
  registry.updatedAt = nowIso;
  await writeConfirmationRegistry(params.canonicalWorldRoot, registry);
  return { ok: true };
}

export async function copySectionData(params: {
  fromWorldRoot: string;
  toWorldRoot: string;
  sections: SessionDataSection[];
}): Promise<Array<{ section: SessionDataSection; path: string; result: "copied" | "missing" }>> {
  const outcomes: Array<{ section: SessionDataSection; path: string; result: "copied" | "missing" }> = [];
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

export async function deleteSectionDataFromWorkspace(params: {
  workspaceRoot: string;
  sections: SessionDataSection[];
}): Promise<Array<{ section: SessionDataSection; path: string; result: "deleted" | "missing" }>> {
  const outcomes: Array<{ section: SessionDataSection; path: string; result: "deleted" | "missing" }> = [];

  for (const section of params.sections) {
    const relativePath = SECTION_PATHS[section];
    const absolute = path.resolve(params.workspaceRoot, relativePath);
    let result: "deleted" | "missing" = "deleted";
    try {
      await fsp.rm(absolute);
    } catch {
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
