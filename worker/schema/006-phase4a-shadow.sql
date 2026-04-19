-- Shadow Real Trading Infrastructure
-- Records what WOULD happen on a real exchange, without executing

CREATE TABLE IF NOT EXISTS shadow_orders (
  id TEXT PRIMARY KEY,
  paper_trade_id TEXT,
  fund_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  slug TEXT,
  question TEXT,
  direction TEXT NOT NULL,
  side TEXT NOT NULL,
  shares REAL NOT NULL,
  price REAL NOT NULL,
  order_type TEXT DEFAULT 'LIMIT',
  status TEXT DEFAULT 'SIMULATED',
  simulated_fill_price REAL,
  simulated_slippage REAL,
  paper_pnl REAL,
  shadow_pnl REAL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO system_config (key, value, updated_at)
VALUES ('KILL_SWITCH', 'false', datetime('now'));

INSERT OR IGNORE INTO system_config (key, value, updated_at)
VALUES ('EXECUTION_MODE', 'paper', datetime('now'));
