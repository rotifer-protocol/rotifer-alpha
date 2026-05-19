/**
 * Order Lifecycle Gene unit tests
 *
 * Focus: pure function decideOrderLifecycle — exhaustive coverage of
 * all action branches with injected nowMs for deterministic results.
 *
 * No I/O; DB functions (settleShadowOrderForTrade, createLiveOrder,
 * updateLiveOrderStatus) are thin SQL wrappers — not tested here.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  decideOrderLifecycle,
  DEFAULT_ORDER_LIFECYCLE_PARAMS,
  type OrderLifecycleInput,
} from "../src/order-lifecycle";

// ─── helpers ──────────────────────────────────────────────────────────────────

const T0 = new Date("2026-05-19T10:00:00Z").getTime();
const MINS = (n: number) => n * 60_000;

function baseInput(overrides: Partial<OrderLifecycleInput> = {}): OrderLifecycleInput {
  return {
    orderId: "test-order-001",
    submittedAt: new Date(T0).toISOString(),
    side: "BUY",
    limitPrice: 0.60,
    currentMarketPrice: 0.60,
    sizeUsdc: 100,
    filledUsdc: 0,
    ...overrides,
  };
}

// ─── HOLD: within normal operating parameters ─────────────────────────────────

test("HOLD when no timeout, no significant drift, not filled", () => {
  const d = decideOrderLifecycle(baseInput(), T0 + MINS(5));
  assert.equal(d.action, "HOLD");
  assert.equal(d.reason, "within_params");
});

test("HOLD when fully filled", () => {
  const d = decideOrderLifecycle(
    baseInput({ filledUsdc: 100 }),
    T0 + MINS(5),
  );
  assert.equal(d.action, "HOLD");
  assert.equal(d.reason, "fully_filled");
});

// ─── CANCEL: timeout with insufficient fill ────────────────────────────────────

test("CANCEL when max wait exceeded with no fill", () => {
  const d = decideOrderLifecycle(baseInput(), T0 + MINS(31)); // default 30 min
  assert.equal(d.action, "CANCEL");
  assert.equal(d.reason, "max_wait_exceeded");
});

test("CANCEL when custom gtcMaxWaitMinutes exceeded", () => {
  const d = decideOrderLifecycle(
    baseInput({ params: { gtcMaxWaitMinutes: 10 } }),
    T0 + MINS(11),
  );
  assert.equal(d.action, "CANCEL");
  assert.equal(d.reason, "max_wait_exceeded");
});

test("CANCEL with invalid submittedAt timestamp", () => {
  const d = decideOrderLifecycle(
    baseInput({ submittedAt: "not-a-date" }),
    T0 + MINS(5),
  );
  assert.equal(d.action, "CANCEL");
  assert.equal(d.reason, "invalid_submitted_at");
});

// ─── ACCEPT_PARTIAL: timeout + sufficient partial fill ────────────────────────

test("ACCEPT_PARTIAL when timeout with 80%+ fill (threshold met exactly)", () => {
  const d = decideOrderLifecycle(
    baseInput({ filledUsdc: 80 }), // 80 / 100 = 80%
    T0 + MINS(31),
  );
  assert.equal(d.action, "ACCEPT_PARTIAL");
  assert.match(d.reason, /timeout_with_partial_fill/);
});

test("ACCEPT_PARTIAL when timeout with 95% fill", () => {
  const d = decideOrderLifecycle(
    baseInput({ filledUsdc: 95 }),
    T0 + MINS(35),
  );
  assert.equal(d.action, "ACCEPT_PARTIAL");
  assert.match(d.reason, /95pct/);
});

test("CANCEL (not ACCEPT_PARTIAL) when timeout with only 50% fill", () => {
  const d = decideOrderLifecycle(
    baseInput({ filledUsdc: 50 }), // 50% < 80% default threshold
    T0 + MINS(31),
  );
  assert.equal(d.action, "CANCEL");
  assert.equal(d.reason, "max_wait_exceeded");
});

test("ACCEPT_PARTIAL with custom partialFillThresholdPct = 60%", () => {
  const d = decideOrderLifecycle(
    baseInput({ filledUsdc: 65, params: { partialFillThresholdPct: 60 } }),
    T0 + MINS(35),
  );
  assert.equal(d.action, "ACCEPT_PARTIAL");
});

// ─── UPDATE_PRICE: market drifted favorably ────────────────────────────────────

test("UPDATE_PRICE for BUY when market drops 60bps below limit price", () => {
  // limitPrice = 0.60, market drops to 0.594 → drift = 0.006/0.60 = 1% = 100bps
  const d = decideOrderLifecycle(
    baseInput({ currentMarketPrice: 0.594 }), // market moved favorably (cheaper for BUY)
    T0 + MINS(5),
  );
  assert.equal(d.action, "UPDATE_PRICE");
  assert.match(d.reason, /favorable/);
  assert.ok(d.newLimitPrice !== undefined);
  assert.equal(d.newLimitPrice, 0.594);
});

test("UPDATE_PRICE for SELL when market rises favorably", () => {
  // SELL: favorable = market price went UP (we get more)
  const d = decideOrderLifecycle(
    baseInput({
      side: "SELL",
      limitPrice: 0.60,
      currentMarketPrice: 0.606, // up 100bps — favorable for SELL
    }),
    T0 + MINS(5),
  );
  assert.equal(d.action, "UPDATE_PRICE");
  assert.ok(d.newLimitPrice !== undefined);
  assert.equal(d.newLimitPrice, 0.606);
});

test("HOLD for BUY when market rises (unfavorable drift)", () => {
  // BUY: unfavorable = market price went UP (costs more)
  const d = decideOrderLifecycle(
    baseInput({ currentMarketPrice: 0.61 }), // up 167bps — unfavorable for BUY
    T0 + MINS(5),
  );
  // No favorable drift: should hold
  assert.equal(d.action, "HOLD");
});

test("HOLD when drift < priceUpdateThresholdBps (20bps < 50bps default)", () => {
  // 0.60 → 0.599 = ~17bps drift, below 50bps threshold
  const d = decideOrderLifecycle(
    baseInput({ currentMarketPrice: 0.599 }),
    T0 + MINS(5),
  );
  assert.equal(d.action, "HOLD");
});

test("UPDATE_PRICE respects custom priceUpdateThresholdBps", () => {
  const d = decideOrderLifecycle(
    baseInput({
      currentMarketPrice: 0.598, // ~33bps drop
      params: { priceUpdateThresholdBps: 30 }, // threshold set to 30bps
    }),
    T0 + MINS(5),
  );
  assert.equal(d.action, "UPDATE_PRICE");
});

// ─── DEFAULT_ORDER_LIFECYCLE_PARAMS ───────────────────────────────────────────

test("DEFAULT_ORDER_LIFECYCLE_PARAMS has expected values", () => {
  assert.equal(DEFAULT_ORDER_LIFECYCLE_PARAMS.gtcMaxWaitMinutes, 30);
  assert.equal(DEFAULT_ORDER_LIFECYCLE_PARAMS.partialFillThresholdPct, 80);
  assert.equal(DEFAULT_ORDER_LIFECYCLE_PARAMS.priceUpdateThresholdBps, 50);
});

// ─── Fee modeling: applyFeeToCost ─────────────────────────────────────────────
// (imported from polymarket-venue to cross-verify integration)

import { applyFeeToCost, POLYMARKET_TAKER_FEE_BPS } from "../src/polymarket-venue";

test("applyFeeToCost returns fill price unchanged when fee = 0", () => {
  const result = applyFeeToCost(0.65, "YES", 0);
  assert.equal(result, 0.65);
});

test("applyFeeToCost increases cost for BUY with non-zero fee", () => {
  const result = applyFeeToCost(0.65, "YES", 200); // 2% fee
  assert.ok(result > 0.65, `Expected > 0.65, got ${result}`);
  assert.equal(result, 0.663); // 0.65 * 1.02 = 0.663
});

test("applyFeeToCost decreases proceeds for SELL with non-zero fee", () => {
  const result = applyFeeToCost(0.65, "NO", 200); // 2% fee
  assert.ok(result < 0.65, `Expected < 0.65, got ${result}`);
  assert.equal(result, 0.637); // 0.65 * 0.98 = 0.637
});

test("POLYMARKET_TAKER_FEE_BPS is 0 (Polymarket current fee)", () => {
  assert.equal(POLYMARKET_TAKER_FEE_BPS, 0);
});
