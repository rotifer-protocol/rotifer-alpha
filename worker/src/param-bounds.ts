/**
 * Shared tier-aware parameter boundaries for fund evolution.
 *
 * Single source of truth used by both:
 *   - PBT parameter evolution (evolve.ts)   — daily cron
 *   - Data-driven micro-evolution (micro-evolve.ts) — per-20-trades
 *
 * ADR-274 D2: Tier-aware bounds (Petri-internal only, NOT protocol-level F(g)).
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
  maxOpenPositions:      { min: 3,    max: 20,    integer: true },
  stopLossPercent:       { min: 0.05, max: 0.30 },
  maxHoldDays:           { min: 3,    max: 30,    integer: true },
  takeProfitPercent:     { min: 0.05, max: 2.0 },
  trailingStopPercent:   { min: 0.03, max: 0.50 },
  probReversalThreshold: { min: 0.05, max: 0.50 },
  // Market Impact Gate: 5%–50% of market liquidity per order.
  // Conservative funds should tend lower (≤10%); aggressive funds may go higher.
  maxMarketImpactRatio:  { min: 0.05, max: 0.50 },
  // Same-event daily quota: max entries per fund per event per UTC calendar day.
  // v2 semantics (2026-05-18 evening fix): counts ALL entries regardless of
  // status — prevents "stop → count resets → re-enter" cycle (James Bond bypass).
  // Default 1: one entry per day is sufficient for correlated multi-outcome events.
  // Conservative funds stay at 1; exploratory funds may evolve to 3-5.
  maxSameEventPositions: { min: 1,    max: 5,    integer: true },
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
