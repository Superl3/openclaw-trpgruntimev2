import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import {
  assertAgentAllowed,
  resolveWorldRootForContext,
  type TrpgRuntimeConfig,
} from "../../config.js";
import { resolveEffectiveWorldRootForSessionSync } from "../../runtime-core/session-workspaces.js";
import { emitRuntimeDiagnostic } from "../../runtime-core/runtime-diagnostics.js";

export type ToolGateResult =
  | { ok: true; worldRoot: string; agentId: string }
  | { ok: false; payload: Record<string, unknown> };

export type JsonToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

export function jsonToolResult(payload: unknown): JsonToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

export function toolGate(params: {
  cfg: TrpgRuntimeConfig;
  ctx: OpenClawPluginToolContext;
  api: OpenClawPluginApi;
}): ToolGateResult {
  const allowed = assertAgentAllowed(params.cfg, params.ctx);
  if (!allowed.ok) {
    return {
      ok: false,
      payload: { ok: false, error: allowed.error },
    };
  }

  const canonicalWorldRoot = resolveWorldRootForContext({
    cfg: params.cfg,
    ctx: params.ctx,
    resolvePath: params.api.resolvePath,
  });
  const worldRoot = resolveEffectiveWorldRootForSessionSync({
    canonicalWorldRoot,
    sessionContextId: params.ctx.sessionId,
  });

  void emitRuntimeDiagnostic({
    cfg: params.cfg,
    worldRoot,
    sessionId: params.ctx.sessionId,
    event: "session_world_root_resolved",
    severity: "info",
    route: "tool_gate",
    gate: "world_root_resolution",
    result: worldRoot === canonicalWorldRoot ? "canonical_world_root" : "session_workspace_root",
    details: {
      canonicalWorldRoot,
      effectiveWorldRoot: worldRoot,
      usedSessionWorkspace: worldRoot !== canonicalWorldRoot,
    },
  });

  return {
    ok: true,
    worldRoot,
    agentId: params.ctx.agentId as string,
  };
}
