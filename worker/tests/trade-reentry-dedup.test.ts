/**
 * Regression tests for isDuplicate re-entry cooldown fix.
 *
 * Root cause: 2026-05-16 Harvey Weinstein 3× identical trades on 鲨鱼·S.
 * Pattern: cron tick (risk→settle→monitor) closes a position, then the
 * Trader step calls isDuplicate() which only checked status='OPEN' → found
 * nothing → re-opened the same market. Repeated across 3 consecutive 5-min
 * ticks, producing 3 identical PROFIT_TAKEN trades.
 *
 * Fix (trade.ts):
 *   1. isDuplicate cooldown: OPEN OR (any REALIZED status AND closed_at >= 4h ago)
 *   2. openedThisRun in-memory set: per-invocation dedup for concurrent Workers
 *
 * Statuses covered by the cooldown (from REALIZED_TRADE_STATUS_SQL):
 *   RESOLVED, STOPPED, EXPIRED, PROFIT_TAKEN, TRAILING_STOPPED, REVERSED
 */

import test from "node:test";
import assert from "node:assert/strict";

import { REALIZED_TRADE_STATUSES, REALIZED_TRADE_STATUS_SQL } from "../src/accounting";

// ─── SQL shape test ───────────────────────────────────────────────────────────

test("REALIZED_TRADE_STATUS_SQL covers all 6 expected closed statuses", () => {
  const expected = ["RESOLVED", "STOPPED", "EXPIRED", "PROFIT_TAKEN", "TRAILING_STOPPED", "REVERSED"];
  for (const s of expected) {
    assert.ok(
      REALIZED_TRADE_STATUS_SQL.includes(`'${s}'`),
      `Expected '${s}' to be in REALIZED_TRADE_STATUS_SQL but got: ${REALIZED_TRADE_STATUS_SQL}`,
    );
  }
  assert.equal(REALIZED_TRADE_STATUSES.length, expected.length,
    "REALIZED_TRADE_STATUSES should have exactly 6 entries; add new statuses to both lists");
});

// ─── isDuplicate SQL query shape ──────────────────────────────────────────────
//
// We test the SQL query that paperTrade() sends to isDuplicate() by
// intercepting db.prepare() calls. Because isDuplicate is private, we do
// a white-box assertion on the query string.

type QueryRecord = { sql: string; binds: unknown[] };

class CapturingDb {
  public queries: QueryRecord[] = [];

  prepare(sql: string) {
    const rec: QueryRecord = { sql, binds: [] };
    this.queries.push(rec);
    return {
      bind: (...args: unknown[]) => {
        rec.binds.push(...args);
        return {
          first: async (_col?: string) => {
            // Respond to isDuplicate query with "no duplicate" so the fund can proceed
            if (sql.includes("status = 'OPEN'") && sql.includes("closed_at >= ?")) return { cnt: 0 };
            // Respond to getOpenPositionCount
            if (sql.includes("COUNT(*) as cnt") && sql.includes("status = 'OPEN'")) return { cnt: 0 };
            // getBalance / calculateCashBalance
            if (sql.includes("SUM(amount)")) return { total: 0 };
            // isFrozen
            if (sql.includes("frozen_until")) return null;
            // getExecutionMode
            if (sql.includes("execution_mode")) return null;
            // getLastEpochAt or other single-row
            return null;
          },
          run: async () => ({ success: true, results: [] }),
          all: async () => ({ results: [] }),
        };
      },
      first: async (_col?: string) => {
        if (sql.includes("execution_mode")) return null;
        if (sql.includes("frozen_until")) return null;
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => ({ success: true, results: [] }),
    };
  }
}

test("isDuplicate SQL query includes all REALIZED_TRADE_STATUS_SQL entries in cooldown clause", async () => {
  const { paperTrade } = await import("../src/trade");

  const db = new CapturingDb();

  const sig = {
    signalId: "SIG-test-001",
    type: "MISPRICING" as const,
    marketId: "market-harvey-weinstein",
    slug: "harvey-weinstein-prison",
    question: "Harvey Weinstein prison time?",
    description: "test signal",
    edge: 2.0,
    confidence: 0.65,
    direction: "BUY_BOTH" as const,
    prices: { "Yes": 0.038, "No": 0.94, sum: 0.978, volume24hr: 100000 },
    timestamp: new Date().toISOString(),
  };

  const fund = {
    id: "shark-s",
    name: "鲨鱼·S",
    emoji: "🦈",
    initialBalance: 10000,
    maxOpenPositions: 5,
    maxPerEvent: 1000,
    minEdge: 1.5,
    minConfidence: 0.5,
    minVolume: 5000,
    minLiquidity: 5000,
    allowedTypes: ["MISPRICING"] as const,
    takeProfitPercent: 0.61,
    trailingStopPercent: 0,
    probReversalThreshold: 0,
    stopLossPercent: 0,
    maxHoldDays: 21,
    sizingScale: 0.1,
    tier: "S" as const,
    allowOtmBuys: true,
    baseSizingUsd: 100,
    referenceSizingEquity: 10000,
  };

  await paperTrade(db as unknown as D1Database, [sig], [], [fund as any], new Date().toISOString());

  // Find the isDuplicate query (it has both status='OPEN' AND closed_at >= ?)
  const dedupQuery = db.queries.find(q =>
    q.sql.includes("status = 'OPEN'") && q.sql.includes("closed_at >= ?"),
  );

  assert.ok(dedupQuery, "isDuplicate query should have been issued");

  // Verify all 6 realized statuses are in the query
  for (const status of REALIZED_TRADE_STATUSES) {
    assert.ok(
      dedupQuery.sql.includes(`'${status}'`),
      `isDuplicate SQL must include '${status}' in cooldown clause`,
    );
  }

  // Verify cooldown cutoff timestamp is passed as a bind parameter
  const binds = dedupQuery.binds;
  assert.equal(binds.length, 3, "isDuplicate should bind: fundId, marketId, cooldownCutoff");
  assert.ok(
    typeof binds[2] === "string" && /^\d{4}-\d{2}-\d{2}T/.test(binds[2] as string),
    `Third bind param should be an ISO timestamp cutoff, got: ${binds[2]}`,
  );
});

// ─── in-run dedup (openedThisRun) ─────────────────────────────────────────────

test("openedThisRun prevents same-fund same-market being opened twice in one invocation", async () => {
  const { paperTrade } = await import("../src/trade");

  let insertCount = 0;
  class TrackingDb {
    prepare(sql: string) {
      return {
        bind: (..._args: unknown[]) => ({
          first: async (_col?: string) => {
            if (sql.includes("closed_at >= ?")) return { cnt: 0 }; // no cooldown hit
            if (sql.includes("COUNT(*) as cnt")) return { cnt: 0 };
            if (sql.includes("SUM(amount)")) return { total: 0 };
            if (sql.includes("frozen_until")) return null;
            if (sql.includes("execution_mode")) return null;
            return null;
          },
          run: async () => {
            if (sql.trim().startsWith("INSERT INTO paper_trades")) insertCount++;
            return { success: true, results: [] };
          },
          all: async () => ({ results: [] }),
        }),
        first: async (_col?: string) => {
          if (sql.includes("execution_mode")) return null;
          return null;
        },
        all: async () => ({ results: [] }),
        run: async () => {
          if (sql.trim().startsWith("INSERT INTO paper_trades")) insertCount++;
          return { success: true, results: [] };
        },
      };
    }
  }

  // Two DIFFERENT signals resolving to the same effectiveMarketId
  const makeSignal = (id: string) => ({
    signalId: id,
    type: "MISPRICING" as const,
    marketId: "market-same-market",
    slug: "same-market",
    question: "Same market?",
    description: "test",
    edge: 2.5,
    confidence: 0.7,
    direction: "BUY_BOTH" as const,
    prices: { "Yes": 0.038, "No": 0.94, sum: 0.978, volume24hr: 100000 },
    timestamp: new Date().toISOString(),
  });

  const fund = {
    id: "shark-s",
    name: "鲨鱼·S",
    emoji: "🦈",
    initialBalance: 10000,
    maxOpenPositions: 5,
    maxPerEvent: 10000,
    minEdge: 1.0,
    minConfidence: 0.3,
    minVolume: 1000,
    minLiquidity: 1000,
    allowedTypes: ["MISPRICING"] as const,
    takeProfitPercent: 0.61,
    trailingStopPercent: 0,
    probReversalThreshold: 0,
    stopLossPercent: 0,
    maxHoldDays: 21,
    sizingScale: 0.1,
    tier: "S" as const,
    allowOtmBuys: true,
    baseSizingUsd: 100,
    referenceSizingEquity: 10000,
  };

  // Feed two signals for the SAME market in one paperTrade() call
  await paperTrade(
    new TrackingDb() as unknown as D1Database,
    [makeSignal("SIG-A"), makeSignal("SIG-B")],
    [],
    [fund as any],
    new Date().toISOString(),
  );

  assert.equal(insertCount, 1,
    "openedThisRun should block the second signal for the same market — expected exactly 1 INSERT");
});
