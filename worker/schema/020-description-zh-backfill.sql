-- Migration 020: Backfill description_zh for all variant types seeded after migration 008.
--
-- Migration 008 added the description_zh column and set values only for the 6 original
-- v1-baseline variants. Subsequent migrations (009, 014, 015) introduced new variant
-- types without Chinese descriptions. This migration covers:
--   1. polymarket-micro-evolver:v1-baseline — recreated by migration 015 without description_zh
--   2. All challenger variants seeded in 009 and 014 (trend-following, adaptive,
--      conservative, high-edge, aggressive)
--   3. Any PBT-generated descendant generations that share the same English description
--      template as their seeded ancestor.

-- ── Micro-evolver: Gradient baseline ─────────────────────────────────────────
UPDATE gene_variants
SET description_zh = '基于梯度的微进化，±2% 参数边界'
WHERE description = 'Gradient-based micro-evolution with ±2% parameter bounds'
  AND description_zh IS NULL;

-- ── Micro-evolver: Aggressive challenger ─────────────────────────────────────
UPDATE gene_variants
SET description_zh = '激进微进化器：4% 参数调整率，15 笔交易触发阈值，适应速度更快'
WHERE description LIKE 'Aggressive micro-evolver%'
  AND description_zh IS NULL;

-- ── Risk: Conservative challenger ────────────────────────────────────────────
UPDATE gene_variants
SET description_zh = '保守风控：止损和最大持仓阈值收紧至 0.8×，更快止损'
WHERE description LIKE 'Conservative risk%'
  AND description_zh IS NULL;

-- ── Trader: High-edge challenger ─────────────────────────────────────────────
UPDATE gene_variants
SET description_zh = '高边缘交易器：要求边缘值 ≥ 2× 基金最小边缘，减少交易次数，提升确信度'
WHERE description LIKE 'High-edge trader%'
  AND description_zh IS NULL;

-- ── Trader: Edge-ranked baseline (new PBT generations) ───────────────────────
UPDATE gene_variants
SET description_zh = '基于边缘排序的信号分配与仓位管理'
WHERE description = 'Edge-ranked signal allocation with position sizing'
  AND description_zh IS NULL;

-- ── Scanner: Trend-following challenger ──────────────────────────────────────
UPDATE gene_variants
SET description_zh = '趋势跟踪扫描器：过滤 SPREAD 信号，结合成交量对齐提升 MISPRICING，置信度下限 0.35，成交量要求 1.5×'
WHERE description LIKE 'Trend-following scanner%'
  AND description_zh IS NULL;

-- ── Monitor: Adaptive challenger ─────────────────────────────────────────────
UPDATE gene_variants
SET description_zh = '自适应监控器：对年轻持仓（< 3 天）放宽止损，随收益增加收紧追踪止损（trailingTightenFactor=0.5）'
WHERE description LIKE 'Adaptive monitor%'
  AND description_zh IS NULL;

-- ── Monitor: LLM-config challenger ───────────────────────────────────────────
UPDATE gene_variants
SET description_zh = '对新持仓更加保守，允许盈利持续奔跑，采用 LLM 驱动的参数配置'
WHERE description LIKE 'More cautious with new positions%'
  AND description_zh IS NULL;
