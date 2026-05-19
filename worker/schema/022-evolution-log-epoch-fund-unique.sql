-- Partial UNIQUE index: enforce one scheduled evolution row per (epoch, fund_id).
--
-- Root cause (validated 2026-05-19 forensic):
--   Multiple stale scheduled Workers wrote to the same D1 database. Epoch 9 ended
--   with both valid scored rows and duplicate VARIANT_INSUFFICIENT/null rows for
--   the same fund, and the frontend sometimes selected the null row first.
--
-- Fix:
--   Scheduled PBT epochs (epoch > 0) should have at most one canonical result per
--   fund. MICRO_EVOLUTION rows use epoch = -1 and remain outside this index.
--
-- Pre-condition:
--   No duplicate (epoch, fund_id) rows exist for epoch > 0.
--   Verified via:
--     SELECT epoch, fund_id, COUNT(*) FROM evolution_log
--     WHERE epoch > 0 GROUP BY epoch, fund_id HAVING COUNT(*) > 1;
--   → 0 rows after the 2026-05-19 Epoch 9 cleanup.

CREATE UNIQUE INDEX IF NOT EXISTS evolution_log_epoch_fund_unique
  ON evolution_log(epoch, fund_id)
  WHERE epoch > 0;
