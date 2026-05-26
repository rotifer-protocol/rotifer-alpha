-- 038-portfolio-coordinator-skips.sql
--
-- v1.0 follow-up: 持久化 Portfolio Coordinator 拦截事件，解 C1.3 verify gap
-- 关联: v1.0 plan C1.3 + ALPHA-PRD-001 C1.3 / Phase 2 启动 Gate
-- Spec: 直接 implement，无独立 spec doc（模式同 schema 037）
--
-- ── Background ─────────────────────────────────────────────────────────────
-- 2026-05-23 wrangler 实测发现 C1.3 ("Portfolio Coordinator 误报率 < 1%")
-- 无法 SQL verify:
--   - `PORTFOLIO_CONCENTRATION` skip in trade.ts:478 仅 in-memory skipReasons
--   - 通过 /api/heartbeat 暴露聚合但不持久化
--   - 无历史 audit trail
--
-- Phase 1 Exit 已 dashboard "PHASE 1 已通过" badge 推断 allClear；但 Phase 2
-- 跑 live 后需要持续监控误报率 + 启发式 ground truth label。
--
-- ── Strategy ───────────────────────────────────────────────────────────────
-- 1. 新建表 portfolio_coordinator_skips: 一行 = 一次拦截事件
-- 2. trade.ts 在 PORTFOLIO_CONCENTRATION skip 后 INSERT (try/catch graceful)
-- 3. 索引 (fund_id, attempted_at) + (event_family_id, attempted_at) 支持监控查询
-- 4. 部分索引 was_likely_safe IS NULL 加速未判定事件查询（批量 label 用）
--
-- ── Ground truth label 设计 ───────────────────────────────────────────────
-- was_likely_safe 字段 NULL by default，由后台批量任务/手动启发式 UPDATE:
--   heuristic_v1: 拦截 24h 内同 event_family 被其他 fund 成功开仓且最终盈利
--                 → was_likely_safe = 1 (拦截可能误报)
--                 否则 was_likely_safe = 0 (拦截正确)
-- 启发式实施留 follow-up，schema 仅提供存储 + label_method 区分判定来源
--
-- ── Backfill ──────────────────────────────────────────────────────────────
-- 不 backfill 历史拦截 — schema 部署前的拦截事件无法恢复（仅 heartbeat 聚合保留）。
-- 从 schema 部署后开始记录新事件，约 2 周后可累计 100+ 拦截事件可观察。

CREATE TABLE IF NOT EXISTS portfolio_coordinator_skips (
  id                      TEXT PRIMARY KEY,
  fund_id                 TEXT NOT NULL,
  signal_id               TEXT NOT NULL,
  event_family_id         TEXT NOT NULL,
  attempted_at            TEXT NOT NULL,
  -- 拦截时上下文
  current_exposure_usdc   REAL NOT NULL,
  attempted_amount_usdc   REAL NOT NULL,
  portfolio_limit_usdc    REAL NOT NULL,
  execution_mode          TEXT NOT NULL,
  -- Ground truth (post-hoc fillable)
  was_likely_safe         INTEGER,     -- 0=correct intercept / 1=likely false positive / NULL=未判定
  label_method            TEXT,        -- 'heuristic_v1' / 'manual' / NULL
  label_at                TEXT
);

CREATE INDEX IF NOT EXISTS idx_pcs_fund_attempted
  ON portfolio_coordinator_skips(fund_id, attempted_at);

CREATE INDEX IF NOT EXISTS idx_pcs_family_attempted
  ON portfolio_coordinator_skips(event_family_id, attempted_at);

CREATE INDEX IF NOT EXISTS idx_pcs_unlabeled
  ON portfolio_coordinator_skips(attempted_at)
  WHERE was_likely_safe IS NULL;

-- ── Verify C1.3 误报率 SQL (post-deployment) ─────────────────────────────
-- SELECT
--   COUNT(*) AS total_intercepts,
--   COUNT(CASE WHEN was_likely_safe = 1 THEN 1 END) AS likely_false_positive,
--   ROUND(100.0 * COUNT(CASE WHEN was_likely_safe = 1 THEN 1 END) /
--         NULLIF(COUNT(CASE WHEN was_likely_safe IS NOT NULL THEN 1 END), 0), 2) AS false_positive_rate
-- FROM portfolio_coordinator_skips
-- WHERE attempted_at > date('now', '-14 days');
-- C1.3 验收: false_positive_rate < 1%
