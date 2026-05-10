/**
 * Pyramid base layer: pure-function unit tests for D-Lite price primitives.
 *
 * Covers clobMidPrice (book parsing), isStale (time threshold), and
 * calcUnrealizedPnl (long/short PnL). External fetchClob* are tested with
 * mocked fetch in price-refresh.test.ts (the orchestration layer).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  clobMidPrice,
  isStale,
  calcUnrealizedPnl,
  PRICE_STALE_THRESHOLD_MS,
  CLOB_MAX_SPREAD,
} from "../src/price";

// ─── clobMidPrice ────────────────────────────────────────

test("clobMidPrice: standard book returns (bid+ask)/2", () => {
  assert.equal(
    clobMidPrice({
      bids: [{ price: "0.45", size: "100" }, { price: "0.44", size: "200" }],
      asks: [{ price: "0.55", size: "100" }, { price: "0.56", size: "200" }],
    }),
    0.5,
  );
});

test("clobMidPrice: only top-of-book matters for mid", () => {
  // Mid = (best_bid + best_ask) / 2 = (0.48 + 0.52) / 2 = 0.5
  // The deeper levels (0.45, 0.55) must NOT influence the mid calculation.
  // (Spread 0.04 stays below CLOB_MAX_SPREAD = 0.10.)
  assert.equal(
    clobMidPrice({
      bids: [{ price: "0.48", size: "1000" }, { price: "0.45", size: "5000" }],
      asks: [{ price: "0.52", size: "1000" }, { price: "0.55", size: "5000" }],
    }),
    0.5,
  );
});

test("clobMidPrice: derives top-of-book even when Polymarket returns unordered levels", () => {
  // Production sample (2026-05-10): CLOB returned bids low→high and asks high→low.
  // The correct top-of-book is max(bids)=0.178 and min(asks)=0.179, not
  // bids[0]=0.001 / asks[0]=0.999. Naive indexing made every restored position
  // look like a no-liquidity book and kept unrealized PnL at 0.
  const mid = clobMidPrice({
    bids: [
      { price: "0.001", size: "2153363" },
      { price: "0.165", size: "31356.68" },
      { price: "0.178", size: "33801.46" },
    ],
    asks: [
      { price: "0.999", size: "27216704.33" },
      { price: "0.2", size: "18131.17" },
      { price: "0.179", size: "1326.35" },
    ],
  });
  assert.ok(mid !== null && Math.abs(mid - 0.1785) < 1e-9, `expected ~0.1785, got ${mid}`);
});

test("clobMidPrice: empty book returns null", () => {
  assert.equal(clobMidPrice({ bids: [], asks: [] }), null);
  assert.equal(clobMidPrice({}), null);
});

test("clobMidPrice: one-sided book returns null (avoids fictitious mark)", () => {
  assert.equal(
    clobMidPrice({ bids: [{ price: "0.45", size: "100" }], asks: [] }),
    null,
  );
  assert.equal(
    clobMidPrice({ bids: [], asks: [{ price: "0.55", size: "100" }] }),
    null,
  );
});

test("clobMidPrice: crossed book (bid > ask) returns null (data anomaly)", () => {
  // A real CLOB cannot have crossed top-of-book; if Polymarket returns one
  // (caching artifact, Cloudflare edge race), treat as invalid.
  assert.equal(
    clobMidPrice({
      bids: [{ price: "0.6", size: "100" }],
      asks: [{ price: "0.4", size: "100" }],
    }),
    null,
  );
});

test("clobMidPrice: zero-priced book returns null (treated as missing)", () => {
  assert.equal(
    clobMidPrice({
      bids: [{ price: "0", size: "100" }],
      asks: [{ price: "0", size: "100" }],
    }),
    null,
  );
});

test("clobMidPrice: malformed price strings return null gracefully", () => {
  assert.equal(
    clobMidPrice({
      bids: [{ price: "not-a-number", size: "100" }],
      asks: [{ price: "0.5", size: "100" }],
    }),
    null,
  );
});

// ─── clobMidPrice spread filter (round-2 fix, 2026-05-10) ────

test("clobMidPrice: 0.01/0.99 thin book returns null (the canonical 0.5 placeholder bug)", () => {
  // This is the EXACT failure mode that produced 49 last_price=0.5 rows in
  // production on 2026-05-10. CLOB minimum-tick floor + maximum-tick ceiling
  // → naive mid = 0.5, indistinguishable from a legit 0.5 mark.
  assert.equal(
    clobMidPrice({
      bids: [{ price: "0.01", size: "1" }],
      asks: [{ price: "0.99", size: "1" }],
    }),
    null,
  );
});

test("clobMidPrice: spread > CLOB_MAX_SPREAD returns null (no liquidity)", () => {
  // Spread 0.20 = 20 cents → no real liquidity.
  assert.equal(
    clobMidPrice({
      bids: [{ price: "0.30", size: "100" }],
      asks: [{ price: "0.50", size: "100" }],
    }),
    null,
  );
});

test("clobMidPrice: spread exactly at CLOB_MAX_SPREAD threshold IS accepted", () => {
  // Boundary: spread === CLOB_MAX_SPREAD (0.10) → still valid.
  // Filter is strictly `>`, not `>=`, to accept exactly-at-threshold books.
  const spread = CLOB_MAX_SPREAD;
  const bid = 0.45;
  const ask = bid + spread; // 0.55
  assert.equal(
    clobMidPrice({
      bids: [{ price: String(bid), size: "100" }],
      asks: [{ price: String(ask), size: "100" }],
    }),
    0.5,
  );
});

test("clobMidPrice: spread just past threshold returns null", () => {
  // Spread = CLOB_MAX_SPREAD + 0.01 → rejected.
  const bid = 0.45;
  const ask = bid + CLOB_MAX_SPREAD + 0.01;
  assert.equal(
    clobMidPrice({
      bids: [{ price: String(bid), size: "100" }],
      asks: [{ price: String(ask), size: "100" }],
    }),
    null,
  );
});

test("clobMidPrice: tight spread (1 cent) on liquid market accepted", () => {
  // Active election binary near settlement: spread ~0.01 → mid is reliable.
  assert.equal(
    clobMidPrice({
      bids: [{ price: "0.515", size: "5000" }],
      asks: [{ price: "0.525", size: "5000" }],
    }),
    0.52,
  );
});

test("clobMidPrice: long-tail market with 5c spread accepted", () => {
  // Realistic thin-but-real Polymarket market: ~5c spread.
  // Use approx compare — IEEE-754 makes (0.27+0.32)/2 land on 0.29500000000000004.
  const mid = clobMidPrice({
    bids: [{ price: "0.27", size: "200" }],
    asks: [{ price: "0.32", size: "200" }],
  });
  assert.ok(mid !== null && Math.abs(mid - 0.295) < 1e-9, `expected ~0.295, got ${mid}`);
});

// ─── isStale ─────────────────────────────────────────────

test("isStale: fresh timestamp (1 min old) is NOT stale", () => {
  const now = Date.now();
  const fresh = new Date(now - 60_000).toISOString();
  assert.equal(isStale(fresh, now), false);
});

test("isStale: timestamp at exactly threshold is NOT stale (boundary)", () => {
  const now = Date.now();
  const atThreshold = new Date(now - PRICE_STALE_THRESHOLD_MS).toISOString();
  assert.equal(isStale(atThreshold, now), false);
});

test("isStale: 1ms past threshold IS stale", () => {
  const now = Date.now();
  const justBeyond = new Date(now - PRICE_STALE_THRESHOLD_MS - 1).toISOString();
  assert.equal(isStale(justBeyond, now), true);
});

test("isStale: 20-min-old timestamp IS stale", () => {
  const now = Date.now();
  const stale = new Date(now - 20 * 60_000).toISOString();
  assert.equal(isStale(stale, now), true);
});

test("isStale: NULL/undefined/empty are stale (never been refreshed)", () => {
  assert.equal(isStale(null), true);
  assert.equal(isStale(undefined), true);
  assert.equal(isStale(""), true);
});

// ─── calcUnrealizedPnl ───────────────────────────────────

test("calcUnrealizedPnl: BUY_YES at gain", () => {
  // Bought 1000 shares at 0.40 (paid $400), now at 0.50.
  // PnL = 1000 × 0.50 - 400 = +$100
  assert.equal(calcUnrealizedPnl("BUY_YES", 1000, 400, 0.5), 100);
});

test("calcUnrealizedPnl: BUY_YES at loss", () => {
  // Bought 1000 shares at 0.50 (paid $500), now at 0.30.
  assert.equal(calcUnrealizedPnl("BUY_YES", 1000, 500, 0.3), -200);
});

test("calcUnrealizedPnl: SELL_YES at gain (short profitable)", () => {
  // Shorted 1000 shares at 0.70 (received $700), now at 0.50.
  // PnL = 700 - 1000 × 0.50 = +$200
  assert.equal(calcUnrealizedPnl("SELL_YES", 1000, 700, 0.5), 200);
});

test("calcUnrealizedPnl: SELL_YES at loss (short losing)", () => {
  // Shorted 1000 shares at 0.30 (received $300), now at 0.50.
  assert.equal(calcUnrealizedPnl("SELL_YES", 1000, 300, 0.5), -200);
});

test("calcUnrealizedPnl: at entry price (current = entry) is zero", () => {
  // 20000 shares × $0.50 = $10000 → matches amount → PnL=0
  assert.equal(calcUnrealizedPnl("BUY_YES", 20000, 10000, 0.5), 0);
});
