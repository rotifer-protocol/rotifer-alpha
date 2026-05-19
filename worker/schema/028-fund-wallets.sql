-- Deposit Wallets (Phase 2 Live setup)
-- ALPHA-001 Phase 2: maps each fund to its deposit wallet address.
--
-- Phase 2: all funds share ONE Owner EOA wallet (register-deposit-wallet.sh sets this up).
-- Phase 3: per-fund Gnosis Safe wallets (multi-sig, ALPHA-PRD-001 §3.3).
--
-- wallet_type: 'eoa' (Phase 2) | 'gnosis_safe' (Phase 3)
-- One row per fund; re-running the script replaces rows.

CREATE TABLE IF NOT EXISTS fund_wallets (
  fund_id               TEXT    PRIMARY KEY,
  wallet_address        TEXT    NOT NULL,
  wallet_type           TEXT    NOT NULL DEFAULT 'eoa',
  initial_balance_usdc  REAL    NOT NULL DEFAULT 0,
  registered_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  notes                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_fund_wallets_address
  ON fund_wallets(wallet_address);
