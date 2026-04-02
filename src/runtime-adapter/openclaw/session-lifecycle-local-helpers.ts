import type { SessionState } from "../../runtime-core/types.js";

export function toObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function sanitizeLegacyBootstrapTemplateText(value: string): string {
  const normalized = readString(value);
  if (!normalized) {
    return "";
  }

  const hasForbidden =
    /\bpart\s*a\b|\bpart\s*b\b/i.test(normalized) ||
    /좋아요\s*,?\s*새\s*캐릭터\s*생성을\s*시작할게요/i.test(normalized) ||
    /숨기고\s*있는\s*비밀/i.test(normalized) ||
    (normalized.match(/(?:^|\n)\s*[1-6]\s*[\).:：-]\s+/g)?.length ?? 0) >= 4;

  if (hasForbidden) {
    return "캐릭터 준비를 이어갈게요.";
  }

  return normalized;
}

export function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function readInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

export function clampTraceTailCount(value: unknown, fallback: number): number {
  const parsed = readInteger(value);
  if (!parsed) {
    return fallback;
  }
  return Math.max(1, Math.min(12, parsed));
}

function summarizeTraceData(value: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const allowedKeys = new Set([
    "routeActionId",
    "inputActionId",
    "resolvedActionId",
    "selectedActionId",
    "selectedSource",
    "selectedConfidence",
    "classification",
    "deltaTimeSec",
    "sceneId",
    "uiVersion",
    "result",
    "reason",
    "transitionCount",
    "surfacedNow",
    "expiredDeleted",
    "failedNow",
    "mutatedNow",
    "archivedNow",
    "generationAttempted",
    "updatedCount",
    "slotCount",
    "locationId",
    "locationShifted",
    "memoryTouched",
    "tracesCreated",
    "tracesExpired",
    "dispatchId",
    "mode",
    "actionId",
  ]);
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!allowedKeys.has(key)) {
      continue;
    }
    if (typeof raw === "string") {
      out[key] = raw.length <= 72 ? raw : `${raw.slice(0, 69)}...`;
      continue;
    }
    if (typeof raw === "number" || typeof raw === "boolean" || raw === null) {
      out[key] = raw;
    }
  }
  return out;
}

export function traceTailPayload(session: SessionState, tailCount: number, includeData: boolean): Array<Record<string, unknown>> {
  return session.trace.events.slice(-tailCount).map((event) => {
    const base: Record<string, unknown> = {
      tsIso: event.tsIso,
      lane: event.lane,
      type: event.type,
      severity: event.severity,
    };
    if (event.code) {
      base.code = event.code;
    }
    if (includeData) {
      base.data = summarizeTraceData(event.data);
    }
    return base;
  });
}
