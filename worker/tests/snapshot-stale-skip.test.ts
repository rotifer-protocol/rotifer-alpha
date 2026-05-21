/**
 * snapshot-stale-skip.test.ts (2026-05-21)
 *
 * P9-B fix regression tests for takeSnapshot() — protects the daily
 * portfolio_snapshots cron from clobbering a previous valid row when every
 * OPEN position got skipped as stale.
 *
 * Bug history (2026-05-10):
 *   - commit 3c270a0 (5/10 23:37) deployed D-Lite stale-price fields: added
 *     paper_trades.last_price_updated_at (default NULL) + isStale() guard
 *     in takeSnapshot's mark-to-market loop.
 *   - 22 minutes later (≈ 23:59 UTC) the daily snapshot cron ran. The new
 *     column was still NULL across the board (price-refresh hadn't backfilled
 *     yet). isStale(null) returns true → every OPEN position skipped →
 *     unrealizedPnl = 0 across all 15 funds.
 *   - INSERT OR REPLACE wrote the zero-unrealized snapshot, destroying the
 *     previous day's valid row. NAV charts showed a 30%+ trough across all
 *     funds that recovered the next day.
 *
 * Fix (this commit):
 *   - takeSnapshot() now tracks staleSkipCount in the mark-to-market loop.
 *   - When openCount > 0 AND staleSkipCount === openCount (every position
 *     was skipped), the snapshot write is bypassed and a warning logged.
 *   - This preserves the previous day's valid row rather than overwriting
 *     it with misleading zero data.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { takeSnapshot } from "../src/index.js";
import { PRICE_STALE_THRESHOLD_MS } from "../src/price.js";
import type { FundConfig } from "../src/types.js";

// ─── Mock D1 db ──────────────────────────────────────────────────────────────

interface OpenTradeRow {
  id: string;
  fund_id: string;
  market_id: string;
  direction: string;
  entry_price: number;
  shares: number;
  amount: number;
  last_price: number | null;
  last_price_updated_at: string | null;
}

interface RealizedRow {
  pnl: number;
  wins: number;
  losses: number;
}

interface MockDbOptions {
  openTrades: OpenTradeRow[];
  realizedByFund?: Record<string, RealizedRow>;
}

function makeMockDb(opts: MockDbOptions) {
  const capturedInserts: any[][] = [];

  const db = {
    prepare(sql: string) {
      const trimmed = sql.trim();

      if (trimmed.startsWith("SELECT id, fund_id")) {
        return {
          async all() {
            return { results: opts.openTrades, success: true, meta: {} };
          },
        };
      }

      if (trimmed.startsWith("SELECT") && trimmed.includes("COALESCE(SUM(pnl)")) {
        return {
          bind(fundId: string) {
            return {
              async first() {
                return opts.realizedByFund?.[fundId] ?? { pnl: 0, wins: 0, losses: 0 };
              },
            };
          },
        };
      }

      if (trimmed.startsWith("INSERT OR REPLACE INTO portfolio_snapshots")) {
        return {
          bind(...args: any[]) {
            return {
              async run() {
                capturedInserts.push(args);
                return { success: true, meta: { changes: 1 } };
              },
            };
          },
        };
      }

      throw new Error(`MockDb: unexpected SQL: ${trimmed.slice(0, 80)}`);
    },
  } as unknown as D1Database;

  return { db, capturedInserts };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function freshTimestamp(): string {
  // 5 minutes ago — well within PRICE_STALE_THRESHOLD_MS (10 min)
  return new Date(Date.now() - 5 * 60_000).toISOString();
}

function staleTimestamp(): string {
  // 1 hour ago — far beyond stale threshold
  return new Date(Date.now() - 60 * 60_000).toISOString();
}

function makeFund(overrides: Partial<FundConfig>): FundConfig {
  return {
    id: "test_fund",
    name: "Test",
    emoji: "🧪",
    motto: "",
    initialBalance: 10_000,
    monthlyTarget: 0.05,
    drawdownLimit: 0.20,
    drawdownSoftLimit: 0.10,
    allowedTypes: [],
    minEdge: 0,
    minConfidence: 0,
    minVolume: 0,
    minLiquidity: 0,
    maxPerEvent: 1000,
    maxOpenPositions: 5,
    stopLossPercent: 0.10,
    maxHoldDays: 7,
    takeProfitPercent: 0.20,
    trailingStopPercent: 0.10,
    probReversalThreshold: 0.20,
    sizingMode: "fixed",
    sizingBase: 100,
    sizingScale: 0,
    ...overrides,
  } as FundConfig;
}

function makeTrade(
  fundId: string,
  marketId: string,
  last_price_updated_at: string | null,
): OpenTradeRow {
  return {
    id: `t-${fundId}-${marketId}`,
    fund_id: fundId,
    market_id: marketId,
    direction: "BUY_YES",
    entry_price: 0.50,
    shares: 200,
    amount: 100,
    last_price: 0.55,
    last_price_updated_at,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("P9-B protection: all OPEN positions stale → snapshot write is skipped", async () => {
  const fund = makeFund({ id: "honey_badger_l", initialBalance: 1_000_000 });
  const { db, capturedInserts } = makeMockDb({
    openTrades: [
      makeTrade("honey_badger_l", "1962237", staleTimestamp()),
      makeTrade("honey_badger_l", "2155023", staleTimestamp()),
      makeTrade("honey_badger_l", "2241742", staleTimestamp()),
    ],
  });

  await takeSnapshot(db, "2026-05-10", [fund]);

  assert.equal(
    capturedInserts.length,
    0,
    "INSERT OR REPLACE must not fire when all OPEN positions are stale",
  );
});

test("P9-B protection: NULL last_price_updated_at counts as stale (the 5/10 root cause)", async () => {
  // Reproduces commit 3c270a0 deploy-window scenario: brand-new column
  // defaulted to NULL across all OPEN trades before price-refresh backfilled.
  const fund = makeFund({ id: "cheetah", initialBalance: 10_000 });
  const { db, capturedInserts } = makeMockDb({
    openTrades: [
      makeTrade("cheetah", "m1", null),
      makeTrade("cheetah", "m2", null),
    ],
  });

  await takeSnapshot(db, "2026-05-10", [fund]);

  assert.equal(capturedInserts.length, 0, "NULL timestamps must trigger skip");
});

test("partial stale: fund still writes snapshot with surviving fresh positions", async () => {
  const fund = makeFund({ id: "shark_m", initialBalance: 100_000 });
  const { db, capturedInserts } = makeMockDb({
    openTrades: [
      makeTrade("shark_m", "m1", freshTimestamp()),
      makeTrade("shark_m", "m2", staleTimestamp()),
    ],
  });

  await takeSnapshot(db, "2026-05-10", [fund]);

  assert.equal(capturedInserts.length, 1, "snapshot must write when at least one fresh trade contributes");
  // Args: [id, fund_id, date, cash, openCount, unrealized, realized, totalValue, wins, losses, winRate, monthlyTarget, drawdownLimit, frozen]
  const args = capturedInserts[0];
  assert.equal(args[1], "shark_m");
  assert.equal(args[4], 2, "openCount should reflect both OPEN trades, including the stale one");
  // unrealized comes from the 1 fresh trade only: (last_price 0.55 - entry 0.50) * 200 shares = $10
  assert.ok(args[5] > 0, "unrealized should be > 0 from the single fresh trade");
});

test("fund with zero OPEN positions: snapshot writes normally (un=0 is legitimate)", async () => {
  const fund = makeFund({ id: "turtle", initialBalance: 10_000 });
  const { db, capturedInserts } = makeMockDb({ openTrades: [] });

  await takeSnapshot(db, "2026-05-10", [fund]);

  assert.equal(capturedInserts.length, 1, "empty-portfolio funds still need their snapshot");
  assert.equal(capturedInserts[0][4], 0, "openCount = 0");
  assert.equal(capturedInserts[0][5], 0, "unrealized = 0");
});

test("regression: 2026-05-10 scenario — 15 funds all stale → 0 INSERTs (would have been 15 zero-rows)", async () => {
  // Pre-fix: this scenario clobbered 15 valid prior-day rows with un=0.
  // Post-fix: zero writes happen; prior snapshots remain intact.
  const FUND_IDS = [
    "cheetah", "cheetah_m", "cheetah_l",
    "octopus", "octopus_m", "octopus_l",
    "shark", "shark_m", "shark_l",
    "turtle", "turtle_m", "turtle_l",
    "honey_badger", "honey_badger_m", "honey_badger_l",
  ];
  const funds = FUND_IDS.map(id => makeFund({ id, initialBalance: 10_000 }));
  const openTrades = FUND_IDS.flatMap(id => [
    makeTrade(id, `${id}-m1`, null),
    makeTrade(id, `${id}-m2`, null),
  ]);

  const { db, capturedInserts } = makeMockDb({ openTrades });

  await takeSnapshot(db, "2026-05-10", funds);

  assert.equal(
    capturedInserts.length,
    0,
    "P9-B protection: all 15 funds must skip writes when every position is NULL-timestamped",
  );
});

test("mixed cohort: stale funds skip, healthy funds write", async () => {
  // Realistic: deploy-window may affect only some funds (e.g. those without
  // recent price-refresh activity). Healthy funds should not be punished.
  const cheetah = makeFund({ id: "cheetah", initialBalance: 10_000 });
  const turtle = makeFund({ id: "turtle", initialBalance: 10_000 });

  const { db, capturedInserts } = makeMockDb({
    openTrades: [
      // cheetah: all stale → skip
      makeTrade("cheetah", "m1", staleTimestamp()),
      makeTrade("cheetah", "m2", staleTimestamp()),
      // turtle: fresh → write
      makeTrade("turtle", "m3", freshTimestamp()),
    ],
  });

  await takeSnapshot(db, "2026-05-10", [cheetah, turtle]);

  assert.equal(capturedInserts.length, 1, "only turtle should write");
  assert.equal(capturedInserts[0][1], "turtle", "the written snapshot is for turtle, not cheetah");
});

test("stale threshold boundary — 1s inside threshold = fresh, snapshot writes", async () => {
  // 1 second inside PRICE_STALE_THRESHOLD_MS (10min - 1s ago) — should be fresh
  // regardless of test/code Date.now() jitter.
  const justInside = new Date(Date.now() - PRICE_STALE_THRESHOLD_MS + 1_000).toISOString();
  const fund = makeFund({ id: "cheetah", initialBalance: 10_000 });

  const { db, capturedInserts } = makeMockDb({
    openTrades: [makeTrade("cheetah", "m1", justInside)],
  });

  await takeSnapshot(db, "2026-05-10", [fund]);

  assert.equal(capturedInserts.length, 1, "trade 1s newer than threshold must be treated as fresh");
});

test("stale threshold boundary — 1s past threshold = stale, snapshot skipped", async () => {
  // 1 second past PRICE_STALE_THRESHOLD_MS (10min + 1s ago) — should be stale
  // regardless of test/code Date.now() jitter.
  const justOutside = new Date(Date.now() - PRICE_STALE_THRESHOLD_MS - 1_000).toISOString();
  const fund = makeFund({ id: "cheetah", initialBalance: 10_000 });

  const { db, capturedInserts } = makeMockDb({
    openTrades: [makeTrade("cheetah", "m1", justOutside)],
  });

  await takeSnapshot(db, "2026-05-10", [fund]);

  assert.equal(capturedInserts.length, 0, "trade 1s older than threshold must trigger stale-skip protection");
});
