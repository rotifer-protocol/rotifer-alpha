import { calcUnrealizedPnl, isStale } from "./price";
import { isUnreasonableLoss } from "./risk-policy";
import { PERFORMANCE_MONITOR_REASON_SQL } from "./trade-semantics";

export const REALIZED_TRADE_STATUSES = [
  "RESOLVED",
  "STOPPED",
  "EXPIRED",
  "PROFIT_TAKEN",
  "TRAILING_STOPPED",
  "REVERSED",
] as const;

export const REALIZED_TRADE_STATUS_SQL = REALIZED_TRADE_STATUSES
  .map(status => `'${status}'`)
  .join(",");

export const PERFORMANCE_REALIZED_TRADE_WHERE_SQL =
  `status IN (${REALIZED_TRADE_STATUS_SQL}) AND ${PERFORMANCE_MONITOR_REASON_SQL}`;

/**
 * D-Lite (2026-05-10): SQL column whitelist for OPEN-trade reads that need
 * mark-to-market. Keep this in sync with OpenTradeWithMark below — every
 * caller that reads OPEN trades for unrealized-PnL calculation MUST include
 * these columns to use calculateOpenPositionStats().
 *
 * Note: select extra columns (id, fund_id, slug, etc.) at the call site;
 * this constant only enumerates the mark-to-market essentials.
 */
export const OPEN_TRADE_MARK_COLUMNS_SQL =
  "market_id, direction, shares, amount, last_price, last_price_updated_at";

/**
 * D-Lite mark-to-market input. last_price and last_price_updated_at come
 * from D1 paper_trades (refreshed every 5 min by price-refresh.ts cron),
 * NOT from per-request fetchPrices() — the silent-skip bug in the old
 * priceLookup path caused 9.7%→6.2%→8.4% jitter and is now retired.
 */
export interface OpenTradeWithMark {
  market_id: string;
  direction: string;
  shares: number;
  amount: number;
  last_price: number | null;
  last_price_updated_at: string | null;
}

export function calculateCashBalance(
  initialBalance: number,
  invested: number,
  realizedPnl: number,
): number {
  return Math.round((initialBalance - invested + realizedPnl) * 100) / 100;
}

export function calculateTotalValue(
  initialBalance: number,
  realizedPnl: number,
  unrealizedPnl: number,
): number {
  return Math.round((initialBalance + realizedPnl + unrealizedPnl) * 100) / 100;
}

export function calculateReturnPct(initialBalance: number, totalValue: number): number {
  if (initialBalance === 0) return 0;
  return ((totalValue - initialBalance) / initialBalance) * 100;
}

export function calculateDrawdownPct(initialBalance: number, totalValue: number): number {
  if (initialBalance === 0) return 0;
  return Math.max(0, (initialBalance - totalValue) / initialBalance);
}

export function calculateCurrentPositionValue(amount: number, unrealizedPnl: number): number {
  return Math.round((amount + unrealizedPnl) * 100) / 100;
}

export interface OpenPositionStatsResult {
  openPositions: number;
  invested: number;
  unrealizedPnl: number;
  /** D-Lite: positions with NULL or stale last_price contributing 0 to unrealized.
   *  Surfaced to UI for transparency (instead of silently inflating numbers). */
  staleCount: number;
}

/**
 * D-Lite mark-to-market: compute unrealized PnL using last_price stored on
 * each trade row. Stale and NULL prices are explicitly counted, NOT silently
 * dropped — the old behavior (`if (typeof price !== "number") continue`)
 * inflated the numerator on API recovery and caused the systemic jitter
 * documented in 2026-05-10 founder D-Lite authorization.
 *
 * Stale-treatment policy:
 *   - Unrealized contribution = 0 for stale rows.
 *   - This is the safest default: it never overstates equity (no inflation),
 *     but downstream callers can warn (UI badge) or skip decisions
 *     (monitor/risk) when staleCount > 0.
 */
export function calculateOpenPositionStats(
  trades: OpenTradeWithMark[],
  nowMs?: number,
): OpenPositionStatsResult {
  let invested = 0;
  let unrealizedPnl = 0;
  let staleCount = 0;

  for (const trade of trades) {
    const amount = Number(trade.amount ?? 0);
    invested += amount;
    const price = trade.last_price;
    const updatedAt = trade.last_price_updated_at;

    if (typeof price !== "number" || isStale(updatedAt, nowMs)) {
      staleCount++;
      continue;
    }
    const u = calcUnrealizedPnl(
      trade.direction,
      Number(trade.shares ?? 0),
      amount,
      price,
    );
    // Track 3 sanity guard (2026-05-10): if computed unrealized PnL implies
    // > SANITY_LOSS_MULTIPLIER × position-size loss, treat as bad mark.
    // Counted as stale (not silently skipped) so UI can surface the warning.
    if (isUnreasonableLoss(u, amount)) {
      staleCount++;
      continue;
    }
    unrealizedPnl += u;
  }

  return {
    openPositions: trades.length,
    invested: Math.round(invested * 100) / 100,
    unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
    staleCount,
  };
}
