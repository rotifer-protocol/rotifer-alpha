-- 037-paper-trades-signals-category.sql
--
-- v1.0 follow-up: 持久化 ArbSignal.category 到 paper_trades + signals
-- 关联: v1.0 plan C1.3 follow-up + ALPHA-PRD-003 P-HARDEN1.2 数据 gap 修复
-- Spec: internal/products/rotifer-alpha/plan/schema-037-category-persistence-spec.md
--
-- ── Background ─────────────────────────────────────────────────────────────
-- 2026-05-23 wrangler 实测发现:
--   - paper_trades 表无 category 字段
--   - signals 表无 category 字段
--   - category 仅 runtime ArbSignal.category 存在
--
-- 后果:
--   1. P-HARDEN1.2 (5 类别 ≥100 笔已结算) 无法用 SQL GROUP BY 精确监控
--   2. §4.1 Platt scaling 训练时需要重跑 inferCategory(slug, question)
--   3. SQL LIKE 反推误匹配率高 (例 `-ai%` 命中 "airspace")
--
-- ── Strategy ───────────────────────────────────────────────────────────────
-- 1. ALTER TABLE 加 category 列 (TEXT NOT NULL DEFAULT 'other')
--    - TEXT 而非 CHECK enum: SignalCategory union 在 TS 层已确保
--    - DEFAULT 'other' 防 INSERT 漏值 + 'other' 是合法 SignalCategory
-- 2. 部分索引 paper_trades(category, closed_at) WHERE closed_at IS NOT NULL
--    - P-HARDEN1.2 查询都是已结算 trades, 部分索引节省空间
-- 3. 全量索引 signals(category, created_at)
--    - 历史信号回溯按 category + 时间窗口
--
-- ── Post-deployment steps ──────────────────────────────────────────────────
-- 1. wrangler deploy worker (含 INSERT 改造)
-- 2. tsx worker/scripts/backfill-paper-trades-signals-category.ts
-- 3. 验证: SELECT category, COUNT(*) FROM paper_trades WHERE closed_at IS NOT NULL GROUP BY category

ALTER TABLE paper_trades ADD COLUMN category TEXT NOT NULL DEFAULT 'other';
ALTER TABLE signals      ADD COLUMN category TEXT NOT NULL DEFAULT 'other';

CREATE INDEX IF NOT EXISTS idx_paper_trades_category_closed
  ON paper_trades(category, closed_at)
  WHERE closed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_signals_category_created
  ON signals(category, created_at);
