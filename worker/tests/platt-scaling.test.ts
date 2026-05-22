/**
 * platt-scaling.test.ts (2026-05-22)
 *
 * v1.0.5 §4.1 Platt scaling skeleton tests (ALPHA-PRD-003 C-HARDEN1.4).
 *
 * Validates the calibration math and batch-application contract that downstream
 * scan.ts / trade.ts will rely on once P-HARDEN1.2 data ships and a non-identity
 * model is trained. Tests deliberately cover both:
 *   1. Identity-default behavior (calibratedProb == rawProb), which is the
 *      production state until training data accumulates.
 *   2. Non-identity coefficients, so we know the math works correctly the
 *      moment we swap IDENTITY_PLATT_MODEL for a trained one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  sigmoid,
  calibrateProbability,
  applyCalibrationToSignals,
  IDENTITY_PLATT_MODEL,
  type PlattModelStore,
} from "../src/signal-calibration.js";
import type { ArbSignal, SignalCategory } from "../src/types.js";

// ── sigmoid math ──────────────────────────────────────────────────────────

test("sigmoid(0) = 0.5", () => {
  assert.equal(sigmoid(0), 0.5);
});

test("sigmoid(large positive) → 1", () => {
  assert.ok(sigmoid(100) > 0.999);
  assert.ok(sigmoid(100) <= 1);
});

test("sigmoid(large negative) → 0", () => {
  assert.ok(sigmoid(-100) < 0.001);
  assert.ok(sigmoid(-100) >= 0);
});

test("sigmoid is numerically stable for extreme inputs", () => {
  // Without the branch on sign of x, exp(-x) for x = -1000 would be Infinity.
  assert.ok(Number.isFinite(sigmoid(-1000)));
  assert.ok(Number.isFinite(sigmoid(1000)));
});

test("sigmoid is monotonic increasing", () => {
  const xs = [-5, -1, 0, 1, 5];
  const ys = xs.map(sigmoid);
  for (let i = 1; i < ys.length; i++) {
    assert.ok(ys[i] > ys[i - 1], `monotonic at i=${i}: ${ys[i-1]} -> ${ys[i]}`);
  }
});

// ── Identity model (production default) ──────────────────────────────────

test("identity model: calibratedProb == rawProb for every category", () => {
  const cats: SignalCategory[] = ["sports", "politics", "crypto", "ai", "other"];
  for (const cat of cats) {
    assert.equal(calibrateProbability(0.3, cat, IDENTITY_PLATT_MODEL), 0.3);
    assert.equal(calibrateProbability(0.7, cat, IDENTITY_PLATT_MODEL), 0.7);
    assert.equal(calibrateProbability(0.5, cat, IDENTITY_PLATT_MODEL), 0.5);
  }
});

test("identity model: default arg also works", () => {
  // Default-arg path: calibrateProbability(p, cat) with no model arg
  assert.equal(calibrateProbability(0.42, "sports"), 0.42);
});

// ── Non-identity model ────────────────────────────────────────────────────

test("non-identity model: applies sigmoid correctly", () => {
  // a=2, b=-1 → calibrated(0.5) = sigmoid(2*0.5 - 1) = sigmoid(0) = 0.5
  // (different math identity than the identity model)
  const model: PlattModelStore = {
    sports:   { a: 2, b: -1 },
    politics: { a: 1, b: 0 },
    crypto:   { a: 1, b: 0 },
    ai:       { a: 1, b: 0 },
    other:    { a: 1, b: 0 },
  };
  assert.equal(calibrateProbability(0.5, "sports", model), 0.5);
  // calibrated(0) = sigmoid(2*0 - 1) = sigmoid(-1) ≈ 0.269
  assert.ok(Math.abs(calibrateProbability(0, "sports", model) - 0.269) < 0.01);
});

test("non-identity model: different categories use different coefficients", () => {
  // crypto with extreme down-shift: a=1, b=-3
  // sigmoid(1*0.5 - 3) = sigmoid(-2.5) ≈ 0.0759
  const model: PlattModelStore = {
    ...IDENTITY_PLATT_MODEL,
    crypto:   { a: 1, b: -3 },
  };
  const calibCrypto = calibrateProbability(0.5, "crypto", model);
  const calibSports = calibrateProbability(0.5, "sports", model);
  assert.ok(calibCrypto < 0.1, `crypto calibrated should be ~0.076, got ${calibCrypto}`);
  assert.equal(calibSports, 0.5);  // identity for sports
});

// ── Defensive fallbacks ───────────────────────────────────────────────────

test("rawProb clamping: out-of-range input clamped to [0, 1]", () => {
  // Negative rawProb defensively clamped to 0
  assert.equal(calibrateProbability(-0.5, "sports", IDENTITY_PLATT_MODEL), 0);
  // > 1 clamped to 1
  assert.equal(calibrateProbability(1.5, "sports", IDENTITY_PLATT_MODEL), 1);
});

test("NaN coefficients: fallback to rawProb (defensive)", () => {
  const corrupt: PlattModelStore = {
    ...IDENTITY_PLATT_MODEL,
    sports: { a: NaN, b: 0 },
  };
  assert.equal(calibrateProbability(0.42, "sports", corrupt), 0.42);
});

test("Infinity coefficients: fallback to rawProb", () => {
  const corrupt: PlattModelStore = {
    ...IDENTITY_PLATT_MODEL,
    sports: { a: 1, b: Infinity },
  };
  assert.equal(calibrateProbability(0.42, "sports", corrupt), 0.42);
});

// ── applyCalibrationToSignals batch ───────────────────────────────────────

function makeSignal(overrides: Partial<ArbSignal> = {}): ArbSignal {
  return {
    signalId: "test",
    type: "MISPRICING",
    marketId: "m1",
    slug: "s",
    question: "?",
    description: "",
    edge: 1,
    confidence: 0.5,
    direction: "BUY_YES",
    prices: {},
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

test("applyCalibrationToSignals: populates calibratedProb when rawProb present", () => {
  const sigs = [
    makeSignal({ rawProb: 0.3, category: "sports" }),
    makeSignal({ rawProb: 0.7, category: "crypto" }),
  ];
  applyCalibrationToSignals(sigs, IDENTITY_PLATT_MODEL);
  assert.equal(sigs[0].calibratedProb, 0.3);
  assert.equal(sigs[1].calibratedProb, 0.7);
});

test("applyCalibrationToSignals: skips signals without rawProb (preserves current behavior)", () => {
  const sigs = [
    makeSignal({ category: "sports" }), // no rawProb
    makeSignal({ rawProb: 0.42, category: "politics" }),
  ];
  applyCalibrationToSignals(sigs, IDENTITY_PLATT_MODEL);
  assert.equal(sigs[0].calibratedProb, undefined);
  assert.equal(sigs[1].calibratedProb, 0.42);
});

test("applyCalibrationToSignals: missing category defaults to 'other'", () => {
  const sigs = [makeSignal({ rawProb: 0.5 })]; // no category
  applyCalibrationToSignals(sigs, IDENTITY_PLATT_MODEL);
  assert.equal(sigs[0].calibratedProb, 0.5);
});

test("applyCalibrationToSignals: returns same array reference (mutates in place)", () => {
  const sigs = [makeSignal({ rawProb: 0.5, category: "ai" })];
  const result = applyCalibrationToSignals(sigs, IDENTITY_PLATT_MODEL);
  assert.equal(result, sigs);
});
