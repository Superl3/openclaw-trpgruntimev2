import type { GovernanceResult, IdempotencyRecord, IdempotencyStore } from "./tool-governance-guard.js";

const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_IDEMPOTENCY_MAX_ENTRIES = 4000;

export type InMemoryIdempotencyStoreOptions = {
  ttlMs?: number;
  maxEntries?: number;
};

type StoreEntry<TResult> = IdempotencyRecord<TResult> & {
  updatedAtMs: number;
};

function makeStoreKey(params: { sessionId: string; toolName: string; key: string }): string {
  return `${params.sessionId}::${params.toolName}::${params.key}`;
}

function pruneStore<TResult>(
  map: Map<string, StoreEntry<TResult>>,
  nowMs: number,
  ttlMs: number,
  maxEntries: number,
): void {
  for (const [key, value] of map.entries()) {
    if (nowMs - value.updatedAtMs > ttlMs) {
      map.delete(key);
    }
  }

  if (map.size <= maxEntries) {
    return;
  }

  const sorted = Array.from(map.entries()).sort((left, right) => left[1].updatedAtMs - right[1].updatedAtMs);
  const removeCount = Math.max(0, sorted.length - maxEntries);
  for (let index = 0; index < removeCount; index += 1) {
    const candidate = sorted[index];
    if (candidate) {
      map.delete(candidate[0]);
    }
  }
}

export function createInMemoryIdempotencyStore<TResult>(
  options?: InMemoryIdempotencyStoreOptions,
): IdempotencyStore<TResult> {
  const ttlMs = options?.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const maxEntries = options?.maxEntries ?? DEFAULT_IDEMPOTENCY_MAX_ENTRIES;
  const map = new Map<string, StoreEntry<TResult>>();

  return {
    async get(params) {
      const nowMs = Date.now();
      pruneStore(map, nowMs, ttlMs, maxEntries);

      const key = makeStoreKey(params);
      const entry = map.get(key);
      if (!entry) {
        return null;
      }

      entry.updatedAtMs = nowMs;
      return {
        payloadHash: entry.payloadHash,
        status: entry.status,
        response: entry.response,
      };
    },

    async putProcessing(params) {
      const nowMs = Date.now();
      pruneStore(map, nowMs, ttlMs, maxEntries);

      const key = makeStoreKey(params);
      map.set(key, {
        payloadHash: params.payloadHash,
        status: "processing",
        updatedAtMs: nowMs,
      });
    },

    async putDone(params) {
      const nowMs = Date.now();
      pruneStore(map, nowMs, ttlMs, maxEntries);

      const key = makeStoreKey(params);
      map.set(key, {
        payloadHash: params.payloadHash,
        status: "done",
        response: params.response as GovernanceResult<TResult>,
        updatedAtMs: nowMs,
      });
    },
  };
}
