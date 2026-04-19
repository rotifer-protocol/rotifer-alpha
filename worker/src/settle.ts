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
 * NO EXTERNAL NETWORK CALLS — settler works entirely with in-memory market data
 * that is already fetched by the scanner step.
 */
import type { FundConfig, MarketSnapshot, Settlement } from "./types";
import { getExecutionMode, recordShadowClose } from "./execution";

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
  const mode = await getExecutionMode(db);

  for (const trade of openTrades.results as any[]) {
    const m = marketMap.get(trade.market_id);
    if (!m) continue;
    if (m.active || !m.closed) continue;
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
    }

    const fund = funds.find(f => f.id === trade.fund_id);
    settlements.push({
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
