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
 * Calculate effective position sizing with **dual-semantic** drawdown soft
 * limits (v1.0.5 §1 P8-B, ALPHA-003 D2).
 *
 * Two independent risk guardrails — the more restrictive one wins:
 *
 *  - **peakDrawdown** (from-peak loss, 业界标准 drawdown): the常态保护.
 *    Triggers when a fund retraces from its high-water mark.
 *  - **lossVsInitialDrawdown** (vs initial capital, 绝对兜底): the absolute
 *    safety net. Triggers when a fund's value falls below its starting
 *    balance — defends the "fund never climbed + just bleeds" scenario
 *    that peakDrawdown can miss.
 *
 * Either DD reaching its `*Limit` triggers hard stop (return 0). Either
 * DD reaching its `*SoftLimit` triggers sizing halving.
 *
 * Compatibility (schema 035 transition):
 *   When fund.peakDrawdown* / fund.lossVsInitial* fields are missing
 *   (pre-035 funds), falls back to fund.drawdown* legacy values. Both
 *   guardrails read from the same legacy field, so behavior degrades
 *   gracefully to the old single-semantic protection.
 *
 * @param rawSize Initial position sizing before drawdown adjustment
 * @param peakDrawdown Loss from historical peak equity, ≥ 0
 * @param lossVsInitialDrawdown Loss vs initial capital balance, ≥ 0
 * @param fund Fund config with drawdown threshold parameters
 * @returns 0 (hard stop) | round(rawSize/2) (soft halve) | rawSize (no trigger)
 */
export function effectiveSizing(
  rawSize: number,
  peakDrawdown: number,
  lossVsInitialDrawdown: number,
  fund: FundConfig,
): number {
  // Compatibility: fallback to legacy drawdown_* when new fields missing.
  const peakHardLimit = fund.peakDrawdownLimit     ?? fund.drawdownLimit;
  const peakSoftLimit = fund.peakDrawdownSoftLimit ?? fund.drawdownSoftLimit;
  const lossHardLimit = fund.lossVsInitialLimit     ?? fund.drawdownLimit;
  const lossSoftLimit = fund.lossVsInitialSoftLimit ?? fund.drawdownSoftLimit;

  // Hard stop: either DD exceeds its hard limit → no new positions.
  if (peakDrawdown          >= peakHardLimit) return 0;
  if (lossVsInitialDrawdown >= lossHardLimit) return 0;

  // Soft halve: either DD exceeds its soft limit → sizing × 0.5.
  if (peakDrawdown          >= peakSoftLimit) return Math.round(rawSize * 0.5);
  if (lossVsInitialDrawdown >= lossSoftLimit) return Math.round(rawSize * 0.5);

  return rawSize;
}

/**
 * Look up a fund's peak historical equity from portfolio_snapshots.
 *
 * Returned value is at least `fallback` (typically initialBalance) — protects
 * brand-new funds with no snapshots and against any anomalously low MAX from
 * the table. The caller is also responsible for taking max(returned, currentEquity)
 * to handle the "fund is currently making a new high but no daily snapshot has
 * been written yet" case (snapshots run on a daily cron, not per-trade).
 *
 * Added 2026-05-21 as part of P8 fix (drawdown peak-vs-initial reference bug).
 *
 * @param db D1 database
 * @param fundId Fund ID to look up
 * @param fallback Minimum value returned (typically fund.initialBalance)
 * @returns max(MAX(total_value) FROM portfolio_snapshots WHERE fund_id=?, fallback)
 */
export async function getPeakEquity(
  db: D1Database,
  fundId: string,
  fallback: number,
): Promise<number> {
  const row = await db.prepare(
    "SELECT MAX(total_value) AS peak FROM portfolio_snapshots WHERE fund_id = ?",
  ).bind(fundId).first<{ peak: number | null }>();
  const dbPeak = row?.peak ?? null;
  if (dbPeak === null || !Number.isFinite(dbPeak)) return fallback;
  return Math.max(dbPeak, fallback);
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
