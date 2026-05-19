/**
 * PolymarketVenue unit tests
 *
 * Focus: pure functions (walkClobFill, estimatePolymarketFees)
 * and the ExecutionVenue interface contract.
 *
 * Network calls are mocked via globalThis.fetch replacement.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  walkClobFill,
  estimatePolymarketFees,
  PolymarketVenue,
  type ClobLevel,
} from "../src/polymarket-venue";

// ─── walkClobFill ─────────────────────────────────────────

const MID = 0.55;

// Simple orderbook fixture
const ASKS: ClobLevel[] = [
  { price: 0.56, size: 100 },  // $56 USDC available at this level
  { price: 0.57, size: 200 },  // $114 USDC
  { price: 0.58, size: 500 },  // $290 USDC
];
const BIDS: ClobLevel[] = [
  { price: 0.54, size: 100 },
  { price: 0.53, size: 200 },
  { price: 0.52, size: 500 },
];

test("walkClobFill: fills small BUY at best ask", () => {
  // $50 order — fits within the first ask level ($56 USDC available)
  const r = walkClobFill("BUY", 50, ASKS, MID);
  assert.equal(r.available, true);
  assert.ok(Math.abs(r.avgFillPrice - 0.56) < 0.001, "fill price should be ~0.56");
  assert.ok(Math.abs(r.filledUsdc - 50) < 0.1, "filled USDC should be ~50");
  assert.ok(r.slippageBps > 0, "BUY above mid → positive slippage");
});

test("walkClobFill: fills larger BUY across two ask levels", () => {
  // $100 order: $56 at level 1 + $44 at level 2
  const r = walkClobFill("BUY", 100, ASKS, MID);
  assert.equal(r.available, true);
  // Level 1: 100 shares at 0.56 → $56; Level 2: 44/0.57 shares at 0.57 → $44
  const shares1 = 56 / 0.56;
  const shares2 = 44 / 0.57;
  const expectedAvg = 100 / (shares1 + shares2);
  assert.ok(Math.abs(r.avgFillPrice - expectedAvg) < 0.001, "weighted avg price should be correct");
  assert.ok(Math.abs(r.filledUsdc - 100) < 0.1, "filled USDC should be ~100");
});

test("walkClobFill: unavailable when order exceeds total depth", () => {
  // $600 order, only $56+$114+$290=$460 available
  const r = walkClobFill("BUY", 600, ASKS, MID);
  assert.equal(r.available, false);
  assert.ok(r.filledUsdc < 600, "partial fill is less than order size");
});

test("walkClobFill: fills SELL at bids from highest to lowest", () => {
  const r = walkClobFill("SELL", 50, BIDS, MID);
  assert.equal(r.available, true);
  assert.ok(Math.abs(r.avgFillPrice - 0.54) < 0.001, "should fill at best bid (0.54)");
  assert.ok(r.slippageBps > 0, "SELL below mid → positive slippage");
});

test("walkClobFill: empty levels returns unavailable", () => {
  const r = walkClobFill("BUY", 100, [], MID);
  assert.equal(r.available, false);
  assert.equal(r.filledUsdc, 0);
});

test("walkClobFill: zero sizeUsdc returns unavailable", () => {
  const r = walkClobFill("BUY", 0, ASKS, MID);
  assert.equal(r.available, false);
});

test("walkClobFill: skips levels with zero price or size", () => {
  const badLevels: ClobLevel[] = [
    { price: 0, size: 100 },      // zero price — skipped
    { price: 0.56, size: 0 },     // zero size — skipped
    { price: 0.57, size: 50 },    // valid
  ];
  const r = walkClobFill("BUY", 20, badLevels, MID);
  assert.equal(r.available, true);
  assert.ok(Math.abs(r.avgFillPrice - 0.57) < 0.001, "should fill at the only valid level");
});

test("walkClobFill: slippage bps matches expected formula", () => {
  // Fill at 0.60 vs mid 0.55 for BUY → slippage = (0.60 - 0.55) / 0.55 * 10000 ≈ 909 bps
  const r = walkClobFill("BUY", 50, [{ price: 0.60, size: 200 }], 0.55);
  const expected = Math.round(((0.60 - 0.55) / 0.55) * 10000);
  assert.equal(r.slippageBps, expected);
});

// ─── estimatePolymarketFees ───────────────────────────────

test("estimatePolymarketFees: returns 0 (Polymarket 0% fee model)", () => {
  assert.equal(estimatePolymarketFees(100), 0);
  assert.equal(estimatePolymarketFees(0), 0);
  assert.equal(estimatePolymarketFees(1000), 0);
});

// ─── PolymarketVenue interface contract ───────────────────

test("PolymarketVenue: throws on live mode (Phase 2 not implemented)", () => {
  assert.throws(
    () => new PolymarketVenue("live"),
    /live mode.*not yet implemented/,
  );
});

test("PolymarketVenue: constructs in shadow mode", () => {
  const venue = new PolymarketVenue("shadow");
  assert.equal(venue.name, "polymarket-v2");
  assert.equal(venue.mode, "shadow");
});

test("PolymarketVenue.quote(): simulated fallback when no tokenId", async () => {
  const venue = new PolymarketVenue("shadow");
  const quote = await venue.quote({
    fundId: "fund-1",
    marketId: "market-123",
    side: "YES",
    sizeUsdc: 100,
    priceCents: 55,
    maxSlippageBps: 200,
    // no tokenId
  });
  assert.equal(quote.source, "simulated");
  assert.equal(quote.available, true);
  assert.ok(quote.estimatedFillPrice > 0);
  assert.ok(quote.estimatedFillPrice < 1);
  assert.equal(quote.fundId, "fund-1");
});

test("PolymarketVenue.submit(): shadow mode returns correct structure", async () => {
  const venue = new PolymarketVenue("shadow");
  const result = await venue.submit({
    fundId: "fund-1",
    marketId: "market-123",
    side: "YES",
    sizeUsdc: 100,
    priceCents: 55,
    maxSlippageBps: 200,
  });
  assert.ok(["SHADOW_FILL", "SHADOW_REJECT"].includes(result.status));
  assert.ok(result.orderId, "should have an orderId");
  assert.equal(typeof result.orderId, "string");
  assert.ok(result.shadowData, "should have shadowData");
  assert.ok(Math.abs(result.shadowData!.paperEntryPrice - 0.55) < 0.001);
  assert.equal(result.shadowData!.source, "simulated");
});

test("PolymarketVenue.quote(): falls back to simulated when fetch fails", async () => {
  // Save original fetch
  const origFetch = globalThis.fetch;
  // Mock fetch to reject
  (globalThis as any).fetch = async () => { throw new Error("network error"); };

  try {
    const venue = new PolymarketVenue("shadow");
    const quote = await venue.quote({
      fundId: "fund-1",
      marketId: "market-123",
      tokenId: "token-abc",
      side: "YES",
      sizeUsdc: 100,
      priceCents: 55,
      maxSlippageBps: 200,
    });
    // Network failure → fall back to simulated
    assert.equal(quote.source, "simulated");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("PolymarketVenue.quote(): uses clob_orderbook source when fetch succeeds", async () => {
  const mockBook = {
    bids: [{ price: "0.54", size: "500" }],
    asks: [{ price: "0.56", size: "500" }],
  };
  const origFetch = globalThis.fetch;
  (globalThis as any).fetch = async () => ({
    ok: true,
    json: async () => mockBook,
  });

  try {
    const venue = new PolymarketVenue("shadow");
    const quote = await venue.quote({
      fundId: "fund-1",
      marketId: "market-123",
      tokenId: "token-abc",
      side: "YES",
      sizeUsdc: 50,
      priceCents: 55,
      maxSlippageBps: 200,
    });
    assert.equal(quote.source, "clob_orderbook");
    assert.equal(quote.available, true);
    // BUY YES → take asks → fill at 0.56
    assert.ok(Math.abs(quote.estimatedFillPrice - 0.56) < 0.001, "fill at ask price 0.56");
  } finally {
    globalThis.fetch = origFetch;
  }
});
