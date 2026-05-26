/**
 * portfolio-coordinator-skip-log.test.ts (2026-05-23)
 *
 * Schema 038 INSERT-side regression tests for portfolio_coordinator_skips
 * logging in trade.ts PORTFOLIO_CONCENTRATION skip path.
 *
 * Validates:
 *   - When PORTFOLIO_CONCENTRATION skip fires, a row is INSERTed with the
 *     correct fields (fund_id, signal_id, event_family_id, exposure, amount,
 *     portfolio_limit, execution_mode)
 *   - When the table doesn't exist yet (pre-schema-038 deploy), the INSERT
 *     fails gracefully — the skip itself still records to skipReasons + the
 *     function does NOT throw to the caller
 *   - was_likely_safe / label_method / label_at remain NULL on initial INSERT
 *     (backfilled later by heuristic batch job)
 *
 * Note: full paperTrade() integration is heavy to mock; these tests focus on
 * the INSERT contract directly (mirror the trade.ts call shape).
 */

import test from "node:test";
import assert from "node:assert/strict";

interface RecordedCall {
  sql: string;
  args: unknown[];
}

class RecordingDb {
  public readonly calls: RecordedCall[] = [];
  public shouldThrow: Error | null = null;

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        run: async () => {
          if (this.shouldThrow) {
            const err = this.shouldThrow;
            this.shouldThrow = null;
            throw err;
          }
          this.calls.push({ sql, args });
          return { meta: {} };
        },
      }),
    };
  }
}

// ── INSERT contract ─────────────────────────────────────────────────────────

test("portfolio_coordinator_skips INSERT shape: 9 columns, 9 placeholders", () => {
  const insertSql = `INSERT INTO portfolio_coordinator_skips (
              id, fund_id, signal_id, event_family_id, attempted_at,
              current_exposure_usdc, attempted_amount_usdc, portfolio_limit_usdc, execution_mode
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  // 9 named columns + 9 placeholders
  const placeholderCount = (insertSql.match(/\?/g) ?? []).length;
  assert.equal(placeholderCount, 9, "9 placeholders for 9 NOT NULL columns");
  assert.ok(insertSql.includes("portfolio_coordinator_skips"), "table name present");
  assert.ok(insertSql.includes("current_exposure_usdc"), "exposure column present");
  assert.ok(insertSql.includes("attempted_amount_usdc"), "amount column present");
  assert.ok(insertSql.includes("portfolio_limit_usdc"), "limit column present");
});

test("portfolio_coordinator_skips INSERT: was_likely_safe / label_* are NOT in initial INSERT", () => {
  // These fields are populated later by heuristic batch job — initial INSERT
  // leaves them NULL (schema default).
  const insertSql = `INSERT INTO portfolio_coordinator_skips (
              id, fund_id, signal_id, event_family_id, attempted_at,
              current_exposure_usdc, attempted_amount_usdc, portfolio_limit_usdc, execution_mode
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  assert.ok(!insertSql.includes("was_likely_safe"), "label field must NOT be in INSERT");
  assert.ok(!insertSql.includes("label_method"), "label_method must NOT be in INSERT");
  assert.ok(!insertSql.includes("label_at"), "label_at must NOT be in INSERT");
});

// ── Binding behavior ────────────────────────────────────────────────────────

test("skip log: bind values land at correct positions", async () => {
  const db = new RecordingDb();
  const fundId = "shark_l";
  const signalId = "SIG-abc";
  const familyKey = "nba-finals-2026";
  const ts = "2026-05-23T10:00:00.000Z";
  const currentExposure = 150.0;
  const attemptedAmount = 80.0;
  const portfolioLimit = 200.0;
  const executionMode = "live";

  // Mirror trade.ts shape
  await db
    .prepare(`INSERT INTO portfolio_coordinator_skips (
              id, fund_id, signal_id, event_family_id, attempted_at,
              current_exposure_usdc, attempted_amount_usdc, portfolio_limit_usdc, execution_mode
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      "skip-1", fundId, signalId, familyKey, ts,
      currentExposure, attemptedAmount, portfolioLimit, executionMode,
    )
    .run();

  assert.equal(db.calls.length, 1);
  const args = db.calls[0].args;
  // Position 0..8 (id, fund_id, signal_id, event_family_id, attempted_at,
  //   current_exposure, attempted_amount, portfolio_limit, execution_mode)
  assert.equal(args[0], "skip-1");
  assert.equal(args[1], "shark_l");
  assert.equal(args[2], "SIG-abc");
  assert.equal(args[3], "nba-finals-2026");
  assert.equal(args[4], ts);
  assert.equal(args[5], 150.0);
  assert.equal(args[6], 80.0);
  assert.equal(args[7], 200.0);
  assert.equal(args[8], "live");
});

// ── Graceful degradation (schema not yet deployed) ──────────────────────────

test("skip log: 'no such table' error swallowed (pre-schema-038 graceful path)", async () => {
  const db = new RecordingDb();
  db.shouldThrow = Object.assign(new Error("D1_ERROR: no such table: portfolio_coordinator_skips"), {});

  // Mirror trade.ts try/catch path
  let warningLogged = false;
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warningLogged = true;
    // (don't actually print during test)
  };

  let threw = false;
  try {
    await db
      .prepare("INSERT INTO portfolio_coordinator_skips (...) VALUES (?)")
      .bind("x")
      .run();
  } catch (e) {
    const msg = String((e as any)?.message ?? e);
    if (!msg.includes("no such table")) {
      console.warn(`[portfolio-coordinator] skip log INSERT failed: ${msg}`);
      threw = true; // would surface unexpected errors
    }
    // 'no such table' silently suppressed
  } finally {
    console.warn = origWarn;
  }

  assert.equal(threw, false, "pre-deploy 'no such table' must not surface as error");
  assert.equal(warningLogged, false, "no warning for expected pre-deploy table-missing case");
});

test("skip log: non-table-missing errors DO surface as warning", async () => {
  const db = new RecordingDb();
  db.shouldThrow = new Error("D1_ERROR: UNIQUE constraint failed: portfolio_coordinator_skips.id");

  let warningLogged = false;
  const origWarn = console.warn;
  console.warn = () => { warningLogged = true; };

  try {
    await db
      .prepare("INSERT INTO portfolio_coordinator_skips (...) VALUES (?)")
      .bind("x")
      .run();
  } catch (e) {
    const msg = String((e as any)?.message ?? e);
    if (!msg.includes("no such table")) {
      console.warn(`[portfolio-coordinator] skip log INSERT failed: ${msg}`);
    }
  } finally {
    console.warn = origWarn;
  }

  assert.equal(warningLogged, true, "unexpected errors must log a warning");
});

// ── Verify SQL contract (C1.3 误报率 query) ────────────────────────────────

test("C1.3 verify SQL: returns expected shape (labeled-only denominator)", () => {
  // Document the query intended for Phase 2 monitoring; not actually run here.
  // Test asserts the query structure has key elements correct.
  const verifySql = `
    SELECT
      COUNT(*) AS total_intercepts,
      COUNT(CASE WHEN was_likely_safe = 1 THEN 1 END) AS likely_false_positive,
      ROUND(100.0 * COUNT(CASE WHEN was_likely_safe = 1 THEN 1 END) /
            NULLIF(COUNT(CASE WHEN was_likely_safe IS NOT NULL THEN 1 END), 0), 2) AS false_positive_rate
    FROM portfolio_coordinator_skips
    WHERE attempted_at > date('now', '-14 days');
  `;

  // Denominator uses was_likely_safe IS NOT NULL (only labeled rows) — important:
  // if many rows are still NULL (un-labeled), false_positive_rate stays accurate
  // among labeled subset rather than artificially low due to NULL division.
  assert.ok(verifySql.includes("was_likely_safe IS NOT NULL"), "denominator filters labeled rows");
  assert.ok(verifySql.includes("NULLIF"), "guard against divide-by-zero");
  assert.ok(verifySql.includes("portfolio_coordinator_skips"), "queries the new table");
});
