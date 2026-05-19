-- Gene variant outcome provenance.
--
-- Root cause (validated 2026-05-19):
--   gene_variants.trades_evaluated / win_count / loss_count / total_pnl are
--   materialized counters. When paper_trades rows were later invalidated, those
--   counters could not be replayed because no per-outcome source table existed.
--
-- Fix:
--   Record every future Gene attribution outcome with variant, source, optional
--   paper_trade_id, and PnL. gene_variants remains a fast materialized summary,
--   but can now be recomputed from this table.

CREATE TABLE IF NOT EXISTS gene_variant_outcomes (
  id TEXT PRIMARY KEY,
  variant_id TEXT NOT NULL,
  gene_id TEXT NOT NULL,
  source TEXT NOT NULL,
  paper_trade_id TEXT,
  fund_id TEXT,
  market_id TEXT,
  status TEXT,
  pnl REAL NOT NULL,
  won INTEGER NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS gene_variant_outcomes_variant_idx
  ON gene_variant_outcomes(variant_id, recorded_at);

CREATE INDEX IF NOT EXISTS gene_variant_outcomes_trade_idx
  ON gene_variant_outcomes(paper_trade_id)
  WHERE paper_trade_id IS NOT NULL;
