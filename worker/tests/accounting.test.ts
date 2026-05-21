import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateCashBalance,
  calculateCurrentPositionValue,
  calculateDrawdownPct,
  calculateOpenPositionStats,
  calculateReturnPct,
  calculateTotalValue,
  type OpenTradeWithMark,
  PERFORMANCE_REALIZED_TRADE_WHERE_SQL,
  REALIZED_TRADE_STATUSES,
} from "../src/accounting";

const NOW = Date.UTC(2026, 4, 10, 12, 0, 0); // fixed clock for stale tests
const FRESH = new Date(NOW - 60_000).toISOString();        // 1 min old → fresh
const STALE = new Date(NOW - 20 * 60_000).toISOString();   // 20 min old → stale

test("D-Lite: trade at entry price has zero unrealized pnl", () => {
  const trades: OpenTradeWithMark[] = [
    { market_id: "m1", direction: "BUY_YES", shares: 20000, amount: 10000, last_price: 0.5, last_price_updated_at: FRESH },
  ];
  const openStats = calculateOpenPositionStats(trades, NOW);

  assert.equal(openStats.invested, 10000);
  assert.equal(openStats.unrealizedPnl, 0);
  assert.equal(openStats.staleCount, 0);

  const totalValue = calculateTotalValue(10000, 0, openStats.unrealizedPnl);
  assert.equal(totalValue, 10000);
  assert.equal(calculateReturnPct(10000, totalValue), 0);
});

test("D-Lite: long and short trades both produce correct unrealized PnL", () => {
  // BUY_YES @ 0.4 (paid 400 for 1000 shares), now 0.5 → +100
  // SELL_YES @ 0.7 (received 700 for 1000 shares short), now 0.6 → +100
  const trades: OpenTradeWithMark[] = [
    { market_id: "long",  direction: "BUY_YES",  shares: 1000, amount: 400, last_price: 0.5, last_price_updated_at: FRESH },
    { market_id: "short", direction: "SELL_YES", shares: 1000, amount: 700, last_price: 0.6, last_price_updated_at: FRESH },
  ];
  const openStats = calculateOpenPositionStats(trades, NOW);

  assert.equal(openStats.openPositions, 2);
  assert.equal(openStats.invested, 1100);
  assert.equal(openStats.unrealizedPnl, 200);
  assert.equal(openStats.staleCount, 0);
});

test("D-Lite: NULL last_price contributes 0 unrealized + staleCount++", () => {
  const trades: OpenTradeWithMark[] = [
    { market_id: "fresh",  direction: "BUY_YES", shares: 1000, amount: 400, last_price: 0.5, last_price_updated_at: FRESH },
    { market_id: "null",   direction: "BUY_YES", shares: 1000, amount: 400, last_price: null, last_price_updated_at: null },
  ];
  const openStats = calculateOpenPositionStats(trades, NOW);

  assert.equal(openStats.openPositions, 2);
  assert.equal(openStats.invested, 800);
  assert.equal(openStats.unrealizedPnl, 100);  // only the fresh one contributes
  assert.equal(openStats.staleCount, 1);
});

test("D-Lite: stale last_price (>10min) is skipped and counted", () => {
  const trades: OpenTradeWithMark[] = [
    { market_id: "fresh", direction: "BUY_YES", shares: 1000, amount: 400, last_price: 0.5, last_price_updated_at: FRESH },
    { market_id: "stale", direction: "BUY_YES", shares: 1000, amount: 400, last_price: 0.9, last_price_updated_at: STALE },
  ];
  const openStats = calculateOpenPositionStats(trades, NOW);

  assert.equal(openStats.unrealizedPnl, 100);  // stale row's +500 ignored
  assert.equal(openStats.staleCount, 1);
});

test("D-Lite: staleCount + unrealized never silently drops positions (anti-jitter)", () => {
  // Reproduces the 2026-05-10 jitter scenario: 2 fresh + 3 stale.
  // Old buggy behavior: 3 stale silently skipped → unrealized inflated when
  // CLOB recovers. New behavior: staleCount=3 surfaces the gap to UI.
  const trades: OpenTradeWithMark[] = [
    { market_id: "f1", direction: "BUY_YES", shares: 1000, amount: 500, last_price: 0.6, last_price_updated_at: FRESH },
    { market_id: "f2", direction: "BUY_YES", shares: 1000, amount: 500, last_price: 0.7, last_price_updated_at: FRESH },
    { market_id: "s1", direction: "BUY_YES", shares: 1000, amount: 500, last_price: 0.9, last_price_updated_at: STALE },
    { market_id: "s2", direction: "BUY_YES", shares: 1000, amount: 500, last_price: null, last_price_updated_at: null },
    { market_id: "s3", direction: "BUY_YES", shares: 1000, amount: 500, last_price: 0.99, last_price_updated_at: STALE },
  ];
  const openStats = calculateOpenPositionStats(trades, NOW);

  assert.equal(openStats.openPositions, 5);
  assert.equal(openStats.invested, 2500);
  // f1: +100, f2: +200 → total +300 (stale rows excluded but counted)
  assert.equal(openStats.unrealizedPnl, 300);
  assert.equal(openStats.staleCount, 3);
});

test("Track 3: implausible mark loss (>1000% × amount) is treated as stale", () => {
  // Replays the 2026-05-10 forensic: SELL_YES @ entry=0.0015 with bogus mark
  // 0.5 from Polymarket Gamma placeholder for thin orderbook.
  // shares = amount/entry = 25,000,000 for amount=$37,500
  // unrealized = 37500 - 25_000_000 × 0.5 = -$12,462,500 (332× position size)
  // Track 3 sanity guard treats this as bad mark — counts as stale, not loss.
  const trades: OpenTradeWithMark[] = [
    { market_id: "fresh-ok",     direction: "BUY_YES",  shares: 1000,    amount: 400,   last_price: 0.5, last_price_updated_at: FRESH },
    { market_id: "fresh-bogus",  direction: "SELL_YES", shares: 25_000_000, amount: 37500, last_price: 0.5, last_price_updated_at: FRESH },
  ];
  const openStats = calculateOpenPositionStats(trades, NOW);

  assert.equal(openStats.openPositions, 2);
  assert.equal(openStats.invested, 37900);
  // Only the OK trade contributes: 1000×0.5 - 400 = +100
  assert.equal(openStats.unrealizedPnl, 100);
  // Bogus row counted as stale (UI surfaces warning), not silently skipped.
  assert.equal(openStats.staleCount, 1);
});

test("Track 3: legitimate -500% loss for SELL_YES tail is NOT flagged", () => {
  // SELL_YES @ entry=0.05 (post-Track-2 minimum legal entry), shares=2000
  // for amount=$100. Mark moves to 0.30 (real probability shift).
  // unrealized = 100 - 2000 × 0.30 = -$500 → -500% of position.
  // Within sanity band (10× = -1000% threshold) — legitimate stop-loss
  // territory, NOT flagged as stale.
  const trades: OpenTradeWithMark[] = [
    { market_id: "tail",  direction: "SELL_YES", shares: 2000, amount: 100, last_price: 0.30, last_price_updated_at: FRESH },
  ];
  const openStats = calculateOpenPositionStats(trades, NOW);

  assert.equal(openStats.unrealizedPnl, -500);
  assert.equal(openStats.staleCount, 0);
});

test("cash balance subtracts invested capital and adds realized pnl", () => {
  assert.equal(calculateCashBalance(10000, 725, 0), 9275);
  assert.equal(calculateCashBalance(10000, 725, 150), 9425);
});

test("drawdown uses mark-to-market equity instead of invested notional", () => {
  const totalValue = calculateTotalValue(10000, 0, -250);
  assert.equal(totalValue, 9750);
  // legacy semantic: passing initialBalance still works as a backwards-compat
  // reference for tests that pre-date the P8 peak-DD fix.
  assert.equal(calculateDrawdownPct(10000, totalValue), 0.025);
});

// P8 fix (2026-05-21) regression coverage — confirms calculateDrawdownPct now
// behaves correctly when callers pass peak equity instead of initial balance.
test("drawdown reports peak-to-trough when reference is peak equity", () => {
  // honey_badger_l-shaped scenario: $1M → $1.477M peak → $1.031M now.
  // Old call site (calculateDrawdownPct(initial, current)) returned 0% because
  // current still exceeded initial. Calling with peak as reference now reports
  // the true 30.2% drawdown that risk.effectiveSizing() needs.
  assert.equal(calculateDrawdownPct(1_477_000, 1_031_000).toFixed(3), "0.302");
});

test("drawdown returns 0 when current equity exceeds reference", () => {
  // A fund making a new high should never report negative drawdown — the
  // Math.max(0, ...) clamp protects against snapshots that lag intra-day
  // peaks (portfolio_snapshots cron runs daily, not per trade).
  assert.equal(calculateDrawdownPct(1_000_000, 1_200_000), 0);
});

test("drawdown returns 0 when reference is 0", () => {
  // Defensive: avoid division-by-zero when a fund has no recorded peak yet.
  assert.equal(calculateDrawdownPct(0, 100), 0);
});

test("current position value is cost basis plus unrealized pnl", () => {
  assert.equal(calculateCurrentPositionValue(400, 100), 500);
  assert.equal(calculateCurrentPositionValue(700, -100), 600);
});

test("realized trade status list includes monitor-driven close states", () => {
  assert.deepEqual(
    REALIZED_TRADE_STATUSES,
    [
      "RESOLVED",
      "STOPPED",
      "EXPIRED",
      "PROFIT_TAKEN",
      "TRAILING_STOPPED",
      "REVERSED",
      // Admin-voided concentration positions (2026-05-18) — triggers 4h re-entry cooldown
      "FORCE_CLOSED",
    ],
  );
});

test("performance filter excludes migrated invalidation rows", () => {
  assert.match(PERFORMANCE_REALIZED_TRADE_WHERE_SQL, /monitor_reason IS NULL/);
  assert.match(PERFORMANCE_REALIZED_TRADE_WHERE_SQL, /NOT LIKE 'MIGRATED:%'/);
});
