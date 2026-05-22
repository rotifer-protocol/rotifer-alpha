-- 035-rollback.sql
--
-- Rollback for 035-p8b-drawdown-double-semantics.sql
--
-- ── ⚠️ WARNING ─────────────────────────────────────────────────────────────
-- 本 rollback 仅删除 4 个新增列,**不**触碰 drawdown_limit / drawdown_soft_limit。
-- 035 migration 中的 Step 2 (peak_drawdown_* backfill) 是单向数据复制——
-- rollback 后 peak_drawdown 数据丢失。如果 effectiveSizing() 已经用了双 DD
-- 逻辑,rollback 前必须先切回单 DD 模式(改 risk.ts + redeploy worker)。
--
-- 安全 rollback 流程:
--   1. 先回滚 worker 代码 (risk.ts effectiveSizing 切回单 DD)
--   2. 等 worker 部署稳定 (5min cron 跑一次)
--   3. 跑本 SQL
--
-- 跳过 Step 1 = sizing 决策可能 NaN / undefined。

-- ── Step 1: Drop 4 new columns ───────────────────────────────────────────
-- SQLite 不直接支持 DROP COLUMN < 3.35,但 D1 用更新版 SQLite 支持。
-- 如果 D1 报错,改用 "ALTER TABLE ... RENAME TO _old + CREATE TABLE + INSERT + DROP" 三步。
ALTER TABLE fund_configs DROP COLUMN loss_vs_initial_limit;
ALTER TABLE fund_configs DROP COLUMN loss_vs_initial_soft_limit;
ALTER TABLE fund_configs DROP COLUMN peak_drawdown_limit;
ALTER TABLE fund_configs DROP COLUMN peak_drawdown_soft_limit;
