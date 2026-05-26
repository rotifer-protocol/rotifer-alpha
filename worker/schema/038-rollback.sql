-- 038-rollback.sql
--
-- Rollback for 038-portfolio-coordinator-skips.sql
--
-- ── Safety ────────────────────────────────────────────────────────────────
-- Before running this rollback:
--   1. Verify worker code no longer INSERTs to portfolio_coordinator_skips.
--      grep worker/src/trade.ts for `INSERT INTO portfolio_coordinator_skips`.
--      Remove or comment out before re-deploying worker.
--   2. If skip data has accumulated and is needed for audit, EXPORT first:
--        wrangler d1 execute polymarket-signals --remote \
--          --command "SELECT * FROM portfolio_coordinator_skips" > skips_backup.json

DROP INDEX IF EXISTS idx_pcs_unlabeled;
DROP INDEX IF EXISTS idx_pcs_family_attempted;
DROP INDEX IF EXISTS idx_pcs_fund_attempted;
DROP TABLE IF EXISTS portfolio_coordinator_skips;
