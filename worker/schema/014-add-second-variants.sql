-- Migration 014: Add second variants for risk, trader, and micro-evolver genes.
-- Enables Code Epoch competition (elimination threshold >=2) for all 5 evolvable genes.
-- Settler is intentionally excluded — deterministic logic with zero behavioral variation.

-- polymarket-risk: conservative challenger (tighter stops, shorter holds)
INSERT OR IGNORE INTO gene_variants
  (id, gene_id, variant_name, description, strategy_key, config, parent_variant_id, generation, status, created_at)
VALUES
  ('polymarket-risk:conservative g1',
   'polymarket-risk',
   'conservative g1',
   'Conservative risk: 0.8× stop-loss and max-hold thresholds — cut losses faster',
   'conservative',
   '{}',
   'polymarket-risk:v1-baseline',
   1,
   'active',
   datetime('now'));

-- polymarket-trader: high-edge challenger (only signals with edge >= 2× minEdge)
INSERT OR IGNORE INTO gene_variants
  (id, gene_id, variant_name, description, strategy_key, config, parent_variant_id, generation, status, created_at)
VALUES
  ('polymarket-trader:high-edge g1',
   'polymarket-trader',
   'high-edge g1',
   'High-edge trader: requires edge >= 2× fund minEdge — fewer trades, higher conviction',
   'high-edge',
   '{}',
   'polymarket-trader:v1-baseline',
   1,
   'active',
   datetime('now'));

-- polymarket-micro-evolver: aggressive challenger (4% nudge, 15-trade threshold)
INSERT OR IGNORE INTO gene_variants
  (id, gene_id, variant_name, description, strategy_key, config, parent_variant_id, generation, status, created_at)
VALUES
  ('polymarket-micro-evolver:aggressive g1',
   'polymarket-micro-evolver',
   'aggressive g1',
   'Aggressive micro-evolver: 4% nudge ratio and 15-trade threshold — adapts faster',
   'aggressive',
   '{}',
   'polymarket-micro-evolver:v1-baseline',
   1,
   'active',
   datetime('now'));
