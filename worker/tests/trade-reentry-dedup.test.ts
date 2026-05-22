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

test("REALIZED_TRADE_STATUS_SQL covers all expected closed statuses", () => {
  // 7 statuses: the original 6 + FORCE_CLOSED (admin void, 2026-05-18)
  const expected = ["RESOLVED", "STOPPED", "EXPIRED", "PROFIT_TAKEN", "TRAILING_STOPPED", "REVERSED", "FORCE_CLOSED"];
  for (const s of expected) {
    assert.ok(
      REALIZED_TRADE_STATUS_SQL.includes(`'${s}'`),
      `Expected '${s}' to be in REALIZED_TRADE_STATUS_SQL but got: ${REALIZED_TRADE_STATUS_SQL}`,
    );
  }
  assert.equal(REALIZED_TRADE_STATUSES.length, expected.length,
    "REALIZED_TRADE_STATUSES should have exactly 7 entries; add new statuses to both lists");
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
    // category mirrors scan.ts:analyze() emit shape (signal-calibration.ts gate
    // would otherwise treat undefined as 'other' → untrusted → 1.5× edge premium
    // would block sig.edge=2.0 against fund.minEdge=1.5).
    category: "politics" as const,
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

// ─── partial UNIQUE index race (schema/021) ───────────────────────────────────
//
// Validates the LAST line of defense for the cron-concurrency duplicate-trade
// pattern. Forensic 2026-05-17: Cloudflare Workers cron at-least-once semantics
// fired 2-3 concurrent isolates for the same */5 schedule on 16 of 24h ticks.
// Each isolate runs its own paperTrade() with its own openedThisRun set, all
// reading 0 OPEN rows pre-INSERT (D1 read-replica lag), then all INSERT racing.
//
// schema/021 partial UNIQUE index on (fund_id, market_id) WHERE status='OPEN'
// makes only ONE INSERT win at the DB; the rest receive
// SQLITE_CONSTRAINT_UNIQUE. trade.ts must catch this and translate to a
// DUPLICATE_MARKET skip (NOT propagate the error and break the loop for
// subsequent funds/sigs).

test("INSERT failing with SQLITE_CONSTRAINT_UNIQUE is caught and skipped (schema/021 race)", async () => {
  const { paperTrade } = await import("../src/trade");

  let insertAttempts = 0;
  let insertSuccesses = 0;
  let duplicateSkips = 0;
  class UniqueRaceDb {
    prepare(sql: string) {
      return {
        bind: (..._args: unknown[]) => ({
          first: async (_col?: string) => {
            // Simulate 0 rows from every read — the racing-isolates view of D1
            // before any INSERT is committed.
            if (sql.includes("closed_at >= ?")) return { cnt: 0 };
            if (sql.includes("COUNT(*) as cnt")) return { cnt: 0 };
            if (sql.includes("SUM(amount)")) return { total: 0 };
            if (sql.includes("frozen_until")) return null;
            if (sql.includes("execution_mode")) return null;
            return null;
          },
          run: async () => {
            if (sql.trim().startsWith("INSERT INTO paper_trades")) {
              insertAttempts++;
              // First INSERT succeeds (this isolate "wins" the race);
              // every subsequent INSERT for the same (fund, market) hits the
              // partial unique index and SQLite raises this exact error string.
              if (insertAttempts === 1) {
                insertSuccesses++;
                return { success: true, results: [] };
              }
              throw new Error(
                "D1_ERROR: UNIQUE constraint failed: paper_trades.fund_id, paper_trades.market_id: SQLITE_CONSTRAINT",
              );
            }
            return { success: true, results: [] };
          },
          all: async () => ({ results: [] }),
        }),
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true, results: [] }),
      };
    }
  }

  // Two DIFFERENT signals for two DIFFERENT markets — but we'll force them to
  // resolve to the SAME effectiveMarketId so the partial index race fires.
  // openedThisRun would normally block this in a single paperTrade call (sig B
  // → set.has() === true → DUPLICATE_MARKET skip). We bypass openedThisRun by
  // making sig A fail at INSERT (here it succeeds) and feeding two markets
  // that are actually different — the 2nd raises UNIQUE because we asserted it
  // in the mock. This is the post-cleanup invariant: the catch block must
  // translate the throw into a skipReason, NOT bubble the error out.
  const sigA = {
    signalId: "SIG-CONCURRENT-A",
    type: "MISPRICING" as const,
    marketId: "market-A",
    slug: "concurrent-A",
    question: "concurrent A?",
    description: "test",
    edge: 2.5,
    confidence: 0.7,
    direction: "BUY_BOTH" as const,
    prices: { "Yes": 0.4, "No": 0.62, sum: 1.02, volume24hr: 50000 },
    timestamp: new Date().toISOString(),
  };
  const sigB = { ...sigA, signalId: "SIG-CONCURRENT-B", marketId: "market-B", slug: "concurrent-B" };

  const fund = {
    id: "shark",
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

  let result: Awaited<ReturnType<typeof paperTrade>>;
  try {
    result = await paperTrade(
      new UniqueRaceDb() as unknown as D1Database,
      [sigA, sigB],
      [],
      [fund as any],
      new Date().toISOString(),
    );
  } catch (e) {
    assert.fail(`paperTrade must NOT throw on UNIQUE constraint failure — got: ${e}`);
  }

  duplicateSkips = result.skipReasons.filter(s => s.code === "DUPLICATE_MARKET").length;

  assert.equal(insertAttempts, 2, "Expected 2 INSERT attempts (one per signal)");
  assert.equal(insertSuccesses, 1, "Expected exactly 1 INSERT to succeed (the race winner)");
  assert.equal(result.trades.length, 1, "Only the winning INSERT should produce a trade record");
  assert.equal(duplicateSkips, 1,
    "The losing INSERT must produce a DUPLICATE_MARKET skip reason (not bubble the throw)");
});

test("non-UNIQUE INSERT errors still propagate (no overly broad swallow)", async () => {
  const { paperTrade } = await import("../src/trade");

  class FailingDb {
    prepare(sql: string) {
      return {
        bind: (..._args: unknown[]) => ({
          first: async (_col?: string) => {
            if (sql.includes("closed_at >= ?")) return { cnt: 0 };
            if (sql.includes("COUNT(*) as cnt")) return { cnt: 0 };
            if (sql.includes("SUM(amount)")) return { total: 0 };
            if (sql.includes("frozen_until")) return null;
            if (sql.includes("execution_mode")) return null;
            return null;
          },
          run: async () => {
            if (sql.trim().startsWith("INSERT INTO paper_trades")) {
              throw new Error("D1_ERROR: disk full / network timeout / arbitrary other error");
            }
            return { success: true, results: [] };
          },
          all: async () => ({ results: [] }),
        }),
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true, results: [] }),
      };
    }
  }

  const sig = {
    signalId: "SIG-FAIL-OTHER",
    type: "MISPRICING" as const,
    marketId: "market-other-error",
    slug: "other-error",
    question: "Other error?",
    description: "test",
    edge: 2.5,
    confidence: 0.7,
    direction: "BUY_BOTH" as const,
    prices: { "Yes": 0.4, "No": 0.62, sum: 1.02, volume24hr: 50000 },
    timestamp: new Date().toISOString(),
  };
  const fund = {
    id: "shark",
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

  await assert.rejects(
    paperTrade(
      new FailingDb() as unknown as D1Database,
      [sig],
      [],
      [fund as any],
      new Date().toISOString(),
    ),
    /disk full|network timeout|arbitrary other error/,
    "Non-UNIQUE INSERT errors must propagate (the catch must NOT swallow generic errors)",
  );
});

// ─── isDuplicate cooldown behavior — M15 distributed read-after-write ─────────
//
// Behavior-level tests added per ADR-280 D5: instead of asserting SQL string
// shape (which M10 warns is "spuriously precise"), verify paperTrade's actual
// behavior given different mock D1 responses to the isDuplicate query.
//
// What's tested: the *behavior* of the cooldown decision (cnt=1 → skip vs
// cnt=0 → INSERT), not the SQL string. Future refactors that change the SQL
// (e.g. adjust cooldown window, change status list) keep these tests valid as
// long as the function still maps cnt > 0 to "duplicate".
//
// Limitation: still a mock-based test, not a real SQLite integration test.
// Per ADR-280 D5, full in-memory SQLite is deferred to trade.ts refactor or
// isDuplicate cooldown logic change. M10 ("spurious accuracy") not fully
// eliminated, but partial-UNIQUE index (schema/021) is the physical floor.

const cooldownFund = {
  id: "shark",
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

const cooldownSig = (id: string, marketId: string, slug: string) => ({
  signalId: id,
  type: "MISPRICING" as const,
  marketId,
  slug,
  question: "Cooldown test?",
  description: "test",
  edge: 2.5,
  confidence: 0.7,
  direction: "BUY_BOTH" as const,
  prices: { "Yes": 0.4, "No": 0.62, sum: 1.02, volume24hr: 50000 },
  timestamp: new Date().toISOString(),
});

test("isDuplicate cooldown HIT (cnt=1) → DUPLICATE_MARKET skip + 0 INSERT", async () => {
  const { paperTrade } = await import("../src/trade");

  let insertCount = 0;
  class CooldownHitDb {
    prepare(sql: string) {
      return {
        bind: (..._args: unknown[]) => ({
          first: async (_col?: string) => {
            // SIMULATE: D1 returns cnt=1 for the isDuplicate query → there's
            // a recent realized trade for (fund, market) within the cooldown
            // window. paperTrade should treat this as duplicate and skip.
            if (sql.includes("closed_at >= ?")) return { cnt: 1 };
            // No active OPEN positions for the open-position-count check
            if (sql.includes("COUNT(*) as cnt") && sql.includes("status = 'OPEN'")) return { cnt: 0 };
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
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true, results: [] }),
      };
    }
  }

  const result = await paperTrade(
    new CooldownHitDb() as unknown as D1Database,
    [cooldownSig("SIG-COOLDOWN-HIT", "market-cooldown-hit", "cooldown-hit")],
    [],
    [cooldownFund as any],
    new Date().toISOString(),
  );

  const dupSkips = result.skipReasons.filter(s => s.code === "DUPLICATE_MARKET");

  assert.equal(insertCount, 0,
    "Cooldown hit must produce 0 INSERT — paperTrade must respect isDuplicate's positive signal");
  assert.equal(result.trades.length, 0,
    "No trade record should be produced when cooldown blocks");
  assert.equal(dupSkips.length, 1,
    `Cooldown hit should produce exactly 1 DUPLICATE_MARKET skip; got skipReasons: ${JSON.stringify(result.skipReasons)}`);
});

test("isDuplicate cooldown MISS (cnt=0) → INSERT proceeds + trade record produced", async () => {
  const { paperTrade } = await import("../src/trade");

  let insertCount = 0;
  class CooldownMissDb {
    prepare(sql: string) {
      return {
        bind: (..._args: unknown[]) => ({
          first: async (_col?: string) => {
            // SIMULATE: D1 returns cnt=0 → no recent duplicate within cooldown.
            // paperTrade should proceed with the INSERT.
            if (sql.includes("closed_at >= ?")) return { cnt: 0 };
            if (sql.includes("COUNT(*) as cnt") && sql.includes("status = 'OPEN'")) return { cnt: 0 };
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
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true, results: [] }),
      };
    }
  }

  const result = await paperTrade(
    new CooldownMissDb() as unknown as D1Database,
    [cooldownSig("SIG-COOLDOWN-MISS", "market-cooldown-miss", "cooldown-miss")],
    [],
    [cooldownFund as any],
    new Date().toISOString(),
  );

  const dupSkips = result.skipReasons.filter(s => s.code === "DUPLICATE_MARKET");

  assert.equal(insertCount, 1,
    "Cooldown miss must produce 1 INSERT — paperTrade should proceed when isDuplicate signals no duplicate");
  assert.equal(result.trades.length, 1,
    "Exactly one trade record should be produced when cooldown is clean");
  assert.equal(dupSkips.length, 0,
    `No DUPLICATE_MARKET skip should appear when cnt=0; got skipReasons: ${JSON.stringify(result.skipReasons)}`);
});

// ─── freshlyClosedThisRun in-pipeline cooldown (Problem B fix) ────────────
//
// Root cause: within the same runGenomePipeline tick, monitor closes a trade
// then trader calls isDuplicate() via D1 — but D1 replicas haven't synced the
// UPDATE yet (M15, ADR-280 §D6). Fix: genome.ts builds freshlyClosedThisRun
// Set from monitorOut.actions and passes it to paperTrade, which checks it
// BEFORE the DB query.

test("freshlyClosedThisRun blocks re-entry without DB query (in-pipeline cooldown)", async () => {
  const { paperTrade } = await import("../src/trade");

  let isDuplicateQueryCount = 0;
  class TrackingDb {
    prepare(sql: string) {
      return {
        bind: (..._args: unknown[]) => ({
          first: async (_col?: string) => {
            if (sql.includes("closed_at >= ?")) {
              isDuplicateQueryCount++;
              return { cnt: 0 }; // DB says "no cooldown" — but in-memory set should win
            }
            if (sql.includes("COUNT(*) as cnt")) return { cnt: 0 };
            if (sql.includes("SUM(amount)")) return { total: 0 };
            if (sql.includes("frozen_until")) return null;
            if (sql.includes("execution_mode")) return null;
            return null;
          },
          run: async () => ({ success: true, results: [] }),
          all: async () => ({ results: [] }),
        }),
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true, results: [] }),
      };
    }
  }

  const marketId = "market-freshly-closed";
  const fundId = "shark";
  const sig = {
    signalId: "SIG-FRESH-CLOSE",
    type: "MISPRICING" as const,
    marketId,
    slug: "freshly-closed-market",
    question: "Freshly closed?",
    description: "test",
    edge: 2.5,
    confidence: 0.7,
    direction: "BUY_BOTH" as const,
    prices: { "Yes": 0.4, "No": 0.62, sum: 1.02, volume24hr: 50000 },
    timestamp: new Date().toISOString(),
  };
  const fund = {
    id: fundId,
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

  // Simulate: monitor just closed fundId:marketId in this same pipeline tick
  const freshlyClosedThisRun = new Set([`${fundId}:${marketId}`]);

  const result = await paperTrade(
    new TrackingDb() as unknown as D1Database,
    [sig],
    [],
    [fund as any],
    new Date().toISOString(),
    freshlyClosedThisRun,
  );

  const dupSkips = result.skipReasons.filter(r => r.code === "DUPLICATE_MARKET");
  assert.equal(dupSkips.length, 1,
    "freshlyClosedThisRun hit must produce DUPLICATE_MARKET skip");
  assert.equal(result.trades.length, 0,
    "No trade should be opened for a freshly-closed market");
  assert.equal(isDuplicateQueryCount, 0,
    "isDuplicate DB query must NOT be reached when freshlyClosedThisRun hits first (short-circuit)");
});

// ─── Market Impact Gate ────────────────────────────────────────────────────
//
// rawSize / liquidity > maxMarketImpactRatio → MARKET_IMPACT_TOO_HIGH skip.
// Default ratio is 0.15 (15%). Evolvable via PARAM_BOUNDS_INVARIANT.

test("Market Impact Gate: rawSize > 15% of liquidity → MARKET_IMPACT_TOO_HIGH skip", async () => {
  const { paperTrade } = await import("../src/trade");

  let insertCount = 0;
  class ImpactDb {
    prepare(sql: string) {
      return {
        bind: (..._args: unknown[]) => ({
          first: async (_col?: string) => {
            if (sql.includes("closed_at >= ?")) return { cnt: 0 };
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
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true, results: [] }),
      };
    }
  }

  const fund = {
    id: "honey_badger_l", name: "蜜獾·L", emoji: "🦡",
    initialBalance: 100000, maxOpenPositions: 5, maxPerEvent: 50000,
    minEdge: 1.0, minConfidence: 0.3, minVolume: 1000, minLiquidity: 1000,
    allowedTypes: ["MISPRICING"] as const,
    takeProfitPercent: 0.61, trailingStopPercent: 0,
    probReversalThreshold: 0, stopLossPercent: 0, maxHoldDays: 21,
    sizingMode: "fixed" as const, sizingBase: 50000, sizingScale: 0,
    maxMarketImpactRatio: 0.15, // 15% cap
    tier: "M" as const,
  };

  // Signal: liquidity = 100k, fund.sizingBase = 50k → rawSize/liquidity = 50%  > 15% → should skip
  const sigThin = {
    signalId: "SIG-THIN",
    type: "MISPRICING" as const,
    marketId: "market-thin",
    slug: "thin-market",
    question: "Thin market?",
    description: "test",
    edge: 3.0,
    confidence: 0.8,
    direction: "BUY_BOTH" as const,
    prices: { "Yes": 0.4, "No": 0.62, sum: 1.02, volume24hr: 200000, liquidity: 100000 },
    timestamp: new Date().toISOString(),
  };

  // Signal: liquidity = 1M, fund.sizingBase = 50k → rawSize/liquidity = 5% < 15% → should trade
  const sigDeep = {
    ...sigThin,
    signalId: "SIG-DEEP",
    marketId: "market-deep",
    slug: "deep-market",
    prices: { "Yes": 0.4, "No": 0.62, sum: 1.02, volume24hr: 2000000, liquidity: 1000000 },
  };

  const result = await paperTrade(
    new ImpactDb() as unknown as D1Database,
    [sigThin, sigDeep],
    [],
    [fund as any],
    new Date().toISOString(),
  );

  const impactSkips = result.skipReasons.filter(r => r.code === "MARKET_IMPACT_TOO_HIGH");
  assert.equal(impactSkips.length, 1,
    "Thin market (rawSize/liq > maxMarketImpactRatio) must produce MARKET_IMPACT_TOO_HIGH skip");
  assert.equal(result.trades.length, 1,
    "Deep market (rawSize/liq <= maxMarketImpactRatio) must produce 1 trade");
  assert.equal(insertCount, 1,
    "Only 1 INSERT should occur — thin market skipped, deep market traded");
});

test("Market Impact Gate: no skip when ratio is below threshold (deep market)", async () => {
  const { paperTrade } = await import("../src/trade");

  let insertCount = 0;
  class ZeroLiqDb {
    prepare(sql: string) {
      return {
        bind: (..._args: unknown[]) => ({
          first: async (_col?: string) => {
            if (sql.includes("closed_at >= ?")) return { cnt: 0 };
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
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true, results: [] }),
      };
    }
  }

  const fund = {
    id: "shark", name: "鲨鱼·S", emoji: "🦈",
    initialBalance: 10000, maxOpenPositions: 5, maxPerEvent: 10000,
    minEdge: 1.0, minConfidence: 0.3, minVolume: 1000, minLiquidity: 1000,
    allowedTypes: ["MISPRICING"] as const,
    takeProfitPercent: 0.61, trailingStopPercent: 0,
    probReversalThreshold: 0, stopLossPercent: 0, maxHoldDays: 21,
    sizingMode: "fixed" as const, sizingBase: 5000, sizingScale: 0,
    maxMarketImpactRatio: 0.15,
    tier: "S" as const,
  };

  // Signal: no liquidity field, but has volume24hr (so volume check passes).
  // liquidity = sig.prices["liquidity"] ?? sig.prices["volume24hr"] ?? 0
  // We strip "liquidity" from prices — gate falls back to volume24hr = 500000.
  // rawSize = 5000, liquidity = 500000 → ratio = 0.01 < 0.15 → gate does NOT fire.
  // This verifies the gate only fires when ratio is exceeded, not on missing data.
  const sig = {
    signalId: "SIG-NO-LIQ",
    type: "MISPRICING" as const,
    marketId: "market-no-liq",
    slug: "no-liq",
    question: "No liquidity data?",
    description: "test",
    edge: 2.5,
    confidence: 0.7,
    direction: "BUY_BOTH" as const,
    prices: { "Yes": 0.4, "No": 0.62, sum: 1.02, volume24hr: 500000 },  // no explicit liquidity field
    timestamp: new Date().toISOString(),
  };

  const result = await paperTrade(
    new ZeroLiqDb() as unknown as D1Database,
    [sig],
    [],
    [fund as any],
    new Date().toISOString(),
  );

  const impactSkips = result.skipReasons.filter(r => r.code === "MARKET_IMPACT_TOO_HIGH");
  assert.equal(impactSkips.length, 0,
    "Market Impact Gate must NOT fire when rawSize/liquidity ratio is below the threshold");
  assert.equal(insertCount, 1, "Trade should proceed when market has sufficient liquidity depth");
});

// ─── D1DatabaseError (non-Error instanceof) catch path ────────────────────
//
// Production Cloudflare D1 throws D1DatabaseError which has a .message property
// but does NOT extend the standard JS Error class (instanceof Error = false).
// The original catch used `e instanceof Error ? e.message : String(e)` which
// hit `String(e)` → "[object Object]" → UNIQUE check missed → error propagated
// to genome.ts storeError() → noisy pipeline_errors entries even after v3 deploy.
//
// Fix (trade.ts): `String((e as any)?.message ?? e)` — reads .message directly.
// This test verifies the fix by throwing a plain object (no instanceof Error).

test("INSERT failing with D1DatabaseError-style object (no instanceof Error) is caught and skipped", async () => {
  const { paperTrade } = await import("../src/trade");

  let duplicateSkips = 0;

  class D1StyleDb {
    prepare(sql: string) {
      return {
        bind: (..._args: unknown[]) => ({
          first: async (_col?: string) => {
            if (sql.includes("closed_at >= ?")) return { cnt: 0 };
            if (sql.includes("COUNT(*) as cnt")) return { cnt: 0 };
            if (sql.includes("SUM(amount)")) return { total: 0 };
            if (sql.includes("frozen_until")) return null;
            if (sql.includes("execution_mode")) return null;
            return null;
          },
          run: async () => {
            if (sql.trim().startsWith("INSERT INTO paper_trades")) {
              // Simulate a D1DatabaseError: plain object with .message, NOT instanceof Error.
              // This is the class of error the real Cloudflare D1 binding throws in production.
              const d1Error = { message: "D1_ERROR: UNIQUE constraint failed: paper_trades.fund_id, paper_trades.market_id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)" };
              throw d1Error;
            }
            return { success: true, results: [] };
          },
          all: async () => ({ results: [] }),
        }),
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true, results: [] }),
      };
    }
  }

  const sig = {
    signalId: "SIG-D1ERR",
    type: "MISPRICING" as const,
    marketId: "market-d1-style-err",
    slug: "d1-style-err",
    question: "D1 style error?",
    description: "test",
    edge: 2.5,
    confidence: 0.7,
    direction: "BUY_BOTH" as const,
    prices: { "Yes": 0.4, "No": 0.62, sum: 1.02, volume24hr: 50000 },
    timestamp: new Date().toISOString(),
  };
  const fund = {
    id: "shark",
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

  const result = await paperTrade(
    new D1StyleDb() as unknown as D1Database,
    [sig],
    [],
    [fund as any],
    new Date().toISOString(),
  );

  duplicateSkips = result.skipReasons.filter(r => r.code === "DUPLICATE_MARKET").length;

  assert.equal(duplicateSkips, 1,
    "D1DatabaseError-style object (non-Error instanceof) must be caught and translated to DUPLICATE_MARKET skip");
  assert.equal(result.trades.length, 0,
    "No trade should be recorded when D1DatabaseError-style UNIQUE violation is thrown");
});

// ─── maxSameEventPositions horizontal cap (2026-05-18 圆桌 6:0) ──────────────
//
// Root cause: 蜜獾·L / 海龟 etc. opened N positions across N candidates of the
// same multi-outcome event (邦德演员 7 笔, NBA 东部 4 笔). KV cooldown does NOT
// protect against this because each candidate has a distinct market_id.
// Fix: getSameEventOpenCount(db, fundId, slug) count-based cap in paperTrade().
//
// Tests use a mock DB where daily event-family history returns a configurable count.
// v2 semantics: counts ALL entries today (any status), not just OPEN.
// v3 semantics: slug/question are normalized through eventFamilyKey(), so nearby
// Polymarket slugs/questions can still be treated as one correlated event family.

function makeSameEventDb(dailyCount: number, insertCountRef: { n: number }) {
  class SameEventDb {
    prepare(sql: string) {
      return {
        bind: (..._args: unknown[]) => ({
          first: async (_col?: string) => {
            if (sql.includes("closed_at")) return { cnt: 0 };               // isDuplicate → no cooldown
            if (sql.includes("COUNT(*) as cnt")) return { cnt: 0 };         // getOpenPositionCount
            if (sql.includes("SUM(amount)")) return { total: 0 };           // getBalance
            if (sql.includes("frozen_until")) return null;
            return null;
          },
          run: async () => {
            if (sql.trim().startsWith("INSERT INTO paper_trades")) insertCountRef.n++;
            return { success: true, results: [] };
          },
          all: async () => {
            if (sql.includes("opened_at >=")) {
              return {
                results: Array.from({ length: dailyCount }, () => ({
                  slug: BOND_SIG.slug,
                  question: BOND_SIG.question,
                })),
              };
            }
            return { results: [] };
          },
        }),
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true, results: [] }),
      };
    }
  }
  return new SameEventDb() as unknown as D1Database;
}

const BASE_FUND = {
  id: "honey_badger_l", name: "蜜獾·L", emoji: "🦡",
  initialBalance: 1_000_000, maxOpenPositions: 20, maxPerEvent: 500_000,
  minEdge: 1.0, minConfidence: 0.3, minVolume: 5_000, minLiquidity: 5_000,
  allowedTypes: ["MULTI_OUTCOME_ARB"] as const,
  takeProfitPercent: 1.08, trailingStopPercent: 0.27,
  probReversalThreshold: 0.30, stopLossPercent: 0.30, maxHoldDays: 21,
  sizingMode: "fixed" as const, sizingBase: 40_000, sizingScale: 0,
  maxMarketImpactRatio: 0.50,
} as const;

const BOND_SIG = {
  signalId: "SIG-BOND-HENRY",
  type: "MULTI_OUTCOME_ARB" as const,
  marketId: "market-henry-cavill",
  slug: "next-james-bond-actor-635",
  question: "Will Henry Cavill be the next James Bond?",
  description: "test signal",
  edge: 3.5,
  confidence: 0.75,
  direction: "BUY_STRONGEST" as const,
  prices: { "Henry Cavill": 0.06, sum: 0.88, volume24hr: 500_000, liquidity: 500_000 },
  timestamp: new Date().toISOString(),
};

test("MAX_SAME_EVENT_POSITIONS blocks entry when daily event entry count reaches cap", async () => {
  const { paperTrade } = await import("../src/trade");

  const insertCountRef = { n: 0 };
  // Simulate 2 entries already today in the bond event (cap = 2, v2 daily-quota semantics)
  const db = makeSameEventDb(2, insertCountRef);

  const fund = { ...BASE_FUND, maxSameEventPositions: 2 };

  const result = await paperTrade(db, [BOND_SIG], [], [fund as any], new Date().toISOString());

  const capSkips = result.skipReasons.filter(r => r.code === "MAX_SAME_EVENT_POSITIONS");
  assert.equal(capSkips.length, 1,
    "Should produce exactly 1 MAX_SAME_EVENT_POSITIONS skip when daily count equals cap");
  assert.equal(result.trades.length, 0, "No trade should be opened when cap is reached");
  assert.equal(insertCountRef.n, 0, "No INSERT should be issued");
});

test("MAX_SAME_EVENT_POSITIONS does not block entry for a different event family", async () => {
  const { paperTrade } = await import("../src/trade");

  // DB says the bond event family is at cap (2) daily entries, but we send a
  // signal for a different event family.
  class CrossEventDb {
    prepare(sql: string) {
      return {
        bind: (..._args: unknown[]) => ({
          first: async (_col?: string) => {
            if (sql.includes("closed_at")) return { cnt: 0 };
            if (sql.includes("COUNT(*) as cnt")) return { cnt: 0 };
            if (sql.includes("SUM(amount)")) return { total: 0 };
            if (sql.includes("frozen_until")) return null;
            return null;
          },
          run: async () => ({ success: true, results: [] }),
          all: async () => {
            if (sql.includes("opened_at >=")) {
              return {
                results: [
                  { slug: "next-james-bond-actor-635", question: "Next James Bond actor?" },
                  { slug: "james-norton-announced-as-next-james-bond", question: "James Norton announced as next James Bond?" },
                ],
              };
            }
            return { results: [] };
          },
        }),
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true, results: [] }),
      };
    }
  }

  const nbaWestSig = {
    ...BOND_SIG,
    signalId: "SIG-NBA-WEST",
    marketId: "market-okc-thunder",
    slug: "nba-playoffs-western-conference-champion",
    question: "Will OKC Thunder win the NBA West?",
    prices: { "OKC Thunder": 0.55, sum: 0.95, volume24hr: 800_000, liquidity: 800_000 },
  };

  const fund = { ...BASE_FUND, maxSameEventPositions: 2, allowedTypes: ["MULTI_OUTCOME_ARB"] as const };

  const result = await paperTrade(
    new CrossEventDb() as unknown as D1Database,
    [BOND_SIG, nbaWestSig],
    [],
    [fund as any],
    new Date().toISOString(),
  );

  const capSkips = result.skipReasons.filter(r => r.code === "MAX_SAME_EVENT_POSITIONS");
  assert.equal(capSkips.length, 1,
    "Bond signal (same-family count 2 >= cap 2) should be blocked");
  assert.equal(result.trades.length, 1,
    "NBA West signal (different event family) must pass through and trade");
});

test("MAX_SAME_EVENT_POSITIONS uses default cap 1 when fund.maxSameEventPositions is not set", async () => {
  const { paperTrade } = await import("../src/trade");

  // Fund without explicit maxSameEventPositions — default is now 1 (v2, daily-quota semantics)
  const insertCountRef = { n: 0 };
  const db = makeSameEventDb(1, insertCountRef); // daily count = 1 = default cap

  // Strip maxSameEventPositions from fund to confirm default is applied
  const { maxMarketImpactRatio, ...fundWithoutCap } = BASE_FUND as any;
  const fund = { ...fundWithoutCap, maxMarketImpactRatio: 0.50 };
  // Ensure maxSameEventPositions is truly absent
  delete fund.maxSameEventPositions;

  const result = await paperTrade(db, [BOND_SIG], [], [fund as any], new Date().toISOString());

  const capSkips = result.skipReasons.filter(r => r.code === "MAX_SAME_EVENT_POSITIONS");
  assert.equal(capSkips.length, 1,
    "Default cap of 1 must fire when dailyCount (1) >= default (1) and fund has no maxSameEventPositions");
  assert.equal(insertCountRef.n, 0, "No INSERT when default cap is reached");
});
