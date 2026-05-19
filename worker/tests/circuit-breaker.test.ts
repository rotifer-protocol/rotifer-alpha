/**
 * Circuit Breaker Gene unit tests
 *
 * Focus: pure function checkCircuitBreaker — all action branches.
 * DB functions are thin SQL wrappers; not tested here.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  checkCircuitBreaker,
  DEFAULT_CB_THRESHOLD_PCT,
  type CircuitBreakerState,
} from "../src/circuit-breaker";

function baseState(overrides: Partial<CircuitBreakerState> = {}): CircuitBreakerState {
  return {
    fundId: "test-fund",
    epochStartUsdc: 1000,
    epochLossUsdc: 0,
    tripped: false,
    ...overrides,
  };
}

// ── DEFAULT_CB_THRESHOLD_PCT ──────────────────────────────────────────────────

test("DEFAULT_CB_THRESHOLD_PCT is 20", () => {
  assert.equal(DEFAULT_CB_THRESHOLD_PCT, 20);
});

// ── ALLOWED: within threshold ─────────────────────────────────────────────────

test("not blocked when no loss", () => {
  const r = checkCircuitBreaker(baseState(), DEFAULT_CB_THRESHOLD_PCT);
  assert.equal(r.blocked, false);
  assert.equal(r.epochLossPct, 0);
});

test("not blocked when loss is below threshold (19.9%)", () => {
  const r = checkCircuitBreaker(
    baseState({ epochLossUsdc: 199 }),
    DEFAULT_CB_THRESHOLD_PCT,
  );
  assert.equal(r.blocked, false);
  assert.ok(r.epochLossPct < 20);
});

test("not blocked when epochStartUsdc is 0 (no capital at stake)", () => {
  const r = checkCircuitBreaker(
    baseState({ epochStartUsdc: 0, epochLossUsdc: 50 }),
    DEFAULT_CB_THRESHOLD_PCT,
  );
  assert.equal(r.blocked, false);
  assert.equal(r.epochLossPct, 0);
});

// ── BLOCKED: threshold exceeded ───────────────────────────────────────────────

test("blocked when loss exactly equals threshold (20%)", () => {
  const r = checkCircuitBreaker(
    baseState({ epochLossUsdc: 200 }), // 200/1000 = 20%
    DEFAULT_CB_THRESHOLD_PCT,
  );
  assert.equal(r.blocked, true);
  assert.match(r.reason ?? "", /20\.0pct/);
});

test("blocked when loss exceeds threshold (25%)", () => {
  const r = checkCircuitBreaker(
    baseState({ epochLossUsdc: 250 }),
    DEFAULT_CB_THRESHOLD_PCT,
  );
  assert.equal(r.blocked, true);
  assert.equal(r.epochLossPct, 25);
});

test("blocked when already tripped (even with no loss)", () => {
  const r = checkCircuitBreaker(
    baseState({ tripped: true, trippedAt: "2026-05-19T10:00:00Z" }),
    DEFAULT_CB_THRESHOLD_PCT,
  );
  assert.equal(r.blocked, true);
  assert.match(r.reason ?? "", /circuit_breaker_tripped/);
});

// ── newLossUsdc projection ────────────────────────────────────────────────────

test("blocked when existing loss + newLossUsdc would exceed threshold", () => {
  // existing loss: 180 (18%), newLossUsdc: 25 → projected 205 (20.5%)
  const r = checkCircuitBreaker(
    baseState({ epochLossUsdc: 180 }),
    DEFAULT_CB_THRESHOLD_PCT,
    25,
  );
  assert.equal(r.blocked, true);
});

test("not blocked when existing loss + newLossUsdc stays under threshold", () => {
  // existing: 100 (10%), newLossUsdc: 50 → projected 150 (15%)
  const r = checkCircuitBreaker(
    baseState({ epochLossUsdc: 100 }),
    DEFAULT_CB_THRESHOLD_PCT,
    50,
  );
  assert.equal(r.blocked, false);
});

// ── custom threshold ──────────────────────────────────────────────────────────

test("respects custom thresholdPct = 10%", () => {
  const r = checkCircuitBreaker(
    baseState({ epochLossUsdc: 100 }), // 100/1000 = 10%
    10,
  );
  assert.equal(r.blocked, true);
  assert.equal(r.thresholdPct, 10);
});

test("not blocked with custom thresholdPct = 30% and 20% loss", () => {
  const r = checkCircuitBreaker(
    baseState({ epochLossUsdc: 200 }), // 200/1000 = 20%
    30,
  );
  assert.equal(r.blocked, false);
});
