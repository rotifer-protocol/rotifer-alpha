/**
 * PolymarketVenue — Polymarket CLOB V2 Execution Venue (ALPHA-001 §7)
 *
 * Shadow mode (Phase 1):
 *   quote() fetches real CLOB V2 orderbook, walks depth to estimate fill price.
 *   submit() records to shadow_orders — no real orders submitted.
 *
 * Live mode (Phase 2):
 *   submit() builds + EIP-712 signs an order, posts to CLOB V2 as FOK.
 *   Uses EOA signing (signatureType=0), records outcome to live_orders.
 *   Requires OWNER_PRIVATE_KEY Worker secret.
 *
 * Design principles:
 *  - walkClobFill() is a pure function (no I/O) for testability
 *  - All async I/O is isolated in fetchOrderbook(), submit(), and live helpers
 *  - Slippage guard: pre-flight check before live order submission
 *  - Fees: 0% currently (Polymarket removed fees); constant POLYMARKET_TAKER_FEE_BPS
 *    is kept for future-proofing and explicit modeling
 */

import type { ExecutionVenue, OrderIntent, QuoteResult, OrderResult } from "./venue.js";
import {
  buildOrderAmounts,
  buildSignedOrderV2,
  privateKeyToWalletAddress,
  CTF_EXCHANGE_V2,
} from "./polymarket-signer.js";
import {
  loadOrDeriveApiCreds,
  buildL2Headers,
} from "./polymarket-api-creds.js";
import {
  createLiveOrder,
  updateLiveOrderStatus,
} from "./order-lifecycle.js";

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

/**
 * Shadow mode caps simulated order size to Phase 2's maxSingleTradeUsdc.
 * Paper trades can be $5k–$200k+, but real Phase 2 orders are ≤ $20.
 * Without this cap, shadow fill rate reflects orderbook depth for unrealistically
 * large orders and underestimates Phase 2 real-world fillability.
 */
const SHADOW_SIZE_CAP_USDC = 20;

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
 * Phase 2 (Live):   submit() builds EIP-712 signed FOK order, posts to CLOB V2.
 *                   Requires ownerPrivateKey + walletAddress.
 *                   Uses signatureType=0 (EOA), no heartbeat (FOK is immediate).
 */
export class PolymarketVenue implements ExecutionVenue {
  readonly name = "polymarket-v2";

  /** Resolved wallet address — lazily derived from ownerPrivateKey if not provided. */
  private readonly resolvedWalletAddress: string | undefined;

  constructor(
    readonly mode: "shadow" | "live",
    private readonly db?: D1Database,
    private readonly ownerPrivateKey?: string,
    walletAddress?: string,
  ) {
    if (mode === "live") {
      if (!ownerPrivateKey) {
        throw new Error(
          "PolymarketVenue live mode requires ownerPrivateKey. " +
          "Set OWNER_PRIVATE_KEY Worker secret and pass it to the constructor.",
        );
      }
      if (!db) {
        throw new Error("PolymarketVenue live mode requires D1 database binding.");
      }
      this.resolvedWalletAddress = walletAddress ?? privateKeyToWalletAddress(ownerPrivateKey);
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

    // Shadow mode: cap simulated size to Phase 2 max trade size.
    // This makes fill rate reflect what real $20 orders would experience.
    const effectiveSize = this.mode === "shadow"
      ? Math.min(intent.sizeUsdc, SHADOW_SIZE_CAP_USDC)
      : intent.sizeUsdc;

    // Map side to orderbook side
    // YES buyer → takes asks; NO buyer (selling YES) → takes bids
    const clobSide: "BUY" | "SELL" = intent.side === "YES" ? "BUY" : "SELL";
    const levels = clobSide === "BUY" ? book.asks : book.bids;

    const fill = walkClobFill(clobSide, effectiveSize, levels, book.midPrice);
    const fees = estimatePolymarketFees(effectiveSize);

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
      return this.submitLive(intent);
    }
    return this.submitShadow(intent);
  }

  // ─── Shadow submit ──────────────────────────────────────────────────────────

  private async submitShadow(intent: OrderIntent): Promise<OrderResult> {
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

  // ─── Live submit (Phase 2 · P2.5) ──────────────────────────────────────────

  /**
   * Submit a live FOK order to Polymarket CLOB V2.
   *
   * Flow:
   *   1. Pre-flight slippage check via real orderbook quote
   *   2. Build + EIP-712 sign V2 order (EOA, signatureType=0)
   *   3. Derive/load API credentials from D1 (L1 auth, cached 72h)
   *   4. Build L2 HMAC auth headers
   *   5. POST /order as FOK (Fill-Or-Kill, no resting order, no heartbeat needed)
   *   6. Parse CLOB response → FILLED / REJECTED
   *   7. Persist to live_orders D1 table
   *
   * Phase 2 constraints:
   *   - FOK only (no GTC/GTD heartbeat — Durable Object path is Phase 3)
   *   - EOA signing only (signatureType=0; POLY_1271 deposit wallet = Phase 3)
   *   - Neg Risk markets are skipped with REJECTED (untested contract path)
   *   - tokenId required; orders without token_id are skipped
   */
  private async submitLive(intent: OrderIntent): Promise<OrderResult> {
    const db = this.db!;
    const privateKey = this.ownerPrivateKey!;
    const walletAddress = this.resolvedWalletAddress!;
    const localOrderId = crypto.randomUUID();

    // Phase 2: skip Neg Risk markets (multi-outcome, different exchange contract)
    if (intent.negRisk) {
      await this.recordLiveRejection(db, localOrderId, intent, 0, "neg_risk_not_supported_phase2");
      return { orderId: localOrderId, status: "REJECTED", fillPrice: 0, fillShares: 0, fees: 0 };
    }

    // tokenId is required to sign the order
    if (!intent.tokenId) {
      await this.recordLiveRejection(db, localOrderId, intent, 0, "missing_token_id");
      return { orderId: localOrderId, status: "REJECTED", fillPrice: 0, fillShares: 0, fees: 0 };
    }

    // ── 1. Pre-flight: check orderbook quote + slippage ─────────────────────
    const quote = await this.quote(intent);
    if (!quote.available || quote.estimatedSlippage > intent.maxSlippageBps) {
      const reason = quote.available ? "slippage_exceeded" : "insufficient_depth";
      await this.recordLiveRejection(db, localOrderId, intent, 0, reason);
      return { orderId: localOrderId, status: "REJECTED", fillPrice: 0, fillShares: 0, fees: 0 };
    }

    // ── 2. Build order amounts ──────────────────────────────────────────────
    const amounts = buildOrderAmounts(intent.side, intent.sizeUsdc, intent.priceCents);

    // ── 3. Sign EIP-712 V2 order ────────────────────────────────────────────
    let signedOrder;
    try {
      signedOrder = await buildSignedOrderV2(privateKey, intent.tokenId, amounts, CTF_EXCHANGE_V2);
    } catch {
      await this.recordLiveRejection(db, localOrderId, intent, amounts.sharesHuman, "sign_failed");
      return { orderId: localOrderId, status: "REJECTED", fillPrice: 0, fillShares: 0, fees: 0 };
    }

    // ── 4. Load API credentials (L1 derive → D1 cache) ─────────────────────
    let creds;
    try {
      creds = await loadOrDeriveApiCreds(db, privateKey, walletAddress);
    } catch {
      await this.recordLiveRejection(db, localOrderId, intent, amounts.sharesHuman, "creds_unavailable");
      return { orderId: localOrderId, status: "REJECTED", fillPrice: 0, fillShares: 0, fees: 0 };
    }

    // ── 5. POST /order (FOK) ────────────────────────────────────────────────
    const postBody = JSON.stringify({
      order:     signedOrder,
      owner:     creds.apiKey,
      orderType: "FOK",
    });

    let clobOrderId: string | undefined;
    let clobStatus: string | undefined;
    let httpStatus = 0;

    try {
      const headers = await buildL2Headers(walletAddress, creds, "POST", "/order", postBody);
      const res = await fetch(`${CLOB_API}/order`, {
        method:  "POST",
        headers,
        body:    postBody,
        signal:  AbortSignal.timeout(CLOB_TIMEOUT_MS),
      });
      httpStatus = res.status;
      if (res.ok) {
        const json = await res.json() as { orderID?: string; status?: string };
        clobOrderId = json.orderID;
        clobStatus  = json.status; // "matched" | "live" | "delayed" | "unmatched"
      }
    } catch {
      // Network error or timeout — fall through to rejection path
    }

    // ── 6. Persist to live_orders ───────────────────────────────────────────
    await createLiveOrder(db, {
      id:           localOrderId,
      paperTradeId: "",  // caller links to paper trade after this returns
      fundId:       intent.fundId,
      marketId:     intent.marketId,
      tokenId:      intent.tokenId,
      side:         intent.side === "YES" ? "BUY" : "SELL",
      sizeUsdc:     intent.sizeUsdc,
      limitPrice:   intent.priceCents / 100,
      shares:       amounts.sharesHuman,
    });

    // FOK "matched" or "live" → consider filled; everything else → rejected
    const filled =
      httpStatus >= 200 && httpStatus < 300 &&
      (clobStatus === "matched" || clobStatus === "live");

    if (filled) {
      const fillPrice  = quote.estimatedFillPrice;
      const fillShares = amounts.sharesHuman;
      await updateLiveOrderStatus(db, localOrderId, {
        status:       "FILLED",
        filledUsdc:   intent.sizeUsdc,
        filledShares: fillShares,
        avgFillPrice: fillPrice,
        feeUsdc:      0,
        clobOrderId,
        filledAt:     new Date().toISOString(),
      });
      return { orderId: localOrderId, status: "FILLED", fillPrice, fillShares, fees: 0 };
    }

    await updateLiveOrderStatus(db, localOrderId, {
      status:       "REJECTED",
      clobOrderId,
      cancelReason: clobStatus ? `clob:${clobStatus}` : `http:${httpStatus}`,
    });
    return { orderId: localOrderId, status: "REJECTED", fillPrice: 0, fillShares: 0, fees: 0 };
  }

  /** Record a pre-submission rejection to live_orders without hitting the API. */
  private async recordLiveRejection(
    db: D1Database,
    orderId: string,
    intent: OrderIntent,
    sharesHuman: number,
    reason: string,
  ): Promise<void> {
    await createLiveOrder(db, {
      id:           orderId,
      paperTradeId: "",
      fundId:       intent.fundId,
      marketId:     intent.marketId,
      tokenId:      intent.tokenId,
      side:         intent.side === "YES" ? "BUY" : "SELL",
      sizeUsdc:     intent.sizeUsdc,
      limitPrice:   intent.priceCents / 100,
      shares:       sharesHuman,
    });
    await updateLiveOrderStatus(db, orderId, { status: "REJECTED", cancelReason: reason });
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
