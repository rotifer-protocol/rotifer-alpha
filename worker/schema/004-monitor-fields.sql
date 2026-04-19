-- Active trading support — high water mark tracking + close reason
ALTER TABLE paper_trades ADD COLUMN high_water_mark REAL;
ALTER TABLE paper_trades ADD COLUMN monitor_reason TEXT;

-- Store the 3 new evolvable params in fund_configs
ALTER TABLE fund_configs ADD COLUMN take_profit_percent REAL DEFAULT 0.25;
ALTER TABLE fund_configs ADD COLUMN trailing_stop_percent REAL DEFAULT 0.10;
ALTER TABLE fund_configs ADD COLUMN prob_reversal_threshold REAL DEFAULT 0.15;
