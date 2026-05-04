-- ADR-274 D5: Delete Beluga/Leviathan — 0 trade data, clean slate for 3×5 matrix.
-- Execute each statement individually in D1 Console.

-- Statement 1: Remove paper trades (none expected, but clean up just in case)
DELETE FROM paper_trades WHERE fund_id IN ('beluga', 'leviathan');

-- Statement 2: Remove fund configs
DELETE FROM fund_configs WHERE id IN ('beluga', 'leviathan');

-- Statement 3: Verify deletion
SELECT id, name FROM fund_configs ORDER BY id;
