-- Order Lifecycle Foundation (Phase 1 Shadow + Phase 2 Live prep)
-- ALPHA-001 §10 G2: order lifecycle management (GTC / partial fills / settlement)

-- Fee modeling: fee amount actually paid per shadow order
ALTER TABLE shadow_orders ADD COLUMN fee_usdc REAL DEFAULT 0;

-- Shadow order settlement tracking: when the paper trade resolves,
-- record the actual exit price so Phase 1 can measure prediction accuracy.
ALTER TABLE shadow_orders ADD COLUMN settled_at TEXT;
ALTER TABLE shadow_orders ADD COLUMN actual_exit_price REAL;

-- Fee modeling: fee columns in paper_trades for accurate PnL
-- entry_fee_usdc = fee paid on open; exit_fee_usdc = fee paid on close.
-- Currently Polymarket 0% fee — stored as 0, architecture ready for non-zero.
ALTER TABLE paper_trades ADD COLUMN entry_fee_usdc REAL DEFAULT 0;
ALTER TABLE paper_trades ADD COLUMN exit_fee_usdc REAL DEFAULT 0;
