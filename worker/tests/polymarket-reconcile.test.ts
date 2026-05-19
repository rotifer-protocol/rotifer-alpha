/**
 * Tests for polymarket-reconcile.ts
 * Focuses on the pure matchOrders() function — deterministic, no I/O.
 *
 * fetchPolymarketTrades / runReconcile require live network + D1; tested manually
 * against the staging wallet once OWNER_PRIVATE_KEY is configured.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { matchOrders, type PolyTrade } from "../src/polymarket-reconcile.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const now = new Date("2026-05-19T12:00:00Z");
const ms = now.getTime();

function d1Order(
  id: string,
  side: "BUY" | "SELL",
  filledUsdc: number,
  clobOrderId: string | null = null,
  filledAt: string | null = now.toISOString(),
) {
  return {
    id,
    side,
    filled_usdc: filledUsdc,
    filled_shares: 0,
    clob_order_id: clobOrderId,
    filled_at: filledAt,
    token_id: null,
  };
}

function chainTrade(
  tradeId: string,
  side: "BUY" | "SELL",
  price: number,
  size: number,
  makerOrderId?: string,
  takerOrderId?: string,
  matchTime = now.toISOString(),
): PolyTrade {
  return {
    tradeId,
    side,
    price,
    size,
    usdcAmount: Math.round(price * size * 1_000_000) / 1_000_000,
    matchTime,
    makerOrderId,
    takerOrderId,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("matchOrders: empty inputs → both unmatched empty", () => {
  const result = matchOrders([], []);
  assert.deepEqual(result.unmatchedD1, []);
  assert.deepEqual(result.unmatchedChain, []);
});

test("matchOrders: full exact match via takerOrderId → both unmatched = 0", () => {
  const orders = [
    d1Order("d1-1", "BUY", 10.0, "0xclob-a"),
    d1Order("d1-2", "SELL", 5.0, "0xclob-b"),
  ];
  const trades = [
    chainTrade("t-1", "BUY", 0.60, 16.667, undefined, "0xclob-a"),
    chainTrade("t-2", "SELL", 0.60, 8.333, undefined, "0xclob-b"),
  ];
  const result = matchOrders(orders, trades);
  assert.deepEqual(result.unmatchedD1, []);
  assert.deepEqual(result.unmatchedChain, []);
});

test("matchOrders: full exact match via makerOrderId", () => {
  const orders = [d1Order("d1-1", "BUY", 6.0, "0xclob-maker-1")];
  const trades = [chainTrade("t-1", "BUY", 0.60, 10.0, "0xclob-maker-1")];
  const result = matchOrders(orders, trades);
  assert.deepEqual(result.unmatchedD1, []);
  assert.deepEqual(result.unmatchedChain, []);
});

test("matchOrders: D1 order without chain counterpart is unmatched", () => {
  const orders = [d1Order("d1-1", "BUY", 10.0, "0xclob-unknown")];
  const trades: PolyTrade[] = [];
  const result = matchOrders(orders, trades);
  assert.ok(result.unmatchedD1.includes("0xclob-unknown"), "clob_order_id used as label");
  assert.deepEqual(result.unmatchedChain, []);
});

test("matchOrders: chain trade without D1 counterpart is unmatched", () => {
  const orders: ReturnType<typeof d1Order>[] = [];
  const trades = [chainTrade("t-orphan", "BUY", 0.5, 20.0)];
  const result = matchOrders(orders, trades);
  assert.deepEqual(result.unmatchedD1, []);
  assert.ok(result.unmatchedChain.includes("t-orphan"));
});

test("matchOrders: fuzzy match on side + amount ±$0.005 + timestamp within 30s", () => {
  const orders = [d1Order("d1-fuzz", "BUY", 12.0, null, new Date(ms).toISOString())];
  const trades = [
    // 0.60 × 20 = 12.0 USDC; timestamp +15s
    chainTrade("t-fuzz", "BUY", 0.60, 20.0, undefined, undefined, new Date(ms + 15_000).toISOString()),
  ];
  const result = matchOrders(orders, trades);
  assert.deepEqual(result.unmatchedD1, []);
  assert.deepEqual(result.unmatchedChain, []);
});

test("matchOrders: fuzzy match fails when timestamp gap > 60s", () => {
  const orders = [d1Order("d1-late", "BUY", 12.0, null, new Date(ms).toISOString())];
  const trades = [
    chainTrade("t-late", "BUY", 0.60, 20.0, undefined, undefined, new Date(ms + 90_000).toISOString()),
  ];
  const result = matchOrders(orders, trades);
  assert.equal(result.unmatchedD1.length, 1);
  assert.equal(result.unmatchedChain.length, 1);
});

test("matchOrders: fuzzy match fails when side differs", () => {
  const orders = [d1Order("d1-side", "BUY", 12.0, null)];
  const trades = [chainTrade("t-side", "SELL", 0.60, 20.0)];
  const result = matchOrders(orders, trades);
  assert.equal(result.unmatchedD1.length, 1);
  assert.equal(result.unmatchedChain.length, 1);
});

test("matchOrders: fuzzy match fails when USDC diff > $0.01", () => {
  const orders = [d1Order("d1-amount", "BUY", 10.0, null)];
  // 0.60 × 16.7 = 10.02 → diff = 0.02 > $0.01 threshold
  const trades = [chainTrade("t-amount", "BUY", 0.60, 16.7)];
  const result = matchOrders(orders, trades);
  assert.equal(result.unmatchedD1.length, 1);
  assert.equal(result.unmatchedChain.length, 1);
});

test("matchOrders: exact match takes priority; each order consumed at most once", () => {
  // Two D1 orders with same amount; first has exact clob_order_id → chain trade 1
  const orders = [
    d1Order("d1-exact", "BUY", 10.0, "0xclob-x"),
    d1Order("d1-fuzzy", "BUY", 10.0, null),
  ];
  const trades = [
    chainTrade("t-1", "BUY", 0.50, 20.0, undefined, "0xclob-x"),  // exact → d1-exact
    chainTrade("t-2", "BUY", 0.50, 20.0),                          // fuzzy → d1-fuzzy
  ];
  const result = matchOrders(orders, trades);
  assert.deepEqual(result.unmatchedD1, []);
  assert.deepEqual(result.unmatchedChain, []);
});

test("matchOrders: partial match — 1 matched + 1 unmatched on each side", () => {
  const orders = [
    d1Order("d1-matched", "BUY", 10.0, "0xclob-matched"),
    d1Order("d1-ghost",   "BUY", 5.0,  "0xclob-ghost"),   // no chain counterpart
  ];
  const trades = [
    chainTrade("t-matched", "BUY",  0.50, 20.0, undefined, "0xclob-matched"),
    chainTrade("t-orphan",  "SELL", 0.70, 7.143),          // no D1 counterpart
  ];
  const result = matchOrders(orders, trades);
  assert.deepEqual(result.unmatchedD1, ["0xclob-ghost"]);
  assert.deepEqual(result.unmatchedChain, ["t-orphan"]);
});

test("matchOrders: falls back to internal id when clob_order_id is null and no fuzzy match", () => {
  // Large unique amount — won't fuzzy match any real trade
  const orders = [d1Order("d1-no-clob", "BUY", 999_999.0, null)];
  const result = matchOrders(orders, []);
  assert.ok(result.unmatchedD1.includes("d1-no-clob"), "internal id used as fallback label");
});

test("matchOrders: 10-order full match stress test", () => {
  const n = 10;
  const ordersArr = Array.from({ length: n }, (_, i) =>
    d1Order(`d1-${i}`, "BUY", (i + 1) * 5, `0xclob-${i}`),
  );
  const tradesArr = Array.from({ length: n }, (_, i) =>
    chainTrade(`t-${i}`, "BUY", 0.50, ((i + 1) * 5) / 0.50, undefined, `0xclob-${i}`),
  );
  const result = matchOrders(ordersArr, tradesArr);
  assert.deepEqual(result.unmatchedD1, []);
  assert.deepEqual(result.unmatchedChain, []);
});
