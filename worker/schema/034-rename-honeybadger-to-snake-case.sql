-- 034: Rename `honeyBadger*` fund IDs to `honey_badger*` (snake_case 规范化)
--
-- Context: 2026-05-21 标识符边界规则决议——跨系统标识符统一 snake_case。
--   honeyBadger 是 15 个基金中唯一的 camelCase ID，已导致前端 toLowerCase()
--   查找失败 bug（前端已修，但 ID 本身不规范是根因）。
--
-- Cascade scope: 与 033 相同 10 张表。
-- 执行前：暂停 cron + 跑 034-precheck.sh 确认行数。
-- 失败回滚：跑 034-rollback.sql。
--
-- 实际执行备注（2026-05-21）：
--   - D1 `--file` 首次执行因网络中断，后续逐表执行导致 `paper_trades`
--     进入部分迁移状态。
--   - 重跑完整 SQL 时，3 条旧 `honeyBadger` 行与已迁移的
--     `honey_badger` 行在 UNIQUE(fund_id, market_id) 上冲突。
--   - 已删除这些旧 ID 冲突行（正确行已存在）：market_id
--     1962237 / 2155023 / 2241742；另 1 条非冲突旧行已改为 `honey_badger`。
--   - 若未来复盘或回滚，注意 034-rollback.sql 不会恢复这 3 条已删除的
--     重复旧 ID 行。

PRAGMA foreign_keys = OFF;

UPDATE paper_trades
   SET fund_id = REPLACE(fund_id, 'honeyBadger', 'honey_badger')
 WHERE fund_id IN ('honeyBadger', 'honeyBadger_m', 'honeyBadger_l');

UPDATE portfolio_snapshots
   SET fund_id = REPLACE(fund_id, 'honeyBadger', 'honey_badger')
 WHERE fund_id IN ('honeyBadger', 'honeyBadger_m', 'honeyBadger_l');

UPDATE evolution_log
   SET fund_id = REPLACE(fund_id, 'honeyBadger', 'honey_badger')
 WHERE fund_id IN ('honeyBadger', 'honeyBadger_m', 'honeyBadger_l');

UPDATE circuit_breaker_state
   SET fund_id = REPLACE(fund_id, 'honeyBadger', 'honey_badger')
 WHERE fund_id IN ('honeyBadger', 'honeyBadger_m', 'honeyBadger_l');

UPDATE fund_wallets
   SET fund_id = REPLACE(fund_id, 'honeyBadger', 'honey_badger')
 WHERE fund_id IN ('honeyBadger', 'honeyBadger_m', 'honeyBadger_l');

UPDATE gene_variant_adjustments
   SET fund_id = REPLACE(fund_id, 'honeyBadger', 'honey_badger')
 WHERE fund_id IN ('honeyBadger', 'honeyBadger_m', 'honeyBadger_l');

UPDATE gene_variant_outcomes
   SET fund_id = REPLACE(fund_id, 'honeyBadger', 'honey_badger')
 WHERE fund_id IN ('honeyBadger', 'honeyBadger_m', 'honeyBadger_l');

UPDATE live_orders
   SET fund_id = REPLACE(fund_id, 'honeyBadger', 'honey_badger')
 WHERE fund_id IN ('honeyBadger', 'honeyBadger_m', 'honeyBadger_l');

UPDATE shadow_orders
   SET fund_id = REPLACE(fund_id, 'honeyBadger', 'honey_badger')
 WHERE fund_id IN ('honeyBadger', 'honeyBadger_m', 'honeyBadger_l');

UPDATE fund_configs
   SET id = REPLACE(id, 'honeyBadger', 'honey_badger')
 WHERE id IN ('honeyBadger', 'honeyBadger_m', 'honeyBadger_l');

PRAGMA foreign_keys = ON;
