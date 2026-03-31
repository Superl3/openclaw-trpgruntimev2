import { emitRuntimeDiagnostic } from "../../runtime-core/runtime-diagnostics.js";
import type { TrpgRuntimeConfig } from "../../config.js";

export async function emitBeforePromptBuildStart(params: {
  cfg: TrpgRuntimeConfig;
  sessionId?: string;
  hasPrompt: boolean;
  messageCount: number;
}): Promise<void> {
  await emitRuntimeDiagnostic({
    cfg: params.cfg,
    worldRoot: params.cfg.worldRoot,
    sessionId: params.sessionId,
    event: "before_prompt_build_start",
    severity: "info",
    route: "before_prompt_build",
    gate: "entry",
    result: "started",
    details: {
      hasPrompt: params.hasPrompt,
      messageCount: params.messageCount,
    },
  });
}

export async function emitSessionWorldRootResolved(params: {
  cfg: TrpgRuntimeConfig;
  worldRoot: string;
  sessionId?: string;
  canonicalWorldRoot: string;
  effectiveWorldRoot: string;
}): Promise<void> {
  await emitRuntimeDiagnostic({
    cfg: params.cfg,
    worldRoot: params.worldRoot,
    sessionId: params.sessionId,
    event: "session_world_root_resolved",
    severity: "info",
    route: "before_prompt_build",
    gate: "world_root_resolution",
    result: params.effectiveWorldRoot === params.canonicalWorldRoot ? "canonical_world_root" : "session_workspace_root",
    details: {
      canonicalWorldRoot: params.canonicalWorldRoot,
      effectiveWorldRoot: params.effectiveWorldRoot,
      usedSessionWorkspace: params.effectiveWorldRoot !== params.canonicalWorldRoot,
    },
  });
}

export async function emitBeforePromptPhaseDetected(params: {
  cfg: TrpgRuntimeConfig;
  worldRoot: string;
  sessionId?: string;
  runtimePhase: string;
  phaseSignals: Record<string, unknown>;
}): Promise<void> {
  await emitRuntimeDiagnostic({
    cfg: params.cfg,
    worldRoot: params.worldRoot,
    sessionId: params.sessionId,
    event: "before_prompt_build_phase_detected",
    severity: "info",
    runtimePhase: params.runtimePhase,
    route: "before_prompt_build",
    gate: "phase",
    result: params.runtimePhase,
    details: params.phaseSignals,
  });
}

export async function emitBeforePromptBranchSelected(params: {
  cfg: TrpgRuntimeConfig;
  worldRoot: string;
  sessionId?: string;
  runtimePhase: string;
  result: "bootstrap" | "in_game";
  bootstrapComplete: boolean;
  justCompleted: boolean;
}): Promise<void> {
  await emitRuntimeDiagnostic({
    cfg: params.cfg,
    worldRoot: params.worldRoot,
    sessionId: params.sessionId,
    event: "before_prompt_build_branch_selected",
    severity: "info",
    runtimePhase: params.runtimePhase,
    route: "before_prompt_build",
    gate: "branch",
    result: params.result,
    details: {
      bootstrapComplete: params.bootstrapComplete,
      justCompleted: params.justCompleted,
    },
  });
}

export async function emitBeforePromptBuildFailed(params: {
  cfg: TrpgRuntimeConfig;
  sessionId?: string;
  errorMessage: string;
}): Promise<void> {
  await emitRuntimeDiagnostic({
    cfg: params.cfg,
    worldRoot: params.cfg.worldRoot,
    sessionId: params.sessionId,
    event: "before_prompt_build_failed",
    severity: "warn",
    route: "before_prompt_build",
    gate: "execution",
    result: "failed",
    details: {
      error: params.errorMessage,
    },
  });
}
