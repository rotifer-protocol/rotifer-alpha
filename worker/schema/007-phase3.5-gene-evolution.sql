-- Gene Implementation-Level Evolution

CREATE TABLE IF NOT EXISTS gene_variants (
  id TEXT PRIMARY KEY,
  gene_id TEXT NOT NULL,
  variant_name TEXT NOT NULL,
  description TEXT,
  strategy_key TEXT NOT NULL,
  config TEXT DEFAULT '{}',
  parent_variant_id TEXT,
  generation INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  petri_score REAL DEFAULT 0,
  trades_evaluated INTEGER DEFAULT 0,
  win_count INTEGER DEFAULT 0,
  loss_count INTEGER DEFAULT 0,
  total_pnl REAL DEFAULT 0,
  created_at TEXT NOT NULL,
  eliminated_at TEXT,
  UNIQUE(gene_id, variant_name)
);

CREATE TABLE IF NOT EXISTS gene_lineage (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL,
  child_id TEXT NOT NULL,
  mutation_type TEXT NOT NULL,
  mutation_description TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gene_evolution_log (
  id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  gene_id TEXT NOT NULL,
  action TEXT NOT NULL,
  variant_id TEXT,
  details TEXT,
  petri_score REAL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gene_active_config (
  gene_id TEXT PRIMARY KEY,
  active_variant_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Seed baseline variants for all 6 Genes
INSERT OR IGNORE INTO gene_variants (id, gene_id, variant_name, description, strategy_key, generation, status, created_at)
VALUES
  ('polymarket-scanner:v1-baseline', 'polymarket-scanner', 'v1-baseline', 'Standard edge-based signal detection with volume/liquidity filtering', 'baseline', 0, 'active', datetime('now')),
  ('polymarket-risk:v1-baseline', 'polymarket-risk', 'v1-baseline', 'Fixed stop-loss and max-hold-days risk checks', 'baseline', 0, 'active', datetime('now')),
  ('polymarket-monitor:v1-baseline', 'polymarket-monitor', 'v1-baseline', 'Fixed take-profit, trailing-stop, and probability reversal', 'baseline', 0, 'active', datetime('now')),
  ('polymarket-settler:v1-baseline', 'polymarket-settler', 'v1-baseline', 'Market resolution detection and PnL settlement', 'baseline', 0, 'active', datetime('now')),
  ('polymarket-trader:v1-baseline', 'polymarket-trader', 'v1-baseline', 'Edge-ranked signal allocation with position sizing', 'baseline', 0, 'active', datetime('now')),
  ('polymarket-evolver:v1-baseline', 'polymarket-evolver', 'v1-baseline', 'Gradient-based micro-evolution with ±2% parameter bounds', 'baseline', 0, 'active', datetime('now'));

-- Set baseline as active for all Genes
INSERT OR IGNORE INTO gene_active_config (gene_id, active_variant_id, updated_at)
VALUES
  ('polymarket-scanner', 'polymarket-scanner:v1-baseline', datetime('now')),
  ('polymarket-risk', 'polymarket-risk:v1-baseline', datetime('now')),
  ('polymarket-monitor', 'polymarket-monitor:v1-baseline', datetime('now')),
  ('polymarket-settler', 'polymarket-settler:v1-baseline', datetime('now')),
  ('polymarket-trader', 'polymarket-trader:v1-baseline', datetime('now')),
  ('polymarket-evolver', 'polymarket-evolver:v1-baseline', datetime('now'));

-- Seed epoch 0
INSERT OR IGNORE INTO gene_evolution_log (id, epoch, gene_id, action, details, created_at)
VALUES ('epoch-0-init', 0, '*', 'epoch_started', '{"description":"Baseline variants seeded."}', datetime('now'));
