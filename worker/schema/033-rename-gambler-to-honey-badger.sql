-- 033: Rename `gambler*` fund IDs to `honeyBadger*` + emoji 🎲 → 🦡
--
-- Context: 2026-05-21 创始人观察到 `gambler` 字段名在开源场景下会让 user
--   误解为"鼓励赌博"。基金的实际定位是"高风险、高回报、低 Sharpe（蜜獾型攻击者）"
--   而非赌博。同时 `gambler` 系列 emoji 当前是 🎲（骰子），与 fundMeta.ts 中
--   `Honey Badger` 的 archetype 不一致——这是历史 ID/UI 双漂移，本次一并修复。
--
-- ⚠️ 三层一致：
--   1. fund ID:  gambler → honeyBadger / gambler_m → honeyBadger_m / gambler_l → honeyBadger_l
--   2. emoji:   🎲 → 🦡 （fund_configs.emoji 列）
--   3. UI/i18n: 已在 site/src/* 同步（独立 commit，与本 SQL 同部署窗口）
--
-- ⚠️ Cascade scope: 10 张表共 1148 行 (2026-05-21 wrangler d1 远程统计)
--   fund_configs (3) | paper_trades (246) | portfolio_snapshots (82)
--   evolution_log (28) | circuit_breaker_state (0) | fund_wallets (0)
--   gene_variant_adjustments (89) | gene_variant_outcomes (114)
--   live_orders (0) | shadow_orders (589)
--
-- ⚠️ FK constraint: D1 foreign_keys=ON, evolution_log.fund_id → fund_configs.id
--   存在 FK 约束。无论先 UPDATE 哪张表都会触发循环约束错误。
--   解决：临时 PRAGMA foreign_keys = OFF（文件末尾恢复）。
--
-- ⚠️ 不变性保护：
--   - WHERE fund_id IN (...) 严格限定只匹配 3 个预期 ID（即使将来出现 'gambler_xs'
--     也不会被误改，必须显式扩列表才会生效）
--   - REPLACE() 在被 WHERE 命中后才做字符串替换（双层防御）
--
-- 执行前必读：先跑 033-precheck.sql 确认行数与本头部一致。
-- 失败回滚：跑 033-rollback.sql 反向恢复（保持 ID 映射对称）。
--
-- Related:
--   - internal/products/rotifer-alpha/plan/live-trading-plan.md §"Gambler 重命名"
--   - rotifer-alpha/site/src/i18n/translations.ts (UI 文案)
--   - rotifer-alpha/site/src/lib/fundMeta.ts (前端基金元数据)
--   - rotifer-alpha/worker/src/types.ts (Worker 端基金枚举)

PRAGMA foreign_keys = OFF;

-- Cascade tables (顺序无关，因为 FK 已关闭)
UPDATE paper_trades
   SET fund_id = REPLACE(fund_id, 'gambler', 'honeyBadger')
 WHERE fund_id IN ('gambler', 'gambler_m', 'gambler_l');

UPDATE portfolio_snapshots
   SET fund_id = REPLACE(fund_id, 'gambler', 'honeyBadger')
 WHERE fund_id IN ('gambler', 'gambler_m', 'gambler_l');

UPDATE evolution_log
   SET fund_id = REPLACE(fund_id, 'gambler', 'honeyBadger')
 WHERE fund_id IN ('gambler', 'gambler_m', 'gambler_l');

UPDATE circuit_breaker_state
   SET fund_id = REPLACE(fund_id, 'gambler', 'honeyBadger')
 WHERE fund_id IN ('gambler', 'gambler_m', 'gambler_l');

UPDATE fund_wallets
   SET fund_id = REPLACE(fund_id, 'gambler', 'honeyBadger')
 WHERE fund_id IN ('gambler', 'gambler_m', 'gambler_l');

UPDATE gene_variant_adjustments
   SET fund_id = REPLACE(fund_id, 'gambler', 'honeyBadger')
 WHERE fund_id IN ('gambler', 'gambler_m', 'gambler_l');

UPDATE gene_variant_outcomes
   SET fund_id = REPLACE(fund_id, 'gambler', 'honeyBadger')
 WHERE fund_id IN ('gambler', 'gambler_m', 'gambler_l');

UPDATE live_orders
   SET fund_id = REPLACE(fund_id, 'gambler', 'honeyBadger')
 WHERE fund_id IN ('gambler', 'gambler_m', 'gambler_l');

UPDATE shadow_orders
   SET fund_id = REPLACE(fund_id, 'gambler', 'honeyBadger')
 WHERE fund_id IN ('gambler', 'gambler_m', 'gambler_l');

-- Parent table: rename PK + fix emoji 🎲 → 🦡
UPDATE fund_configs
   SET id    = REPLACE(id, 'gambler', 'honeyBadger'),
       emoji = '🦡'
 WHERE id IN ('gambler', 'gambler_m', 'gambler_l');

PRAGMA foreign_keys = ON;
