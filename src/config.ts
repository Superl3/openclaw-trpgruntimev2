import path from "node:path";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";

export type TrpgRuntimeConfig = {
  worldRoot?: string;
  allowPatchApply: boolean;
  maxReadBytes: number;
  maxFilesPerQuery: number;
  maxOperationsPerPatch: number;
  allowedAgentIds: string[];
};

const DEFAULT_CONFIG: TrpgRuntimeConfig = {
  worldRoot: undefined,
  allowPatchApply: false,
  maxReadBytes: 262_144,
  maxFilesPerQuery: 40,
  maxOperationsPerPatch: 64,
  allowedAgentIds: ["trpg"],
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return parsed;
}

function readStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const values = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return values.length > 0 ? values : fallback;
}

export function parseTrpgRuntimeConfig(raw: unknown): TrpgRuntimeConfig {
  const obj = asRecord(raw);
  const worldRoot = typeof obj.worldRoot === "string" && obj.worldRoot.trim() ? obj.worldRoot : undefined;
  const allowPatchApply = typeof obj.allowPatchApply === "boolean" ? obj.allowPatchApply : false;

  return {
    worldRoot,
    allowPatchApply,
    maxReadBytes: readInteger(
      obj.maxReadBytes,
      DEFAULT_CONFIG.maxReadBytes,
      4_096,
      1_048_576,
      "maxReadBytes",
    ),
    maxFilesPerQuery: readInteger(
      obj.maxFilesPerQuery,
      DEFAULT_CONFIG.maxFilesPerQuery,
      1,
      200,
      "maxFilesPerQuery",
    ),
    maxOperationsPerPatch: readInteger(
      obj.maxOperationsPerPatch,
      DEFAULT_CONFIG.maxOperationsPerPatch,
      1,
      200,
      "maxOperationsPerPatch",
    ),
    allowedAgentIds: readStringArray(obj.allowedAgentIds, DEFAULT_CONFIG.allowedAgentIds),
  };
}

export const trpgRuntimeConfigSchema = {
  parse(value: unknown) {
    return parseTrpgRuntimeConfig(value);
  },
};

export function resolveWorldRootForContext(params: {
  cfg: TrpgRuntimeConfig;
  ctx: OpenClawPluginToolContext;
  resolvePath: (input: string) => string;
}): string {
  const fromWorkspace =
    typeof params.ctx.workspaceDir === "string" && params.ctx.workspaceDir.trim()
      ? path.join(params.ctx.workspaceDir, "world")
      : undefined;

  if (fromWorkspace) {
    return path.resolve(fromWorkspace);
  }

  if (params.cfg.worldRoot) {
    return path.resolve(params.resolvePath(params.cfg.worldRoot));
  }

  return path.resolve(params.resolvePath("~/.openclaw/workspace-trpg/world"));
}

export function assertAgentAllowed(
  cfg: TrpgRuntimeConfig,
  ctx: OpenClawPluginToolContext,
): { ok: true } | { ok: false; error: string } {
  const agentId = typeof ctx.agentId === "string" ? ctx.agentId.trim() : "";
  if (!agentId) {
    return {
      ok: false,
      error:
        "agentId is missing in tool context. This plugin is restricted to dedicated TRPG agent sessions.",
    };
  }

  if (!cfg.allowedAgentIds.includes(agentId)) {
    return {
      ok: false,
      error: `agentId '${agentId}' is not allowed. Allowed agent ids: ${cfg.allowedAgentIds.join(", ")}`,
    };
  }

  return { ok: true };
}
