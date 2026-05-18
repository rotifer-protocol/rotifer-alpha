/**
 * Polymarket Trader — Code Boundary Map
 *
 * PURE COMPUTATION:
 *   - entryDirection() — signal → direction mapping
 *   - entryPrice()     — signal → price extraction
 *   - Position sizing logic (sizing(), effectiveSizing())
 *   - Skip reason classification
 *
 * DB SIDE EFFECTS:
 *   - paperTrade()    → reads paper_trades (with last_price), writes new trades
 *   - getBalance()    → reads
 *   - isDuplicate()   → reads
 *   - isFrozen()      → reads
 *
 * EXTERNAL SIDE EFFECTS (D-Lite, 2026-05-10):
 *   - fetchClobTokenIds() → only on INSERT new trades (token_id backfill)
 *   - mark-to-market reads come from D1.last_price, NOT per-request fetch.
 */
import type { ArbSignal, FundConfig, MarketSnapshot, TradeAction } from "./types";
import { sizing } from "./types";
import { effectiveSizing, getOpenPositionCount } from "./risk";
import {
  calculateCashBalance,
  calculateDrawdownPct,
  calculateOpenPositionStats,
  calculateTotalValue,
  type OpenTradeWithMark,
  OPEN_TRADE_MARK_COLUMNS_SQL,
  PERFORMANCE_REALIZED_TRADE_WHERE_SQL,
  REALIZED_TRADE_STATUS_SQL,
} from "./accounting";
import { fetchClobTokenIds } from "./price";
import { getExecutionMode, recordShadowOpen } from "./execution";
import { isOTMPosition, calcOTMCap, isUnsafeSellEntry } from "./risk-policy";

export function entryDirection(sig: ArbSignal): string {
  if (sig.type === "MISPRICING") return sig.direction === "BUY_BOTH" ? "BUY_YES" : "SELL_YES";
  if (sig.type === "MULTI_OUTCOME_ARB") return sig.direction === "BUY_STRONGEST" ? "BUY_YES" : "SELL_YES";
  return "BUY_YES";
}

export function entryPrice(sig: ArbSignal): number {
  if (sig.type === "SPREAD") return sig.prices["midpoint"] ?? 0.5;
  const p = Object.entries(sig.prices).filter(
    ([k]) => k !== "sum" && k !== "yes_price_sum" && k !== "volume24hr",
  );
  if (p.length === 0) return 0.5;
  if (sig.direction === "BUY_STRONGEST" || sig.direction === "BUY_BOTH") {
    return Math.max(...p.map(([, v]) => v));
  }
  return Math.min(...p.map(([, v]) => v));
}

/**
 * Direction-aware price boundary check.
 *
 * Why direction matters: entryPrice() returns max-side for BUY signals
 * (the high outcome we're buying) and min-side for SELL signals
 * (the low outcome we're selling, e.g. SELL_WEAKEST in a multi-outcome arb).
 *
 * - BUY  signals: price > 0.95 has no upside; < 0.01 is data anomaly.
 * - SELL signals: LOW price IS the alpha — selling near-zero outcomes and
 *   letting them settle to 0 is the canonical SELL_WEAKEST profit case.
 *   Only filter near-1 (no downside) or true zero (data anomaly).
 *
 * Bug history (2026-05-05): a uniform `price <= 0.01 || price >= 0.99`
 * filter caused 7+ hours of trade blockage when SELL_WEAKEST candidates
 * (Philadelphia 76ers @ 0.0085, Flyers @ 0.01) priced below 0.01,
 * even though scanner had already validated edge=2.65 / confidence=0.71.
 */
export function passesPriceBoundary(price: number, direction: string): boolean {
  const isBuy = direction.startsWith("BUY");
  const lowerBound = isBuy ? 0.01 : 0.001;
  const upperBound = isBuy ? 0.95 : 0.99;
  return price >= lowerBound && price <= upperBound;
}

async function getBalance(db: D1Database, fundId: string, initial: number): Promise<number> {
  const invested = await db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM paper_trades WHERE fund_id = ? AND status = 'OPEN'",
  ).bind(fundId).first<{ total: number }>();
  const realized = await db.prepare(
    `SELECT COALESCE(SUM(pnl), 0) as total
     FROM paper_trades
     WHERE fund_id = ? AND ${PERFORMANCE_REALIZED_TRADE_WHERE_SQL}`,
  ).bind(fundId).first<{ total: number }>();
  return calculateCashBalance(initial, invested?.total ?? 0, realized?.total ?? 0);
}

async function getEventExposure(db: D1Database, fundId: string, eventSlug: string): Promise<number> {
  const r = await db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM paper_trades WHERE fund_id = ? AND status = 'OPEN' AND slug = ?",
  ).bind(fundId, eventSlug).first<{ total: number }>();
  return r?.total ?? 0;
}

async function isFrozen(db: D1Database, fundId: string): Promise<boolean> {
  const r = await db.prepare(
    "SELECT frozen_until FROM portfolio_snapshots WHERE fund_id = ? AND frozen_until IS NOT NULL ORDER BY date DESC LIMIT 1",
  ).bind(fundId).first<{ frozen_until: string }>();
  if (!r) return false;
  return new Date(r.frozen_until) > new Date();
}

// Re-entry cooldown: prevent re-entering a market that was recently closed by
// ANY exit path (take-profit, stop-loss, expiry, reversal, resolution).
//
// Without this, the pipeline sequence (risk→settle→monitor → trader) would
// re-open positions that were just closed in the same 5-minute cron tick.
// Confirmed root cause of the Harvey Weinstein 3× duplicate trades (2026-05-16).
//
// REALIZED_TRADE_STATUS_SQL is imported from accounting.ts — single source of
// truth for all closed-trade statuses. Adding a new close reason there
// automatically extends the cooldown, preventing future recurrences.
const REENTRY_COOLDOWN_HOURS = 4;

async function isDuplicate(db: D1Database, fundId: string, marketId: string): Promise<boolean> {
  const cooldownCutoff = new Date(Date.now() - REENTRY_COOLDOWN_HOURS * 3_600_000).toISOString();
  const r = await db.prepare(
    `SELECT COUNT(*) as cnt FROM paper_trades
     WHERE fund_id = ? AND market_id = ? AND (
       status = 'OPEN'
       OR (status IN (${REALIZED_TRADE_STATUS_SQL}) AND closed_at >= ?)
     )`,
  ).bind(fundId, marketId, cooldownCutoff).first<{ cnt: number }>();
  return (r?.cnt ?? 0) > 0;
}

export interface SkipReasonEntry {
  fundId: string;
  code: string;
}

export interface PaperTradeResult {
  trades: TradeAction[];
  skipReasons: SkipReasonEntry[];
}

export async function paperTrade(
  db: D1Database,
  sigs: ArbSignal[],
  markets: MarketSnapshot[],
  funds: FundConfig[],
  ts: string,
  freshlyClosedThisRun?: ReadonlySet<string>,
): Promise<PaperTradeResult> {
  const trades: TradeAction[] = [];
  const skipReasons: SkipReasonEntry[] = [];
  // In-run dedup: tracks (fundId, marketId) pairs opened in THIS invocation.
  // First line of defense — eliminates same-invocation duplicates (sigs[] containing
  // multiple signals for the same effectiveMarketId).
  //
  // NOT sufficient on its own: Cloudflare Workers cron at-least-once semantics
  // routinely fires 2-3 concurrent isolates per */5 schedule (forensic 2026-05-17:
  // 16 of 24h ticks). Each isolate has its own openedThisRun set, so the residual
  // race is caught by the schema/021 partial UNIQUE index → SQLITE_CONSTRAINT_UNIQUE
  // is handled at the INSERT site below.
  const openedThisRun = new Set<string>();

  for (const fund of funds) {
    if (await isFrozen(db, fund.id)) {
      skipReasons.push({ fundId: fund.id, code: "FUND_FROZEN" });
      continue;
    }

    const openCount = await getOpenPositionCount(db, fund.id);
    if (openCount >= fund.maxOpenPositions) {
      skipReasons.push({ fundId: fund.id, code: "MAX_POSITIONS" });
      continue;
    }

    let cash = await getBalance(db, fund.id, fund.initialBalance);
    // positionsOpened tracks new opens within this invocation so the
    // MAX_POSITIONS gate stays accurate without an extra DB round-trip per signal.
    let positionsOpened = 0;
    // D-Lite: read last_price from D1 (refreshed every 5min by price-refresh.ts cron),
    // never fetch per-request. Stale rows contribute 0 to unrealized — see
    // calculateOpenPositionStats() for stale-treatment policy.
    const openTradesResult = await db.prepare(
      `SELECT ${OPEN_TRADE_MARK_COLUMNS_SQL} FROM paper_trades WHERE fund_id = ? AND status = 'OPEN'`,
    ).bind(fund.id).all<OpenTradeWithMark>();
    const openTrades = openTradesResult.results ?? [];
    const openStats = calculateOpenPositionStats(openTrades);
    const realizedPnl = cash + openStats.invested - fund.initialBalance;
    const currentEquity = calculateTotalValue(fund.initialBalance, realizedPnl, openStats.unrealizedPnl);
    const currentDrawdown = calculateDrawdownPct(fund.initialBalance, currentEquity);

    for (const sig of sigs) {
      if (openCount + positionsOpened >= fund.maxOpenPositions) {
        skipReasons.push({ fundId: fund.id, code: "MAX_POSITIONS" });
        break;
      }

      if (!fund.allowedTypes.includes(sig.type)) {
        skipReasons.push({ fundId: fund.id, code: "TYPE_NOT_ALLOWED" });
        continue;
      }
      if (sig.edge < fund.minEdge) {
        skipReasons.push({ fundId: fund.id, code: "EDGE_TOO_LOW" });
        continue;
      }
      if (sig.confidence < fund.minConfidence) {
        skipReasons.push({ fundId: fund.id, code: "CONFIDENCE_TOO_LOW" });
        continue;
      }

      const vol = sig.prices["volume24hr"] ?? 0;
      if (vol < fund.minVolume) {
        skipReasons.push({ fundId: fund.id, code: "VOLUME_TOO_LOW" });
        continue;
      }

      const liq = sig.prices["liquidity"] ?? vol;
      if (liq < fund.minLiquidity) {
        skipReasons.push({ fundId: fund.id, code: "LIQUIDITY_TOO_LOW" });
        continue;
      }

      if (fund.id === "octopus" && sig.type !== "SPREAD" && sig.edge * sig.confidence < 1.5) {
        skipReasons.push({ fundId: fund.id, code: "COMPOSITE_TOO_LOW" });
        continue;
      }

      const effectiveMarketId = sig.resolvedMarketId ?? sig.marketId;
      const runKey = `${fund.id}:${effectiveMarketId}`;
      // freshlyClosedThisRun: in-pipeline memory set populated by monitor gene for
      // positions closed earlier in THIS pipeline tick. Checked BEFORE the DB
      // isDuplicate query because D1 read replicas may not yet reflect the monitor's
      // UPDATE (M15: distributed read-after-write is untrustworthy — ADR-280 §D6).
      if (
        openedThisRun.has(runKey)
        || freshlyClosedThisRun?.has(runKey)
        || await isDuplicate(db, fund.id, effectiveMarketId)
      ) {
        skipReasons.push({ fundId: fund.id, code: "DUPLICATE_MARKET" });
        continue;
      }
      const exposure = await getEventExposure(db, fund.id, sig.slug);
      if (exposure >= fund.maxPerEvent) {
        skipReasons.push({ fundId: fund.id, code: "MAX_EVENT_EXPOSURE" });
        continue;
      }

      const rawSize = sizing(fund, sig);
      const adjustedSize = effectiveSizing(rawSize, currentDrawdown, fund);
      const amount = Math.min(adjustedSize, cash, fund.maxPerEvent - exposure);
      if (amount < 50) {
        skipReasons.push({ fundId: fund.id, code: "INSUFFICIENT_CASH" });
        continue;
      }

      const price = entryPrice(sig);
      const dir = entryDirection(sig);
      if (!passesPriceBoundary(price, dir)) {
        skipReasons.push({ fundId: fund.id, code: "PRICE_BOUNDARY" });
        continue;
      }

      // Track 2 (P0, 2026-05-10): hard reject SELL_YES at deep-OTM entry.
      // Forensic: 33 SELL_YES @ entry 0.0015-0.025 produced -$86.28M phantom
      // losses (Gamma 0.5 placeholder × 1666× leverage). D-Lite eliminated the
      // API entry; this rule eliminates the leverage amplifier — together they
      // prevent recurrence. BUY at deep OTM stays allowed (long-shot bet,
      // asymmetric upside) but is gated by OTM_CAP below.
      if (isUnsafeSellEntry(price, dir)) {
        skipReasons.push({ fundId: fund.id, code: "LOW_PRICE_REJECT" });
        continue;
      }

      // P2 (Path A, founder approved 2026-05-10): hard OTM single-position cap.
      // Constants in risk-policy.ts are intentionally NOT in EVOLVABLE_PARAMS —
      // catastrophe protection must not be self-tuned by funds chasing fitness.
      if (isOTMPosition(price, dir)) {
        const otmCap = calcOTMCap(currentEquity);
        if (amount > otmCap) {
          skipReasons.push({ fundId: fund.id, code: "OTM_CAP" });
          continue;
        }
      }

      const shares = amount / price;

      const tradeId = crypto.randomUUID();
      // D-Lite (Phase 6): best-effort token_id discovery at INSERT time so the
      // cron price refresher never has to lazy-backfill new rows. If Gamma is
      // unreachable we still INSERT with token_id=NULL — refreshOpenPrices()
      // will pick it up on the next cycle.
      // last_price is initialized to entry_price (the executed price = freshest
      // possible mark-to-market value) and last_price_updated_at = trade ts.
      let tokenId: string | null = null;
      try {
        const ids = await fetchClobTokenIds(effectiveMarketId);
        tokenId = ids?.[0] ?? null;
      } catch {
        tokenId = null;
      }
      // schema/021 partial UNIQUE index on (fund_id, market_id) WHERE status='OPEN'
      // catches the residual race that openedThisRun + isDuplicate cannot:
      // Cloudflare Workers cron at-least-once → 2-3 concurrent isolates each
      // with their own in-memory set, all reading 0 OPEN rows pre-INSERT.
      // SQLITE_CONSTRAINT_UNIQUE → translate to DUPLICATE_MARKET skip; do NOT throw.
      try {
        await db.prepare(
          `INSERT INTO paper_trades (
            id, fund_id, signal_id, market_id, slug, question, direction,
            entry_price, shares, amount, status, opened_at,
            token_id, last_price, last_price_updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
        ).bind(
          tradeId, fund.id, sig.signalId, effectiveMarketId, sig.slug, sig.question, dir,
          price, shares, amount, ts,
          tokenId, price, ts,
        ).run();
      } catch (e) {
        // D1DatabaseError in Workers production does not extend Error (instanceof = false),
        // but still carries a .message property. Access it directly to avoid String(e)
        // returning "[object Object]" and causing the UNIQUE check to silently miss.
        const msg = String((e as any)?.message ?? e);
        if (msg.includes("UNIQUE constraint failed") && msg.includes("paper_trades")) {
          skipReasons.push({ fundId: fund.id, code: "DUPLICATE_MARKET" });
          continue;
        }
        throw e;
      }

      const mode = await getExecutionMode(db);
      if (mode === "shadow") {
        await recordShadowOpen(db, tradeId, fund.id, effectiveMarketId, sig.slug, sig.question, dir, price, shares, amount);
      }

      openedThisRun.add(runKey);
      cash -= amount;
      positionsOpened++;
      trades.push({
        fundId: fund.id,
        fundEmoji: fund.emoji,
        fundName: fund.name,
        signalId: sig.signalId,
        slug: sig.slug,
        question: sig.question,
        direction: dir,
        price,
        amount,
        shares,
      });
    }
  }
  return { trades, skipReasons };
}
