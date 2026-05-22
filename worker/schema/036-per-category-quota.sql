-- 036-per-category-quota.sql
--
-- v1.0.5 §4.2 Per-Category Signal Diversity Quota
-- ADR: ALPHA-003 D2 (v1.0.5 立项)
-- PRD: ALPHA-PRD-003 C-HARDEN1.6
-- Plan: products/rotifer-alpha/plan/rotifer-alpha-v1.0.5-plan.md §4.2
--
-- ── Background ─────────────────────────────────────────────────────────────
-- v1.0 §P9-C (commit e753c0c, 2026-05-21) introduced a hardcoded
-- UNTRUSTED_CATEGORY_MULTIPLIER=1.5 + floor as transitional protection
-- against crypto/ai 100% / 18.2% stop rates after Layer 1 signal source
-- expansion (commit b66ea8e). The fundamental problem — raw edge/confidence
-- failing for new categories without recalibration — needed two layers:
--   (1) Bayesian Platt scaling (v1.0.5 §4.1, in progress)
--   (2) Per-category hard quotas (this migration)
--
-- Even calibrated edge values can fill a budget if `applyCategoryBudget`
-- only caps by total fraction. Per-category quotas let each fund declare
-- "at most X% of my signals may be crypto" independent of how the calibrated
-- edge looks. Belt + suspenders.
--
-- ── Schema ────────────────────────────────────────────────────────────────
-- 5 new REAL columns on fund_configs, one per SignalCategory. Default values
-- are NOT NULL with archetype-specific seed via Step 3 backfill. The legacy
-- `max_category_fraction` column (schema 031) is retained as fallback —
-- applyCategoryBudget reads max_cat_<X> first, falls back to legacy if NULL.
--
-- Step 1: Add 5 nullable columns
-- Step 2: Backfill per archetype × 3 tier
-- (Optional Step 3): Once §P9-C transitional gate deleted (after Platt
-- scaling lands), legacy `max_category_fraction` may be dropped. Not done
-- in this migration to keep rollback simple.

-- ── Step 1: Add per-category columns ───────────────────────────────────
ALTER TABLE fund_configs ADD COLUMN max_cat_sports    REAL;
ALTER TABLE fund_configs ADD COLUMN max_cat_politics  REAL;
ALTER TABLE fund_configs ADD COLUMN max_cat_crypto    REAL;
ALTER TABLE fund_configs ADD COLUMN max_cat_ai        REAL;
ALTER TABLE fund_configs ADD COLUMN max_cat_other     REAL;

-- ── Step 2: Backfill per archetype × 3 tier ──────────────────────────
-- Conservative archetypes (turtle / octopus): heavy sports/politics tilt,
-- minimal crypto/ai/other (new categories with low calibration trust).
UPDATE fund_configs SET
  max_cat_sports    = 0.40,
  max_cat_politics  = 0.30,
  max_cat_crypto    = 0.10,
  max_cat_ai        = 0.10,
  max_cat_other     = 0.10
WHERE id IN ('turtle', 'turtle_m', 'turtle_l', 'octopus', 'octopus_m', 'octopus_l');

-- Medium-aggression archetypes (cheetah / shark): bigger sports + same
-- low untrusted-category exposure.
UPDATE fund_configs SET
  max_cat_sports    = 0.50,
  max_cat_politics  = 0.30,
  max_cat_crypto    = 0.10,
  max_cat_ai        = 0.10,
  max_cat_other     = 0.10
WHERE id IN ('cheetah', 'cheetah_m', 'cheetah_l', 'shark', 'shark_m', 'shark_l');

-- Aggressive archetype (honey_badger): largest sports + double untrusted
-- exposure budget — willing to bet on crypto/ai when edge is real.
UPDATE fund_configs SET
  max_cat_sports    = 0.50,
  max_cat_politics  = 0.30,
  max_cat_crypto    = 0.20,
  max_cat_ai        = 0.20,
  max_cat_other     = 0.20
WHERE id IN ('honey_badger', 'honey_badger_m', 'honey_badger_l');

-- ── Sanity check (informational, no-op when all funds backfilled) ────
-- SELECT id FROM fund_configs WHERE
--   max_cat_sports IS NULL OR max_cat_politics IS NULL OR
--   max_cat_crypto IS NULL OR max_cat_ai IS NULL OR max_cat_other IS NULL;
-- Expected: 0 rows.

-- ── Compat note ──────────────────────────────────────────────────────
-- Legacy max_category_fraction (schema 031) is preserved. applyCategoryBudget
-- in worker code reads max_cat_<X> first, falls back to max_category_fraction
-- when the per-cat field is NULL or absent. This lets pre-deployment funds
-- continue to work and lets new code make this column safely required later.
