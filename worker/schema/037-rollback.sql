-- 037-rollback.sql
--
-- Rollback for 037-paper-trades-signals-category.sql
--
-- ── ⚠️ Safety ────────────────────────────────────────────────────────
-- Before running this rollback:
--   1. Verify worker code no longer reads/writes paper_trades.category /
--      signals.category. grep worker/src/ for `category` references in
--      INSERT statements + SELECT queries.
--   2. If backfill has populated category data and you want to preserve
--      it, EXPORT before rollback:
--        wrangler d1 execute polymarket-signals --remote \
--          --command "SELECT id, category FROM paper_trades WHERE category != 'other'" \
--          > paper_trades_category_backup.json
--      (Similarly for signals)
--   3. After rollback, redeploy worker without category column references.

DROP INDEX IF EXISTS idx_paper_trades_category_closed;
DROP INDEX IF EXISTS idx_signals_category_created;
ALTER TABLE paper_trades DROP COLUMN category;
ALTER TABLE signals      DROP COLUMN category;
