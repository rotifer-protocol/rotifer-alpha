/**
 * ExecutionVenue — L3 Execution Layer Abstraction (ALPHA-001 §4.1)
 *
 * Separates "what to trade" (Gene / PBT decision layer) from "how to execute"
 * (exchange-specific submission, signing, order management).
 *
 * Phase 1: PaperVenue (existing) + PolymarketVenue(mode="shadow")
 * Phase 2: PolymarketVenue(mode="live") with real EIP-712 + CLOB V2
 * Phase 3: KalshiVenue (future)
 */

// ─── OrderIntent — the only output from the Fund Decision Layer ─────────────

/**
 * An intent to open a position, produced by the Gene / paperTrade() layer.
 * ExecutionVenue is responsible for converting this into actual market activity.
 */
export interface OrderIntent {
  fundId: string;
  marketId: string;      // Polymarket effectiveMarketId (condition_id or market_id)
  tokenId?: string;      // CLOB token_id for the YES side; venue resolves if absent
  side: "YES" | "NO";   // YES = buying YES tokens; NO = selling YES (buying NO)
  sizeUsdc: number;      // notional in USDC
  priceCents: number;    // entry price as integer cents 0–100 (e.g. 45 = $0.45)
  maxSlippageBps: number; // max acceptable slippage in basis points (100 = 1%)
  expiresAt?: number;    // Unix timestamp for GTC; absent = immediate or cancel
}

// ─── QuoteResult — what the venue expects will happen ───────────────────────

/**
 * The venue's estimate before order submission.
 * In shadow mode this is the simulation result stored to shadow_orders.
 */
export interface QuoteResult {
  fundId: string;
  marketId: string;
  side: "YES" | "NO";
  estimatedFillPrice: number;   // 0–1 probability units
  estimatedSlippage: number;    // signed bps (positive = worse for buyer)
  estimatedFees: number;        // USDC amount (maker/taker fee)
  available: boolean;           // false if orderbook has insufficient depth
  reason?: string;              // why unavailable, if applicable
  orderbookDepth?: number;      // total USDC liquidity at or better than quoted price
  source: "clob_orderbook" | "simulated";  // how the quote was computed
}

// ─── OrderResult — what actually happened (or was simulated to happen) ──────

export type OrderStatus =
  | "FILLED"         // fully executed (live mode)
  | "PARTIAL"        // partially filled (live mode, GTC may continue)
  | "REJECTED"       // venue rejected (slippage exceeded, book empty, etc.)
  | "SHADOW_FILL"    // shadow mode: would have filled
  | "SHADOW_REJECT"  // shadow mode: would have been rejected
  | "PAPER";         // paper mode: direct DB insert, no venue interaction

export interface OrderResult {
  orderId: string;
  status: OrderStatus;
  fillPrice: number;   // 0–1; 0 if rejected
  fillShares: number;
  fees: number;        // USDC
  /** Populated in shadow mode for calibration tracking */
  shadowData?: {
    paperEntryPrice: number;      // what paperTrade() thought the price was
    venueEstimatedFillPrice: number;
    orderbookDepth: number;
    source: "clob_orderbook" | "simulated";
  };
}

// ─── ExecutionVenue interface ────────────────────────────────────────────────

/**
 * The execution venue contract. Every trading platform must implement this.
 *
 * Gene layer MUST NOT import platform-specific code directly —
 * all platform coupling lives inside venue implementations.
 */
export interface ExecutionVenue {
  readonly name: string;
  readonly mode: "paper" | "shadow" | "live";

  /**
   * Get a price quote from the venue without submitting an order.
   * Used for shadow calibration and pre-submission slippage check.
   */
  quote(intent: OrderIntent): Promise<QuoteResult>;

  /**
   * Submit an order to the venue (or simulate submission in shadow mode).
   * In live mode: signs and submits to the actual CLOB API.
   * In shadow mode: returns simulated result, records to shadow_orders.
   * In paper mode: direct D1 insert, no venue interaction.
   */
  submit(intent: OrderIntent): Promise<OrderResult>;
}
