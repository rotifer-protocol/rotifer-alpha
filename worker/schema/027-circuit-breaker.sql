-- Circuit Breaker State (Phase 2 Live safety guard)
-- ALPHA-001 §9: prevents catastrophic single-epoch loss during live trading.
--
-- Per-fund, per-epoch tracking:
--   epoch_start_usdc = fund capital at epoch start (used to compute loss %)
--   epoch_loss_usdc  = cumulative realized loss in current epoch
--   tripped = 1 if CB fired; new trades blocked until operator resets or next epoch
--
-- Epoch defined as: 24h rolling window, reset by daily 01:00 UTC cron.
-- Initialised with all 15 funds at epoch_start_usdc=0 (will backfill on first cron).

CREATE TABLE IF NOT EXISTS circuit_breaker_state (
  fund_id           TEXT PRIMARY KEY,
  epoch_start_usdc  REAL NOT NULL DEFAULT 0,
  epoch_loss_usdc   REAL NOT NULL DEFAULT 0,
  tripped           INTEGER NOT NULL DEFAULT 0,  -- 0=false, 1=true
  tripped_at        TEXT,
  epoch_started_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
