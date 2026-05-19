/**
 * PolymarketVenue — Phase 1 Shadow Implementation (ALPHA-001 §7)
 *
 * Shadow mode: fetches real CLOB V2 orderbook, walks depth to estimate fill
 * price, records to shadow_orders. Does NOT submit real orders.
 *
 * Live mode (Phase 2, not yet implemented): EIP-712 signing + CLOB V2 submission
 * via Deposit Wallet (POLY_1271 signatureType = 3).
 *
 * Design principles:
 *  - walkClobFill() is a pure function (no I/O) for testability
 *  - All async I/O is isolated in fetchOrderbook() and submit()
 *  - Fees use Polymarket's published taker fee (2% default, 0% for makers)
 *    Conservative: use taker rate for all shadow estimates
 */

import type { ExecutionVenue, OrderIntent, QuoteResult, OrderResult } from "./venue";

// ─── Constants ───────────────────────────────────────────────────────────────

const CLOB_API = "https://clob.polymarket.com";
const CLOB_TIMEOUT_MS = 8_000;

/** Polymarket taker fee for market orders (as of 2026-05, 2% spread).
 *  Source: https://docs.polymarket.com/guides/fees
 *  Conservative estimate: we use the taker rate even for limit orders. */
export const POLYMARKET_TAKER_FEE_BPS = 0; // Polymarket has 0% trading fee currently
// Note: Polymarket charges 0% trading fees. The "spread" is the bid-ask spread.
// If they reintroduce fees, update this constant.

/** Maximum slippage we'll simulate — above this, the order is marked "SHADOW_REJECT". */
const MAX_SIMULATED_SLIPPAGE_BPS = 500; // 5%

// ─── Orderbook walk (pure, testable) ─────────────────────────────────────────

export interface ClobLevel {
  price: number;  // 0–1 probability
  size: number;   // shares
}

export interface ClobFillResult {
  available: boolean;
  avgFillPrice: number;    // weighted average fill price (0–1)
  slippageBps: number;     // bps vs mid price; positive = worse for trader
  filledUsdc: number;      // USDC actually filled
  totalShares: number;
  depthUsdc: number;       // total USDC available at or better than fill price
}

/**
 * Walk the CLOB orderbook to simulate a market order of `sizeUsdc`.
 *
 * For a BUY order (taking asks): walk from lowest ask upward.
 * For a SELL order (trading into bids): walk from highest bid downward.
 *
 * Price convention: 0–1 probability scale.
 * Size convention: shares at that price level.
 * USDC = shares × price.
 *
 * @param side     "BUY" = take asks; "SELL" = take bids
 * @param sizeUsdc notional to fill in USDC
 * @param levels   sorted levels from the relevant side (ask: ASC, bid: DESC)
 * @param midPrice current mid price for slippage calculation
 */
export function walkClobFill(
  side: "BUY" | "SELL",
  sizeUsdc: number,
  levels: ClobLevel[],
  midPrice: number,
): ClobFillResult {
  if (levels.length === 0 || sizeUsdc <= 0 || midPrice <= 0) {
    return { available: false, avgFillPrice: 0, slippageBps: 0, filledUsdc: 0, totalShares: 0, depthUsdc: 0 };
  }

  // Sort levels: buy takes lowest asks first, sell takes highest bids first
  const sorted = [...levels].sort((a, b) =>
    side === "BUY" ? a.price - b.price : b.price - a.price,
  );

  let remainingUsdc = sizeUsdc;
  let totalCost = 0;    // USDC spent
  let totalShares = 0;  // shares acquired
  let depthUsdc = 0;    // total USDC available up to fill point

  for (const level of sorted) {
    if (level.price <= 0 || level.size <= 0) continue;
    if (remainingUsdc <= 0) break;

    const levelUsdc = level.price * level.size;   // USDC available at this level
    const fillUsdc = Math.min(remainingUsdc, levelUsdc);
    const fillShares = fillUsdc / level.price;

    totalCost += fillUsdc;
    totalShares += fillShares;
    depthUsdc += levelUsdc;
    remainingUsdc -= fillUsdc;
  }

  if (totalShares <= 0 || totalCost <= 0) {
    return { available: false, avgFillPrice: 0, slippageBps: 0, filledUsdc: 0, totalShares: 0, depthUsdc };
  }

  const avgFillPrice = totalCost / totalShares;

  // Slippage: how far fill price deviated from mid
  // BUY: fill above mid = positive slippage (adverse)
  // SELL: fill below mid = positive slippage (adverse)
  const priceDeviation = side === "BUY"
    ? avgFillPrice - midPrice
    : midPrice - avgFillPrice;
  const slippageBps = midPrice > 0
    ? Math.round((priceDeviation / midPrice) * 10000)
    : 0;

  const notFilled = remainingUsdc > 0.01; // 1¢ threshold for "incomplete fill"

  return {
    available: !notFilled && slippageBps <= MAX_SIMULATED_SLIPPAGE_BPS,
    avgFillPrice: Math.round(avgFillPrice * 10000) / 10000,
    slippageBps,
    filledUsdc: totalCost,
    totalShares: Math.round(totalShares * 10000) / 10000,
    depthUsdc: Math.round(depthUsdc * 100) / 100,
  };
}

// ─── Fee model ───────────────────────────────────────────────────────────────

/**
 * Estimate Polymarket trading fees for a given notional size.
 * Currently 0% (Polymarket removed fees), but modeled explicitly for
 * future-proofing and Phase 2 accuracy.
 */
export function estimatePolymarketFees(sizeUsdc: number): number {
  return Math.round(sizeUsdc * (POLYMARKET_TAKER_FEE_BPS / 10000) * 100) / 100;
}

/**
 * Apply fee to fill price to get the all-in cost per share.
 *
 * BUY:  net cost per share = fillPrice × (1 + fee_bps / 10000)
 * SELL: net proceeds per share = fillPrice × (1 − fee_bps / 10000)
 *
 * With POLYMARKET_TAKER_FEE_BPS = 0, returns fillPrice unchanged.
 * When fees are reinstated, update POLYMARKET_TAKER_FEE_BPS — all
 * callers automatically reflect accurate all-in pricing.
 */
export function applyFeeToCost(fillPrice: number, side: "YES" | "NO", feeBps: number): number {
  if (feeBps === 0) return Math.round(fillPrice * 10000) / 10000;
  const feeMultiplier = side === "YES"
    ? 1 + feeBps / 10000   // BUY: more expensive
    : 1 - feeBps / 10000;  // SELL: less proceeds
  return Math.round(fillPrice * feeMultiplier * 10000) / 10000;
}

// ─── Orderbook fetch ─────────────────────────────────────────────────────────

interface RawClobLevel {
  price: string;
  size: string;
}

interface RawClobBook {
  bids?: RawClobLevel[];
  asks?: RawClobLevel[];
}

export interface ClobOrderbook {
  bids: ClobLevel[];
  asks: ClobLevel[];
  midPrice: number | null;
}

/**
 * Fetch and parse the CLOB V2 orderbook for a given token_id (YES side).
 * Returns null on network failure or malformed response.
 */
export async function fetchPolymarketOrderbook(tokenId: string): Promise<ClobOrderbook | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLOB_TIMEOUT_MS);
  try {
    const res = await fetch(`${CLOB_API}/book?token_id=${tokenId}`, { signal: controller.signal });
    if (!res.ok) return null;

    const raw: RawClobBook = await res.json();

    const bids: ClobLevel[] = (raw.bids ?? [])
      .map(l => ({ price: Number(l.price), size: Number(l.size) }))
      .filter(l => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.size) && l.size > 0);

    const asks: ClobLevel[] = (raw.asks ?? [])
      .map(l => ({ price: Number(l.price), size: Number(l.size) }))
      .filter(l => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.size) && l.size > 0);

    // Compute mid price: (best_bid + best_ask) / 2
    const bestBid = bids.length > 0 ? Math.max(...bids.map(l => l.price)) : null;
    const bestAsk = asks.length > 0 ? Math.min(...asks.map(l => l.price)) : null;
    const midPrice = (bestBid !== null && bestAsk !== null && bestAsk > bestBid)
      ? (bestBid + bestAsk) / 2
      : null;

    return { bids, asks, midPrice };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── PolymarketVenue ─────────────────────────────────────────────────────────

/**
 * Polymarket CLOB V2 execution venue.
 *
 * Phase 1 (Shadow): quote() fetches real orderbook + walks depth.
 *                   submit() simulates fill, records to shadow_orders.
 * Phase 2 (Live):   submit() signs EIP-712 order + POSTs to CLOB V2 API.
 *                   Not yet implemented — throws if mode="live".
 */
export class PolymarketVenue implements ExecutionVenue {
  readonly name = "polymarket-v2";

  constructor(
    readonly mode: "shadow" | "live",
    private readonly db?: D1Database,
  ) {
    if (mode === "live") {
      // Safety guard: live mode not implemented yet (Phase 2)
      throw new Error(
        "PolymarketVenue live mode is not yet implemented (ALPHA-001 Phase 2). " +
        "Use mode='shadow' for Phase 1.",
      );
    }
  }

  async quote(intent: OrderIntent): Promise<QuoteResult> {
    const tokenId = intent.tokenId;

    if (!tokenId) {
      // Fall back to simulated quote when token_id not available
      return simulatedQuote(intent);
    }

    const book = await fetchPolymarketOrderbook(tokenId);
    if (!book || book.midPrice === null) {
      return simulatedQuote(intent);
    }

    // Map side to orderbook side
    // YES buyer → takes asks; NO buyer (selling YES) → takes bids
    const clobSide: "BUY" | "SELL" = intent.side === "YES" ? "BUY" : "SELL";
    const levels = clobSide === "BUY" ? book.asks : book.bids;

    const fill = walkClobFill(clobSide, intent.sizeUsdc, levels, book.midPrice);
    const fees = estimatePolymarketFees(intent.sizeUsdc);

    // All-in fill price: raw fill price + fee spread (cost to trader)
    // BUY: net cost per share = avgFillPrice * (1 + fee_bps/10000)
    // SELL: net proceeds per share = avgFillPrice * (1 - fee_bps/10000)
    // Currently fee = 0%, so no numeric change — interface ready for non-zero fees.
    const allInFillPrice = applyFeeToCost(fill.avgFillPrice, intent.side, POLYMARKET_TAKER_FEE_BPS);

    return {
      fundId: intent.fundId,
      marketId: intent.marketId,
      side: intent.side,
      estimatedFillPrice: allInFillPrice,
      estimatedSlippage: fill.slippageBps,
      estimatedFees: fees,
      available: fill.available,
      reason: fill.available ? undefined : "insufficient_depth_or_slippage",
      orderbookDepth: fill.depthUsdc,
      source: "clob_orderbook",
    };
  }

  async submit(intent: OrderIntent): Promise<OrderResult> {
    if (this.mode === "live") {
      // Phase 2 placeholder
      throw new Error("live mode not implemented — ALPHA-001 Phase 2");
    }

    // Shadow mode: get real quote, record to shadow_orders (if db available)
    const venueQuote = await this.quote(intent);
    const orderId = crypto.randomUUID();

    const status = venueQuote.available ? "SHADOW_FILL" : "SHADOW_REJECT";
    const fillPrice = venueQuote.available ? venueQuote.estimatedFillPrice : 0;
    const fillShares = (fillPrice > 0) ? intent.sizeUsdc / fillPrice : 0;
    const paperEntryPrice = intent.priceCents / 100;

    if (this.db) {
      await recordShadowVenueOrder(this.db, intent, venueQuote, orderId, status);
    }

    return {
      orderId,
      status,
      fillPrice,
      fillShares: Math.round(fillShares * 10000) / 10000,
      fees: venueQuote.estimatedFees,
      shadowData: {
        paperEntryPrice,
        venueEstimatedFillPrice: venueQuote.estimatedFillPrice,
        orderbookDepth: venueQuote.orderbookDepth ?? 0,
        source: venueQuote.source,
      },
    };
  }
}

// ─── Simulated quote fallback ─────────────────────────────────────────────────

/**
 * Fallback quote when CLOB API is unavailable or token_id is missing.
 * Uses the same simplified model as the legacy simulateClob() in execution.ts,
 * but expressed in the QuoteResult contract.
 */
function simulatedQuote(intent: OrderIntent): QuoteResult {
  const entryPrice = intent.priceCents / 100;
  const slippageBps = Math.round(Math.min(intent.sizeUsdc * 0.001, 20)); // max 20bps
  const direction = intent.side === "YES" ? 1 : -1;
  const fillPrice = Math.max(0.001, Math.min(0.999, entryPrice * (1 + direction * slippageBps / 10000)));

  return {
    fundId: intent.fundId,
    marketId: intent.marketId,
    side: intent.side,
    estimatedFillPrice: applyFeeToCost(fillPrice, intent.side, POLYMARKET_TAKER_FEE_BPS),
    estimatedSlippage: slippageBps,
    estimatedFees: estimatePolymarketFees(intent.sizeUsdc),
    available: true,
    orderbookDepth: undefined,
    source: "simulated",
  };
}

// ─── Shadow order recording with venue quote ─────────────────────────────────

/**
 * Record a shadow order with venue-quality fill estimate to D1.
 *
 * Stores both the paper entry price (intent.priceCents / 100) and the
 * venue-estimated fill price (venueQuote.estimatedFillPrice) so Phase 1
 * shadow vs paper calibration can compare them.
 *
 * Shadow_orders table columns used:
 *   price                → paper entry price (original signal price)
 *   simulated_fill_price → venue estimated fill price (real or simulated orderbook)
 *   simulated_slippage   → estimated slippage in bps (signed)
 *   order_type           → "LIMIT" (shadow orders are always limit)
 *   status               → "WOULD_FILL" | "WOULD_REJECT" | "WOULD_PARTIAL"
 */
async function recordShadowVenueOrder(
  db: D1Database,
  intent: OrderIntent,
  venueQuote: QuoteResult,
  orderId: string,
  status: "SHADOW_FILL" | "SHADOW_REJECT",
): Promise<void> {
  const side: "BUY" | "SELL" = intent.side === "YES" ? "BUY" : "SELL";
  const clobStatus = status === "SHADOW_FILL" ? "WOULD_FILL" : "WOULD_REJECT";
  const paperEntryPrice = intent.priceCents / 100;
  const direction = intent.side === "YES" ? "BUY_YES" : "SELL_YES";

  // Derive shares from USDC / entry price (paper convention)
  const shares = paperEntryPrice > 0
    ? Math.round((intent.sizeUsdc / paperEntryPrice) * 1000) / 1000
    : 0;

  await db.prepare(
    `INSERT OR IGNORE INTO shadow_orders
     (id, paper_trade_id, fund_id, market_id, slug, question, direction, side,
      shares, price, order_type, status, simulated_fill_price, simulated_slippage, created_at)
     VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, 'LIMIT', ?, ?, ?, ?)`,
  ).bind(
    orderId,
    intent.fundId,
    intent.marketId,
    "",    // slug — caller sets this if needed; PolymarketVenue doesn't have it
    "",    // question — same
    direction,
    side,
    shares,
    paperEntryPrice,
    clobStatus,
    venueQuote.estimatedFillPrice,
    venueQuote.estimatedSlippage,
    new Date().toISOString(),
  ).run();
}
