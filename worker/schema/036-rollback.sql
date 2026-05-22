-- 036-rollback.sql
--
-- Rollback for 036-per-category-quota.sql
--
-- ── ⚠️ Safety ────────────────────────────────────────────────────────
-- Before running this rollback:
--   1. Verify no code in the worker reads max_cat_<X> without fallback —
--      grep `worker/src/scan.ts applyCategoryBudget` & `worker/src/evolve.ts`
--      for `max_cat_` references. As of schema 036 deployment, all readers
--      fall back to legacy `max_category_fraction` (schema 031), so this
--      rollback is safe even with worker still deployed.
--   2. If PARAM_BOUNDS_INVARIANT in param-bounds.ts has been extended with
--      maxCatSports/Politics/Crypto/Ai/Other entries that PBT evolution might
--      try to write, those must be removed first to avoid INSERT errors after
--      the columns vanish.

ALTER TABLE fund_configs DROP COLUMN max_cat_sports;
ALTER TABLE fund_configs DROP COLUMN max_cat_politics;
ALTER TABLE fund_configs DROP COLUMN max_cat_crypto;
ALTER TABLE fund_configs DROP COLUMN max_cat_ai;
ALTER TABLE fund_configs DROP COLUMN max_cat_other;
