/**
 * Polymarket live_orders reconciliation — ALPHA-001 Phase 2 · P2.6
 *
 * Compares D1 live_orders (what we recorded) against Polymarket trade history
 * API (what actually happened on-chain) to satisfy Phase 2 Exit condition C2.3:
 *
 *   "Deposit Wallet 余额对账误差 = 0"
 *
 * Two-level check:
 *   L1: Net USDC amount (quick sanity — are the totals the same?)
 *   L2: Per-order matching (clob_order_id ↔ maker/taker_order_id, with fuzzy fallback)
 *
 * Phase 2 constraints:
 *   - FOK-only orders: every FILLED D1 entry should have a matching Polymarket trade
 *     within seconds (no resting GTC orders that settle later)
 *   - All funds share one wallet (fund_wallets.wallet_address join)
 *   - Polygon RPC not required: Polymarket trade history API covers on-chain state
 *
 * API endpoints used (public, no L2 auth required for reads):
 *   GET https://clob.polymarket.com/data/trades?maker_address={addr}&limit=500
 *   GET https://clob.polymarket.com/data/trades?taker_address={addr}&limit=500
 *
 * References:
 *   https://docs.polymarket.com/api-reference/data
 *   ADR ALPHA-001 §C2.3 Phase 2 Exit condition
 */

const CLOB_API = "https://clob.polymarket.com";
const RECONCILE_TIMEOUT_MS = 12_000;
/** $0.01 tolerance — floating-point rounding in price×size math */
const DISCREPANCY_THRESHOLD_USDC = 0.01;
/** Fuzzy time window for order matching when clob_order_id is unavailable */
const FUZZY_MATCH_WINDOW_MS = 60_000;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ReconcileReport {
  id: string;
  runAt: string;
  walletAddress: string;

  /** D1 perspective: what live_orders records */
  d1: {
    filledCount: number;
    /** pUSD spent on BUY fills */
    usdcOut: number;
    /** pUSD received from SELL fills */
    usdcIn: number;
    /** in − out (negative = net buyer) */
    netChange: number;
  };

  /**
   * Polymarket trade history perspective.
   * null if the API was unreachable (apiStatus = "error").
   */
  chain: {
    tradeCount: number;
    usdcOut: number;
    usdcIn: number;
    netChange: number;
  } | null;

  /**
   * |d1.netChange − chain.netChange| in USDC.
   * null when chain query failed.
   */
  usdcDiscrepancy: number | null;

  /** D1 FILLED order IDs (clob_order_id or internal id) absent from chain trades */
  unmatchedInD1: string[];

  /** Polymarket trade IDs absent from D1 FILLED orders */
  unmatchedInChain: string[];

  /**
   * true if:
   *   - usdcDiscrepancy < $0.01
   *   - unmatchedInD1.length === 0
   *   - unmatchedInChain.length === 0
   *
   * Phase 2 Exit C2.3 requires isClean = true for 14 consecutive days.
   */
  isClean: boolean;

  /** "ok" — trade API called successfully; "error" — API call failed; "skipped" — not attempted */
  apiStatus: "ok" | "error" | "skipped";
  errorMessage?: string;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface D1FilledOrder {
  id: string;
  side: "BUY" | "SELL";
  filled_usdc: number;
  filled_shares: number;
  clob_order_id: string | null;
  filled_at: string | null;
  token_id: string | null;
}

export interface PolyTrade {
  tradeId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  /** price × size (USDC equivalent) — pre-computed for efficiency */
  usdcAmount: number;
  matchTime: string;
  makerOrderId?: string;
  takerOrderId?: string;
  assetId?: string;
}

// Raw Polymarket API response shape (defensive — field names vary by version)
interface RawPolyTrade {
  id?: string;
  trade_id?: string;
  side?: string;
  price?: string | number;
  size?: string | number;
  match_time?: string;
  matched_at?: string;
  maker_order_id?: string;
  taker_order_id?: string;
  asset_id?: string;
  status?: string;
}

// ─── D1 query ─────────────────────────────────────────────────────────────────

async function queryD1Filled(
  db: D1Database,
  walletAddress: string,
): Promise<D1FilledOrder[]> {
  // Join through fund_wallets so we only fetch orders belonging to this wallet.
  // In Phase 2, all funds map to the same wallet_address.
  const rows = await db
    .prepare(
      `SELECT
         lo.id,
         lo.side,
         COALESCE(lo.filled_usdc, 0)      AS filled_usdc,
         COALESCE(lo.filled_shares, 0)    AS filled_shares,
         lo.clob_order_id,
         lo.filled_at,
         lo.token_id
       FROM live_orders lo
       INNER JOIN fund_wallets fw ON fw.fund_id = lo.fund_id
       WHERE fw.wallet_address = ?
         AND lo.status = 'FILLED'
       ORDER BY lo.filled_at DESC`,
    )
    .bind(walletAddress)
    .all<D1FilledOrder>();

  return rows.results ?? [];
}

// ─── Polymarket trade history API ─────────────────────────────────────────────

/**
 * Fetch all trades for a wallet from Polymarket CLOB data API.
 *
 * Queries both maker_address and taker_address to capture both sides of each trade.
 * FOK orders are taker-side by convention; maker_address may also return partial matches.
 * Deduplicates by trade_id.
 */
export async function fetchPolymarketTrades(walletAddress: string): Promise<PolyTrade[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECONCILE_TIMEOUT_MS);

  try {
    const base = `${CLOB_API}/data/trades`;
    const opts: RequestInit = {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    };

    const [makerRes, takerRes] = await Promise.all([
      fetch(`${base}?maker_address=${walletAddress}&limit=500`, opts),
      fetch(`${base}?taker_address=${walletAddress}&limit=500`, opts),
    ]);

    const makerRaw: RawPolyTrade[] = makerRes.ok
      ? (await makerRes.json() as unknown[]).filter((x): x is RawPolyTrade => typeof x === "object" && x !== null)
      : [];
    const takerRaw: RawPolyTrade[] = takerRes.ok
      ? (await takerRes.json() as unknown[]).filter((x): x is RawPolyTrade => typeof x === "object" && x !== null)
      : [];

    const seen = new Set<string>();
    const trades: PolyTrade[] = [];

    for (const raw of [...makerRaw, ...takerRaw]) {
      const tradeId = String(raw.id ?? raw.trade_id ?? "");
      if (!tradeId || seen.has(tradeId)) continue;
      seen.add(tradeId);

      const price = parseFloat(String(raw.price ?? "0"));
      const size = parseFloat(String(raw.size ?? "0"));
      if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) continue;

      const side: "BUY" | "SELL" =
        String(raw.side ?? "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY";

      // Round USDC amount to 6 decimal places (matching pUSD precision)
      const usdcAmount = Math.round(price * size * 1_000_000) / 1_000_000;

      trades.push({
        tradeId,
        side,
        price,
        size,
        usdcAmount,
        matchTime: String(raw.match_time ?? raw.matched_at ?? ""),
        makerOrderId: raw.maker_order_id,
        takerOrderId: raw.taker_order_id,
        assetId: raw.asset_id,
      });
    }

    return trades;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Order matching (pure, testable) ─────────────────────────────────────────

/**
 * Match D1 FILLED orders against Polymarket chain trades.
 *
 * Matching strategy (in priority order):
 *   1. Exact: D1.clob_order_id === trade.takerOrderId  (FOK = taker)
 *   2. Exact: D1.clob_order_id === trade.makerOrderId  (fallback)
 *   3. Fuzzy: same side + |usdcAmount difference| < $0.01 + timestamp within 60s
 *
 * Returns IDs of unmatched entries on both sides.
 */
export function matchOrders(
  d1Orders: Pick<D1FilledOrder, "id" | "side" | "filled_usdc" | "clob_order_id" | "filled_at" | "token_id">[],
  chainTrades: PolyTrade[],
): { unmatchedD1: string[]; unmatchedChain: string[] } {
  const matchedD1 = new Set<string>();
  const matchedChain = new Set<string>();

  // Pass 1: exact match by clob_order_id
  for (const d1 of d1Orders) {
    if (!d1.clob_order_id) continue;
    for (const trade of chainTrades) {
      if (matchedChain.has(trade.tradeId)) continue;
      if (
        trade.takerOrderId === d1.clob_order_id ||
        trade.makerOrderId === d1.clob_order_id
      ) {
        matchedD1.add(d1.id);
        matchedChain.add(trade.tradeId);
        break;
      }
    }
  }

  // Pass 2: fuzzy match for remaining unmatched orders
  for (const d1 of d1Orders) {
    if (matchedD1.has(d1.id)) continue;

    const d1Usdc = d1.filled_usdc ?? 0;
    const d1TimeMs = d1.filled_at ? new Date(d1.filled_at).getTime() : 0;

    for (const trade of chainTrades) {
      if (matchedChain.has(trade.tradeId)) continue;

      const sideMatch = d1.side === trade.side;
      const usdcMatch = Math.abs(trade.usdcAmount - d1Usdc) < DISCREPANCY_THRESHOLD_USDC;
      const tradeTimeMs = trade.matchTime ? new Date(trade.matchTime).getTime() : 0;
      const timeMatch =
        d1TimeMs === 0 ||
        tradeTimeMs === 0 ||
        Math.abs(d1TimeMs - tradeTimeMs) <= FUZZY_MATCH_WINDOW_MS;

      if (sideMatch && usdcMatch && timeMatch) {
        matchedD1.add(d1.id);
        matchedChain.add(trade.tradeId);
        break;
      }
    }
  }

  return {
    unmatchedD1: d1Orders
      .filter((o) => !matchedD1.has(o.id))
      .map((o) => o.clob_order_id ?? o.id),
    unmatchedChain: chainTrades
      .filter((t) => !matchedChain.has(t.tradeId))
      .map((t) => t.tradeId),
  };
}

// ─── Main orchestrator ────────────────────────────────────────────────────────

/**
 * Run a full reconciliation for the given wallet address.
 *
 * Flow:
 *   1. Query D1 live_orders FILLED rows linked to this wallet
 *   2. Fetch Polymarket trade history (maker + taker address queries, deduplicated)
 *   3. Compare totals (net USDC) and match individual orders
 *   4. Persist result to reconcile_log
 *   5. Return ReconcileReport
 *
 * Safe to call at any time — always appends a new row, never overwrites history.
 *
 * @param db            D1 database binding
 * @param walletAddress Checksummed Polygon EOA address (from fund_wallets)
 */
export async function runReconcile(
  db: D1Database,
  walletAddress: string,
): Promise<ReconcileReport> {
  const reportId = crypto.randomUUID();
  const runAt = new Date().toISOString();

  // ── Step 1: D1 side ──────────────────────────────────────────────────────────
  const d1Orders = await queryD1Filled(db, walletAddress);

  const d1UsdcOut = round6(
    d1Orders.filter((o) => o.side === "BUY").reduce((s, o) => s + (o.filled_usdc ?? 0), 0),
  );
  const d1UsdcIn = round6(
    d1Orders.filter((o) => o.side === "SELL").reduce((s, o) => s + (o.filled_usdc ?? 0), 0),
  );
  const d1Net = round6(d1UsdcIn - d1UsdcOut);

  const d1 = {
    filledCount: d1Orders.length,
    usdcOut: d1UsdcOut,
    usdcIn: d1UsdcIn,
    netChange: d1Net,
  };

  // ── Step 2: Chain side ───────────────────────────────────────────────────────
  let chainTrades: PolyTrade[] | null = null;
  let apiStatus: ReconcileReport["apiStatus"] = "skipped";
  let apiError: string | undefined;

  try {
    chainTrades = await fetchPolymarketTrades(walletAddress);
    apiStatus = "ok";
  } catch (err) {
    apiStatus = "error";
    apiError = String(err).slice(0, 300);
  }

  // ── Step 3: Compare ──────────────────────────────────────────────────────────
  let chain: ReconcileReport["chain"] = null;
  let usdcDiscrepancy: number | null = null;
  let unmatchedInD1: string[] = [];
  let unmatchedInChain: string[] = [];

  if (chainTrades !== null) {
    const chainUsdcOut = round6(
      chainTrades.filter((t) => t.side === "BUY").reduce((s, t) => s + t.usdcAmount, 0),
    );
    const chainUsdcIn = round6(
      chainTrades.filter((t) => t.side === "SELL").reduce((s, t) => s + t.usdcAmount, 0),
    );
    const chainNet = round6(chainUsdcIn - chainUsdcOut);

    chain = {
      tradeCount: chainTrades.length,
      usdcOut: chainUsdcOut,
      usdcIn: chainUsdcIn,
      netChange: chainNet,
    };

    usdcDiscrepancy = round6(Math.abs(d1Net - chainNet));

    const matchResult = matchOrders(d1Orders, chainTrades);
    unmatchedInD1 = matchResult.unmatchedD1;
    unmatchedInChain = matchResult.unmatchedChain;
  }

  const isClean =
    chain !== null &&
    (usdcDiscrepancy ?? Infinity) < DISCREPANCY_THRESHOLD_USDC &&
    unmatchedInD1.length === 0 &&
    unmatchedInChain.length === 0;

  // ── Step 4: Persist ──────────────────────────────────────────────────────────
  await db
    .prepare(
      `INSERT INTO reconcile_log
       (id, run_at, wallet_address,
        d1_filled_count, d1_usdc_out, d1_usdc_in, d1_net_change,
        chain_trade_count, chain_usdc_out, chain_usdc_in,
        usdc_discrepancy, unmatched_d1_count, unmatched_chain_count,
        is_clean, api_status, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      reportId,
      runAt,
      walletAddress,
      d1.filledCount,
      d1.usdcOut,
      d1.usdcIn,
      d1.netChange,
      chain?.tradeCount ?? null,
      chain?.usdcOut ?? null,
      chain?.usdcIn ?? null,
      usdcDiscrepancy ?? null,
      unmatchedInD1.length,
      unmatchedInChain.length,
      isClean ? 1 : 0,
      apiStatus,
      apiError ?? null,
    )
    .run();

  return {
    id: reportId,
    runAt,
    walletAddress,
    d1,
    chain,
    usdcDiscrepancy,
    unmatchedInD1,
    unmatchedInChain,
    isClean,
    apiStatus,
    errorMessage: apiError,
  };
}

// ─── Helpers for callers ──────────────────────────────────────────────────────

/**
 * Read the most recent reconcile entry for a wallet from D1.
 * Returns null if no reconcile has been run yet (p26 not yet active).
 */
export async function getLastReconcileReport(
  db: D1Database,
  walletAddress: string,
): Promise<{
  runAt: string;
  isClean: boolean;
  usdcDiscrepancy: number | null;
  d1FilledCount: number;
  apiStatus: string;
} | null> {
  const row = await db
    .prepare(
      `SELECT run_at, is_clean, usdc_discrepancy, d1_filled_count, api_status
       FROM reconcile_log
       WHERE wallet_address = ?
       ORDER BY run_at DESC
       LIMIT 1`,
    )
    .bind(walletAddress)
    .first<{
      run_at: string;
      is_clean: number;
      usdc_discrepancy: number | null;
      d1_filled_count: number;
      api_status: string;
    }>();

  if (!row) return null;

  return {
    runAt: row.run_at,
    isClean: row.is_clean === 1,
    usdcDiscrepancy: row.usdc_discrepancy,
    d1FilledCount: row.d1_filled_count,
    apiStatus: row.api_status,
  };
}

// ─── Internal utils ───────────────────────────────────────────────────────────

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
