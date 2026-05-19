/**
 * Polymarket Monitor — Code Boundary Map
 *
 * PURE COMPUTATION:
 *   - Take-profit threshold check
 *   - Trailing stop (high-water-mark regression) check
 *   - Probability reversal detection
 *   - calcUnrealizedPnl() — imported, pure arithmetic
 *
 * DB SIDE EFFECTS:
 *   - monitor() → reads paper_trades (incl. last_price for mark-to-market)
 *   - executeMonitorActions() → writes paper_trades (status update, pnl recording)
 *
 * EXTERNAL SIDE EFFECTS (D-Lite, 2026-05-10):
 *   - none — last_price is read from D1 (refreshed every 5min by price-refresh.ts).
 *   - Stale rows are explicitly skipped (no decision on stale data).
 */
import type { FundConfig, TradeStatus } from "./types";
import { calcUnrealizedPnl, isStale } from "./price";
import { isUnreasonableLoss } from "./risk-policy";
import { getExecutionMode, recordShadowClose } from "./execution";
import { settleShadowOrderForTrade } from "./order-lifecycle";
import { recordCircuitBreakerLoss } from "./circuit-breaker";

export interface MonitorAction {
  tradeId: string;
  fundId: string;
  marketId: string;
  slug: string;
  question: string;
  direction: string;
  shares: number;
  newStatus: TradeStatus;
  pnl: number;
  reason: string;
  currentPrice: number;
  entryPrice: number;
}

export interface MonitorResult {
  actions: MonitorAction[];
  highWaterMarkUpdates: Array<{ tradeId: string; hwm: number }>;
}

interface OpenTrade {
  id: string;
  fund_id: string;
  market_id: string;
  question: string;
  direction: string;
  entry_price: number;
  shares: number;
  amount: number;
  high_water_mark: number | null;
  slug: string;
  /** D-Lite mark-to-market source (refreshed by price-refresh.ts cron) */
  last_price: number | null;
  last_price_updated_at: string | null;
}

export interface MonitorOptions {
  adaptiveMode?: boolean;
  youngPositionDays?: number;
  trailingTightenFactor?: number;
}

export async function monitor(
  db: D1Database,
  funds: FundConfig[],
  options?: MonitorOptions,
): Promise<MonitorResult> {
  const result: MonitorResult = { actions: [], highWaterMarkUpdates: [] };
  const adaptive = options?.adaptiveMode ?? false;
  const youngDays = options?.youngPositionDays ?? 3;
  const tightenFactor = options?.trailingTightenFactor ?? 0.5;

  const allOpen = await db.prepare(
    `SELECT id, fund_id, market_id, question, direction, entry_price, shares, amount,
            high_water_mark, slug, opened_at, last_price, last_price_updated_at
     FROM paper_trades WHERE status = 'OPEN'`,
  ).all();
  const trades = (allOpen.results ?? []) as unknown as (OpenTrade & { opened_at?: string })[];
  if (trades.length === 0) return result;

  const fundMap = new Map(funds.map(f => [f.id, f]));
  const nowMs = Date.now();

  for (const trade of trades) {
    const fund = fundMap.get(trade.fund_id);
    if (!fund) continue;

    // D-Lite stale guard: never act on stale or NULL last_price.
    // Decisions made on stale data caused 9.7%→6.2% jitter — rather than
    // silently using a possibly-old price, skip this trade and let the next
    // cron cycle re-evaluate after price-refresh.ts has updated D1.
    const currentPrice = trade.last_price;
    if (typeof currentPrice !== "number" || isStale(trade.last_price_updated_at, nowMs)) {
      continue;
    }

    const unrealized = calcUnrealizedPnl(trade.direction, trade.shares, trade.amount, currentPrice);
    // Track 3 sanity guard (2026-05-10): refuse to act on a mark that implies
    // > 1000% loss. Catches Polymarket-style placeholder values bleeding past
    // D-Lite (defense-in-depth) without false-tripping on legitimate tail losses.
    if (isUnreasonableLoss(unrealized, trade.amount)) continue;
    const returnPct = unrealized / trade.amount;

    const holdDays = trade.opened_at
      ? (Date.now() - new Date(trade.opened_at).getTime()) / 86400000
      : Infinity;
    const isYoung = adaptive && holdDays < youngDays;

    // --- Take Profit ---
    const effectiveTakeProfit = isYoung ? Infinity : fund.takeProfitPercent;
    if (returnPct >= effectiveTakeProfit) {
      result.actions.push({
        tradeId: trade.id,
        fundId: trade.fund_id,
        marketId: trade.market_id,
        slug: trade.slug ?? "",
        question: trade.question,
        direction: trade.direction,
        shares: trade.shares,
        newStatus: "PROFIT_TAKEN",
        pnl: Math.round(unrealized * 100) / 100,
        reason: `Take profit triggered at ${(returnPct * 100).toFixed(1)}% (threshold: ${(fund.takeProfitPercent * 100).toFixed(0)}%)`,
        currentPrice,
        entryPrice: trade.entry_price,
      });
      continue;
    }

    // --- Trailing Stop ---
    const hwm = trade.high_water_mark ?? trade.entry_price;
    let newHwm = hwm;
    if (currentPrice > hwm) {
      newHwm = currentPrice;
      result.highWaterMarkUpdates.push({ tradeId: trade.id, hwm: newHwm });
    }
    if (newHwm > trade.entry_price) {
      const dropFromHwm = (newHwm - currentPrice) / newHwm;
      const gainFromEntry = (newHwm - trade.entry_price) / trade.entry_price;
      const effectiveTrailingStop = adaptive && gainFromEntry > 0.1
        ? fund.trailingStopPercent * (1 - tightenFactor * Math.min(gainFromEntry, 0.5))
        : fund.trailingStopPercent;
      if (dropFromHwm >= effectiveTrailingStop) {
        const pnl = calcUnrealizedPnl(trade.direction, trade.shares, trade.amount, currentPrice);
        result.actions.push({
          tradeId: trade.id,
          fundId: trade.fund_id,
          marketId: trade.market_id,
          slug: trade.slug ?? "",
          question: trade.question,
          direction: trade.direction,
          shares: trade.shares,
          newStatus: "TRAILING_STOPPED",
          pnl: Math.round(pnl * 100) / 100,
          reason: `Trailing stop: price dropped ${(dropFromHwm * 100).toFixed(1)}% from HWM ${newHwm.toFixed(3)} (threshold: ${(fund.trailingStopPercent * 100).toFixed(0)}%)`,
          currentPrice,
          entryPrice: trade.entry_price,
        });
        continue;
      }
    }

    // --- Probability Reversal ---
    if (trade.direction === "BUY_YES" && currentPrice < trade.entry_price) {
      const reversal = trade.entry_price - currentPrice;
      if (reversal >= fund.probReversalThreshold) {
        const pnl = calcUnrealizedPnl(trade.direction, trade.shares, trade.amount, currentPrice);
        result.actions.push({
          tradeId: trade.id,
          fundId: trade.fund_id,
          marketId: trade.market_id,
          slug: trade.slug ?? "",
          question: trade.question,
          direction: trade.direction,
          shares: trade.shares,
          newStatus: "REVERSED",
          pnl: Math.round(pnl * 100) / 100,
          reason: `Probability reversed by ${(reversal * 100).toFixed(1)}pp (threshold: ${(fund.probReversalThreshold * 100).toFixed(0)}pp)`,
          currentPrice,
          entryPrice: trade.entry_price,
        });
        continue;
      }
    }
    if (trade.direction === "SELL_YES" && currentPrice > trade.entry_price) {
      const reversal = currentPrice - trade.entry_price;
      if (reversal >= fund.probReversalThreshold) {
        const pnl = calcUnrealizedPnl(trade.direction, trade.shares, trade.amount, currentPrice);
        result.actions.push({
          tradeId: trade.id,
          fundId: trade.fund_id,
          marketId: trade.market_id,
          slug: trade.slug ?? "",
          question: trade.question,
          direction: trade.direction,
          shares: trade.shares,
          newStatus: "REVERSED",
          pnl: Math.round(pnl * 100) / 100,
          reason: `Probability reversed by ${(reversal * 100).toFixed(1)}pp against short (threshold: ${(fund.probReversalThreshold * 100).toFixed(0)}pp)`,
          currentPrice,
          entryPrice: trade.entry_price,
        });
      }
    }
  }

  return result;
}

export async function executeMonitorActions(
  db: D1Database,
  monitorResult: MonitorResult,
): Promise<void> {
  const now = new Date().toISOString();

  for (const hwm of monitorResult.highWaterMarkUpdates) {
    const alreadyClosed = monitorResult.actions.some(a => a.tradeId === hwm.tradeId);
    if (alreadyClosed) continue;
    await db.prepare(
      "UPDATE paper_trades SET high_water_mark = ? WHERE id = ?",
    ).bind(hwm.hwm, hwm.tradeId).run();
  }

  const mode = await getExecutionMode(db);

  for (const action of monitorResult.actions) {
    await db.prepare(
      "UPDATE paper_trades SET status = ?, exit_price = ?, pnl = ?, closed_at = ?, monitor_reason = ? WHERE id = ?",
    ).bind(action.newStatus, action.currentPrice, action.pnl, now, action.reason, action.tradeId).run();

    if (mode === "shadow") {
      await recordShadowClose(db, action.tradeId, action.fundId, action.marketId, action.slug, action.question, action.direction, action.currentPrice, action.shares, action.pnl);
      // Phase 1 accuracy: record actual exit price on linked shadow orders
      await settleShadowOrderForTrade(db, action.tradeId, action.currentPrice);
    }

    // Circuit Breaker loss tracking (all modes including shadow for pre-live validation)
    if (action.pnl < 0) {
      await recordCircuitBreakerLoss(db, action.fundId, Math.abs(action.pnl));
    }
  }
}
