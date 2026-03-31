import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { TrpgRuntimeConfig } from "../../config.js";
import { buildLifecycleCompactionPreview } from "../../lifecycle-compact.js";

function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export type LifecycleFallbackTrigger =
  | "scene_transition"
  | "fast_wait"
  | "zone_generation"
  | "downtime_tick";

function hasExplicitLifecycleToolInvocationIntent(latestAction: string): boolean {
  const lower = latestAction.trim().toLowerCase();
  if (!lower) {
    return false;
  }
  return (
    lower.includes("trpg_state_compact") ||
    lower.includes("state_compact") ||
    lower.includes("state compact") ||
    lower.includes("lifecycle compaction")
  );
}

function isDowntimeTickIntent(latestAction: string): boolean {
  const lower = latestAction.trim().toLowerCase();
  if (!lower) {
    return false;
  }
  return (
    lower.includes("downtime_tick") ||
    lower.includes("downtime tick") ||
    lower.includes("/downtime") ||
    lower.includes("downtime")
  );
}

export function detectLifecycleFallbackTrigger(params: {
  fastWaitApplied: boolean;
  generatedZone: boolean;
  sceneTransition: boolean;
  latestAction: string;
}): LifecycleFallbackTrigger | "" {
  if (params.fastWaitApplied) {
    return "fast_wait";
  }
  if (params.generatedZone) {
    return "zone_generation";
  }
  if (params.sceneTransition) {
    return "scene_transition";
  }
  if (isDowntimeTickIntent(params.latestAction)) {
    return "downtime_tick";
  }
  return "";
}

function mapFallbackTriggerToCompactionTrigger(
  trigger: LifecycleFallbackTrigger,
): "scene_transition" | "fast_wait" | "zone_generation" | "downtime" {
  if (trigger === "downtime_tick") {
    return "downtime";
  }
  return trigger;
}

export async function runLifecyclePreviewIfNeeded(params: {
  api: OpenClawPluginApi;
  cfg: TrpgRuntimeConfig;
  worldRoot: string;
  latestAction: string;
  trigger: LifecycleFallbackTrigger | "";
}): Promise<void> {
  if (!params.trigger) {
    return;
  }

  if (hasExplicitLifecycleToolInvocationIntent(params.latestAction)) {
    params.api.logger.info(
      "[trpg-runtime] lifecycle fallback skipped trigger=" +
        params.trigger +
        " reason=explicit tool invocation preferred",
    );
    return;
  }

  const compactionTrigger = mapFallbackTriggerToCompactionTrigger(params.trigger);
  try {
    const preview = await buildLifecycleCompactionPreview({
      cfg: params.cfg,
      worldRoot: params.worldRoot,
      trigger: compactionTrigger,
      maxCandidates: 8,
    });
    const previewRoot = toObject(preview);
    const summaryRoot = toObject(previewRoot.summary);
    params.api.logger.info(
      "[trpg-runtime] lifecycle fallback dry-run trigger=" +
        params.trigger +
        " compaction_trigger=" +
        compactionTrigger +
        " candidates=" +
        String(readFiniteNumber(previewRoot.candidateCount) ?? 0) +
        " selected=" +
        String(readFiniteNumber(summaryRoot.selected) ?? 0) +
        " ops=" +
        String(readFiniteNumber(previewRoot.operationCount) ?? 0),
    );
  } catch (error) {
    params.api.logger.warn(
      "[trpg-runtime] lifecycle fallback preview skipped: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}
