import { randomUUID } from "node:crypto";
import type { AnchorTickEvent } from "./anchor-layer.js";
import type {
  Clock,
  IdGenerator,
} from "./contracts.js";
import {
  type RuntimeBootstrapDiagnostic,
  type RuntimeBootstrapInput,
  type RuntimeCanonicalProvenance,
  type RuntimeMetadata,
  ensureRuntimeMetadata,
} from "./types.js";

export const DEFAULT_SCENE_ID = "scene-bootstrap";

export class SystemClock implements Clock {
  nowIso(): string {
    return new Date().toISOString();
  }
}

export class RuntimeIdGenerator implements IdGenerator {
  newSessionId(): string {
    return `sess-${randomUUID()}`;
  }

  newActionId(): string {
    return `act-${randomUUID()}`;
  }
}

export function readNonEmptyString(value: string | undefined, fallback: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
}

export function nextUiVersion(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.trunc(value) + 1;
}

export function nextActionSeq(currentActionSeq: number, legacyTurnIndex: number): number {
  const canonical = Number.isFinite(currentActionSeq) ? Math.trunc(currentActionSeq) : 0;
  const legacy = Number.isFinite(legacyTurnIndex) ? Math.trunc(legacyTurnIndex) : 0;
  return Math.max(canonical, legacy) + 1;
}

function normalizeBootstrapDiagnostics(value: RuntimeBootstrapDiagnostic[] | undefined): RuntimeBootstrapDiagnostic[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const diagnostics: RuntimeBootstrapDiagnostic[] = [];
  for (const entry of value) {
    const code = typeof entry?.code === "string" ? entry.code.trim() : "";
    const message = typeof entry?.message === "string" ? entry.message.trim() : "";
    if (!code || !message) {
      continue;
    }
    diagnostics.push({
      code,
      message,
      path: typeof entry.path === "string" && entry.path.trim() ? entry.path.trim() : null,
      severity: entry.severity === "info" || entry.severity === "warn" || entry.severity === "error" ? entry.severity : "warn",
    });
    if (diagnostics.length >= 24) {
      break;
    }
  }
  return diagnostics;
}

export function buildRuntimeMetadata(params: {
  runtimeBootstrap?: RuntimeBootstrapInput | null;
  runtimeBootstrapDiagnostics?: RuntimeBootstrapDiagnostic[];
  runtimeCanonicalProvenance?: RuntimeCanonicalProvenance | null;
}): RuntimeMetadata {
  const diagnostics = normalizeBootstrapDiagnostics(params.runtimeBootstrapDiagnostics);
  if (!params.runtimeBootstrap) {
    return ensureRuntimeMetadata({
      bootstrap: {
        source: "default",
        seed: null,
        diagnostics,
      },
      canonicalSync: params.runtimeCanonicalProvenance ?? undefined,
    });
  }
  return ensureRuntimeMetadata({
    bootstrap: {
      source: "worldSeed",
      seed: {
        worldId: params.runtimeBootstrap.worldId,
        schemaVersion: params.runtimeBootstrap.schemaVersion,
        seedValue: params.runtimeBootstrap.seedValue,
        seedFingerprint: params.runtimeBootstrap.seedFingerprint,
      },
      diagnostics,
    },
    canonicalSync: params.runtimeCanonicalProvenance ?? undefined,
  });
}

export function pressureIntensityBand(value: number): "low" | "moderate" | "high" | "critical" {
  if (!Number.isFinite(value) || value < 35) {
    return "low";
  }
  if (value < 60) {
    return "moderate";
  }
  if (value < 80) {
    return "high";
  }
  return "critical";
}

export function anchorEventTypeToTraceType(eventType: AnchorTickEvent["eventType"]):
  | "engine.anchor.formed"
  | "engine.anchor.advanced"
  | "engine.anchor.escalated"
  | "engine.anchor.resolved"
  | "engine.anchor.failed"
  | "engine.anchor.archived" {
  switch (eventType) {
    case "formed":
      return "engine.anchor.formed";
    case "advanced":
      return "engine.anchor.advanced";
    case "escalated":
      return "engine.anchor.escalated";
    case "resolved":
      return "engine.anchor.resolved";
    case "failed":
      return "engine.anchor.failed";
    case "archived":
      return "engine.anchor.archived";
    default:
      return "engine.anchor.advanced";
  }
}
