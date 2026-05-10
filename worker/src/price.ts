/**
 * Price Layer — Code Boundary Map
 *
 * PURE COMPUTATION:
 *   - calcUnrealizedPnl()    — direction × shares × price → PnL
 *   - clobMidPrice()         — (best_bid + best_ask) / 2 from book
 *   - isStale()              — last_price_updated_at age > threshold
 *
 * EXTERNAL SIDE EFFECTS:
 *   - Gamma path (legacy + token_id discovery):
 *       fetchCurrentPrice(marketId)  → outcomePrices[0]  (24h MA, deprecated for mark)
 *       fetchPrices(marketIds)       → batched           (kept for legacy callers)
 *       fetchClobTokenIds(marketId)  → clobTokenIds[]    (for D-Lite backfill)
 *   - CLOB path (D-Lite source of truth):
 *       fetchClobPrice(tokenId)      → mid_price         (best_bid+best_ask)/2
 *       fetchClobPrices(tokenIds)    → batched
 *
 * D-Lite design (2026-05-10, founder authorized):
 *   - Cron writes last_price to D1 paper_trades on every 5min refresh.
 *   - All consumers (api.ts, monitor.ts, risk.ts, risk-monitor.ts, index.ts
 *     takeSnapshot, trade.ts paperTrade) read last_price directly from
 *     trade rows — NO per-request fetchPrices() calls.
 *   - Gamma path retained for: (a) lazy backfill of token_id for legacy trades,
 *     (b) signal generation (gene-strategies.ts) which still uses outcomePrices,
 *     (c) emergency fallback during D-Lite migration window.
 *
 * Why CLOB mid_price not Gamma outcomePrices:
 *   Gamma `outcomePrices` is a 24h moving average (presentation-grade, lagged).
 *   CLOB `book` returns real-time (best_bid, best_ask) → mid_price is the
 *   industry-standard fair-value mark (Polymarket frontend, IBKR, Bloomberg).
 *   Using Gamma for mark-to-market caused systematic drift + 9.7%→6.2% jitter.
 */

const PRICE_FETCH_TIMEOUT_MS = 10_000;

/** Stale threshold for D-Lite last_price (10 min). Refresh runs every 5 min;
 *  trades older than this are flagged as stale by callers (UI warning + skip
 *  in monitor/risk decisions to avoid acting on stale data). */
export const PRICE_STALE_THRESHOLD_MS = 10 * 60 * 1000;

/** Max bid-ask spread for clobMidPrice to be considered valid (in price units,
 *  0..1 probability scale). Above this threshold the book has no real liquidity
 *  and the mid is meaningless (e.g. bid=0.01 / ask=0.99 → mid=0.5 placeholder
 *  identical to the old Gamma 24h-MA bug). 2026-05-10 round-2 fix.
 *
 *  Polymarket reality:
 *    - Liquid markets: spread ≤ 0.02 (election binaries near settlement)
 *    - Active markets: spread ≤ 0.05 (normal trading)
 *    - Thin markets:   spread 0.10–0.30 (low-volume long-tail)
 *    - "No book":      spread > 0.30 (one-tick floor + ceiling, garbage mid)
 *  Threshold of 0.10 keeps active+thin markets, rejects the no-book case. */
export const CLOB_MAX_SPREAD = 0.10;

// ─── Gamma path (legacy + token_id discovery) ──────────────

/**
 * @deprecated for mark-to-market — uses 24h MA `outcomePrices[0]`.
 * Retained for: signal generation (gene-strategies.ts) and emergency fallback.
 * D-Lite consumers should read paper_trades.last_price (CLOB mid) instead.
 */
export async function fetchCurrentPrice(marketId: string): Promise<number | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PRICE_FETCH_TIMEOUT_MS);
    const res = await fetch(
      `https://gamma-api.polymarket.com/markets/${marketId}`,
      { signal: controller.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const data: any = await res.json();
    const prices = Array.isArray(data.outcomePrices)
      ? data.outcomePrices
      : typeof data.outcomePrices === "string"
        ? JSON.parse(data.outcomePrices)
        : null;
    if (!prices || prices.length === 0) return null;
    return Number(prices[0]);
  } catch {
    return null;
  }
}

/** @deprecated for mark-to-market — see fetchCurrentPrice. */
export async function fetchPrices(marketIds: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(marketIds)];
  const map = new Map<string, number>();
  const BATCH_SIZE = 10;

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);
    const entries = await Promise.allSettled(
      batch.map(async id => {
        const price = await fetchCurrentPrice(id);
        return [id, price] as const;
      }),
    );
    for (const e of entries) {
      if (e.status === "fulfilled" && e.value[1] !== null) {
        map.set(e.value[0], e.value[1]);
      }
    }
  }

  return map;
}

/**
 * Fetch CLOB token IDs for a market (used to bridge market_id → token_id for
 * lazy backfill of legacy paper_trades rows that pre-date D-Lite).
 * Returns [yes_token_id, no_token_id] or null on failure.
 *
 * Note: Gamma returns clobTokenIds either as JSON-encoded string or array,
 * matching the same dual-encoding pattern as outcomePrices.
 */
export async function fetchClobTokenIds(marketId: string): Promise<string[] | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PRICE_FETCH_TIMEOUT_MS);
    const res = await fetch(
      `https://gamma-api.polymarket.com/markets/${marketId}`,
      { signal: controller.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const data: any = await res.json();
    const ids = Array.isArray(data.clobTokenIds)
      ? data.clobTokenIds
      : typeof data.clobTokenIds === "string"
        ? JSON.parse(data.clobTokenIds)
        : null;
    if (!ids || ids.length === 0) return null;
    return ids.map((id: unknown) => String(id));
  } catch {
    return null;
  }
}

// ─── CLOB path (D-Lite source of truth) ────────────────────

interface ClobBookSide {
  price: string;
  size: string;
}

interface ClobBook {
  bids?: ClobBookSide[];
  asks?: ClobBookSide[];
}

/** IEEE-754 cushion for spread comparison: 0.55 − 0.45 = 0.10000000000000003,
 *  not 0.10. Without ε the boundary case (spread === CLOB_MAX_SPREAD) flips
 *  to "rejected" arbitrarily. 1e-9 is a billion times finer than CLOB's
 *  1e-3 minimum tick, so it widens the accept-band by an undetectable amount
 *  while squashing all realistic float artifacts. */
const SPREAD_FLOAT_EPSILON = 1e-9;

/**
 * Compute mid-price from CLOB order book.
 *
 * CLOB book ordering is not stable across Polymarket responses. In production
 * samples, bids arrived low→high and asks arrived high→low, which made a naïve
 * bids[0]/asks[0] implementation read 0.001/0.999 and reject every book as
 * too wide. Always derive top-of-book from all levels:
 *   best bid = max(bids.price)
 *   best ask = min(asks.price)
 *
 * Returns null when:
 *   - book is one-sided or empty
 *   - bid/ask negative or zero
 *   - crossed book (ask < bid)
 *   - spread > CLOB_MAX_SPREAD (no real liquidity — mid is meaningless)
 *
 * The spread filter (round-2 fix, 2026-05-10) prevents the (0.01 + 0.99) / 2
 * = 0.5 systematic-placeholder bug. When CLOB returns minimum-tick floor +
 * maximum-tick ceiling for a no-liquidity market, naive midpoint produces
 * a counterfeit "fair value" that propagates as bogus PnL through D1.
 */
export function clobMidPrice(book: ClobBook): number | null {
  const bidPrices = (book.bids ?? [])
    .map(side => Number(side.price))
    .filter(price => Number.isFinite(price));
  const askPrices = (book.asks ?? [])
    .map(side => Number(side.price))
    .filter(price => Number.isFinite(price));
  const bestBid = bidPrices.length > 0 ? Math.max(...bidPrices) : NaN;
  const bestAsk = askPrices.length > 0 ? Math.min(...askPrices) : NaN;
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return null;
  if (bestBid <= 0 || bestAsk <= 0) return null;
  if (bestAsk < bestBid) return null;
  if (bestAsk - bestBid > CLOB_MAX_SPREAD + SPREAD_FLOAT_EPSILON) return null;
  return (bestBid + bestAsk) / 2;
}

/**
 * Fetch CLOB mid-price for a single token.
 * Returns null on network failure, empty book, or invalid book state.
 */
export async function fetchClobPrice(tokenId: string): Promise<number | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PRICE_FETCH_TIMEOUT_MS);
    const res = await fetch(
      `https://clob.polymarket.com/book?token_id=${tokenId}`,
      { signal: controller.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const book = await res.json() as ClobBook;
    return clobMidPrice(book);
  } catch {
    return null;
  }
}

/**
 * Batch-fetch CLOB mid-prices for multiple tokens.
 * Concurrency capped at BATCH_SIZE to avoid overwhelming CLOB rate limits.
 * Returns map of token_id → mid_price (failed tokens omitted).
 */
export async function fetchClobPrices(tokenIds: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(tokenIds.filter(Boolean))];
  const map = new Map<string, number>();
  const BATCH_SIZE = 10;

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);
    const entries = await Promise.allSettled(
      batch.map(async id => {
        const price = await fetchClobPrice(id);
        return [id, price] as const;
      }),
    );
    for (const e of entries) {
      if (e.status === "fulfilled" && e.value[1] !== null) {
        map.set(e.value[0], e.value[1]);
      }
    }
  }

  return map;
}

// ─── Pure computation ──────────────────────────────────────

/**
 * Mark-to-market unrealized PnL.
 *
 * BUY_YES:  long YES at entry, profit = (current_price - entry_price) × shares
 *           = shares × current_price - amount
 * SELL_YES: short YES at entry, profit = (entry_price - current_price) × shares
 *           = amount - shares × current_price
 */
export function calcUnrealizedPnl(
  direction: string,
  shares: number,
  amount: number,
  currentPrice: number,
): number {
  return direction === "BUY_YES"
    ? shares * currentPrice - amount
    : amount - shares * currentPrice;
}

/**
 * D-Lite stale check: returns true when last_price_updated_at is missing or
 * older than PRICE_STALE_THRESHOLD_MS. Callers use this to (a) flag UI warning
 * counts, (b) skip stale positions in monitor/risk decisions.
 */
export function isStale(updatedAt: string | null | undefined, nowMs?: number): boolean {
  if (!updatedAt) return true;
  const age = (nowMs ?? Date.now()) - new Date(updatedAt).getTime();
  return age > PRICE_STALE_THRESHOLD_MS;
}
