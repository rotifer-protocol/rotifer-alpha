/**
 * Polymarket Settler — Code Boundary Map
 *
 * PURE COMPUTATION:
 *   - PnL calculation from resolved outcome prices
 *   - Direction-aware settlement logic (BUY_YES vs SELL_YES)
 *
 * DB SIDE EFFECTS:
 *   - settle() → reads/writes paper_trades
 *
 * EXTERNAL SIDE EFFECTS:
 *   - fallback fetch to Gamma market endpoint for OPEN trades whose market is no
 *     longer returned by the active scanner set (closed/resolved markets).
 */
import type { FundConfig, MarketSnapshot, Settlement } from "./types";
import { getExecutionMode, recordShadowClose } from "./execution";
import { settleShadowOrderForTrade } from "./order-lifecycle";
import { recordCircuitBreakerLoss } from "./circuit-breaker";

const GAMMA_MARKET_TIMEOUT_MS = 10_000;

function parseOutcomePrices(raw: unknown): number[] {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? (() => {
          try { return JSON.parse(raw) as unknown[]; } catch { return []; }
        })()
      : [];
  return values.map(Number).filter(price => Number.isFinite(price));
}

function gammaMarketToSnapshot(data: any): MarketSnapshot | null {
  const outcomePrices = parseOutcomePrices(data?.outcomePrices);
  if (!data?.id || outcomePrices.length < 2) return null;
  return {
    id: String(data.id),
    question: data.question ?? "",
    slug: data.slug ?? "",
    outcomes: Array.isArray(data.outcomes)
      ? data.outcomes
      : typeof data.outcomes === "string"
        ? (() => { try { return JSON.parse(data.outcomes) as string[]; } catch { return []; } })()
        : [],
    outcomePrices,
    bestBid: Number(data.bestBid ?? 0),
    bestAsk: Number(data.bestAsk ?? 0),
    spread: Number(data.spread ?? 0),
    volume24hr: Number(data.volume24hr ?? data.volume24hrClob ?? 0),
    liquidity: Number(data.liquidityNum ?? data.liquidity ?? 0),
    endDate: data.endDate ?? "",
    eventSlug: Array.isArray(data.events) && data.events[0]?.slug ? data.events[0].slug : "",
    eventTitle: Array.isArray(data.events) && data.events[0]?.title ? data.events[0].title : "",
    active: Boolean(data.active),
    closed: Boolean(data.closed),
  };
}

async function fetchGammaMarket(marketId: string): Promise<MarketSnapshot | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GAMMA_MARKET_TIMEOUT_MS);
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/markets/${marketId}`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return gammaMarketToSnapshot(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function backfillMissingMarkets(
  marketMap: Map<string, MarketSnapshot>,
  openTrades: any[],
): Promise<void> {
  const missingMarketIds = [...new Set(
    openTrades
      .map(trade => String(trade.market_id ?? ""))
      .filter(marketId => marketId && !marketMap.has(marketId)),
  )];
  const BATCH_SIZE = 10;
  for (let i = 0; i < missingMarketIds.length; i += BATCH_SIZE) {
    const batch = missingMarketIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(fetchGammaMarket));
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === "fulfilled" && result.value) {
        marketMap.set(batch[j], result.value);
      }
    }
  }
}

/**
 * Settlement logic.
 *
 * Previous bug: assumed BUY_YES always wins.
 * Fix: check actual market resolution (which outcome won) and compute PnL
 * based on the trader's direction and the resolved outcome.
 *
 * Polymarket binary markets resolve to either:
 * - outcome[0] (typically "Yes") wins → price[0] = 1.0, price[1] = 0.0
 * - outcome[1] (typically "No") wins  → price[0] = 0.0, price[1] = 1.0
 *
 * For closed markets, outcomePrices reflect the resolved state (1.0 or 0.0).
 */
export async function settle(
  db: D1Database,
  markets: MarketSnapshot[],
  funds: FundConfig[],
): Promise<Settlement[]> {
  const openTrades = await db.prepare(
    "SELECT * FROM paper_trades WHERE status = 'OPEN'",
  ).all();
  if (!openTrades.results || openTrades.results.length === 0) return [];

  const settlements: Settlement[] = [];
  const marketMap = new Map<string, MarketSnapshot>();
  for (const m of markets) marketMap.set(m.id, m);
  await backfillMissingMarkets(marketMap, openTrades.results as any[]);
  const mode = await getExecutionMode(db);

  for (const trade of openTrades.results as any[]) {
    const m = marketMap.get(trade.market_id);
    if (!m) continue;
    // Gamma can report resolved markets as active=true AND closed=true
    // (observed on 553843, 2026-05-10). Settlement should key off `closed`,
    // not `active`, otherwise resolved stale positions remain OPEN forever.
    if (!m.closed) continue;
    if (m.outcomePrices.length < 2) continue;

    const yesResolved = m.outcomePrices[0];
    const noResolved = m.outcomePrices[1];

    const yesWon = yesResolved > 0.5;

    let exitPrice: number;
    let pnl: number;
    const closeReason = "Market resolved on Polymarket.";

    if (trade.direction === "BUY_YES") {
      exitPrice = yesWon ? 1.0 : 0.0;
      pnl = trade.shares * exitPrice - trade.amount;
    } else if (trade.direction === "SELL_YES") {
      exitPrice = yesWon ? 1.0 : 0.0;
      pnl = yesWon
        ? -(trade.shares * 1.0 - trade.amount)
        : trade.amount;
    } else {
      exitPrice = yesWon ? 1.0 : 0.0;
      pnl = trade.shares * exitPrice - trade.amount;
    }

    await db.prepare(
      "UPDATE paper_trades SET status = 'RESOLVED', exit_price = ?, pnl = ?, closed_at = ?, monitor_reason = ? WHERE id = ?",
    ).bind(exitPrice, pnl, new Date().toISOString(), closeReason, trade.id).run();

    if (mode === "shadow") {
      await recordShadowClose(db, trade.id, trade.fund_id, trade.market_id, trade.slug ?? "", trade.question, trade.direction, exitPrice, trade.shares, pnl);
      // Phase 1 accuracy: record actual exit price on linked shadow orders
      await settleShadowOrderForTrade(db, trade.id, exitPrice);
    }

    // Circuit Breaker loss tracking (all modes including shadow for pre-live validation)
    if (pnl < 0) {
      await recordCircuitBreakerLoss(db, trade.fund_id, Math.abs(pnl));
    }

    const fund = funds.find(f => f.id === trade.fund_id);
    settlements.push({
      tradeId: trade.id,
      marketId: trade.market_id,
      fundId: trade.fund_id,
      fundEmoji: fund?.emoji ?? "",
      slug: trade.slug ?? "",
      question: trade.question,
      pnl,
      direction: trade.direction,
      entryPrice: trade.entry_price,
      exitPrice,
      status: "RESOLVED",
    });
  }

  return settlements;
}
