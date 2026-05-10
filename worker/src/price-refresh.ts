/**
 * D-Lite Price Refresher — Code Boundary Map
 *
 * PURE COMPUTATION:
 *   - none (orchestration layer)
 *
 * DB SIDE EFFECTS:
 *   - reads paper_trades (OPEN positions: id, market_id, token_id)
 *   - writes paper_trades.token_id (lazy backfill for legacy rows)
 *   - writes paper_trades.last_price + last_price_updated_at (mark-to-market)
 *
 * EXTERNAL SIDE EFFECTS:
 *   - fetchClobTokenIds() → Gamma API (only for backfill of missing token_id)
 *   - fetchClobPrices()   → CLOB book API (mid_price source of truth)
 *
 * Cron integration (index.ts scheduled handler):
 *   refreshOpenPrices() runs as Phase A on every 5min cron BEFORE
 *   risk/monitor/scan/trade phases — guaranteeing all downstream decisions
 *   use the freshest mark prices.
 *
 * Backfill strategy (lazy):
 *   Legacy rows (pre-D-Lite migration 017) have token_id = NULL.
 *   Each cron tick: discover NULL rows → fetch token_ids → UPDATE.
 *   New rows (post-D-Lite, written by trade.ts paperTrade) populate
 *   token_id at INSERT time, so backfill load amortizes to zero quickly.
 *
 * Source: 2026-05-10 founder authorization (D-Lite, Q1=a one-shot, Q2=a accept reval).
 */
import { fetchClobPrices, fetchClobTokenIds } from "./price";

export interface PriceRefreshResult {
  /** OPEN trades discovered at the start of this refresh cycle */
  totalOpen: number;
  /** Trades with missing token_id at start (legacy rows from pre-D-Lite) */
  missingTokenId: number;
  /** Token IDs successfully backfilled this cycle (Gamma success) */
  backfilledTokenIds: number;
  /** Trades successfully updated with last_price (CLOB success) */
  refreshed: number;
  /** Trades whose CLOB fetch failed this cycle (rolled-over staleness) */
  fetchFailed: number;
  /** ISO timestamp of refresh start */
  startedAt: string;
  /** Wall-clock duration in milliseconds */
  durationMs: number;
}

interface OpenTradeRow {
  id: string;
  market_id: string;
  token_id: string | null;
}

/**
 * Single-cycle price refresh. Idempotent — safe to call repeatedly; partial
 * failures (CLOB unreachable for a subset) leave older last_price intact and
 * just don't bump last_price_updated_at, letting stale detection fire later.
 *
 * D1 batch limits: each batch is capped at BATCH_WRITE_LIMIT statements
 * (Cloudflare D1 hard cap = 100). A single OPEN-trade UPDATE is one statement,
 * so we chunk the writes if there are >BATCH_WRITE_LIMIT positions.
 */
const BATCH_WRITE_LIMIT = 50;

export async function refreshOpenPrices(db: D1Database): Promise<PriceRefreshResult> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  const result: PriceRefreshResult = {
    totalOpen: 0,
    missingTokenId: 0,
    backfilledTokenIds: 0,
    refreshed: 0,
    fetchFailed: 0,
    startedAt,
    durationMs: 0,
  };

  // ─── Step 1: load all OPEN trades ────────────────────────
  const openResult = await db.prepare(
    "SELECT id, market_id, token_id FROM paper_trades WHERE status = 'OPEN'",
  ).all<OpenTradeRow>();
  const trades = openResult.results ?? [];
  result.totalOpen = trades.length;
  if (trades.length === 0) {
    result.durationMs = Date.now() - startMs;
    return result;
  }

  // ─── Step 2: lazy backfill token_id for legacy rows ──────
  const needsBackfill = trades.filter(t => !t.token_id);
  result.missingTokenId = needsBackfill.length;

  if (needsBackfill.length > 0) {
    // Group by market_id (multiple trades on same market share token_id)
    const uniqueMarkets = [...new Set(needsBackfill.map(t => t.market_id))];
    const marketToTokenId = new Map<string, string>();

    // Fetch in parallel with allSettled — partial failures don't block others
    const tokenResults = await Promise.allSettled(
      uniqueMarkets.map(async mid => {
        const ids = await fetchClobTokenIds(mid);
        return { marketId: mid, tokenId: ids?.[0] ?? null };
      }),
    );
    for (const r of tokenResults) {
      if (r.status === "fulfilled" && r.value.tokenId) {
        marketToTokenId.set(r.value.marketId, r.value.tokenId);
      }
    }

    // Write back to D1 (batched to respect 50-statement cap)
    const backfillStmts: D1PreparedStatement[] = [];
    for (const t of needsBackfill) {
      const tokenId = marketToTokenId.get(t.market_id);
      if (!tokenId) continue;
      backfillStmts.push(
        db.prepare("UPDATE paper_trades SET token_id = ? WHERE id = ?")
          .bind(tokenId, t.id),
      );
      // Mutate in-memory representation so Step 3 sees the new token_id
      t.token_id = tokenId;
      result.backfilledTokenIds++;
    }
    if (backfillStmts.length > 0) {
      await runBatched(db, backfillStmts);
    }
  }

  // ─── Step 3: batch fetch CLOB mid-prices ─────────────────
  const tokenIds = trades
    .map(t => t.token_id)
    .filter((id): id is string => Boolean(id));
  const uniqueTokenIds = [...new Set(tokenIds)];
  const priceMap = uniqueTokenIds.length > 0
    ? await fetchClobPrices(uniqueTokenIds)
    : new Map<string, number>();

  // ─── Step 4: write last_price + last_price_updated_at ────
  const refreshTs = new Date().toISOString();
  const updateStmts: D1PreparedStatement[] = [];
  for (const t of trades) {
    if (!t.token_id) {
      result.fetchFailed++;
      continue;
    }
    const price = priceMap.get(t.token_id);
    if (price === undefined) {
      result.fetchFailed++;
      continue;
    }
    updateStmts.push(
      db.prepare(
        "UPDATE paper_trades SET last_price = ?, last_price_updated_at = ? WHERE id = ?",
      ).bind(price, refreshTs, t.id),
    );
    result.refreshed++;
  }
  if (updateStmts.length > 0) {
    await runBatched(db, updateStmts);
  }

  result.durationMs = Date.now() - startMs;
  return result;
}

/**
 * Chunk a list of D1 prepared statements into batches respecting the
 * Cloudflare D1 100-statement-per-batch hard cap.
 */
async function runBatched(
  db: D1Database,
  stmts: D1PreparedStatement[],
): Promise<void> {
  for (let i = 0; i < stmts.length; i += BATCH_WRITE_LIMIT) {
    const chunk = stmts.slice(i, i + BATCH_WRITE_LIMIT);
    await db.batch(chunk);
  }
}
