-- ============================================================
-- Phase 3.5+ Schema Migration 010
-- 2026-05-04 — 海龟参数修正 + 机构型基金接入
-- ============================================================
-- 来源：rotifer-alpha 创始人 review 发现两个产品级问题：
--   1. 海龟基金从未下单 → 参数过严（minVolume=20000 + allowedTypes=["MISPRICING"] 共同导致）
--   2. 现有 5 基金均为 $10K 起始资金 → 无法测试产品在大资金量级下的承载能力
--
-- 决策：见内部 plan "海龟基金诊断" + "机构型基金（先犯错后修正）" 章节（private）
--
-- 影响：
--   - turtle 行参数被 UPDATE（保留 created_at + generation + parent_id 等历史字段）
--   - INSERT 两条新机构基金行（beluga $100K + leviathan $1M）
--   - 这两个新基金标 evolveExempt（在 evolve.ts.runEvolution 里被排除 PBT mutate）
-- ============================================================

-- ─── Part 1: 海龟参数放宽（避免"僵尸基金"）──────────────
-- 修改前：minVolume=20000, minLiquidity=10000, allowedTypes=["MISPRICING"], minEdge=2
-- 修改后：minVolume=10000（仍是 5 小基金中最高），allowedTypes 加 MULTI_OUTCOME_ARB，minEdge=1.5

UPDATE fund_configs SET
  allowed_types = '["MISPRICING","MULTI_OUTCOME_ARB"]',
  min_edge = 1.5,
  min_volume = 10000,
  updated_at = datetime('now')
WHERE id = 'turtle';

-- ─── Part 2: INSERT Beluga 白鲸 ($100K 机构型，evolveExempt) ──

INSERT OR IGNORE INTO fund_configs (
  id, name, emoji, motto,
  initial_balance, monthly_target, drawdown_limit, drawdown_soft_limit,
  allowed_types,
  min_edge, min_confidence, min_volume, min_liquidity,
  max_per_event, max_open_positions,
  stop_loss_percent, max_hold_days,
  sizing_mode, sizing_base, sizing_scale,
  take_profit_percent, trailing_stop_percent, prob_reversal_threshold,
  generation, parent_id, created_at, updated_at
) VALUES (
  'beluga', '白鲸', '🐋', '稳健，只吃大机会',
  100000, 0.04, 0.15, 0.08,
  '["MISPRICING","MULTI_OUTCOME_ARB"]',
  1.5, 0.4, 30000, 20000,
  8000, 8,
  0.10, 14,
  'edge', 2000, 4000,
  0.20, 0.10, 0.20,
  0, NULL, datetime('now'), datetime('now')
);

-- ─── Part 3: INSERT Leviathan 巨兽 ($1M 机构型，evolveExempt) ──

INSERT OR IGNORE INTO fund_configs (
  id, name, emoji, motto,
  initial_balance, monthly_target, drawdown_limit, drawdown_soft_limit,
  allowed_types,
  min_edge, min_confidence, min_volume, min_liquidity,
  max_per_event, max_open_positions,
  stop_loss_percent, max_hold_days,
  sizing_mode, sizing_base, sizing_scale,
  take_profit_percent, trailing_stop_percent, prob_reversal_threshold,
  generation, parent_id, created_at, updated_at
) VALUES (
  'leviathan', '巨兽', '🦑', '流动性策略家',
  1000000, 0.05, 0.20, 0.10,
  '["MISPRICING","MULTI_OUTCOME_ARB","SPREAD"]',
  1.5, 0.3, 100000, 50000,
  50000, 5,
  0.12, 21,
  'confidence', 10000, 30000,
  0.30, 0.15, 0.20,
  0, NULL, datetime('now'), datetime('now')
);

-- ─── 验证查询 ──────────────────────────────────
-- 执行后用以下查询确认：
--
-- SELECT id, name, initial_balance, allowed_types, min_volume, min_edge
-- FROM fund_configs ORDER BY initial_balance DESC;
--
-- 预期结果（按资金量降序）：
--   leviathan | 巨兽 | 1000000 | ["MISPRICING","MULTI_OUTCOME_ARB","SPREAD"] | 100000 | 1.5
--   beluga    | 白鲸 | 100000  | ["MISPRICING","MULTI_OUTCOME_ARB"]          | 30000  | 1.5
--   turtle    | 海龟 | 10000   | ["MISPRICING","MULTI_OUTCOME_ARB"]          | 10000  | 1.5
--   cheetah   | 猎豹 | 10000   | ["MISPRICING","MULTI_OUTCOME_ARB"]          | 5000   | 1
--   octopus   | 章鱼 | 10000   | ["MISPRICING","SPREAD"]                     | 5000   | 0
--   shark     | 鲨鱼 | 10000   | ["MISPRICING","MULTI_OUTCOME_ARB","SPREAD"] | 3000   | 0.5
--   gambler   | 蜜獾 | 10000   | ["MISPRICING","MULTI_OUTCOME_ARB","SPREAD"] | 1000   | 0
