import fs from "node:fs/promises";
import type { TrpgRuntimeConfig } from "../../config.js";
import {
  runPatchApply,
  runPatchDryRun,
  type PatchApplyInput,
  type PatchCache,
} from "../../patch-engine.js";
import { emitRuntimeDiagnostic } from "../../runtime-core/runtime-diagnostics.js";
import {
  loadStructuredWorldFile,
  renderStructuredContent,
  resolveWorldAbsolutePath,
} from "../../world-store.js";

type BootstrapPersistenceDeps = {
  toObject: (value: unknown) => Record<string, unknown>;
  readString: (value: unknown) => string;
};

export async function syncBootstrapStateToStatus(
  params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
    player: Record<string, unknown>;
    gameState: Record<string, unknown>;
  },
  deps: BootstrapPersistenceDeps,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const loaded = await loadStructuredWorldFile(params.worldRoot, "state/player-status.yaml", {
    allowMissing: true,
    maxReadBytes: params.cfg.maxReadBytes,
  });

  const root = deps.toObject(loaded.parsed);
  const meta = deps.toObject(root.meta);
  const playerStatus = deps.toObject(root.player_status);
  const bootstrapStatus = deps.toObject(playerStatus.bootstrap);
  const desiredName = deps.readString(playerStatus.name) || deps.readString(params.player.name);
  const desiredGoal = deps.readString(playerStatus.current_goal) || deps.readString(params.player.goal);
  const desiredBootstrapName = deps.readString(params.player.name);
  const desiredBootstrapBackground = deps.readString(params.player.background);
  const desiredBootstrapMotive = deps.readString(params.player.motive);
  const desiredBootstrapGoal = deps.readString(params.player.goal);
  const desiredCharacterCreated = params.gameState.character_created === true;
  const desiredBootstrapComplete = params.gameState.bootstrap_complete === true;
  const changed =
    deps.readString(playerStatus.name) !== desiredName ||
    deps.readString(playerStatus.current_goal) !== desiredGoal ||
    deps.readString(bootstrapStatus.name) !== desiredBootstrapName ||
    deps.readString(bootstrapStatus.background) !== desiredBootstrapBackground ||
    deps.readString(bootstrapStatus.motive) !== desiredBootstrapMotive ||
    deps.readString(bootstrapStatus.goal) !== desiredBootstrapGoal ||
    (playerStatus.character_created === true) !== desiredCharacterCreated ||
    (playerStatus.bootstrap_complete === true) !== desiredBootstrapComplete ||
    (bootstrapStatus.character_created === true) !== desiredCharacterCreated ||
    (bootstrapStatus.bootstrap_complete === true) !== desiredBootstrapComplete;

  if (!changed && loaded.exists) {
    return;
  }

  root.meta = {
    ...meta,
    schema_version: 1,
    last_updated: deps.readString(meta.last_updated) || nowIso,
  };
  root.player_status = {
    ...playerStatus,
    name: desiredName,
    current_goal: desiredGoal,
    character_created: desiredCharacterCreated,
    bootstrap_complete: desiredBootstrapComplete,
    bootstrap: {
      ...bootstrapStatus,
      name: desiredBootstrapName,
      background: desiredBootstrapBackground,
      motive: desiredBootstrapMotive,
      goal: desiredBootstrapGoal,
      character_created: desiredCharacterCreated,
      bootstrap_complete: desiredBootstrapComplete,
      synced_at: nowIso,
    },
  };

  const rendered = renderStructuredContent(loaded.format ?? "yaml", root);
  await fs.writeFile(resolveWorldAbsolutePath(params.worldRoot, "state/player-status.yaml"), rendered, "utf8");
}

export async function applyBootstrapAuditedPersistence(
  params: {
    cfg: TrpgRuntimeConfig;
    worldRoot: string;
    agentId: string;
    sessionId?: string;
    patchCache: PatchCache;
    title: string;
    operations: Array<Record<string, unknown>>;
  },
  deps: BootstrapPersistenceDeps,
): Promise<{ ok: boolean; error?: string }> {
  if (params.operations.length === 0) {
    return { ok: true };
  }

  const canUseAuditedPatch = params.cfg.allowPatchApply && params.cfg.runtimeSafetyFlags.canonicalWriteBackEnabled;
  await emitRuntimeDiagnostic({
    cfg: params.cfg,
    worldRoot: params.worldRoot,
    sessionId: params.sessionId,
    event: "bootstrap_persistence_attempt",
    severity: "info",
    runtimePhase: "BOOTSTRAP",
    route: "before_prompt_build",
    gate: "bootstrap_persistence",
    result: canUseAuditedPatch ? "audited" : "fallback",
    details: {
      title: params.title,
      operationCount: params.operations.length,
    },
  });

  if (!canUseAuditedPatch) {
    await emitRuntimeDiagnostic({
      cfg: params.cfg,
      worldRoot: params.worldRoot,
      sessionId: params.sessionId,
      event: "bootstrap_persistence_fallback",
      severity: "warn",
      runtimePhase: "BOOTSTRAP",
      route: "before_prompt_build",
      gate: "bootstrap_persistence",
      result: "fallback_direct_write",
      details: {
        allowPatchApply: params.cfg.allowPatchApply,
        canonicalWriteBackEnabled: params.cfg.runtimeSafetyFlags.canonicalWriteBackEnabled,
      },
    });
    try {
      for (const operation of params.operations) {
        const op = deps.readString(operation.op);
        const file = deps.readString(operation.file);
        const pointer = deps.readString(operation.pointer);
        if (op !== "set" || pointer !== "/" || !file) {
          continue;
        }
        const absolute = resolveWorldAbsolutePath(params.worldRoot, file);
        const ext = file.toLowerCase().endsWith(".json") ? "json" : "yaml";
        const rendered = renderStructuredContent(ext, operation.value);
        await fs.writeFile(absolute, rendered, "utf8");
      }
      await emitRuntimeDiagnostic({
        cfg: params.cfg,
        worldRoot: params.worldRoot,
        sessionId: params.sessionId,
        event: "bootstrap_persistence_success",
        severity: "info",
        runtimePhase: "BOOTSTRAP",
        route: "before_prompt_build",
        gate: "bootstrap_persistence",
        result: "success",
        details: {
          title: params.title,
          mode: "fallback_direct_write",
        },
      });
      return { ok: true };
    } catch (error) {
      await emitRuntimeDiagnostic({
        cfg: params.cfg,
        worldRoot: params.worldRoot,
        sessionId: params.sessionId,
        event: "bootstrap_persistence_failed",
        severity: "error",
        runtimePhase: "BOOTSTRAP",
        route: "before_prompt_build",
        gate: "bootstrap_persistence",
        result: "failed",
        details: {
          title: params.title,
          mode: "fallback_direct_write",
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const dryRunResult = await runPatchDryRun({
    worldRoot: params.worldRoot,
    cfg: params.cfg,
    agentId: params.agentId,
    cache: params.patchCache,
    input: {
      title: params.title,
      allowNewFiles: true,
      operations: params.operations,
    },
  });
  const dryRunRoot = deps.toObject(dryRunResult);
  if (dryRunRoot.ok !== true) {
    return {
      ok: false,
      error: deps.readString(dryRunRoot.error) || "bootstrap audited dry-run failed",
    };
  }

  const validatedPatchId = deps.readString(dryRunRoot.patchId);
  if (!validatedPatchId) {
    return {
      ok: false,
      error: "bootstrap audited dry-run did not return patchId",
    };
  }

  const applyResult = await runPatchApply({
    worldRoot: params.worldRoot,
    cfg: params.cfg,
    agentId: params.agentId,
    sessionId: params.sessionId,
    cache: params.patchCache,
    input: {
      validatedPatchId,
      audit: {
        approved: true,
        approvedBy: "canon-auditor",
        verdict: "pass",
        conflictStatus: "non-conflicting",
        canonAbsorptionVerdict: "accept",
        note: "bootstrap-runtime auto persistence (memory-scribe-lite)",
      },
    } as PatchApplyInput,
  });
  const applyRoot = deps.toObject(applyResult);
  if (applyRoot.ok !== true) {
    await emitRuntimeDiagnostic({
      cfg: params.cfg,
      worldRoot: params.worldRoot,
      sessionId: params.sessionId,
      event: "bootstrap_persistence_failed",
      severity: "error",
      runtimePhase: "BOOTSTRAP",
      route: "before_prompt_build",
      gate: "bootstrap_persistence",
      result: "failed",
      details: {
        title: params.title,
        mode: "audited_apply",
        error: deps.readString(applyRoot.error) || "bootstrap audited apply failed",
      },
    });
    return {
      ok: false,
      error: deps.readString(applyRoot.error) || "bootstrap audited apply failed",
    };
  }

  await emitRuntimeDiagnostic({
    cfg: params.cfg,
    worldRoot: params.worldRoot,
    sessionId: params.sessionId,
    event: "bootstrap_persistence_success",
    severity: "info",
    runtimePhase: "BOOTSTRAP",
    route: "before_prompt_build",
    gate: "bootstrap_persistence",
    result: "success",
    details: {
      title: params.title,
      mode: "audited_apply",
      patchId: deps.readString(applyRoot.appliedPatchId),
    },
  });

  return { ok: true };
}
