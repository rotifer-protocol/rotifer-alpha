-- Migration 018: Backfill lineage rows for g1 challengers added in migration 014.
--
-- Migration 014 created parent_variant_id links for risk/trader/micro-evolver,
-- but did not insert gene_lineage rows. The public Gene Evolution report reads
-- gene_lineage, so those g1 variants looked unparented even though the variant
-- records had parent ids.

INSERT OR IGNORE INTO gene_lineage (id, parent_id, child_id, mutation_type, mutation_description, created_at)
VALUES
  (
    'lineage-risk-v1-to-conservative-g1',
    'polymarket-risk:v1-baseline',
    'polymarket-risk:conservative g1',
    'threshold_tightening',
    'Tightened stop-loss and max-hold thresholds to cut losses faster.',
    datetime('now')
  ),
  (
    'lineage-trader-v1-to-high-edge-g1',
    'polymarket-trader:v1-baseline',
    'polymarket-trader:high-edge g1',
    'signal_filter',
    'Raised entry bar to edge >= 2x fund minEdge for fewer, higher-conviction trades.',
    datetime('now')
  ),
  (
    'lineage-micro-evolver-v1-to-aggressive-g1',
    'polymarket-micro-evolver:v1-baseline',
    'polymarket-micro-evolver:aggressive g1',
    'adaptation_rate',
    'Increased parameter nudge ratio and lowered trade threshold so fund params adapt faster.',
    datetime('now')
  );
