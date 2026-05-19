-- Reconciliation audit log (P2.6 — ALPHA-001 Phase 2 Exit condition C2.3)
-- Stores each run of the live_orders ↔ Polymarket trade history comparison.
--
-- Phase 2 Exit gate C2.3: "Deposit Wallet 余额对账误差 = 0"
--   → is_clean = 1 AND usdc_discrepancy < 0.01 for 14 consecutive days
--
-- Populated by:
--   runReconcile() in polymarket-reconcile.ts (programmatic)
--   GET /api/live-reconcile?refresh=1 (operator-triggered)
--   Daily 00:00 UTC cron (automatic)

CREATE TABLE IF NOT EXISTS reconcile_log (
  id                    TEXT    PRIMARY KEY,
  run_at                TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  wallet_address        TEXT    NOT NULL,

  -- D1 side: what live_orders records as having happened
  d1_filled_count       INTEGER NOT NULL DEFAULT 0,
  d1_usdc_out           REAL    NOT NULL DEFAULT 0,  -- pUSD spent on BUY fills
  d1_usdc_in            REAL    NOT NULL DEFAULT 0,  -- pUSD received from SELL fills
  d1_net_change         REAL    NOT NULL DEFAULT 0,  -- in - out (negative = net buyer)

  -- Polymarket trade history side (null if API unavailable)
  chain_trade_count     INTEGER,
  chain_usdc_out        REAL,
  chain_usdc_in         REAL,

  -- Discrepancy: |d1_net_change - chain_net_change|; null if chain query failed
  usdc_discrepancy      REAL,

  -- Matching detail
  unmatched_d1_count    INTEGER NOT NULL DEFAULT 0,  -- D1 FILLED with no chain match
  unmatched_chain_count INTEGER NOT NULL DEFAULT 0,  -- chain trade with no D1 match

  -- Health flag: 1 if discrepancy < 0.01 AND no unmatched entries on either side
  is_clean              INTEGER NOT NULL DEFAULT 0,

  -- API call status
  api_status            TEXT    NOT NULL DEFAULT 'ok',  -- 'ok' | 'error' | 'skipped'
  error_message         TEXT
);

CREATE INDEX IF NOT EXISTS idx_reconcile_log_wallet_time
  ON reconcile_log(wallet_address, run_at DESC);
