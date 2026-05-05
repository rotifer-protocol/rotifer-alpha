-- Migration 015: Normalize polymarket-evolver → polymarket-micro-evolver
--
-- Root cause: schema/007 seeded gene_id = "polymarket-evolver", but all
-- subsequent code (genome.ts variant loading, migrations 012/014, strategies)
-- used "polymarket-micro-evolver". GENE_REGISTRY was the last stale reference.
--
-- This migration renames existing DB records so the entire system is consistent.

-- Step 1: Create renamed baseline variant (copy data, assign new canonical ID)
INSERT OR IGNORE INTO gene_variants
  (id, gene_id, variant_name, description, strategy_key, config, parent_variant_id, generation, status, created_at)
SELECT
  'polymarket-micro-evolver:v1-baseline',
  'polymarket-micro-evolver',
  variant_name, description, strategy_key, config, NULL, generation, status, created_at
FROM gene_variants
WHERE id = 'polymarket-evolver:v1-baseline';

-- Step 2: Point active config to new canonical variant
INSERT OR REPLACE INTO gene_active_config (gene_id, active_variant_id, updated_at)
VALUES ('polymarket-micro-evolver', 'polymarket-micro-evolver:v1-baseline', datetime('now'));

-- Step 3: Remove stale old-ID records
DELETE FROM gene_active_config WHERE gene_id = 'polymarket-evolver';
DELETE FROM gene_lineage
  WHERE parent_id LIKE 'polymarket-evolver:%'
     OR child_id  LIKE 'polymarket-evolver:%';
DELETE FROM gene_variants WHERE gene_id = 'polymarket-evolver';
