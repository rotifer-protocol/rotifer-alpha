/**
 * Live P&L computation for Phase 2 live trading — ALPHA-PRD-001 §Phase 3 P&L card
 *
 * Data sources:
 *   1. D1 `live_orders`   — every submitted order with filled_usdc, side, status
 *   2. D1 `fund_wallets`  — initial_balance_usdc per fund (set at wallet registration time)
 *   3. Polymarket CLOB    — GET /data/balance?address=<addr> for current trading account balance
 *
 * P&L model (Phase 2, prediction-market specific):
 *   - "Deployed"  = cumulative pUSD spent on BUY fills
 *   - "Received"  = cumulative pUSD from SELL fills (pre-resolution exits)
 *   - "Net flow"  = deployed − received (net exposure)
 *   - "Balance Δ" = current_wallet_balance − initial_budget (true realised P&L,
 *                   includes market resolutions; requires Polymarket API)
 *
 * Notes:
 *   - Polymarket balance query is best-effort: card degrades gracefully when unavailable.
 *   - All USDC values are 6-decimal precision (pUSD = USDC.e on Polygon).
 */

const CLOB_API = "https://clob.polymarket.com";
const BALANCE_TIMEOUT_MS = 8_000;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface FundPnLRow {
  fundId: string;
  /** Number of FILLED BUY orders */
  filledBuys: number;
  /** Number of FILLED SELL orders */
  filledSells: number;
  /** Sum of filled_usdc for FILLED BUY orders */
  deployedUsdc: number;
  /** Sum of filled_usdc for FILLED SELL orders */
  receivedUsdc: number;
  /** Total orders submitted (all statuses) */
  totalOrders: number;
  /** REJECTED orders count */
  rejectedOrders: number;
}

export interface LivePnLReport {
  generatedAt: string;
  walletAddress: string;

  /**
   * Sum of initial_balance_usdc from fund_wallets for this wallet.
   * Represents total pUSD deposited to start Phase 2.
   */
  initialBudgetUsdc: number;

  /**
   * Current trading account balance from Polymarket CLOB API.
   * Reflects unspent pUSD + resolved position payouts.
   * null when API is unreachable.
   */
  walletBalanceUsdc: number | null;

  /** "ok" | "error" | "unavailable" (no orders yet, API call skipped) */
  balanceApiStatus: "ok" | "error" | "unavailable";

  /** pUSD spent on all FILLED BUY orders */
  totalDeployedUsdc: number;

  /** pUSD received from all FILLED SELL orders */
  totalReceivedUsdc: number;

  /** totalDeployedUsdc − totalReceivedUsdc (net exposure) */
  netDeployedUsdc: number;

  /** Total FILLED orders (BUY + SELL) */
  totalFilledOrders: number;

  /** Total REJECTED orders */
  totalRejectedOrders: number;

  /** Per-fund breakdown, sorted by deployedUsdc desc */
  funds: FundPnLRow[];
}

// ─── Polymarket balance fetch ──────────────────────────────────────────────────

/**
 * Fetch current USDC balance from Polymarket CLOB data API.
 * Public endpoint, no L2 auth required.
 * Returns null on any error or unexpected response shape.
 */
async function fetchClobBalance(walletAddress: string): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS);

  try {
    const res = await fetch(
      `${CLOB_API}/data/balance?address=${walletAddress}`,
      { signal: controller.signal, headers: { Accept: "application/json" } },
    );
    if (!res.ok) return null;

    const data = await res.json() as Record<string, unknown> | null;
    if (!data) return null;

    // API may return { balance: "12.345678" } or { USDC: "12.345678" }
    const raw = data["balance"] ?? data["USDC"] ?? data["usdc"] ?? null;
    if (raw === null || raw === undefined) return null;

    const val = parseFloat(String(raw));
    return Number.isFinite(val) && val >= 0 ? round6(val) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── D1 queries ───────────────────────────────────────────────────────────────

interface FundPnLRaw {
  fund_id: string;
  filled_buys: number;
  filled_sells: number;
  deployed_usdc: number;
  received_usdc: number;
  total_orders: number;
  rejected_orders: number;
}

async function queryFundPnL(
  db: D1Database,
  walletAddress: string,
): Promise<FundPnLRaw[]> {
  const result = await db
    .prepare(
      `SELECT
         lo.fund_id,
         SUM(CASE WHEN lo.side = 'BUY'  AND lo.status = 'FILLED' THEN 1 ELSE 0 END) AS filled_buys,
         SUM(CASE WHEN lo.side = 'SELL' AND lo.status = 'FILLED' THEN 1 ELSE 0 END) AS filled_sells,
         SUM(CASE WHEN lo.side = 'BUY'  AND lo.status = 'FILLED'
                  THEN COALESCE(lo.filled_usdc, 0) ELSE 0 END)                      AS deployed_usdc,
         SUM(CASE WHEN lo.side = 'SELL' AND lo.status = 'FILLED'
                  THEN COALESCE(lo.filled_usdc, 0) ELSE 0 END)                      AS received_usdc,
         COUNT(*)                                                                     AS total_orders,
         SUM(CASE WHEN lo.status = 'REJECTED' THEN 1 ELSE 0 END)                    AS rejected_orders
       FROM live_orders lo
       INNER JOIN fund_wallets fw ON fw.fund_id = lo.fund_id
       WHERE fw.wallet_address = ?
       GROUP BY lo.fund_id
       ORDER BY deployed_usdc DESC`,
    )
    .bind(walletAddress)
    .all<FundPnLRaw>();

  return result.results ?? [];
}

async function queryInitialBudget(
  db: D1Database,
  walletAddress: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(initial_balance_usdc), 0) AS total
       FROM fund_wallets
       WHERE wallet_address = ?`,
    )
    .bind(walletAddress)
    .first<{ total: number }>();

  return row?.total ?? 0;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Compute a LivePnLReport for the given wallet.
 *
 * Always returns a valid report — Polymarket API failures degrade gracefully
 * to null walletBalanceUsdc with balanceApiStatus = "error".
 */
export async function getLivePnL(
  db: D1Database,
  walletAddress: string,
): Promise<LivePnLReport> {
  const generatedAt = new Date().toISOString();

  const [fundRows, initialBudgetUsdc] = await Promise.all([
    queryFundPnL(db, walletAddress),
    queryInitialBudget(db, walletAddress),
  ]);

  const funds: FundPnLRow[] = fundRows.map((r) => ({
    fundId: r.fund_id,
    filledBuys: r.filled_buys ?? 0,
    filledSells: r.filled_sells ?? 0,
    deployedUsdc: round6(r.deployed_usdc ?? 0),
    receivedUsdc: round6(r.received_usdc ?? 0),
    totalOrders: r.total_orders ?? 0,
    rejectedOrders: r.rejected_orders ?? 0,
  }));

  const totalDeployedUsdc = round6(funds.reduce((s, f) => s + f.deployedUsdc, 0));
  const totalReceivedUsdc = round6(funds.reduce((s, f) => s + f.receivedUsdc, 0));
  const totalFilledOrders = funds.reduce((s, f) => s + f.filledBuys + f.filledSells, 0);
  const totalRejectedOrders = funds.reduce((s, f) => s + f.rejectedOrders, 0);

  // Skip balance API when there are no live orders yet (no wallet balance to show)
  let walletBalanceUsdc: number | null = null;
  let balanceApiStatus: LivePnLReport["balanceApiStatus"] = "unavailable";

  if (totalFilledOrders > 0 || initialBudgetUsdc > 0) {
    walletBalanceUsdc = await fetchClobBalance(walletAddress);
    balanceApiStatus = walletBalanceUsdc !== null ? "ok" : "error";
  }

  return {
    generatedAt,
    walletAddress,
    initialBudgetUsdc,
    walletBalanceUsdc,
    balanceApiStatus,
    totalDeployedUsdc,
    totalReceivedUsdc,
    netDeployedUsdc: round6(totalDeployedUsdc - totalReceivedUsdc),
    totalFilledOrders,
    totalRejectedOrders,
    funds,
  };
}

// ─── Internal utils ───────────────────────────────────────────────────────────

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
