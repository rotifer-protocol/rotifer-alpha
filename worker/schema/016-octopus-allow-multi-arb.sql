-- 2026-05-06 F8 cascade: temporarily allow MULTI_OUTCOME_ARB for octopus tier.
--
-- Background:
--   The MISPRICING signal type in scan.ts is semantically broken — it computes
--   `Math.abs(outcomePrices[0] + outcomePrices[1] - 1.0)` from Polymarket's
--   mid-price field which the API hardcodes to sum to 1.0 for binary markets.
--   Therefore MISPRICING signals NEVER trigger in production. Combined with the
--   rarity of SPREAD signals (most binary markets have spread = 1%, below the
--   2% threshold), octopus funds had effectively NO signal source — leading to
--   7+ hours of zero trades despite Group A funds (turtle/cheetah/shark/gambler)
--   trading actively on MULTI_OUTCOME_ARB.
--
-- Fix path:
--   - Immediate (this migration): unblock octopus by allowing MULTI_OUTCOME_ARB
--     so octopus tier joins Group A's signal pool. This is a TEMPORARY measure.
--   - Follow-up (P2.2 — pending): redesign MISPRICING using bestBid/bestAsk
--     instead of mid-price, OR introduce a new BINARY_LARGE_EDGE signal type.
--     Once the binary signal source is fixed, octopus's allowed_types should
--     revert to `["MISPRICING","SPREAD"]` (or replaced with the new type) to
--     restore strategy differentiation across the 3×5 matrix.
--
-- Execute each statement individually in D1 Console.

-- Statement 1: octopus (small / $10K)
UPDATE fund_configs
SET
  allowed_types = '["MISPRICING","SPREAD","MULTI_OUTCOME_ARB"]',
  updated_at = datetime('now')
WHERE id = 'octopus';

-- Statement 2: octopus_m (medium / $100K)
UPDATE fund_configs
SET
  allowed_types = '["MISPRICING","SPREAD","MULTI_OUTCOME_ARB"]',
  updated_at = datetime('now')
WHERE id = 'octopus_m';

-- Statement 3: octopus_l (large / $1M)
UPDATE fund_configs
SET
  allowed_types = '["MISPRICING","SPREAD","MULTI_OUTCOME_ARB"]',
  updated_at = datetime('now')
WHERE id = 'octopus_l';

-- Statement 4: Verify — should show three octopus rows with MULTI_OUTCOME_ARB present
SELECT id, name, initial_balance, allowed_types
FROM fund_configs
WHERE id IN ('octopus', 'octopus_m', 'octopus_l')
ORDER BY initial_balance;
