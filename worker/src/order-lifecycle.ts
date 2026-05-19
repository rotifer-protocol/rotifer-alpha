/**
 * Order Lifecycle Gene  (polymarket-order-lifecycle)
 * Rotifer Protocol Gene — ALPHA-001 §10 G2
 *
 * Manages the lifecycle of limit orders placed on Polymarket CLOB V2.
 *
 * Phase 1 (Shadow): pure decision logic + shadow order settlement tracking.
 *   Shadow orders are instant estimates; GTC management isn't needed.
 *   This module records actual outcomes when paper trades settle, enabling
 *   Phase 1 prediction accuracy analysis.
 *
 * Phase 2 (Live): Gene drives real order management:
 *   - Poll CLOB V2 for order status
 *   - Cancel GTC orders that exceed gtcMaxWaitMinutes
 *   - Accept partial fills meeting partialFillThresholdPct
 *   - Update limit price when market drifts beyond priceUpdateThresholdBps
 *
 * Gene design: all decision logic is pure (no I/O) for:
 *   - Testability (injected nowMs, no Date.now() inside)
 *   - Future extraction as standalone Rotifer Protocol Gene
 *   - Evolution: evolvable params wired to PARAM_BOUNDS_INVARIANT
 */

// ── Evolvable Gene Parameters ────────────────────────────────────────────────

export interface OrderLifecycleParams {
  /** Cancel GTC order if not filled within this many minutes. Default: 30. */
  gtcMaxWaitMinutes: number;
  /** Accept partial fill if at least this percentage of size is filled. Default: 80. */
  partialFillThresholdPct: number;
  /** Update limit price if market moves by at least this many bps in our favor. Default: 50. */
  priceUpdateThresholdBps: number;
}

export const DEFAULT_ORDER_LIFECYCLE_PARAMS: OrderLifecycleParams = {
  gtcMaxWaitMinutes: 30,
  partialFillThresholdPct: 80,
  priceUpdateThresholdBps: 50,
};

// ── Gene I/O Contracts ───────────────────────────────────────────────────────

export type OrderLifecycleAction = "HOLD" | "CANCEL" | "ACCEPT_PARTIAL" | "UPDATE_PRICE";

export interface OrderLifecycleDecision {
  action: OrderLifecycleAction;
  reason: string;
  /** Only present when action = "UPDATE_PRICE" */
  newLimitPrice?: number;
}

export interface OrderLifecycleInput {
  orderId: string;
  submittedAt: string;         // ISO timestamp
  side: "BUY" | "SELL";
  limitPrice: number;          // 0–1
  currentMarketPrice: number;  // 0–1, latest market mid
  sizeUsdc: number;
  filledUsdc: number;
  params?: Partial<OrderLifecycleParams>;
}

// ── Core Decision Logic (pure, testable) ─────────────────────────────────────

/**
 * Decide what to do with an open GTC limit order.
 *
 * Pure function — no I/O, no side effects. `nowMs` is injected for
 * deterministic tests. Callers pass `Date.now()` in production.
 *
 * Returns a Decision with an action and machine-readable reason.
 */
export function decideOrderLifecycle(
  input: OrderLifecycleInput,
  nowMs: number,
): OrderLifecycleDecision {
  const params: OrderLifecycleParams = {
    ...DEFAULT_ORDER_LIFECYCLE_PARAMS,
    ...input.params,
  };

  const submittedMs = new Date(input.submittedAt).getTime();
  if (Number.isNaN(submittedMs)) {
    return { action: "CANCEL", reason: "invalid_submitted_at" };
  }

  const elapsedMinutes = (nowMs - submittedMs) / 60_000;
  const fillPct = input.sizeUsdc > 0 ? (input.filledUsdc / input.sizeUsdc) * 100 : 0;

  // Fully filled — nothing to decide
  if (fillPct >= 100) {
    return { action: "HOLD", reason: "fully_filled" };
  }

  // GTC timeout check
  if (elapsedMinutes >= params.gtcMaxWaitMinutes) {
    if (fillPct >= params.partialFillThresholdPct) {
      return {
        action: "ACCEPT_PARTIAL",
        reason: `timeout_with_partial_fill_${Math.round(fillPct)}pct`,
      };
    }
    return { action: "CANCEL", reason: "max_wait_exceeded" };
  }

  // Favorable market drift: market moved toward a better price for us
  if (input.currentMarketPrice > 0 && input.limitPrice > 0) {
    const priceDriftBps = Math.abs(
      ((input.currentMarketPrice - input.limitPrice) / input.limitPrice) * 10000,
    );
    const marketFavorable =
      (input.side === "BUY" && input.currentMarketPrice < input.limitPrice) ||
      (input.side === "SELL" && input.currentMarketPrice > input.limitPrice);

    if (marketFavorable && priceDriftBps >= params.priceUpdateThresholdBps) {
      const newLimitPrice = Math.round(input.currentMarketPrice * 10000) / 10000;
      return {
        action: "UPDATE_PRICE",
        reason: `market_drifted_${Math.round(priceDriftBps)}bps_favorable`,
        newLimitPrice,
      };
    }
  }

  return { action: "HOLD", reason: "within_params" };
}

// ── Shadow Settlement Tracking (Phase 1) ─────────────────────────────────────

/**
 * Record the actual market outcome of a shadow order when its paper trade
 * settles. Enables Phase 1 prediction accuracy analysis:
 *   - Was WOULD_FILL correct? (actual_exit_price vs simulated_fill_price)
 *   - How accurate was slippage estimation?
 *
 * @returns number of shadow_orders rows updated (0–N)
 */
export async function settleShadowOrderForTrade(
  db: D1Database,
  paperTradeId: string,
  actualExitPrice: number,
): Promise<number> {
  const result = await db.prepare(
    `UPDATE shadow_orders
     SET settled_at = ?,
         actual_exit_price = ?
     WHERE paper_trade_id = ?
       AND settled_at IS NULL`,
  ).bind(new Date().toISOString(), actualExitPrice, paperTradeId).run();

  return result.meta?.changes ?? 0;
}

// ── Live Order CRUD (Phase 2 foundation) ─────────────────────────────────────

export interface LiveOrderRecord {
  id: string;
  paperTradeId: string;
  shadowOrderId?: string;
  fundId: string;
  marketId: string;
  tokenId?: string;
  side: "BUY" | "SELL";
  sizeUsdc: number;
  limitPrice: number;
  shares: number;
  expiresAt?: string;
}

/**
 * Persist a new live order to D1.
 * Phase 1: called with stub data to test the schema.
 * Phase 2: called after CLOB V2 order submission succeeds.
 */
export async function createLiveOrder(
  db: D1Database,
  order: LiveOrderRecord,
): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO live_orders
     (id, paper_trade_id, shadow_order_id, fund_id, market_id, token_id,
      side, size_usdc, limit_price, shares, status, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
  ).bind(
    order.id,
    order.paperTradeId,
    order.shadowOrderId ?? null,
    order.fundId,
    order.marketId,
    order.tokenId ?? null,
    order.side,
    order.sizeUsdc,
    order.limitPrice,
    order.shares,
    order.expiresAt ?? null,
    new Date().toISOString(),
    new Date().toISOString(),
  ).run();
}

export type LiveOrderStatus =
  | "PENDING"
  | "OPEN"
  | "FILLED"
  | "PARTIAL"
  | "CANCELLED"
  | "EXPIRED"
  | "REJECTED";

export interface LiveOrderUpdate {
  status: LiveOrderStatus;
  filledUsdc?: number;
  filledShares?: number;
  avgFillPrice?: number;
  feeUsdc?: number;
  clobOrderId?: string;
  cancelReason?: string;
  filledAt?: string;
  cancelledAt?: string;
}

/**
 * Update live order status after a CLOB V2 polling cycle.
 * Phase 2: called by the order status poller.
 * Phase 1: not used (all orders are shadow).
 */
export async function updateLiveOrderStatus(
  db: D1Database,
  orderId: string,
  update: LiveOrderUpdate,
): Promise<void> {
  await db.prepare(
    `UPDATE live_orders
     SET status           = ?,
         filled_usdc      = COALESCE(?, filled_usdc),
         filled_shares    = COALESCE(?, filled_shares),
         avg_fill_price   = COALESCE(?, avg_fill_price),
         fee_usdc         = COALESCE(?, fee_usdc),
         clob_order_id    = COALESCE(?, clob_order_id),
         cancel_reason    = COALESCE(?, cancel_reason),
         filled_at        = COALESCE(?, filled_at),
         cancelled_at     = COALESCE(?, cancelled_at),
         updated_at       = ?
     WHERE id = ?`,
  ).bind(
    update.status,
    update.filledUsdc ?? null,
    update.filledShares ?? null,
    update.avgFillPrice ?? null,
    update.feeUsdc ?? null,
    update.clobOrderId ?? null,
    update.cancelReason ?? null,
    update.filledAt ?? null,
    update.cancelledAt ?? null,
    new Date().toISOString(),
    orderId,
  ).run();
}
