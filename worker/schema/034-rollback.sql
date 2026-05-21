-- 034-rollback: Revert `honey_badger*` back to `honeyBadger*`

PRAGMA foreign_keys = OFF;

UPDATE paper_trades
   SET fund_id = REPLACE(fund_id, 'honey_badger', 'honeyBadger')
 WHERE fund_id IN ('honey_badger', 'honey_badger_m', 'honey_badger_l');

UPDATE portfolio_snapshots
   SET fund_id = REPLACE(fund_id, 'honey_badger', 'honeyBadger')
 WHERE fund_id IN ('honey_badger', 'honey_badger_m', 'honey_badger_l');

UPDATE evolution_log
   SET fund_id = REPLACE(fund_id, 'honey_badger', 'honeyBadger')
 WHERE fund_id IN ('honey_badger', 'honey_badger_m', 'honey_badger_l');

UPDATE circuit_breaker_state
   SET fund_id = REPLACE(fund_id, 'honey_badger', 'honeyBadger')
 WHERE fund_id IN ('honey_badger', 'honey_badger_m', 'honey_badger_l');

UPDATE fund_wallets
   SET fund_id = REPLACE(fund_id, 'honey_badger', 'honeyBadger')
 WHERE fund_id IN ('honey_badger', 'honey_badger_m', 'honey_badger_l');

UPDATE gene_variant_adjustments
   SET fund_id = REPLACE(fund_id, 'honey_badger', 'honeyBadger')
 WHERE fund_id IN ('honey_badger', 'honey_badger_m', 'honey_badger_l');

UPDATE gene_variant_outcomes
   SET fund_id = REPLACE(fund_id, 'honey_badger', 'honeyBadger')
 WHERE fund_id IN ('honey_badger', 'honey_badger_m', 'honey_badger_l');

UPDATE live_orders
   SET fund_id = REPLACE(fund_id, 'honey_badger', 'honeyBadger')
 WHERE fund_id IN ('honey_badger', 'honey_badger_m', 'honey_badger_l');

UPDATE shadow_orders
   SET fund_id = REPLACE(fund_id, 'honey_badger', 'honeyBadger')
 WHERE fund_id IN ('honey_badger', 'honey_badger_m', 'honey_badger_l');

UPDATE fund_configs
   SET id = REPLACE(id, 'honey_badger', 'honeyBadger')
 WHERE id IN ('honey_badger', 'honey_badger_m', 'honey_badger_l');

PRAGMA foreign_keys = ON;
