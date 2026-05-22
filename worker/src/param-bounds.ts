/**
 * Shared tier-aware parameter boundaries for fund evolution.
 *
 * Single source of truth used by both:
 *   - PBT parameter evolution (evolve.ts)   — daily cron
 *   - Data-driven micro-evolution (micro-evolve.ts) — per-20-trades
 *
 * ADR-274 D2: Tier-aware bounds (Alpha-internal only, NOT protocol-level F(g)).
 */

export interface ParamBound {
  min: number;
  max: number;
  integer?: boolean;
}

/** Infer fund tier from initial balance (ADR-274 D1). */
export function fundTier(initialBalance: number): "small" | "medium" | "large" {
  if (initialBalance < 50_000) return "small";
  if (initialBalance < 500_000) return "medium";
  return "large";
}

// Tier-scaled bounds: scale proportionally with fund capital
export const PARAM_BOUNDS_BY_TIER: Record<"small" | "medium" | "large", Record<string, ParamBound>> = {
  small: {
    maxPerEvent:  { min: 50,    max: 2_000,    integer: true },
    minVolume:    { min: 1_000, max: 100_000,  integer: true },
    minLiquidity: { min: 1_000, max: 100_000,  integer: true },
    sizingBase:   { min: 50,    max: 500,      integer: true },
    sizingScale:  { min: 0,     max: 500,      integer: true },
  },
  medium: {
    maxPerEvent:  { min: 500,    max: 20_000,   integer: true },
    minVolume:    { min: 5_000,  max: 500_000,  integer: true },
    minLiquidity: { min: 5_000,  max: 500_000,  integer: true },
    sizingBase:   { min: 500,    max: 5_000,    integer: true },
    sizingScale:  { min: 0,      max: 5_000,    integer: true },
  },
  large: {
    maxPerEvent:  { min: 5_000,   max: 200_000,   integer: true },
    minVolume:    { min: 50_000,  max: 2_000_000, integer: true },
    minLiquidity: { min: 50_000,  max: 2_000_000, integer: true },
    sizingBase:   { min: 5_000,   max: 50_000,    integer: true },
    sizingScale:  { min: 0,       max: 50_000,    integer: true },
  },
};

// Tier-invariant bounds: identical across all capital tiers
export const PARAM_BOUNDS_INVARIANT: Record<string, ParamBound> = {
  minEdge:               { min: 0,    max: 10 },
  minConfidence:         { min: 0,    max: 1 },
  monthlyTarget:         { min: 0.01, max: 0.30 },
  drawdownLimit:         { min: 0.05, max: 0.50 },
  // v1.0.5 §1 P8-B Drawdown Double-Semantics (ALPHA-PRD-003 C-HARDEN1.1):
  // 新双语义字段,与旧 drawdownLimit 并行进化。
  // peakDrawdown_* 与 drawdownLimit 同范围 (语义已是 peak,方案 A 后).
  // lossVsInitial_* 略宽 (绝对兜底,触发更慢但更严重).
  peakDrawdownLimit:        { min: 0.05, max: 0.50 },
  peakDrawdownSoftLimit:    { min: 0.02, max: 0.30 },
  lossVsInitialLimit:       { min: 0.10, max: 0.60 },
  lossVsInitialSoftLimit:   { min: 0.05, max: 0.40 },
  maxOpenPositions:      { min: 3,    max: 20,    integer: true },
  stopLossPercent:       { min: 0.05, max: 0.30 },
  maxHoldDays:           { min: 3,    max: 30,    integer: true },
  takeProfitPercent:     { min: 0.05, max: 2.0 },
  trailingStopPercent:   { min: 0.03, max: 0.50 },
  probReversalThreshold: { min: 0.05, max: 0.50 },
  // Market Impact Gate: 5%–50% of market liquidity per order.
  // Conservative funds should tend lower (≤10%); aggressive funds may go higher.
  maxMarketImpactRatio:  { min: 0.05, max: 0.50 },
  // Same-event rolling-window count cap (v3, 2026-05-19).
  // Max entries per fund per event family within the last eventFamilyCooldownHours.
  // Default 1; conservative funds stay at 1, exploratory funds may evolve to 3-5.
  maxSameEventPositions: { min: 1,    max: 5,    integer: true },
  // Cooldown window for the same-event count gate (hours).
  // Replaces UTC-midnight boundary with a rolling window anchored to the
  // cron timestamp. Default 6h: conservative funds may evolve toward 12-24h
  // (effectively once-per-day); aggressive funds toward 2-4h (faster re-entry).
  eventFamilyCooldownHours: { min: 2,  max: 24,   integer: true },
  // Signal diversity budget: max fraction of total signals from any single
  // category (sports/politics/crypto/ai/other). Default 0.40 (40%).
  // Conservative funds evolve toward 0.20-0.30 (strict diversification);
  // aggressive funds may evolve toward 0.50-0.60 (allow category concentration
  // when a single-category opportunity is genuinely strong).
  maxCategoryFraction:      { min: 0.10, max: 0.80 },
};

export const EVOLVABLE_PARAMS: string[] = [
  ...Object.keys(PARAM_BOUNDS_INVARIANT),
  ...Object.keys(PARAM_BOUNDS_BY_TIER.small), // same keys across all tiers
];

export function getBound(
  tier: "small" | "medium" | "large",
  param: string,
): ParamBound | undefined {
  return PARAM_BOUNDS_BY_TIER[tier]?.[param] ?? PARAM_BOUNDS_INVARIANT[param];
}

export function clampParam(
  tier: "small" | "medium" | "large",
  name: string,
  value: number,
): number {
  const bound = getBound(tier, name);
  if (!bound) return value;
  let v = Math.max(bound.min, Math.min(bound.max, value));
  if (bound.integer) v = Math.round(v);
  return Math.round(v * 10000) / 10000;
}
