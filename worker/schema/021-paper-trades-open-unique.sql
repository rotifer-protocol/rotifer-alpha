-- Partial UNIQUE index: enforce one OPEN trade per (fund_id, market_id).
--
-- Root cause (validated 2026-05-17 forensic):
--   Cloudflare Workers cron (* /5 * * * *) frequently fires with at-least-once
--   semantics — same schedule triggers 2-3 concurrent isolates. Each isolate runs
--   a full pipeline → analyze() (sigCtr resets per call) → paperTrade() (own
--   in-memory openedThisRun set) → INSERT.
--
--   Application-level dedup (isDuplicate DB read + openedThisRun in-memory set)
--   does NOT survive concurrent isolates: their isDuplicate() reads happen before
--   any INSERT commits, so all see 0 OPEN rows and proceed to INSERT.
--
--   Forensic SQL (paper_trades by 1-second bucket grouping signal_id timestamp
--   prefix) showed 16 cron ticks in the prior 24h triggered 2-3 concurrent
--   invocations — this is the norm, not an outlier.
--
-- Fix: DB-level partial unique index. SQLite enforces (fund_id, market_id)
--   uniqueness only over rows where status='OPEN'. Concurrent INSERT racers
--   beyond the first all fail with SQLITE_CONSTRAINT_UNIQUE — caught in trade.ts
--   and translated to a DUPLICATE_MARKET skip reason. Closed/invalidated rows
--   stay outside the index, so re-entry after a legitimate close still works.
--
-- Pre-condition (already enforced before this migration runs):
--   No two rows in paper_trades share (fund_id, market_id) with status='OPEN'.
--   Verified via:
--     SELECT fund_id, market_id, COUNT(*) FROM paper_trades
--     WHERE status='OPEN' GROUP BY fund_id, market_id HAVING COUNT(*)>1;
--   → 0 rows after the 2026-05-17 cleanup of 13 dup_groups (26 rows invalidated
--     with monitor_reason='MIGRATED: duplicate OPEN replica - replica-lag bug').

CREATE UNIQUE INDEX IF NOT EXISTS paper_trades_open_unique
  ON paper_trades(fund_id, market_id)
  WHERE status='OPEN';
