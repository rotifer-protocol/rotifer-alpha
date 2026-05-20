/**
 * Circuit Breaker Gene  (polymarket-circuit-breaker)
 * Rotifer Protocol Gene — ALPHA-001 §9
 *
 * Prevents catastrophic single-epoch loss during Phase 2 live trading.
 * Tracks each fund's cumulative realized loss per epoch; trips if the loss
 * exceeds circuitBreakerThresholdPct of epoch-start capital.
 *
 * Phase 1 (Shadow): CB is tracked but does NOT block trades.
 *   Shadow orders don't use real money; tracking provides pre-live validation.
 *
 * Phase 2 (Live): CB blocks real order submission if tripped.
 *   Operator must reset via /api/circuit-breaker/reset or wait for next epoch.
 *
 * Gene design (Rotifer Protocol):
 *   - checkCircuitBreaker() is a pure function (no I/O, injected state)
 *   - DB functions are side-effect isolated
 *   - thresholdPct is a HARD SAFETY FLOOR, NOT an evolvable Gene parameter —
 *     funds must not self-tune their own safety limits
 *
 * Epoch = 24h rolling window. Reset by daily 01:00 UTC cron (index.ts).
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** Default circuit breaker threshold: trip if fund loses >20% of epoch capital. */
export const DEFAULT_CB_THRESHOLD_PCT = 20;

// ── Pure decision logic (Gene core, testable) ────────────────────────────────

export interface CircuitBreakerState {
  fundId: string;
  epochStartUsdc: number;
  epochLossUsdc: number;
  tripped: boolean;
  trippedAt?: string;
}

export interface CircuitBreakerCheck {
  blocked: boolean;
  reason?: string;
  epochLossPct: number;
  thresholdPct: number;
}

/**
 * Check whether a fund's circuit breaker is blocking new trades.
 *
 * Pure function: all inputs are explicit. No I/O.
 *
 * @param state    current CB state for this fund
 * @param thresholdPct  loss % that trips the breaker (hard floor, not evolved)
 * @param newLossUsdc   additional loss about to be recorded (0 for pre-trade checks)
 */
export function checkCircuitBreaker(
  state: CircuitBreakerState,
  thresholdPct: number,
  newLossUsdc = 0,
): CircuitBreakerCheck {
  if (state.tripped) {
    return {
      blocked: true,
      reason: `circuit_breaker_tripped_at_${state.trippedAt ?? "unknown"}`,
      epochLossPct: state.epochStartUsdc > 0
        ? (state.epochLossUsdc / state.epochStartUsdc) * 100
        : 0,
      thresholdPct,
    };
  }

  const projectedLoss = state.epochLossUsdc + newLossUsdc;
  const epochLossPct = state.epochStartUsdc > 0
    ? (projectedLoss / state.epochStartUsdc) * 100
    : 0;

  if (epochLossPct >= thresholdPct) {
    return {
      blocked: true,
      reason: `epoch_loss_${epochLossPct.toFixed(1)}pct_exceeds_threshold_${thresholdPct}pct`,
      epochLossPct,
      thresholdPct,
    };
  }

  return { blocked: false, epochLossPct, thresholdPct };
}

// ── DB functions (side-effect isolated) ─────────────────────────────────────

/**
 * Ensure a circuit_breaker_state row exists for a fund.
 * Sets epoch_start_usdc to the fund's current balance if creating for the first time.
 */
export async function ensureCircuitBreakerState(
  db: D1Database,
  fundId: string,
  currentBalanceUsdc: number,
): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO circuit_breaker_state
     (fund_id, epoch_start_usdc, epoch_loss_usdc, tripped, epoch_started_at, updated_at)
     VALUES (?, ?, 0, 0, ?, ?)`,
  ).bind(
    fundId,
    currentBalanceUsdc,
    new Date().toISOString(),
    new Date().toISOString(),
  ).run();
}

/**
 * Load circuit breaker state for a single fund.
 * Returns null if no row exists yet (fund hasn't traded this epoch).
 */
export async function loadCircuitBreakerState(
  db: D1Database,
  fundId: string,
): Promise<CircuitBreakerState | null> {
  const row = await db.prepare(
    `SELECT fund_id, epoch_start_usdc, epoch_loss_usdc, tripped, tripped_at
     FROM circuit_breaker_state
     WHERE fund_id = ?`,
  ).bind(fundId).first<{
    fund_id: string;
    epoch_start_usdc: number;
    epoch_loss_usdc: number;
    tripped: number;
    tripped_at: string | null;
  }>();

  if (!row) return null;

  return {
    fundId: row.fund_id,
    epochStartUsdc: Number(row.epoch_start_usdc),
    epochLossUsdc: Number(row.epoch_loss_usdc),
    tripped: row.tripped === 1,
    trippedAt: row.tripped_at ?? undefined,
  };
}

/**
 * Record a realized loss for a fund in the current epoch.
 * Automatically trips the breaker if threshold is exceeded.
 *
 * @param lossUsdc  positive number (the magnitude of the loss)
 * @param thresholdPct  e.g. 20 for 20%
 */
export async function recordCircuitBreakerLoss(
  db: D1Database,
  fundId: string,
  lossUsdc: number,
  thresholdPct = DEFAULT_CB_THRESHOLD_PCT,
): Promise<void> {
  if (lossUsdc <= 0) return; // only losses matter

  const now = new Date().toISOString();

  // Atomically increment epoch_loss_usdc and check if threshold exceeded
  await db.prepare(
    `UPDATE circuit_breaker_state
     SET epoch_loss_usdc = epoch_loss_usdc + ?,
         updated_at = ?
     WHERE fund_id = ?`,
  ).bind(lossUsdc, now, fundId).run();

  // Read back to check if we should trip
  const state = await loadCircuitBreakerState(db, fundId);
  if (!state || state.tripped) return;

  const check = checkCircuitBreaker(state, thresholdPct);
  if (check.blocked) {
    await db.prepare(
      `UPDATE circuit_breaker_state
       SET tripped = 1, tripped_at = ?, updated_at = ?
       WHERE fund_id = ? AND tripped = 0`,
    ).bind(now, now, fundId).run();
  }
}

/**
 * Reset all circuit breaker state at epoch start (daily cron).
 * Updates epoch_start_usdc to current balances; clears epoch_loss_usdc + tripped.
 *
 * @param fundBalances  Map<fundId, currentBalanceUsdc>
 */
export async function resetCircuitBreakerEpochs(
  db: D1Database,
  fundBalances: Map<string, number>,
): Promise<void> {
  const now = new Date().toISOString();

  for (const [fundId, balance] of fundBalances) {
    await db.prepare(
      `INSERT INTO circuit_breaker_state
         (fund_id, epoch_start_usdc, epoch_loss_usdc, tripped, epoch_started_at, updated_at)
       VALUES (?, ?, 0, 0, ?, ?)
       ON CONFLICT(fund_id) DO UPDATE SET
         epoch_start_usdc = excluded.epoch_start_usdc,
         epoch_loss_usdc  = 0,
         tripped          = 0,
         tripped_at       = NULL,
         epoch_started_at = excluded.epoch_started_at,
         updated_at       = excluded.updated_at`,
    ).bind(fundId, balance, now, now).run();
  }
}

/**
 * Operator-triggered manual reset for a single fund's circuit breaker.
 * Called via /api/circuit-breaker/reset (authenticated).
 */
export async function resetFundCircuitBreaker(
  db: D1Database,
  fundId: string,
): Promise<void> {
  await db.prepare(
    `UPDATE circuit_breaker_state
     SET epoch_loss_usdc = 0, tripped = 0, tripped_at = NULL, updated_at = ?
     WHERE fund_id = ?`,
  ).bind(new Date().toISOString(), fundId).run();
}

/**
 * Load all circuit breaker states for the /api/circuit-breaker endpoint.
 */
export async function loadAllCircuitBreakerStates(
  db: D1Database,
): Promise<CircuitBreakerState[]> {
  const rows = await db.prepare(
    `SELECT fund_id, epoch_start_usdc, epoch_loss_usdc, tripped, tripped_at
     FROM circuit_breaker_state
     ORDER BY fund_id`,
  ).all<{
    fund_id: string;
    epoch_start_usdc: number;
    epoch_loss_usdc: number;
    tripped: number;
    tripped_at: string | null;
  }>();

  return (rows.results ?? []).map(row => ({
    fundId: row.fund_id,
    epochStartUsdc: Number(row.epoch_start_usdc),
    epochLossUsdc: Number(row.epoch_loss_usdc),
    tripped: row.tripped === 1,
    trippedAt: row.tripped_at ?? undefined,
  }));
}
