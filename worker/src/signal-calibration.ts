/**
 * Signal Category Calibration Gate (P9-C transitional, 2026-05-21)
 *
 * Bridge between v1.0 (no per-category calibration) and v1.1 §5 Platt scaling.
 * Until Bayesian calibration ships, signals from untrusted categories must
 * clear a 1.5× premium on edge/confidence, with absolute floors to defend
 * against funds whose DNA sets minEdge/minConfidence to 0 (octopus / honey_badger).
 *
 * Evidence (5/14-5/21 paper_trades scan, fund != honey_badger_l):
 *   - crypto:  15 trades / 100% stop / -$4,777   (first appeared 5/20 after
 *              Layer 1 signal pool expansion via order=volume24hr — commit
 *              b66ea8e). Zero gross wins.
 *   - ai:      33 trades / 18.2% stop / net -$3,508 (same provenance).
 *   - sports:  net positive across all 3 windows (5/14-5/16, 5/17-5/19, 5/20-5/21).
 *   - politics: stop_rate 6-29%, net loss but contained.
 *
 * The SignalAgent's raw edge/confidence formula was implicitly tuned on
 * sports/politics market microstructure. crypto and ai markets have different
 * dynamics (continuous price discovery vs discrete event resolution; long-tail
 * tech events vs scheduled elections) that the raw model misreads as
 * "high edge". Bayesian Platt scaling per category (v1.1 §5) will replace
 * this hardcoded multiplier-and-floor approach with data-driven calibration.
 *
 * @see internal/products/rotifer-alpha/plan/rotifer-alpha-v1.1-plan.md §5
 * @see internal/products/rotifer-alpha/plan/rotifer-alpha-v1.0-plan.md §P9-C
 */
import type { ArbSignal, FundConfig, SignalCategory } from "./types";

/**
 * Categories where the SignalAgent's raw edge/confidence is empirically usable.
 * Membership criterion: ≥ 100 settled paper_trades with stop_rate consistent
 * with the model's predicted hit-rate distribution (within ±15 pp).
 */
export const CALIBRATION_TRUSTED: ReadonlySet<SignalCategory> = new Set<SignalCategory>([
  "sports",
  "politics",
]);

/** Premium multiplier required on top of fund DNA thresholds for untrusted categories. */
export const UNTRUSTED_CATEGORY_MULTIPLIER = 1.5;

/**
 * Absolute edge floor for untrusted categories (in %, matching ArbSignal.edge units).
 * Defends against funds with minEdge=0 (octopus / honey_badger / honey_badger_m / honey_badger_l).
 */
export const UNTRUSTED_MIN_EDGE_FLOOR = 1.0;

/**
 * Absolute confidence floor for untrusted categories (0-1 range).
 * Defends against funds with minConfidence=0.
 */
export const UNTRUSTED_MIN_CONFIDENCE_FLOOR = 0.3;

export interface CalibrationGateResult {
  pass: boolean;
  code?: "UNCALIBRATED_EDGE_TOO_LOW" | "UNCALIBRATED_CONFIDENCE_TOO_LOW";
}

/**
 * Apply category-aware calibration gate before a fund admits a signal.
 *
 * Trusted categories pass through (existing fund DNA gates already vetted them).
 * Untrusted categories must clear `max(fund.minEdge * 1.5, EDGE_FLOOR)` and
 * `max(fund.minConfidence * 1.5, CONFIDENCE_FLOOR)` — whichever is stricter.
 *
 * This gate runs AFTER the per-fund minEdge/minConfidence checks in trade.ts,
 * so it only adds extra stringency for untrusted categories — never lowers
 * the bar for trusted ones.
 */
export function categoryCalibrationGate(
  sig: ArbSignal,
  fund: FundConfig,
): CalibrationGateResult {
  const cat = sig.category ?? "other";
  if (CALIBRATION_TRUSTED.has(cat)) return { pass: true };

  // Round thresholds to 2 decimals to match ArbSignal.edge / .confidence
  // precision (scan.ts:210-211 round signal values to 2 decimals on emit).
  // Without this, 0.2 × 1.5 → 0.30000000000000004 would reject a sig with
  // confidence = 0.3 even though both represent the same intended bound.
  const edgeReq = Math.round(
    Math.max(fund.minEdge * UNTRUSTED_CATEGORY_MULTIPLIER, UNTRUSTED_MIN_EDGE_FLOOR) * 100,
  ) / 100;
  if (sig.edge < edgeReq) {
    return { pass: false, code: "UNCALIBRATED_EDGE_TOO_LOW" };
  }

  const confReq = Math.round(
    Math.max(fund.minConfidence * UNTRUSTED_CATEGORY_MULTIPLIER, UNTRUSTED_MIN_CONFIDENCE_FLOOR) * 100,
  ) / 100;
  if (sig.confidence < confReq) {
    return { pass: false, code: "UNCALIBRATED_CONFIDENCE_TOO_LOW" };
  }

  return { pass: true };
}
