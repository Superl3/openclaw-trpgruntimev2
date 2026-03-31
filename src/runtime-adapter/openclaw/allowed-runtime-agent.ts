import type { TrpgRuntimeConfig } from "../../config.js";

export function isAllowedRuntimeAgent(cfg: TrpgRuntimeConfig, agentId: string | undefined): boolean {
  const normalized = typeof agentId === "string" ? agentId.trim() : "";
  if (!normalized) {
    return false;
  }

  if (cfg.allowedAgentIds.length === 0) {
    return true;
  }

  return cfg.allowedAgentIds.includes(normalized);
}
