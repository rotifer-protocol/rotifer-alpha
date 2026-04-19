-- Evolvable fund configuration table
-- Replaces hardcoded FUNDS constant for evolution engine

CREATE TABLE IF NOT EXISTS fund_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL,
  motto TEXT NOT NULL,
  initial_balance REAL NOT NULL,
  monthly_target REAL NOT NULL,
  drawdown_limit REAL NOT NULL,
  drawdown_soft_limit REAL NOT NULL,
  allowed_types TEXT NOT NULL,
  min_edge REAL NOT NULL,
  min_confidence REAL NOT NULL,
  min_volume INTEGER NOT NULL,
  min_liquidity INTEGER NOT NULL,
  max_per_event INTEGER NOT NULL,
  max_open_positions INTEGER NOT NULL,
  stop_loss_percent REAL NOT NULL,
  max_hold_days INTEGER NOT NULL,
  sizing_mode TEXT NOT NULL DEFAULT 'fixed',
  sizing_base REAL NOT NULL DEFAULT 200,
  sizing_scale REAL NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evolution_log (
  id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  executed_at TEXT NOT NULL,
  action TEXT NOT NULL,
  fund_id TEXT NOT NULL,
  params_before TEXT NOT NULL,
  params_after TEXT NOT NULL,
  fitness_before REAL,
  fitness_after REAL,
  reason TEXT NOT NULL,
  FOREIGN KEY (fund_id) REFERENCES fund_configs(id)
);

CREATE INDEX IF NOT EXISTS idx_evolution_epoch ON evolution_log(epoch);
CREATE INDEX IF NOT EXISTS idx_evolution_fund ON evolution_log(fund_id);
