-- Micro-evolution tracking — last micro-evolve timestamp per fund
ALTER TABLE fund_configs ADD COLUMN last_micro_evolve_at TEXT;
ALTER TABLE fund_configs ADD COLUMN micro_evolve_count INTEGER DEFAULT 0;
