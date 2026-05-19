-- Gene variant legacy adjustment ledger.
--
-- Purpose:
--   Keep invalidated historical trade impact separate from live Gene counters.
--   Older gene_variants counters were materialized without per-trade provenance,
--   so invalidated legacy trades cannot be honestly assigned to a specific Gene
--   variant. These rows isolate the bad ledger entries without pretending more
--   precision than the old data supports.

CREATE TABLE IF NOT EXISTS gene_variant_adjustments (
  id TEXT PRIMARY KEY,
  adjustment_type TEXT NOT NULL,
  variant_id TEXT,
  gene_id TEXT,
  paper_trade_id TEXT,
  fund_id TEXT,
  market_id TEXT,
  pnl_delta REAL NOT NULL,
  trade_delta INTEGER NOT NULL,
  win_delta INTEGER NOT NULL,
  loss_delta INTEGER NOT NULL,
  confidence TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS gene_variant_adjustments_trade_type_unique
  ON gene_variant_adjustments(adjustment_type, paper_trade_id)
  WHERE paper_trade_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS gene_variant_adjustments_variant_idx
  ON gene_variant_adjustments(variant_id, created_at);
