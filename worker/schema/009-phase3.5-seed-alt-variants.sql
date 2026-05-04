-- Phase 3.5 Alt-Variant Seed (ADR-273 D2 / P0-4)
--
-- Seeds generation-1 alternative variants for scanner and monitor so the
-- implementation-level evolution loop (code-evolver.ts) has at least one
-- competitor to evaluate against the v1-baseline.
--
-- Petri Score boundary (ADR-273 D5 / ADR-117):
--   petri_score here is a LOCAL PBT metric (Win Rate + avg PnL + trade count).
--   It is STRICTLY independent of the Rotifer Protocol F(g).
--   These records must never be written to the Cloud Registry F(g) column.
--
-- Strategy keys must match entries in gene-strategies.ts:
--   scanner: "baseline" | "trend-following"
--   monitor: "baseline" | "adaptive"

-- ── Scanner v2: trend-following ──────────────────────────────────────────────
-- Prioritizes directional markets; filters SPREAD signals; confidence floor 0.35;
-- volume requirement 1.5× baseline. Hypothesis: higher selectivity improves win rate.

INSERT OR IGNORE INTO gene_variants (
  id, gene_id, variant_name, description,
  strategy_key, config, parent_variant_id, generation,
  status, petri_score, trades_evaluated,
  win_count, loss_count, total_pnl, created_at
) VALUES (
  'polymarket-scanner:v2-trend-following',
  'polymarket-scanner',
  'v2-trend-following',
  'Trend-following scanner: filters SPREAD signals, boosts MISPRICING with volume alignment, applies 0.35 confidence floor and 1.5× volume requirement.',
  'trend-following',
  '{"confidenceFloor":0.35,"volumeMultiplier":1.5,"excludeSpread":true}',
  'polymarket-scanner:v1-baseline',
  1,
  'active',
  0, 0, 0, 0, 0,
  datetime('now')
);

-- Record lineage
INSERT OR IGNORE INTO gene_lineage (id, parent_id, child_id, mutation_type, mutation_description, created_at)
VALUES (
  'lineage-scanner-v1-to-v2',
  'polymarket-scanner:v1-baseline',
  'polymarket-scanner:v2-trend-following',
  'strategy_swap',
  'Replaced edge-only baseline with trend-following filter: higher confidence floor + volume alignment boost.',
  datetime('now')
);

-- Log the seeding event
INSERT OR IGNORE INTO gene_evolution_log (id, epoch, gene_id, action, variant_id, details, created_at)
VALUES (
  'seed-scanner-v2',
  0,
  'polymarket-scanner',
  'variant_seeded',
  'polymarket-scanner:v2-trend-following',
  '{"source":"schema-009","reason":"Phase 3.5 competition seed — requires ≥2 active variants for evolution loop trigger"}',
  datetime('now')
);

-- ── Monitor v2: adaptive ─────────────────────────────────────────────────────
-- Dynamically adjusts thresholds by position age and P&L trajectory.
-- Young positions (< 3 days) get wider stop-loss; profitable positions tighten.
-- Hypothesis: volatility-adjusted thresholds reduce premature exits.

INSERT OR IGNORE INTO gene_variants (
  id, gene_id, variant_name, description,
  strategy_key, config, parent_variant_id, generation,
  status, petri_score, trades_evaluated,
  win_count, loss_count, total_pnl, created_at
) VALUES (
  'polymarket-monitor:v2-adaptive',
  'polymarket-monitor',
  'v2-adaptive',
  'Adaptive monitor: widens stop-loss for young positions (< 3 days), tightens trailing stop as gain increases via trailingTightenFactor=0.5.',
  'adaptive',
  '{"adaptiveMode":true,"youngPositionDays":3,"trailingTightenFactor":0.5}',
  'polymarket-monitor:v1-baseline',
  1,
  'active',
  0, 0, 0, 0, 0,
  datetime('now')
);

-- Record lineage
INSERT OR IGNORE INTO gene_lineage (id, parent_id, child_id, mutation_type, mutation_description, created_at)
VALUES (
  'lineage-monitor-v1-to-v2',
  'polymarket-monitor:v1-baseline',
  'polymarket-monitor:v2-adaptive',
  'strategy_swap',
  'Replaced fixed-threshold monitor with volatility-adaptive thresholds (youngPositionDays=3, trailingTightenFactor=0.5).',
  datetime('now')
);

-- Log the seeding event
INSERT OR IGNORE INTO gene_evolution_log (id, epoch, gene_id, action, variant_id, details, created_at)
VALUES (
  'seed-monitor-v2',
  0,
  'polymarket-monitor',
  'variant_seeded',
  'polymarket-monitor:v2-adaptive',
  '{"source":"schema-009","reason":"Phase 3.5 competition seed — requires ≥2 active variants for evolution loop trigger"}',
  datetime('now')
);
