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
import { effectiveSizing, getOpenPositionCount, getPeakEquity } from "./risk";
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
import { getExecutionMode, recordShadowOpen, type VenueQuoteOverride } from "./execution";
import { isOTMPosition, calcOTMCap, isUnsafeSellEntry } from "./risk-policy";
import { eventFamilyKey } from "./event-family";
import {
  checkPortfolioConcentration,
  getPortfolioEventExposureMap,
  PORTFOLIO_MAX_EVENT_USDC,
} from "./portfolio-coordinator";
import { PolymarketVenue } from "./polymarket-venue";
import { updateLiveOrderStatus } from "./order-lifecycle";
import { categoryCalibrationGate } from "./signal-calibration";
import {
  loadCircuitBreakerState,
  checkCircuitBreaker,
  ensureCircuitBreakerState,
  DEFAULT_CB_THRESHOLD_PCT,
} from "./circuit-breaker";

export function entryDirection(sig: ArbSignal): string {
  if (sig.type === "MISPRICING") return sig.direction === "BUY_BOTH" ? "BUY_YES" : "SELL_YES";
  if (sig.type === "MULTI_OUTCOME_ARB") return sig.direction === "BUY_STRONGEST" ? "BUY_YES" : "SELL_YES";
  return "BUY_YES";
}

export function entryPrice(sig: ArbSignal): number {
  if (sig.type === "SPREAD") return sig.prices["midpoint"] ?? 0.5;
  // Filter non-price metadata fields; price values are always in [0,1].
  const META_KEYS = new Set(["sum", "yes_price_sum", "volume24hr", "liquidity"]);
  const p = Object.entries(sig.prices).filter(
    ([k]) => !META_KEYS.has(k),
  );
  if (p.length === 0) return 0.5;
  if (sig.direction === "BUY_STRONGEST" || sig.direction === "BUY_BOTH") {
    return Math.max(...p.map(([, v]) => v));
  }
  return Math.min(...p.map(([, v]) => v));
}

/**
 * Returns the specific outcome label being traded.
 *
 * For binary YES/NO markets: "Yes" or "No".
 * For multi-outcome categorical markets (MULTI_OUTCOME_ARB): the outcome key
 * whose price was selected by entryPrice() — e.g. "Cleveland Cavaliers".
 *
 * Mirrors entryPrice() exactly: same META_KEYS filter, same max/min logic,
 * but returns the KEY (outcome name) instead of the VALUE (price).
 */
export function outcomeKey(sig: ArbSignal): string {
  // For binary grouped markets ("Will Detroit Pistons win?"), Polymarket provides
  // groupItemTitle = "Detroit Pistons" — use that instead of "Yes"/"No".
  if (sig.groupItemTitle) return sig.groupItemTitle;

  if (sig.direction === "BUY_YES") return "Yes";
  if (sig.direction === "SELL_YES") return "No";
  if (sig.type === "SPREAD") return "Spread";
  const META_KEYS = new Set(["sum", "yes_price_sum", "volume24hr", "liquidity"]);
  const p = Object.entries(sig.prices).filter(([k]) => !META_KEYS.has(k));
  if (p.length === 0) return sig.direction;
  if (sig.direction === "BUY_STRONGEST" || sig.direction === "BUY_BOTH") {
    return p.reduce((best, cur) => cur[1] > best[1] ? cur : best)[0];
  }
  // SELL_WEAKEST, SELL_BOTH — min-side outcome
  return p.reduce((worst, cur) => cur[1] < worst[1] ? cur : worst)[0];
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

interface EventFamilyRow {
  slug: string | null;
  question: string | null;
  amount?: number | null;
}

function incrementMap(map: Map<string, number>, key: string, delta: number): void {
  map.set(key, (map.get(key) ?? 0) + delta);
}

async function getRecentEventFamilyEntryCounts(
  db: D1Database,
  fundId: string,
  since: string,
): Promise<Map<string, number>> {
  // Rolling-window quota semantics (2026-05-19, v3 → replaces calendar-day v2):
  //
  // Counts ALL entries (any status) for fund+event family opened within the
  // last `eventFamilyCooldownHours` hours, regardless of whether they are
  // still OPEN.  The window anchor is the current cron timestamp — not UTC
  // midnight — so the gate is time-based rather than calendar-day based.
  //
  // Why v3 over v2 (daily quota)?
  //   v2 (2026-05-18 fix): used UTC midnight as boundary.  Correct for the
  //   James Bond bypass, but over-restrictive on high-signal days (e.g. NBA
  //   playoff dates) where legitimate new signals emerge hours after the first
  //   entry — each fund could only enter once regardless of signal quality.
  //
  //   v3: "at most N entries in the last H hours" (rolling).  Still prevents
  //   the bypass (stop → re-enter within cooldown is still blocked) while
  //   allowing re-entry after the window has elapsed if a strong new signal
  //   arrives (e.g., 9:45am entry → re-entry allowed after 3:45pm).
  //
  // The `since` parameter = ts - fund.eventFamilyCooldownHours * 3600 * 1000,
  // computed per-fund in paperTrade() to support per-fund evolution.
  const r = await db.prepare(
    "SELECT slug, question FROM paper_trades WHERE fund_id = ? AND opened_at >= ?",
  ).bind(fundId, since).all<EventFamilyRow>();
  const counts = new Map<string, number>();
  for (const row of r.results ?? []) {
    incrementMap(counts, eventFamilyKey(row.slug, row.question), 1);
  }
  return counts;
}

async function getOpenEventFamilyExposure(db: D1Database, fundId: string): Promise<Map<string, number>> {
  const r = await db.prepare(
    "SELECT slug, question, amount FROM paper_trades WHERE fund_id = ? AND status = 'OPEN'",
  ).bind(fundId).all<EventFamilyRow>();
  const exposure = new Map<string, number>();
  for (const row of r.results ?? []) {
    incrementMap(exposure, eventFamilyKey(row.slug, row.question), Number(row.amount ?? 0));
  }
  return exposure;
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

/** Credentials injected for Phase 2 live order submission. */
export interface LiveTradeOpts {
  ownerPrivateKey: string;
  /** Checksummed Polygon address — if omitted, derived from ownerPrivateKey. */
  walletAddress?: string;
}

export async function paperTrade(
  db: D1Database,
  sigs: ArbSignal[],
  markets: MarketSnapshot[],
  funds: FundConfig[],
  ts: string,
  freshlyClosedThisRun?: ReadonlySet<string>,
  liveOpts?: LiveTradeOpts,
): Promise<PaperTradeResult> {
  const trades: TradeAction[] = [];
  const skipReasons: SkipReasonEntry[] = [];
  // Base timestamp in ms — used to derive per-fund rolling cooldown windows.
  // ts is guaranteed ISO format (e.g. "2026-05-18T13:00:01.000Z").
  const nowMs = new Date(ts).getTime();
  // Execution mode — read once here (was previously read per-INSERT for shadow
  // recording). Cached to avoid N DB round-trips in the signal loop and to
  // derive the portfolio concentration limit below.
  const executionMode = await getExecutionMode(db);
  // Portfolio-level event family exposure — loaded once per invocation to
  // avoid N×M DB queries (15 funds × 20 signals = 300 queries without this).
  // Updated in-memory as positions are opened so subsequent fund+signal pairs
  // in the same invocation see accurate cross-fund totals.
  // See: ALPHA-001 §8 / portfolio-coordinator.ts
  //
  // Mode-aware limit: the $200 cap is for Phase 2 Live Small (real money).
  // In paper/shadow mode per-fund daily-quota guards are sufficient; a strict
  // portfolio cap would incorrectly block M/L-tier paper fund positions.
  const portfolioLimit = executionMode === "live"
    ? PORTFOLIO_MAX_EVENT_USDC
    : Number.POSITIVE_INFINITY;
  const portfolioEventExposure = await getPortfolioEventExposureMap(db);
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

    // Circuit Breaker (ALPHA-001 §9): In live mode, block new trades if this
    // fund has lost ≥20% of epoch-start capital in the current 24h epoch.
    // In shadow/paper mode: tracks state but does NOT block (no real money).
    if (executionMode === "live") {
      await ensureCircuitBreakerState(db, fund.id, cash);
      const cbState = await loadCircuitBreakerState(db, fund.id);
      if (cbState) {
        const cbCheck = checkCircuitBreaker(cbState, DEFAULT_CB_THRESHOLD_PCT);
        if (cbCheck.blocked) {
          skipReasons.push({ fundId: fund.id, code: "CIRCUIT_BREAKER_TRIPPED" });
          continue;
        }
      }
    }

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
    // P8 fix (2026-05-21): use peak equity (not initialBalance) as drawdown
    // reference so `effectiveSizing()`'s soft/hard limits actually engage when
    // a once-profitable fund has fallen back from its high. Pre-fix, any fund
    // with totalValue > initialBalance reported drawdown=0% regardless of how
    // far it had fallen from its peak — silently disabling sizing protection.
    // Snapshots are written daily; we max with currentEquity so a fund making
    // a fresh intra-day high reports drawdown=0 instead of a stale negative.
    const peakFromDb = await getPeakEquity(db, fund.id, fund.initialBalance);
    const peakReference = Math.max(peakFromDb, currentEquity);
    const currentDrawdown = calculateDrawdownPct(peakReference, currentEquity);
    // Rolling cooldown window: entries in the last N hours per event family.
    // Per-fund parameter (default 6h) replaces the old UTC-midnight boundary.
    const cooldownHours = fund.eventFamilyCooldownHours ?? 6;
    const cooldownSince = new Date(nowMs - cooldownHours * 3_600_000).toISOString();
    const dailyEventFamilyCounts = await getRecentEventFamilyEntryCounts(db, fund.id, cooldownSince);
    const openEventFamilyExposure = await getOpenEventFamilyExposure(db, fund.id);
    const openedFamilyCounts = new Map<string, number>();
    const openedFamilyExposure = new Map<string, number>();

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

      // P9-C transitional gate (2026-05-21): require 1.5× premium on
      // edge/confidence for untrusted categories (crypto/ai/other) until
      // v1.1 §5 Bayesian Platt scaling provides per-category calibration.
      // Trusted set: sports + politics. See signal-calibration.ts head comment.
      const calibration = categoryCalibrationGate(sig, fund);
      if (!calibration.pass) {
        skipReasons.push({ fundId: fund.id, code: calibration.code! });
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
      // Same-event rolling-window quota (v3, 2026-05-19):
      //
      // At most fund.maxSameEventPositions entries per event family within
      // the last fund.eventFamilyCooldownHours hours (default: 1 per 6h).
      //
      // History:
      //   v1: counted only OPEN positions → James Bond bypass (7-entry fan-out
      //       as each stop-loss reset the count).
      //   v2: switched to calendar-day total (UTC midnight boundary) — fixed
      //       the bypass but too restrictive on high-signal days (NBA playoffs:
      //       all funds blocked after first NBA entry even when new strong
      //       signals emerged hours later in the same day).
      //   v3: rolling window anchored to last N hours — preserves bypass
      //       protection while allowing re-entry after cooldown elapses.
      //       Both `maxSameEventPositions` and `eventFamilyCooldownHours` are
      //       evolvable per fund via PARAM_BOUNDS_INVARIANT.
      const familyKey = eventFamilyKey(sig.slug, sig.question);
      const recentEventCount =
        (dailyEventFamilyCounts.get(familyKey) ?? 0)
        + (openedFamilyCounts.get(familyKey) ?? 0);
      const maxSameEvent = fund.maxSameEventPositions ?? 1;
      if (recentEventCount >= maxSameEvent) {
        skipReasons.push({ fundId: fund.id, code: "MAX_SAME_EVENT_POSITIONS" });
        continue;
      }

      const exposure =
        (openEventFamilyExposure.get(familyKey) ?? 0)
        + (openedFamilyExposure.get(familyKey) ?? 0);
      if (exposure >= fund.maxPerEvent) {
        skipReasons.push({ fundId: fund.id, code: "MAX_EVENT_EXPOSURE" });
        continue;
      }

      const rawSize = sizing(fund, sig);

      // Market Impact Gate (2026-05-18): reject if rawSize would consume too much
      // of market liquidity — our own order would cause significant price impact.
      // Use rawSize (pre-drawdown-adjustment) as the "intended" order size;
      // liquidity comes from Gamma API data attached to the signal.
      const liquidity = (sig.prices["liquidity"] as number | undefined) ?? (sig.prices["volume24hr"] as number | undefined) ?? 0;
      const maxImpactRatio = fund.maxMarketImpactRatio ?? 0.15;
      if (liquidity > 0 && rawSize / liquidity > maxImpactRatio) {
        skipReasons.push({ fundId: fund.id, code: "MARKET_IMPACT_TOO_HIGH" });
        continue;
      }

      const adjustedSize = effectiveSizing(rawSize, currentDrawdown, fund);
      const amount = Math.min(adjustedSize, cash, fund.maxPerEvent - exposure);
      if (amount < 50) {
        skipReasons.push({ fundId: fund.id, code: "INSUFFICIENT_CASH" });
        continue;
      }

      // Portfolio-level concentration gate (ALPHA-001 §8):
      // Blocks entry if the cross-fund total for this event family would exceed
      // portfolioLimit. Prevents the James Bond fan-out pattern where multiple
      // funds each pass their per-fund gate but collectively pile into the same
      // correlated event.
      // portfolioLimit = PORTFOLIO_MAX_EVENT_USDC ($200) in live mode;
      //                 = Infinity in paper/shadow mode (per-fund quota sufficient).
      const portConcentration = checkPortfolioConcentration(
        portfolioEventExposure.get(familyKey) ?? 0,
        amount,
        portfolioLimit,
      );
      if (!portConcentration.allowed) {
        skipReasons.push({ fundId: fund.id, code: "PORTFOLIO_CONCENTRATION" });
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
      const outcomeName = outcomeKey(sig);
      try {
        await db.prepare(
          `INSERT INTO paper_trades (
            id, fund_id, signal_id, market_id, slug, question, direction, outcome_name,
            entry_price, shares, amount, status, opened_at,
            token_id, last_price, last_price_updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
        ).bind(
          tradeId, fund.id, sig.signalId, effectiveMarketId, sig.slug, sig.question, dir, outcomeName,
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

      if (executionMode === "shadow") {
        // Phase 1 Shadow Live: use real CLOB orderbook for fill estimation when
        // token_id is available. Falls back to simplified simulateClob() otherwise.
        let venueQuote: VenueQuoteOverride | undefined;
        if (tokenId) {
          try {
            const venue = new PolymarketVenue("shadow");
            const q = await venue.quote({
              fundId: fund.id,
              marketId: effectiveMarketId,
              tokenId,
              side: dir === "BUY_YES" ? "YES" : "NO",
              sizeUsdc: amount,
              priceCents: Math.round(price * 100),
              maxSlippageBps: 200,
            });
            venueQuote = {
              fillPrice: q.estimatedFillPrice,
              slippageBps: q.estimatedSlippage,
              wouldFill: q.available,
              source: q.source,
            };
          } catch {
            // non-fatal: fall back to legacy simulation
          }
        }
        await recordShadowOpen(db, tradeId, fund.id, effectiveMarketId, sig.slug, sig.question, dir, price, shares, amount, venueQuote);
      }

      if (executionMode === "live" && liveOpts && tokenId) {
        // Phase 2 Live: submit FOK order via Polymarket CLOB V2.
        // Non-fatal — a live order failure does NOT roll back the paper trade.
        // The paper trade remains as the P&L record; live_orders tracks real fills.
        try {
          const venue = new PolymarketVenue(
            "live",
            db,
            liveOpts.ownerPrivateKey,
            liveOpts.walletAddress,
          );
          const result = await venue.submit({
            fundId:        fund.id,
            marketId:      effectiveMarketId,
            tokenId,
            side:          dir === "BUY_YES" ? "YES" : "NO",
            sizeUsdc:      amount,
            priceCents:    Math.round(price * 100),
            maxSlippageBps: 300, // 3% max slippage for Phase 2 small
          });
          // Back-link the live order to the paper trade for reconciliation (P2.6)
          if (result.status !== "REJECTED") {
            await updateLiveOrderStatus(db, result.orderId, {
              status:    result.status as "FILLED" | "PARTIAL" | "OPEN",
              clobOrderId: result.orderId, // already set internally; this is a no-op unless status changed
            });
            // Update paper_trade_id linkage in live_orders
            await db
              .prepare("UPDATE live_orders SET paper_trade_id = ? WHERE id = ?")
              .bind(tradeId, result.orderId)
              .run()
              .catch(() => {}); // non-fatal
          }
        } catch {
          // Live order failure is non-fatal: paper trade is already recorded.
          // Monitoring dashboard will show the REJECTED entry in live_orders.
        }
      }

      openedThisRun.add(runKey);
      incrementMap(openedFamilyCounts, familyKey, 1);
      incrementMap(openedFamilyExposure, familyKey, amount);
      // Keep portfolio exposure map current so later fund+signal pairs in this
      // invocation see the accurate cross-fund total (ALPHA-001 §8).
      portfolioEventExposure.set(
        familyKey,
        (portfolioEventExposure.get(familyKey) ?? 0) + amount,
      );
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
