-- 032: Rename petri_score column to alpha_score
--
-- Context: 2026-05-20 命名收敛圆桌（Alpha Score 三层叙事终态决议）
--   Petri Score (原命名)
--     → PBT Rank Score (2026-05-20 14:00 中间过渡名)
--     → Alpha Score (2026-05-20 20:00 终态名，与 rotifer-alpha 产品品牌一致)
--
-- Boundary: Alpha Score 是 rotifer-alpha 产品的本地 PBT 评估指标，
--   ≠ Rotifer Protocol 协议层 F(g) fitness function（ADR-117 三维独立原则）。
--
-- Migration: Cloudflare D1 (SQLite 3.45+) 支持 ALTER TABLE RENAME COLUMN。
-- 零数据丢失：仅列名变更，所有 petri_score 数据自动保留为 alpha_score。
--
-- 历史 migration 007/009 中的 `petri_score` 引用保留不改（archived SQL 档案）。
-- 应用层代码（worker/src/*.ts + worker/tests/*.ts + site/src/*）已全部 rename。

ALTER TABLE gene_variants RENAME COLUMN petri_score TO alpha_score;
ALTER TABLE gene_evolution_log RENAME COLUMN petri_score TO alpha_score;
