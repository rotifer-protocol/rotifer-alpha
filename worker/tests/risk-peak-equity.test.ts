/**
 * risk-peak-equity.test.ts (2026-05-21)
 *
 * P8 fix regression tests for getPeakEquity() — the helper that anchors
 * drawdown calculations to a fund's historical peak instead of its initial
 * balance, restoring effectiveSizing()'s soft/hard-limit protection.
 *
 * Bug history (pre-2026-05-21):
 *   - trade.ts:324 called calculateDrawdownPct(fund.initialBalance, currentEquity).
 *   - For any fund whose totalValue > initialBalance, drawdown reported 0%
 *     regardless of how far it had fallen from its peak.
 *   - 3 production funds (honeyBadger_l real-DD 30.2%, shark_m 15.3%, cheetah_m 10.4%)
 *     had crossed their soft limits but kept opening full-sized positions.
 *
 * Fix (this commit):
 *   - getPeakEquity(db, fundId, fallback) reads MAX(total_value) FROM
 *     portfolio_snapshots WHERE fund_id=?, with fallback for new funds.
 *   - trade.ts:324 wraps with Math.max(peakFromDb, currentEquity) to handle
 *     the "fund is making a fresh high but no daily snapshot exists yet" case.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { getPeakEquity } from "../src/risk.js";

type PreparedRow = { peak: number | null } | null;

function makeDb(prepared: PreparedRow): D1Database {
  return {
    prepare(_sql: string) {
      return {
        bind(_fundId: string) {
          return {
            async first<T>(): Promise<T | null> {
              return prepared as T | null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

// ── Happy path ────────────────────────────────────────────────────────────────

test("returns DB peak when it exceeds fallback", async () => {
  const db = makeDb({ peak: 1_477_000 });
  const peak = await getPeakEquity(db, "honeyBadger_l", 1_000_000);
  assert.equal(peak, 1_477_000);
});

test("returns fallback when DB peak is below fallback", async () => {
  // Defensive case: anomalously low MAX (e.g. only one early-loss snapshot).
  // Should never return less than the fallback (typically initialBalance).
  const db = makeDb({ peak: 950_000 });
  const peak = await getPeakEquity(db, "any-fund", 1_000_000);
  assert.equal(peak, 1_000_000);
});

// ── Fallback edge cases ───────────────────────────────────────────────────────

test("returns fallback when query returns no row", async () => {
  // Brand-new fund: portfolio_snapshots has nothing for this fund_id.
  const db = makeDb(null);
  const peak = await getPeakEquity(db, "newborn-fund", 100_000);
  assert.equal(peak, 100_000);
});

test("returns fallback when MAX(total_value) is NULL", async () => {
  // SQLite MAX of an empty filtered set returns NULL.
  const db = makeDb({ peak: null });
  const peak = await getPeakEquity(db, "any-fund", 50_000);
  assert.equal(peak, 50_000);
});

test("returns fallback when DB peak is NaN", async () => {
  // Very defensive: corrupt total_value (shouldn't happen, but Number.isFinite
  // guards against any non-finite reaching effectiveSizing()).
  const db = makeDb({ peak: NaN });
  const peak = await getPeakEquity(db, "any-fund", 200_000);
  assert.equal(peak, 200_000);
});
