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

// ─────────────────────────────────────────────────────────────────────────
// v1.0.5 §4.1 Platt scaling (ALPHA-PRD-003 C-HARDEN1.4)
// ─────────────────────────────────────────────────────────────────────────
//
// Per-category Platt scaling replaces the hardcoded UNTRUSTED_CATEGORY_MULTIPLIER
// + floors above with data-driven calibration:
//
//   calibratedProb = sigmoid(a × rawProb + b)
//
// Where (a, b) are logistic-regression coefficients trained on historical
// (rawProb, actual_outcome) pairs from paper_trades. Each category gets its
// own (a, b) — sports markets have different microstructure than crypto, etc.
//
// Training pipeline: see worker/scripts/train-platt-scaling.ts
// Trained model store: worker/data/platt-models.json (or D1 platt_models table)
//
// Until P-HARDEN1.2 (5 categories × ≥100 settled trades) the model defaults
// to identity (a=1, b=0) for every category — calibratedProb == rawProb,
// no behavioral change. Once trained, scan.ts populates sig.calibratedProb
// and downstream consumers (edge re-computation, sizing) use it.
//
// Once Platt is live + per-category quotas (§4.2) ship, this file's
// CALIBRATION_TRUSTED set + UNTRUSTED_* constants above can be removed —
// the calibrated probability + per-category quota naturally subsume the
// transitional gate (low calibratedProb → low edge → filtered by fund.minEdge).

/**
 * Platt scaling coefficients for one category.
 * calibrated_prob = sigmoid(a * raw_prob + b)
 */
export interface PlattScalingParams {
  /** Slope coefficient. Identity default = 1. */
  a: number;
  /** Intercept coefficient. Identity default = 0. */
  b: number;
  /** Training metadata for audit / drift detection. */
  trainedAt?: string;          // ISO timestamp of last training run
  trainedSampleCount?: number; // Number of (rawProb, outcome) pairs used
}

/** Per-category Platt model table. Each SignalCategory maps to one (a, b). */
export type PlattModelStore = Record<SignalCategory, PlattScalingParams>;

/** Identity model: calibratedProb == rawProb for every category. */
export const IDENTITY_PLATT_MODEL: PlattModelStore = {
  sports:   { a: 1, b: 0 },
  politics: { a: 1, b: 0 },
  crypto:   { a: 1, b: 0 },
  ai:       { a: 1, b: 0 },
  other:    { a: 1, b: 0 },
};

/**
 * Logistic / sigmoid function: σ(x) = 1 / (1 + exp(-x))
 * Numerically stable for large |x| (clamps before exp to avoid Infinity).
 */
export function sigmoid(x: number): number {
  if (x >= 0) {
    const ex = Math.exp(-x);
    return 1 / (1 + ex);
  } else {
    const ex = Math.exp(x);
    return ex / (1 + ex);
  }
}

/**
 * Apply per-category Platt scaling to a raw probability.
 *
 * Falls back to identity (returns rawProb unchanged) when:
 *   - category not in model store (defensive: model file out-of-date with new
 *     SignalCategory enum values)
 *   - model params are non-finite (defensive: corrupt model)
 *
 * @param rawProb Raw probability from the SignalAgent, range [0, 1].
 *   Clamped defensively before applying sigmoid argument.
 * @param category Inferred market category. Maps to (a, b) row.
 * @param model Platt model store (per-category coefficients). Defaults to
 *   IDENTITY_PLATT_MODEL when untrained — calibrated == raw.
 * @returns Calibrated probability in [0, 1]. Equal to rawProb when model is
 *   identity or when params are invalid.
 */
export function calibrateProbability(
  rawProb: number,
  category: SignalCategory,
  model: PlattModelStore = IDENTITY_PLATT_MODEL,
): number {
  // Defensive: clamp rawProb to [0, 1] in case caller passed an unclamped edge.
  const p = Math.max(0, Math.min(1, rawProb));
  const params = model[category];
  if (!params || !Number.isFinite(params.a) || !Number.isFinite(params.b)) {
    return p;
  }
  // Identity short-circuit (avoid sigmoid round-trip cost for untrained model).
  if (params.a === 1 && params.b === 0) return p;
  return sigmoid(params.a * p + params.b);
}

/**
 * Batch helper: populates sig.rawProb + sig.calibratedProb on each ArbSignal.
 *
 * Assumes the caller has already populated `sig.rawProb` upstream (or that
 * `sig.confidence` is the raw probability — TBD when scan.ts is wired up).
 * Until then, this is a no-op pass-through that returns the input signals
 * with calibratedProb mirroring rawProb (identity model).
 *
 * @param signals Signals to calibrate. Mutated in place AND returned.
 * @param model Platt model store. Defaults to IDENTITY_PLATT_MODEL.
 */
export function applyCalibrationToSignals(
  signals: ArbSignal[],
  model: PlattModelStore = IDENTITY_PLATT_MODEL,
): ArbSignal[] {
  for (const sig of signals) {
    if (typeof sig.rawProb !== "number") {
      // No upstream raw — skip (preserves current behavior where edge/conf
      // come directly from SignalAgent without an explicit probability layer).
      continue;
    }
    const cat = sig.category ?? "other";
    sig.calibratedProb = calibrateProbability(sig.rawProb, cat, model);
  }
  return signals;
}
