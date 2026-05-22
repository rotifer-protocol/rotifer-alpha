-- 035-p8b-drawdown-double-semantics.sql
--
-- v1.0.5 §1 P8-B Drawdown Double-Semantics
-- ADR: ALPHA-003 D2 (internal: products/rotifer-alpha/adr/ALPHA-003-plan-v1.0.5-hardening-insertion.md)
-- PRD: ALPHA-PRD-003 C-HARDEN1.1
-- Plan: products/rotifer-alpha/plan/rotifer-alpha-v1.0.5-plan.md §1
--
-- ── Background ─────────────────────────────────────────────────────────────
-- P8 方案 A (commit 1987796, 2026-05-21) 把 accounting.ts calculateDrawdownPct
-- 的 reference 从 initialBalance 改为 peak equity，止血了"已盈利基金软限
-- 失效"问题（3 只基金 currentDrawdown silently 失效）。
--
-- 但 fund_configs.drawdown_limit / drawdown_soft_limit 两个字段的语义在
-- 方案 A 部署后**同时被改写**——从"相对初始本金"变成"从最高点跌"，
-- 失去了"绝对亏损保护"维度。
--
-- 本 migration 把单语义升级为双语义：
--   peak_drawdown_*       从最高点跌幅 (业界标准 drawdown)    常态保护
--   loss_vs_initial_*     相对初始本金的亏损比例              绝对兜底
--
-- effectiveSizing() 将取两个 DD 中**更严的**，判断 sizing 砍半 / 停仓。
--
-- ── Rollout strategy ───────────────────────────────────────────────────────
-- Step 1: 新增 4 列 (NULL allowed during backfill window)
-- Step 2: Backfill peak_drawdown_* ← 当前 drawdown_* (语义已是 peak,方案A 后)
-- Step 3: Backfill loss_vs_initial_* per archetype (5 family × 3 tier 同值)
--
-- ── Backward compatibility ─────────────────────────────────────────────────
-- 旧 drawdown_limit / drawdown_soft_limit 字段**保留**作为兼容期 fallback。
-- types.ts FundConfig 中新字段全部 optional，旧字段 deprecated comment 但
-- 不删除。risk.ts effectiveSizing() 在新字段缺失时 fallback 到旧字段。
--
-- 完整切换 (旧字段删除 + types.ts 加 required) 留待 v1.1 GA 后做 schema 040。

-- ── Step 1: Add 4 new columns ────────────────────────────────────────────
ALTER TABLE fund_configs ADD COLUMN loss_vs_initial_limit       REAL;
ALTER TABLE fund_configs ADD COLUMN loss_vs_initial_soft_limit  REAL;
ALTER TABLE fund_configs ADD COLUMN peak_drawdown_limit         REAL;
ALTER TABLE fund_configs ADD COLUMN peak_drawdown_soft_limit    REAL;

-- ── Step 2: Backfill peak_drawdown_* from existing drawdown_* ────────────
-- 语义已是 peak (方案 A 后),直接复制
UPDATE fund_configs
SET peak_drawdown_limit      = drawdown_limit,
    peak_drawdown_soft_limit = drawdown_soft_limit;

-- ── Step 3: Backfill loss_vs_initial_* per archetype ─────────────────────
-- 设计原则:lossVsInitial 阀值略宽于 peakDrawdown (约 1.5×),因为
-- "绝对亏掉本金 X%" 比 "从高点跌 X%" 是更严重的状态——需要更高阀值
-- 才触发"绝对兜底"保护(避免误报),但触发后处理应该更紧急。
-- 5 archetype × 3 tier 同值 (ADR-274 D7 "same personality × different capital")

-- turtle family (保守型,小风险胃口)
UPDATE fund_configs SET
  loss_vs_initial_soft_limit = 0.08,
  loss_vs_initial_limit      = 0.15
WHERE id IN ('turtle', 'turtle_m', 'turtle_l');

-- cheetah family (中度激进)
UPDATE fund_configs SET
  loss_vs_initial_soft_limit = 0.15,
  loss_vs_initial_limit      = 0.25
WHERE id IN ('cheetah', 'cheetah_m', 'cheetah_l');

-- octopus family (数据驱动,中等容忍)
UPDATE fund_configs SET
  loss_vs_initial_soft_limit = 0.12,
  loss_vs_initial_limit      = 0.20
WHERE id IN ('octopus', 'octopus_m', 'octopus_l');

-- shark family (激进型)
UPDATE fund_configs SET
  loss_vs_initial_soft_limit = 0.20,
  loss_vs_initial_limit      = 0.35
WHERE id IN ('shark', 'shark_m', 'shark_l');

-- honey_badger family (最激进,大风险胃口)
UPDATE fund_configs SET
  loss_vs_initial_soft_limit = 0.30,
  loss_vs_initial_limit      = 0.55
WHERE id IN ('honey_badger', 'honey_badger_m', 'honey_badger_l');

-- ── Sanity check (informational, no-op if all rows backfilled) ───────────
-- 验证 backfill 后无 NULL 残留:
--   SELECT id FROM fund_configs WHERE
--     loss_vs_initial_limit IS NULL OR loss_vs_initial_soft_limit IS NULL OR
--     peak_drawdown_limit IS NULL OR peak_drawdown_soft_limit IS NULL;
-- 期望: 0 rows
