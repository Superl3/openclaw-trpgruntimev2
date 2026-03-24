import { randomUUID } from "node:crypto";
import type { RuntimeTraceEvent, RuntimeTraceEventType, SessionState } from "./types.js";

const DEFAULT_TRACE_MAX_EVENTS = 120;

function clampMaxEvents(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_TRACE_MAX_EVENTS;
  }
  const normalized = Math.trunc(value);
  if (normalized < 20) {
    return 20;
  }
  if (normalized > 500) {
    return 500;
  }
  return normalized;
}

export function createTraceEvent(params: {
  lane: RuntimeTraceEvent["lane"];
  type: RuntimeTraceEventType;
  severity?: RuntimeTraceEvent["severity"];
  tsIso: string;
  code?: string;
  recoverable?: boolean;
  data?: Record<string, unknown>;
}): RuntimeTraceEvent {
  return {
    traceId: `trace-${randomUUID()}`,
    tsIso: params.tsIso,
    lane: params.lane,
    type: params.type,
    severity: params.severity ?? "info",
    code: params.code,
    recoverable: params.recoverable,
    data: params.data ?? {},
  };
}

export function ensureTraceState(session: SessionState): SessionState {
  const maxEvents = clampMaxEvents(session.trace?.maxEvents ?? DEFAULT_TRACE_MAX_EVENTS);
  const events = Array.isArray(session.trace?.events)
    ? session.trace.events.filter((entry): entry is RuntimeTraceEvent => !!entry && typeof entry === "object").slice(-maxEvents)
    : [];

  return {
    ...session,
    trace: {
      maxEvents,
      events,
    },
  };
}

export function appendTraceEvent(session: SessionState, event: RuntimeTraceEvent): SessionState {
  const ensured = ensureTraceState(session);
  const maxEvents = clampMaxEvents(ensured.trace.maxEvents);
  const events = [...ensured.trace.events, event].slice(-maxEvents);
  return {
    ...ensured,
    trace: {
      maxEvents,
      events,
    },
  };
}
