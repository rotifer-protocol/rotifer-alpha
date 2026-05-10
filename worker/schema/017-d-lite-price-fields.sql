-- D-Lite (ADR-273 path-A enhancement): mark-to-market via D1.last_price
--
-- Replaces per-request Gamma API fetchPrices to eliminate price-fetch jitter
-- that caused 9.7% → 6.2% → 8.4% total return swings (Gamma 24h MA + silent
-- fallback in accounting.ts:77 dropping failed positions to 0 unrealized).
--
-- Architecture:
--   Cron (every 5 min) → CLOB book API → mid_price → UPDATE paper_trades
--   API path             → SELECT last_price from D1                 (no Gamma)
--   Decision path (monitor/risk) → SELECT last_price from D1         (no Gamma)
--
-- Lazy backfill: token_id is filled by cron on first refresh for existing
-- OPEN trades; new trades populate token_id at INSERT time (trade.ts).
--
-- Source: 2026-05-10 founder authorization (Q1=a one-shot 8h work,
-- Q2=a accept CLOB mid one-time revaluation, golden pyramid testing required)

-- CLOB clobTokenIds[0] (YES outcome) — required to query CLOB book API
ALTER TABLE paper_trades ADD COLUMN token_id TEXT;

-- Last known mid-price from CLOB: (best_bid + best_ask) / 2
ALTER TABLE paper_trades ADD COLUMN last_price REAL;

-- ISO timestamp of last successful refresh; staleness measured against this
ALTER TABLE paper_trades ADD COLUMN last_price_updated_at TEXT;

-- Stale-detection / backfill query optimization
CREATE INDEX IF NOT EXISTS idx_open_last_price_age
  ON paper_trades(status, last_price_updated_at);

-- Backfill helper: tracks OPEN trades still missing token_id
CREATE INDEX IF NOT EXISTS idx_open_missing_token
  ON paper_trades(status, token_id)
  WHERE status = 'OPEN' AND token_id IS NULL;
