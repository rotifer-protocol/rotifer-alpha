/**
 * Regression tests for the adaptive Epoch Gate (D1-D4, roundtable 2026-05-11).
 *
 * Tests the pure evaluateEpochGate() function — all boundary conditions,
 * priority ordering, and parameter semantics.
 *
 * Also tests tier-aware minTradesForEval() thresholds (D2).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateEpochGate,
  minTradesForEval,
  MIN_EPOCH_DAYS,
  MAX_EPOCH_DAYS,
  MIN_ELIGIBLE_VARIANTS,
  TARGET_TRADES_SYSTEM,
} from "../src/evolve";

// ─── minTradesForEval (D2) ───────────────────────────────────────────────────

test("minTradesForEval: S-tier ($10K) → 3", () => {
  assert.equal(minTradesForEval(10_000), 3);
});

test("minTradesForEval: M-tier ($100K) → 5", () => {
  assert.equal(minTradesForEval(100_000), 5);
});

test("minTradesForEval: L-tier ($1M) → 10", () => {
  assert.equal(minTradesForEval(1_000_000), 10);
});

// ─── evaluateEpochGate — hard floor (D3) ────────────────────────────────────

test("gate: TOO_SOON when daysSince < MIN_EPOCH_DAYS", () => {
  const result = evaluateEpochGate(MIN_EPOCH_DAYS - 0.5, 999, 15);
  assert.equal(result.shouldEvolve, false);
  assert.equal(result.reason, "SKIP_TOO_SOON");
});

test("gate: TOO_SOON on day 0 (just evolved)", () => {
  const result = evaluateEpochGate(0, 999, 15);
  assert.equal(result.shouldEvolve, false);
  assert.equal(result.reason, "SKIP_TOO_SOON");
});

test("gate: TOO_SOON takes priority over all other conditions", () => {
  // Even if MAX_EPOCH_DAYS is exceeded in theory, a 0-day elapsed means too soon.
  // (This scenario can't naturally occur but tests priority ordering.)
  const result = evaluateEpochGate(0, TARGET_TRADES_SYSTEM + 100, MIN_ELIGIBLE_VARIANTS + 10);
  assert.equal(result.reason, "SKIP_TOO_SOON");
});

// ─── evaluateEpochGate — hard ceiling (D3) ──────────────────────────────────

test("gate: FORCE_EVOLVE_MAX_DAYS when daysSince >= MAX_EPOCH_DAYS", () => {
  const result = evaluateEpochGate(MAX_EPOCH_DAYS, 0, 0);
  assert.equal(result.shouldEvolve, true);
  assert.equal(result.reason, "FORCE_EVOLVE_MAX_DAYS");
});

test("gate: FORCE_EVOLVE_MAX_DAYS even with zero trades (cold market)", () => {
  const result = evaluateEpochGate(MAX_EPOCH_DAYS + 2, 0, 0);
  assert.equal(result.shouldEvolve, true);
  assert.equal(result.reason, "FORCE_EVOLVE_MAX_DAYS");
});

test("gate: FORCE_EVOLVE_MAX_DAYS takes priority over low-trades check", () => {
  const result = evaluateEpochGate(MAX_EPOCH_DAYS, TARGET_TRADES_SYSTEM - 1, 0);
  assert.equal(result.reason, "FORCE_EVOLVE_MAX_DAYS");
});

// ─── evaluateEpochGate — low trades (D3) ────────────────────────────────────

test("gate: SKIP_LOW_TRADES when trades < TARGET_TRADES_SYSTEM", () => {
  const result = evaluateEpochGate(MIN_EPOCH_DAYS + 1, TARGET_TRADES_SYSTEM - 1, 15);
  assert.equal(result.shouldEvolve, false);
  assert.equal(result.reason, "SKIP_LOW_TRADES");
});

test("gate: SKIP_LOW_TRADES at exactly TARGET - 1", () => {
  const result = evaluateEpochGate(4, TARGET_TRADES_SYSTEM - 1, 15);
  assert.equal(result.reason, "SKIP_LOW_TRADES");
});

// ─── evaluateEpochGate — low eligible variants (D3) ─────────────────────────

test("gate: SKIP_LOW_ELIGIBLE_VARIANTS when eligible < MIN_ELIGIBLE_VARIANTS", () => {
  const result = evaluateEpochGate(MIN_EPOCH_DAYS + 1, TARGET_TRADES_SYSTEM, MIN_ELIGIBLE_VARIANTS - 1);
  assert.equal(result.shouldEvolve, false);
  assert.equal(result.reason, "SKIP_LOW_ELIGIBLE_VARIANTS");
});

test("gate: SKIP_LOW_ELIGIBLE_VARIANTS at 0 eligible", () => {
  const result = evaluateEpochGate(3, TARGET_TRADES_SYSTEM + 100, 0);
  assert.equal(result.reason, "SKIP_LOW_ELIGIBLE_VARIANTS");
});

// ─── evaluateEpochGate — happy path (D3) ────────────────────────────────────

test("gate: EVOLVE_TARGET_MET when all conditions satisfied", () => {
  const result = evaluateEpochGate(MIN_EPOCH_DAYS + 1, TARGET_TRADES_SYSTEM, MIN_ELIGIBLE_VARIANTS);
  assert.equal(result.shouldEvolve, true);
  assert.equal(result.reason, "EVOLVE_TARGET_MET");
});

test("gate: EVOLVE_TARGET_MET at exact boundary values", () => {
  const result = evaluateEpochGate(
    MIN_EPOCH_DAYS,           // exactly at floor (allowed)
    TARGET_TRADES_SYSTEM,     // exactly at target
    MIN_ELIGIBLE_VARIANTS,    // exactly at min
  );
  assert.equal(result.shouldEvolve, true);
  assert.equal(result.reason, "EVOLVE_TARGET_MET");
});

// ─── evaluateEpochGate — gate result metadata ───────────────────────────────

test("gate: result carries back the input metrics", () => {
  const result = evaluateEpochGate(3.7, 75, 10);
  assert.equal(result.daysSinceLastEpoch, 3.7);
  assert.equal(result.tradesSinceLastEpoch, 75);
  assert.equal(result.eligibleVariants, 10);
});

// ─── Real-world scenarios ────────────────────────────────────────────────────

test("gate: current live scenario — day 8, 196 trades, 13 eligible → should evolve", () => {
  // E6 started 2026-05-03, today is 2026-05-11 → ~8 days
  // 196 trades since E6, 13/15 funds meet tier threshold
  const result = evaluateEpochGate(8, 196, 13);
  assert.equal(result.shouldEvolve, true);
  // 8 days >= MAX_EPOCH_DAYS(7) → FORCE_EVOLVE_MAX_DAYS
  assert.equal(result.reason, "FORCE_EVOLVE_MAX_DAYS");
});

test("gate: day 3 high-traffic → EVOLVE_TARGET_MET", () => {
  // Three days in, 70 trades, 10 eligible funds
  const result = evaluateEpochGate(3, 70, 10);
  assert.equal(result.shouldEvolve, true);
  assert.equal(result.reason, "EVOLVE_TARGET_MET");
});

test("gate: day 5 low-traffic cold market → SKIP_LOW_TRADES", () => {
  // Quiet week: 5 days, only 20 trades
  const result = evaluateEpochGate(5, 20, 8);
  assert.equal(result.shouldEvolve, false);
  assert.equal(result.reason, "SKIP_LOW_TRADES");
});

// ─── TARGET_TRADES_SYSTEM matches UI progress bar target ──────────────────
// Regression guard: apiEvolution epochProgress.tradesTarget must equal
// TARGET_TRADES_SYSTEM. The UI SQL must count opened_at (not status='closed'
// which doesn't exist) to stay in sync with the gate trigger logic.
test("TARGET_TRADES_SYSTEM is 60 (UI progress bar denominator)", () => {
  assert.equal(TARGET_TRADES_SYSTEM, 60);
});
