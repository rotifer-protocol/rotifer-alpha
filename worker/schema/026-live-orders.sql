-- Live Orders Table (Phase 2 Live foundation)
-- ALPHA-001 §10 G2: stores real CLOB V2 order state during Phase 2 live trading.
-- In Phase 1 Shadow: not populated (shadow_orders is the record of truth).
-- Schema created now so Phase 2 wiring requires no disruptive migration.

CREATE TABLE IF NOT EXISTS live_orders (
  id                TEXT PRIMARY KEY,
  paper_trade_id    TEXT,          -- bridge to paper_trades.id
  shadow_order_id   TEXT,          -- bridge to shadow_orders.id (Phase 1 reference)
  fund_id           TEXT NOT NULL,
  market_id         TEXT NOT NULL,
  token_id          TEXT,          -- Polymarket CLOB V2 YES token
  side              TEXT NOT NULL, -- 'BUY' | 'SELL'
  size_usdc         REAL NOT NULL,
  limit_price       REAL NOT NULL, -- 0–1
  shares            REAL NOT NULL,

  -- Lifecycle state
  status            TEXT NOT NULL DEFAULT 'PENDING',
  -- PENDING | OPEN | FILLED | PARTIAL | CANCELLED | EXPIRED | REJECTED

  -- Fill tracking (updated as CLOB confirms fills)
  filled_usdc       REAL DEFAULT 0,
  filled_shares     REAL DEFAULT 0,
  avg_fill_price    REAL,
  fee_usdc          REAL DEFAULT 0,

  -- CLOB V2 reference (Phase 2)
  clob_order_id     TEXT,

  -- GTC lifecycle timestamps
  submitted_at      TEXT,
  filled_at         TEXT,
  cancelled_at      TEXT,
  expires_at        TEXT,          -- GTC auto-cancel time

  -- Audit
  cancel_reason     TEXT,          -- 'max_wait_exceeded' | 'partial_rejected' | 'manual'
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_live_orders_fund_status
  ON live_orders(fund_id, status);

CREATE INDEX IF NOT EXISTS idx_live_orders_market
  ON live_orders(market_id, status);

CREATE INDEX IF NOT EXISTS idx_live_orders_paper_trade
  ON live_orders(paper_trade_id);
