import test from "node:test";
import assert from "node:assert/strict";

import { entryDirection, entryPrice, passesPriceBoundary } from "../src/trade";
import type { ArbSignal } from "../src/types";

// ============================================================
// Regression: 2026-05-05 SELL_WEAKEST PRICE_BOUNDARY false-block
// ============================================================
//
// Symptom: 7+ hours of zero trades opened across all 15 funds.
// Heartbeat showed PRICE_BOUNDARY as the dominant skip reason.
//
// Root cause: trade.ts used a uniform `price <= 0.01 || price >= 0.99`
// filter. SELL_WEAKEST signals expose `entryPrice = min(outcomes)`,
// which legitimately approaches 0 for the weakest team in a championship
// market. Filtering them out *defeats the entire SELL_WEAKEST strategy*.
//
// Fix: direction-aware bounds via passesPriceBoundary().

function buildSignal(overrides: Partial<ArbSignal>): ArbSignal {
  return {
    signalId: "SIG-test",
    type: "MULTI_OUTCOME_ARB",
    marketId: "test",
    slug: "test",
    question: "test",
    description: "test",
    edge: 2.0,
    confidence: 0.65,
    direction: "SELL_WEAKEST",
    prices: {},
    timestamp: "2026-05-05T12:00:00.000Z",
    ...overrides,
  };
}

test("SELL_WEAKEST signal at price 0.0085 (76ers in 2026 NBA Champion) is NOT blocked", () => {
  const sig = buildSignal({
    signalId: "SIG-test-0001",
    marketId: "2026-nba-champion",
    slug: "2026-nba-champion",
    question: "2026 NBA Champion",
    edge: 2.3,
    confidence: 0.61,
    prices: {
      "Will the Oklahoma City Thunder win the 2026 NBA Finals?": 0.595,
      "Will the Philadelphia 76ers win the 2026 NBA Finals?": 0.0085,
      "Will the New York Knicks win the 2026 NBA Finals?": 0.0985,
    },
  });

  const price = entryPrice(sig);
  const dir = entryDirection(sig);

  assert.equal(price, 0.0085, "entryPrice should be the min outcome (the weakest team)");
  assert.equal(dir, "SELL_YES", "SELL_WEAKEST maps to SELL_YES");
  assert.equal(passesPriceBoundary(price, dir), true, "0.0085 SELL_YES must pass — this IS the alpha");
});

test("SELL_WEAKEST signal at price 0.01 (Flyers in 2026 NHL Stanley Cup) is NOT blocked", () => {
  const sig = buildSignal({
    signalId: "SIG-test-0002",
    marketId: "2026-nhl-stanley-cup-champion",
    slug: "2026-nhl-stanley-cup-champion",
    question: "2026 NHL Stanley Cup Champion",
    edge: 2.8,
    confidence: 0.75,
    prices: {
      "Will the Carolina Hurricanes win the 2026 NHL Stanley Cup?": 0.315,
      "Will the Philadelphia Flyers win the 2026 NHL Stanley Cup?": 0.01,
    },
  });

  assert.equal(passesPriceBoundary(entryPrice(sig), entryDirection(sig)), true);
});

test("SELL_YES below true zero anomaly (0.0001) IS blocked", () => {
  // Data sanity check: a literally-zero or 1e-4 price likely means the API
  // returned a stale/dead market. Legitimate SELL alpha bottoms out around
  // 0.001-0.005 in practice.
  assert.equal(passesPriceBoundary(0.0001, "SELL_YES"), false);
});

test("BUY_STRONGEST below 0.01 IS blocked (data anomaly)", () => {
  // For BUY signals, low price means we'd be buying a near-impossible
  // outcome — almost certainly a data error or stale snapshot.
  assert.equal(passesPriceBoundary(0.005, "BUY_YES"), false);
});

test("BUY_STRONGEST above 0.95 IS blocked (no upside)", () => {
  // Buying at 0.96+ leaves <4¢ of headroom; risk-reward is broken.
  assert.equal(passesPriceBoundary(0.96, "BUY_YES"), false);
});

test("SELL_YES at 0.99 IS blocked (no downside)", () => {
  // Selling at 0.99+ leaves <1¢ of profit before settlement at 1.0.
  assert.equal(passesPriceBoundary(0.995, "SELL_YES"), false);
});

test("BUY at 0.50 (mid-market) passes", () => {
  assert.equal(passesPriceBoundary(0.5, "BUY_YES"), true);
});

test("SELL at 0.50 (mid-market) passes", () => {
  assert.equal(passesPriceBoundary(0.5, "SELL_YES"), true);
});

// ============================================================
// Boundary edge cases (exact thresholds)
// ============================================================

test("BUY at exactly 0.01 passes (lower bound inclusive)", () => {
  assert.equal(passesPriceBoundary(0.01, "BUY_YES"), true);
});

test("BUY at exactly 0.95 passes (upper bound inclusive)", () => {
  assert.equal(passesPriceBoundary(0.95, "BUY_YES"), true);
});

test("SELL at exactly 0.001 passes (SELL lower bound)", () => {
  assert.equal(passesPriceBoundary(0.001, "SELL_YES"), true);
});

test("SELL at exactly 0.99 passes (SELL upper bound)", () => {
  assert.equal(passesPriceBoundary(0.99, "SELL_YES"), true);
});
