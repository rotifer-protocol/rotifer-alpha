/**
 * Polymarket Risk — Code Boundary Map
 *
 * PURE COMPUTATION:
 *   - Stop-loss evaluation logic
 *   - Max-hold-days expiry logic
 *   - Drawdown calculation
 *   - effectiveSizing() — position sizing with drawdown adjustment
 *
 * DB SIDE EFFECTS:
 *   - checkRiskLimits() → reads/writes paper_trades (last_price for mark)
 *   - getOpenPositionCount() → reads paper_trades
 *
 * EXTERNAL SIDE EFFECTS (D-Lite, 2026-05-10):
 *   - none — last_price is read from D1 (refreshed every 5min by price-refresh.ts).
 *   - Stale rows are explicitly skipped (no risk action on stale data).
 */
import type { FundConfig, MarketSnapshot, Settlement } from "./types";
import { calcUnrealizedPnl, isStale } from "./price";
import { isUnreasonableLoss } from "./risk-policy";
import { getExecutionMode, recordShadowClose } from "./execution";

export interface RiskCheckResult {
  stopped: Settlement[];
  expired: Settlement[];
}

/**
 * Check stop-loss and time-based exit for all open positions.
 * Called during each cron cycle before opening new trades.
 */
export async function checkRiskLimits(
  db: D1Database,
  funds: FundConfig[],
): Promise<RiskCheckResult> {
  const stopped: Settlement[] = [];
  const expired: Settlement[] = [];
  const now = new Date();
  const ts = now.toISOString();
  const mode = await getExecutionMode(db);

  const openTrades = await db.prepare(
    "SELECT * FROM paper_trades WHERE status = 'OPEN'",
  ).all();
  if (!openTrades.results || openTrades.results.length === 0) {
    return { stopped, expired };
  }

  const nowMs = now.getTime();

  for (const trade of openTrades.results as any[]) {
    const fund = funds.find(f => f.id === trade.fund_id);
    if (!fund) continue;

    const openedAt = new Date(trade.opened_at);
    const holdDays = (now.getTime() - openedAt.getTime()) / (1000 * 60 * 60 * 24);

    // D-Lite: read mark from D1 (refreshed by price-refresh.ts cron).
    const lastPrice = trade.last_price;
    const lastUpdatedAt = trade.last_price_updated_at;
    const stale = typeof lastPrice !== "number" || isStale(lastUpdatedAt, nowMs);

    if (holdDays >= fund.maxHoldDays) {
      // Max-hold is a hard boundary — must close even on stale price.
      // Conservative fallback: use entry_price (PnL=0) when stale to avoid
      // marking a fictitious gain/loss based on stale data.
      let exitPrice = stale ? Number(trade.entry_price) : (lastPrice as number);
      let pnl = calcUnrealizedPnl(trade.direction, trade.shares, trade.amount, exitPrice);
      let usedEntryFallback = stale;
      // Track 3 sanity guard (2026-05-10): if mark implies > 1000% loss,
      // refuse the mark and fall back to entry_price (PnL=0). Catches API
      // placeholder values bleeding past D-Lite + Track 2.
      if (!stale && isUnreasonableLoss(pnl, trade.amount)) {
        exitPrice = Number(trade.entry_price);
        pnl = 0;
        usedEntryFallback = true;
      }
      const closeReason = usedEntryFallback
        ? `Max hold window reached (${fund.maxHoldDays}d) — used entry_price (mark unavailable or unreasonable)`
        : `Max hold window reached (${fund.maxHoldDays}d)`;

      await db.prepare(
        "UPDATE paper_trades SET status = 'EXPIRED', exit_price = ?, pnl = ?, closed_at = ?, monitor_reason = ? WHERE id = ?",
      ).bind(exitPrice, pnl, ts, closeReason, trade.id).run();

      if (mode === "shadow") {
        await recordShadowClose(db, trade.id, trade.fund_id, trade.market_id, trade.slug ?? "", trade.question, trade.direction, exitPrice, trade.shares, pnl);
      }

      expired.push({
        tradeId: trade.id,
        marketId: trade.market_id,
        fundId: trade.fund_id,
        fundEmoji: fund.emoji,
        slug: trade.slug ?? "",
        question: trade.question,
        pnl,
        direction: trade.direction,
        entryPrice: trade.entry_price,
        exitPrice,
        status: "EXPIRED",
      });
      continue;
    }

    // Stop-loss is NOT a hard boundary — safe to defer until next refresh.
    if (stale) continue;
    const currentPrice = lastPrice as number;

    const unrealizedPnl = calcUnrealizedPnl(trade.direction, trade.shares, trade.amount, currentPrice);
    // Track 3 sanity guard: skip stop-loss on implausible mark (defer
    // decision until next refresh, when CLOB may have stabilized).
    if (isUnreasonableLoss(unrealizedPnl, trade.amount)) continue;
    const lossPct = -unrealizedPnl / trade.amount;

    if (lossPct >= fund.stopLossPercent) {
      const closeReason = `Stop loss triggered at ${(lossPct * 100).toFixed(1)}% (threshold ${(fund.stopLossPercent * 100).toFixed(1)}%)`;
      await db.prepare(
        "UPDATE paper_trades SET status = 'STOPPED', exit_price = ?, pnl = ?, closed_at = ?, monitor_reason = ? WHERE id = ?",
      ).bind(currentPrice, unrealizedPnl, ts, closeReason, trade.id).run();

      if (mode === "shadow") {
        await recordShadowClose(db, trade.id, trade.fund_id, trade.market_id, trade.slug ?? "", trade.question, trade.direction, currentPrice, trade.shares, unrealizedPnl);
      }

      stopped.push({
        tradeId: trade.id,
        marketId: trade.market_id,
        fundId: trade.fund_id,
        fundEmoji: fund.emoji,
        slug: trade.slug ?? "",
        question: trade.question,
        pnl: unrealizedPnl,
        direction: trade.direction,
        entryPrice: trade.entry_price,
        exitPrice: currentPrice,
        status: "STOPPED",
      });
    }
  }

  return { stopped, expired };
}

/**
 * Calculate effective position sizing with drawdown soft limit.
 * When drawdown is between softLimit and hardLimit, sizing is halved.
 */
export function effectiveSizing(
  rawSize: number,
  currentDrawdown: number,
  fund: FundConfig,
): number {
  if (currentDrawdown >= fund.drawdownLimit) return 0;
  if (currentDrawdown >= fund.drawdownSoftLimit) return Math.round(rawSize * 0.5);
  return rawSize;
}

/**
 * Lightweight piggyback risk check — re-evaluates stop-loss for a fund's
 * open positions when users view the fund page. D-Lite: reads last_price
 * from D1 directly (no per-request fetchPrices); stale rows are skipped.
 *
 * Signature changed 2026-05-10 (D-Lite): priceMap parameter removed.
 */
export async function piggybackRiskCheck(
  db: D1Database,
  fundId: string,
  fund: FundConfig,
): Promise<Settlement[]> {
  const stopped: Settlement[] = [];
  const now = new Date();
  const nowMs = now.getTime();
  const ts = now.toISOString();
  const mode = await getExecutionMode(db);

  const openTrades = await db.prepare(
    "SELECT * FROM paper_trades WHERE fund_id = ? AND status = 'OPEN'",
  ).bind(fundId).all();
  if (!openTrades.results || openTrades.results.length === 0) return stopped;

  for (const trade of openTrades.results as any[]) {
    const lastPrice = trade.last_price;
    if (typeof lastPrice !== "number" || isStale(trade.last_price_updated_at, nowMs)) {
      continue;
    }
    const currentPrice = lastPrice;

    const unrealizedPnl = calcUnrealizedPnl(trade.direction, trade.shares, trade.amount, currentPrice);
    // Track 3 sanity guard: defer stop-loss decision on implausible mark.
    if (isUnreasonableLoss(unrealizedPnl, trade.amount)) continue;
    const lossPct = -unrealizedPnl / trade.amount;

    if (lossPct >= fund.stopLossPercent) {
      const closeReason = `Stop loss triggered at ${(lossPct * 100).toFixed(1)}% (threshold ${(fund.stopLossPercent * 100).toFixed(1)}%)`;
      await db.prepare(
        "UPDATE paper_trades SET status = 'STOPPED', exit_price = ?, pnl = ?, closed_at = ?, monitor_reason = ? WHERE id = ?",
      ).bind(currentPrice, unrealizedPnl, ts, closeReason, trade.id).run();

      if (mode === "shadow") {
        await recordShadowClose(db, trade.id, trade.fund_id, trade.market_id, trade.slug ?? "", trade.question, trade.direction, currentPrice, trade.shares, unrealizedPnl);
      }

      stopped.push({
        tradeId: trade.id,
        marketId: trade.market_id,
        fundId: trade.fund_id,
        fundEmoji: fund.emoji,
        slug: trade.slug ?? "",
        question: trade.question,
        pnl: unrealizedPnl,
        direction: trade.direction,
        entryPrice: trade.entry_price,
        exitPrice: currentPrice,
        status: "STOPPED",
      });
    }
  }

  return stopped;
}

/**
 * Check if a fund has too many open positions.
 */
export async function getOpenPositionCount(
  db: D1Database,
  fundId: string,
): Promise<number> {
  const r = await db.prepare(
    "SELECT COUNT(*) as cnt FROM paper_trades WHERE fund_id = ? AND status = 'OPEN'",
  ).bind(fundId).first<{ cnt: number }>();
  return r?.cnt ?? 0;
}
