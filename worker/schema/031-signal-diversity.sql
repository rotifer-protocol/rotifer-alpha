-- Signal diversity budget parameter (Layer 2, 2026-05-20)
--
-- max_category_fraction: max fraction of total signals from any single inferred
-- category (sports/politics/crypto/ai/other).  Applied in analyze() via
-- applyCategoryBudget() before signals are matched to funds.
--
-- Default 0.40 (40%): conservative enough to prevent NBA/sports domination on
-- high-signal days while still allowing genuine concentrated opportunities.
-- Evolvable via PARAM_BOUNDS_INVARIANT (min: 0.10, max: 0.80).

ALTER TABLE fund_configs ADD COLUMN max_category_fraction REAL NOT NULL DEFAULT 0.40;
