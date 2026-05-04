-- ADR-274 D7: Insert 10 new funds (medium + large tiers) for the 3×5 matrix.
-- Execute each statement individually in D1 Console.
-- Small tier (5 existing funds) remains unchanged.

-- ─── Medium tier ($100K) ──────────────────────────────────────────────────

-- Statement 1: turtle_m
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
  'turtle_m', '海龟·M', '🐢', '少即是多，确定性高于一切',
  100000, 0.03, 0.10, 0.05,
  '["MISPRICING","MULTI_OUTCOME_ARB"]',
  1.5, 0.5, 50000, 30000,
  2000, 5,
  0.05, 7,
  'fixed', 2000, 0,
  0.15, 0.08, 0.15,
  0, NULL, datetime('now'), datetime('now')
);

-- Statement 2: cheetah_m
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
  'cheetah_m', '猎豹·M', '🐆', '机会属于敢于出手的人',
  100000, 0.08, 0.20, 0.10,
  '["MISPRICING","MULTI_OUTCOME_ARB"]',
  1, 0.2, 20000, 15000,
  8000, 10,
  0.15, 14,
  'confidence', 1000, 3000,
  0.30, 0.12, 0.20,
  0, NULL, datetime('now'), datetime('now')
);

-- Statement 3: octopus_m
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
  'octopus_m', '章鱼·M', '🐙', '用数据说话，让公式决策',
  100000, 0.05, 0.15, 0.08,
  '["MISPRICING","SPREAD"]',
  0, 0, 20000, 15000,
  6000, 8,
  0.10, 10,
  'edge', 1000, 3000,
  0.25, 0.10, 0.15,
  0, NULL, datetime('now'), datetime('now')
);

-- Statement 4: shark_m
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
  'shark_m', '鲨鱼·M', '🦈', '大胆出击，快速收割',
  100000, 0.15, 0.30, 0.15,
  '["MISPRICING","MULTI_OUTCOME_ARB","SPREAD"]',
  0.5, 0.1, 15000, 10000,
  15000, 15,
  0.20, 21,
  'confidence', 1500, 5000,
  0.50, 0.18, 0.25,
  0, NULL, datetime('now'), datetime('now')
);

-- Statement 5: gambler_m
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
  'gambler_m', '蜜獾·M', '🎲', '无所畏惧，绝不退让',
  100000, 0.30, 0.50, 0.25,
  '["MISPRICING","MULTI_OUTCOME_ARB","SPREAD"]',
  0, 0, 5000, 5000,
  30000, 20,
  0.30, 30,
  'edge_confidence', 1000, 2000,
  1.00, 0.25, 0.30,
  0, NULL, datetime('now'), datetime('now')
);

-- ─── Large tier ($1M) ──────────────────────────────────────────────────────

-- Statement 6: turtle_l
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
  'turtle_l', '海龟·L', '🐢', '少即是多，确定性高于一切',
  1000000, 0.03, 0.10, 0.05,
  '["MISPRICING","MULTI_OUTCOME_ARB"]',
  1.5, 0.5, 150000, 100000,
  20000, 5,
  0.05, 7,
  'fixed', 20000, 0,
  0.15, 0.08, 0.15,
  0, NULL, datetime('now'), datetime('now')
);

-- Statement 7: cheetah_l
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
  'cheetah_l', '猎豹·L', '🐆', '机会属于敢于出手的人',
  1000000, 0.08, 0.20, 0.10,
  '["MISPRICING","MULTI_OUTCOME_ARB"]',
  1, 0.2, 80000, 60000,
  80000, 10,
  0.15, 14,
  'confidence', 10000, 30000,
  0.30, 0.12, 0.20,
  0, NULL, datetime('now'), datetime('now')
);

-- Statement 8: octopus_l
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
  'octopus_l', '章鱼·L', '🐙', '用数据说话，让公式决策',
  1000000, 0.05, 0.15, 0.08,
  '["MISPRICING","SPREAD"]',
  0, 0, 80000, 60000,
  60000, 8,
  0.10, 10,
  'edge', 10000, 30000,
  0.25, 0.10, 0.15,
  0, NULL, datetime('now'), datetime('now')
);

-- Statement 9: shark_l
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
  'shark_l', '鲨鱼·L', '🦈', '大胆出击，快速收割',
  1000000, 0.15, 0.30, 0.15,
  '["MISPRICING","MULTI_OUTCOME_ARB","SPREAD"]',
  0.5, 0.1, 50000, 40000,
  100000, 15,
  0.20, 21,
  'confidence', 15000, 50000,
  0.50, 0.18, 0.25,
  0, NULL, datetime('now'), datetime('now')
);

-- Statement 10: gambler_l
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
  'gambler_l', '蜜獾·L', '🎲', '无所畏惧，绝不退让',
  1000000, 0.30, 0.50, 0.25,
  '["MISPRICING","MULTI_OUTCOME_ARB","SPREAD"]',
  0, 0, 20000, 15000,
  200000, 20,
  0.30, 30,
  'edge_confidence', 10000, 20000,
  1.00, 0.25, 0.30,
  0, NULL, datetime('now'), datetime('now')
);

-- Statement 11: Verify — should now show 15 funds
SELECT id, name, initial_balance FROM fund_configs ORDER BY initial_balance, id;
