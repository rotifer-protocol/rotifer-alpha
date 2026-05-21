-- 033-rollback: Restore `honeyBadger*` IDs back to `gambler*` + emoji 🦡 → 🎲
--
-- 仅在 033-rename-gambler-to-honey-badger.sql 执行后出现严重问题
-- （应用层无法启动 / 数据外联失败）时使用。
--
-- ⚠️ 注意：rollback 后必须同步回滚应用层（site / worker code revert）。

PRAGMA foreign_keys = OFF;

UPDATE paper_trades
   SET fund_id = REPLACE(fund_id, 'honeyBadger', 'gambler')
 WHERE fund_id IN ('honeyBadger', 'honeyBadger_m', 'honeyBadger_l');

UPDATE portfolio_snapshots
   SET fund_id = REPLACE(fund_id, 'honeyBadger', 'gambler')
 WHERE fund_id IN ('honeyBadger', 'honeyBadger_m', 'honeyBadger_l');

UPDATE evolution_log
   SET fund_id = REPLACE(fund_id, 'honeyBadger', 'gambler')
 WHERE fund_id IN ('honeyBadger', 'honeyBadger_m', 'honeyBadger_l');

UPDATE circuit_breaker_state
   SET fund_id = REPLACE(fund_id, 'honeyBadger', 'gambler')
 WHERE fund_id IN ('honeyBadger', 'honeyBadger_m', 'honeyBadger_l');

UPDATE fund_wallets
   SET fund_id = REPLACE(fund_id, 'honeyBadger', 'gambler')
 WHERE fund_id IN ('honeyBadger', 'honeyBadger_m', 'honeyBadger_l');

UPDATE gene_variant_adjustments
   SET fund_id = REPLACE(fund_id, 'honeyBadger', 'gambler')
 WHERE fund_id IN ('honeyBadger', 'honeyBadger_m', 'honeyBadger_l');

UPDATE gene_variant_outcomes
   SET fund_id = REPLACE(fund_id, 'honeyBadger', 'gambler')
 WHERE fund_id IN ('honeyBadger', 'honeyBadger_m', 'honeyBadger_l');

UPDATE live_orders
   SET fund_id = REPLACE(fund_id, 'honeyBadger', 'gambler')
 WHERE fund_id IN ('honeyBadger', 'honeyBadger_m', 'honeyBadger_l');

UPDATE shadow_orders
   SET fund_id = REPLACE(fund_id, 'honeyBadger', 'gambler')
 WHERE fund_id IN ('honeyBadger', 'honeyBadger_m', 'honeyBadger_l');

UPDATE fund_configs
   SET id    = REPLACE(id, 'honeyBadger', 'gambler'),
       emoji = '🎲'
 WHERE id IN ('honeyBadger', 'honeyBadger_m', 'honeyBadger_l');

PRAGMA foreign_keys = ON;
