import type { ActionFeasibility } from "./scene-loop.js";

export type WhimConfig = {
  enabled: boolean;
  positiveSurpriseWeight: number;
  negativeSurpriseWeight: number;
  maxAbsoluteAdjustment: number;
  taperStartGap: number;
  disableGap: number;
  highRiskThreshold: number;
  highRiskGlobalScale: number;
  highRiskRecklessScale: number;
};

export const DEFAULT_WHIM_CONFIG: WhimConfig = {
  enabled: false,
  positiveSurpriseWeight: 0.034,
  negativeSurpriseWeight: 0.011,
  maxAbsoluteAdjustment: 0.045,
  taperStartGap: 0.08,
  disableGap: 0.2,
  highRiskThreshold: 0.7,
  highRiskGlobalScale: 0.65,
  highRiskRecklessScale: 0,
};

export type WhimAdjustmentInput = {
  actionId: string;
  availability: ActionFeasibility | string | undefined;
  baseScore: number;
  leaderBaseScore: number;
  riskLevel: number;
  config?: Partial<WhimConfig>;
};

export type WhimAdjustmentResult = {
  enabled: boolean;
  applied: boolean;
  adjustment: number;
  adjustedScore: number;
  reason: "disabled" | "invalid_score" | "non_feasible" | "gap_blocked" | "applied";
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function deterministicUnitFromActionId(actionId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < actionId.length; index += 1) {
    hash ^= actionId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function resolveWhimConfig(config?: Partial<WhimConfig>): WhimConfig {
  return {
    enabled: config?.enabled ?? DEFAULT_WHIM_CONFIG.enabled,
    positiveSurpriseWeight: clamp(
      config?.positiveSurpriseWeight ?? DEFAULT_WHIM_CONFIG.positiveSurpriseWeight,
      0,
      0.2,
    ),
    negativeSurpriseWeight: clamp(
      config?.negativeSurpriseWeight ?? DEFAULT_WHIM_CONFIG.negativeSurpriseWeight,
      0,
      0.2,
    ),
    maxAbsoluteAdjustment: clamp(
      config?.maxAbsoluteAdjustment ?? DEFAULT_WHIM_CONFIG.maxAbsoluteAdjustment,
      0,
      0.3,
    ),
    taperStartGap: clamp(config?.taperStartGap ?? DEFAULT_WHIM_CONFIG.taperStartGap, 0, 1),
    disableGap: clamp(config?.disableGap ?? DEFAULT_WHIM_CONFIG.disableGap, 0, 1),
    highRiskThreshold: clamp(config?.highRiskThreshold ?? DEFAULT_WHIM_CONFIG.highRiskThreshold, 0, 1),
    highRiskGlobalScale: clamp(
      config?.highRiskGlobalScale ?? DEFAULT_WHIM_CONFIG.highRiskGlobalScale,
      0,
      1,
    ),
    highRiskRecklessScale: clamp(
      config?.highRiskRecklessScale ?? DEFAULT_WHIM_CONFIG.highRiskRecklessScale,
      0,
      1,
    ),
  };
}

export function applyWhimAdjustment(input: WhimAdjustmentInput): WhimAdjustmentResult {
  const config = resolveWhimConfig(input.config);
  if (!config.enabled) {
    return {
      enabled: false,
      applied: false,
      adjustment: 0,
      adjustedScore: input.baseScore,
      reason: "disabled",
    };
  }

  if (!Number.isFinite(input.baseScore) || !Number.isFinite(input.leaderBaseScore)) {
    return {
      enabled: true,
      applied: false,
      adjustment: 0,
      adjustedScore: input.baseScore,
      reason: "invalid_score",
    };
  }

  if (input.availability === "currently_impossible" || input.availability === "impossible") {
    return {
      enabled: true,
      applied: false,
      adjustment: 0,
      adjustedScore: input.baseScore,
      reason: "non_feasible",
    };
  }

  const gap = Math.max(0, input.leaderBaseScore - input.baseScore);
  if (gap >= config.disableGap) {
    return {
      enabled: true,
      applied: false,
      adjustment: 0,
      adjustedScore: input.baseScore,
      reason: "gap_blocked",
    };
  }

  const taper =
    gap <= config.taperStartGap
      ? 1
      : clamp((config.disableGap - gap) / Math.max(0.000001, config.disableGap - config.taperStartGap), 0, 1);
  const actionUnit = deterministicUnitFromActionId(input.actionId);
  const positive = actionUnit * config.positiveSurpriseWeight;
  const negative = (1 - actionUnit) * config.negativeSurpriseWeight;
  const baseline = positive - negative;

  let safetyScale = 1;
  const highRisk = input.riskLevel >= config.highRiskThreshold;
  if (highRisk) {
    safetyScale *= config.highRiskGlobalScale;
    if (input.availability === "reckless" || input.actionId === "action.rush") {
      safetyScale *= config.highRiskRecklessScale;
    }
  }

  const adjustment = clamp(
    baseline * taper * safetyScale,
    -config.maxAbsoluteAdjustment,
    config.maxAbsoluteAdjustment,
  );
  return {
    enabled: true,
    applied: adjustment !== 0,
    adjustment,
    adjustedScore: input.baseScore + adjustment,
    reason: "applied",
  };
}
