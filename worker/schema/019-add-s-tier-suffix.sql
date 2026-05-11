-- Migration 019: Append ·S suffix to S-tier fund names in fund_configs.
--
-- Background: S-tier ($10K) funds were created without a size suffix.
-- M and L tiers already have ·M / ·L in their name fields (migration 012).
-- This migration aligns S-tier names so all tiers are consistently labeled.
-- The frontend uses fundDisplayName() which now appends ·S dynamically;
-- this migration keeps the DB name field in sync for backend notifications
-- and Telegram reports.
--
-- Execute in D1 Console (Cloudflare Dashboard → D1 → polymarket-signals → Console).

UPDATE fund_configs
SET
  name       = name || '·S',
  updated_at = datetime('now')
WHERE id IN ('cheetah', 'octopus', 'shark', 'gambler', 'turtle');

-- Verify — expected: 猎豹·S / 章鱼·S / 鲨鱼·S / 蜜獾·S / 海龟·S
SELECT id, name, initial_balance FROM fund_configs
WHERE id IN ('cheetah', 'octopus', 'shark', 'gambler', 'turtle')
ORDER BY id;
