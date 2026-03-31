import fs from "node:fs/promises";
import type { TrpgRuntimeConfig } from "../../config.js";
import {
  loadStructuredWorldFile,
  renderStructuredContent,
  resolveWorldAbsolutePath,
} from "../../world-store.js";

export type FastWaitContext = {
  waitApplied: boolean;
  durationLabel: string;
  contextChunk?: string;
};

type ApplyFastWaitV1Deps = {
  toObject: (value: unknown) => Record<string, unknown>;
  readFiniteNumber: (value: unknown) => number | null;
  sanitizeIntentText: (value: string, maxLength?: number) => string;
  joinLines: (lines: string[]) => string;
  isFastWaitIntent: (value: string) => boolean;
  parseFastWaitDurationLabel: (value: string) => string;
  applyFastWaitWorldDrift: (params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
    waitCount: number;
  }) => Promise<string[]>;
};

export async function applyFastWaitV1(
  params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
    latestAction: string;
    prompt: string;
  },
  deps: ApplyFastWaitV1Deps,
): Promise<FastWaitContext> {
  const promptTail = typeof params.prompt === "string" ? params.prompt.slice(-2200) : "";
  const combinedProbe = `${params.latestAction}
${promptTail}`;
  if (!deps.isFastWaitIntent(combinedProbe)) {
    return {
      waitApplied: false,
      durationLabel: "",
    };
  }

  const durationLabel = deps.parseFastWaitDurationLabel(combinedProbe);
  const loaded = await loadStructuredWorldFile(params.worldRoot, "state/fast-wait.yaml", {
    allowMissing: true,
    maxReadBytes: params.cfg.maxReadBytes,
  });

  const root = deps.toObject(loaded.parsed);
  const waitNode = deps.toObject(root.fast_wait);
  const lastCount = deps.readFiniteNumber(waitNode.consecutive_wait_count) ?? 0;
  waitNode.consecutive_wait_count = Math.max(0, Math.floor(lastCount + 1));
  waitNode.last_duration = durationLabel;
  waitNode.last_user_intent = deps.sanitizeIntentText(params.latestAction || combinedProbe, 180);
  waitNode.last_applied_at = new Date().toISOString();

  root.meta = {
    schema_version: 1,
    last_updated: new Date().toISOString(),
  };
  root.fast_wait = waitNode;

  const rendered = renderStructuredContent(loaded.format, root);
  const absolute = resolveWorldAbsolutePath(params.worldRoot, "state/fast-wait.yaml");
  await fs.writeFile(absolute, rendered, "utf8");

  const driftLines = await deps.applyFastWaitWorldDrift({
    cfg: params.cfg,
    worldRoot: params.worldRoot,
    waitCount: Math.max(0, Math.floor(deps.readFiniteNumber(waitNode.consecutive_wait_count) ?? 0)),
  });

  const contextChunk = deps.joinLines([
    "[TRPG_RUNTIME_FAST_WAIT_V1]",
    `Fast-wait intent detected (${durationLabel}).`,
    "Resolve time-skip succinctly: brief progression, pressure shift, and one actionable next hook.",
    "Keep context-first and freeform-first. Do not switch to menu-first output.",
    "Unless player explicitly requests travel, stay in the same scene/zone while applying wait consequences.",
    ...driftLines,
  ]);

  return {
    waitApplied: true,
    durationLabel,
    contextChunk,
  };
}
