/**
 * Execution Layer Abstraction
 *
 * Separates "what to trade" from "how to execute".
 * Paper mode: insert into paper_trades (existing behavior).
 * Shadow mode: additionally record what a real CLOB order would look like.
 *
 * Kill switch: halts all new trading activity when activated.
 */

export type ExecutionMode = "paper" | "shadow";

export interface ShadowOrder {
  id: string;
  paperTradeId: string;
  fundId: string;
  marketId: string;
  slug: string;
  question: string;
  direction: string;
  side: "BUY" | "SELL";
  shares: number;
  price: number;
  orderType: "LIMIT" | "MARKET";
  status: "WOULD_FILL" | "WOULD_REJECT" | "WOULD_PARTIAL";
  simulatedFillPrice: number;
  simulatedSlippage: number;
}

export async function isKillSwitchActive(db: D1Database): Promise<boolean> {
  try {
    const r = await db.prepare(
      "SELECT value FROM system_config WHERE key = 'KILL_SWITCH'",
    ).first<{ value: string }>();
    return r?.value === "true";
  } catch {
    return false;
  }
}

export async function setKillSwitch(db: D1Database, active: boolean): Promise<void> {
  await db.prepare(
    "INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('KILL_SWITCH', ?, ?)",
  ).bind(String(active), new Date().toISOString()).run();
}

export async function getExecutionMode(db: D1Database): Promise<ExecutionMode> {
  try {
    const r = await db.prepare(
      "SELECT value FROM system_config WHERE key = 'EXECUTION_MODE'",
    ).first<{ value: string }>();
    return (r?.value as ExecutionMode) || "paper";
  } catch {
    return "paper";
  }
}

export async function setExecutionMode(db: D1Database, mode: ExecutionMode): Promise<void> {
  await db.prepare(
    "INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('EXECUTION_MODE', ?, ?)",
  ).bind(mode, new Date().toISOString()).run();
}

export async function getSystemConfig(db: D1Database): Promise<Record<string, string>> {
  try {
    const result = await db.prepare("SELECT key, value FROM system_config").all();
    const config: Record<string, string> = {};
    for (const row of result.results || []) {
      config[(row as any).key] = (row as any).value;
    }
    return config;
  } catch {
    return { KILL_SWITCH: "false", EXECUTION_MODE: "paper" };
  }
}

/**
 * Simulate what would happen on Polymarket's CLOB for a given order.
 *
 * Slippage model (simplified): larger orders relative to typical liquidity
 * experience more slippage. Real CLOB would depend on order book depth.
 */
function simulateClob(
  side: "BUY" | "SELL",
  price: number,
  shares: number,
  amount: number,
): { fillPrice: number; slippage: number; wouldFill: boolean } {
  const notional = amount;
  const slippageBps = Math.min(notional * 0.0001, 0.02);

  const fillPrice = side === "BUY"
    ? price * (1 + slippageBps)
    : price * (1 - slippageBps);

  const clamped = Math.round(Math.max(0.001, Math.min(0.999, fillPrice)) * 10000) / 10000;
  const wouldFill = clamped > 0.01 && clamped < 0.99;

  return { fillPrice: clamped, slippage: Math.round(slippageBps * 10000) / 10000, wouldFill };
}

// ─── Pipeline Heartbeat ──────────────────────────────────

export interface PipelineHeartbeat {
  lastScanAt: string;
  totalFetched: number;
  marketsFiltered: number;
  signalsFound: number;
  tradesOpened: number;
  settlementsProcessed: number;
  monitorActions: number;
  riskStops: number;
  riskExpired: number;
  // Flat aggregation by skip code (kept for backward-compat with App.tsx HeartbeatBar)
  skipSummary: Record<string, number>;
  // 2026-05-04: Per-fund skip breakdown for diagnostics (e.g. "why turtle never trades?")
  // Format: { fundId: { skipCode: count } }
  skipByFund?: Record<string, Record<string, number>>;
  // 2026-05-10 D-Lite: per-cycle price refresh telemetry (CLOB mark-to-market path).
  // Surfaces token_id backfill progress + CLOB fetch success rate for /api/heartbeat.
  priceRefresh?: {
    totalOpen: number;
    refreshed: number;
    fetchFailed: number;
    missingTokenId: number;
    backfilledTokenIds: number;
  };
}

export async function storeHeartbeat(db: D1Database, hb: PipelineHeartbeat): Promise<void> {
  try {
    await db.prepare(
      "INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('PIPELINE_HEARTBEAT', ?, ?)",
    ).bind(JSON.stringify(hb), hb.lastScanAt).run();
  } catch {
    // non-critical
  }
}

export async function getHeartbeat(db: D1Database): Promise<PipelineHeartbeat | null> {
  try {
    const r = await db.prepare(
      "SELECT value FROM system_config WHERE key = 'PIPELINE_HEARTBEAT'",
    ).first<{ value: string }>();
    return r ? JSON.parse(r.value) : null;
  } catch {
    return null;
  }
}

// ─── Pipeline Error Log ─────────────────────────────────

export interface PipelineError {
  id: string;
  occurred_at: string;
  stage: string;
  message: string;
  details: string | null;
}

export async function storeError(
  db: D1Database,
  stage: string,
  error: unknown,
  details?: unknown,
): Promise<void> {
  try {
    const message = error instanceof Error ? error.message : String(error);
    await db.prepare(
      "INSERT INTO pipeline_errors (id, occurred_at, stage, message, details) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      crypto.randomUUID(),
      new Date().toISOString(),
      stage,
      message.slice(0, 500),
      details !== undefined ? JSON.stringify(details) : null,
    ).run();
    // Trim to last 100 entries
    await db.prepare(
      "DELETE FROM pipeline_errors WHERE id NOT IN (SELECT id FROM pipeline_errors ORDER BY occurred_at DESC LIMIT 100)",
    ).run();
  } catch {
    // non-critical
  }
}

export async function getPipelineErrors(
  db: D1Database,
  limit = 50,
): Promise<PipelineError[]> {
  try {
    const r = await db.prepare(
      "SELECT * FROM pipeline_errors ORDER BY occurred_at DESC LIMIT ?",
    ).bind(limit).all();
    return (r.results ?? []) as PipelineError[];
  } catch {
    return [];
  }
}

// ─── Shadow Trading ─────────────────────────────────────

export async function recordShadowOpen(
  db: D1Database,
  paperTradeId: string,
  fundId: string,
  marketId: string,
  slug: string,
  question: string,
  direction: string,
  price: number,
  shares: number,
  amount: number,
): Promise<string> {
  const side: "BUY" | "SELL" = direction.startsWith("BUY") ? "BUY" : "SELL";
  const sim = simulateClob(side, price, shares, amount);

  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO shadow_orders
     (id, paper_trade_id, fund_id, market_id, slug, question, direction, side, shares, price, order_type, status, simulated_fill_price, simulated_slippage, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LIMIT', ?, ?, ?, ?)`,
  ).bind(
    id, paperTradeId, fundId, marketId, slug, question,
    direction, side, shares, price,
    sim.wouldFill ? "WOULD_FILL" : "WOULD_REJECT",
    sim.fillPrice, sim.slippage,
    new Date().toISOString(),
  ).run();

  return id;
}

export async function recordShadowClose(
  db: D1Database,
  paperTradeId: string,
  fundId: string,
  marketId: string,
  slug: string,
  question: string,
  direction: string,
  exitPrice: number,
  shares: number,
  paperPnl: number,
): Promise<string> {
  const side: "BUY" | "SELL" = direction.startsWith("BUY") ? "SELL" : "BUY";
  const amount = shares * exitPrice;
  const sim = simulateClob(side, exitPrice, shares, amount);

  const shadowPnl = direction.startsWith("BUY")
    ? shares * sim.fillPrice - shares * exitPrice + paperPnl
    : paperPnl - (sim.fillPrice - exitPrice) * shares;

  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO shadow_orders
     (id, paper_trade_id, fund_id, market_id, slug, question, direction, side, shares, price, order_type, status, simulated_fill_price, simulated_slippage, paper_pnl, shadow_pnl, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LIMIT', ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, paperTradeId, fundId, marketId, slug, question,
    direction, side, shares, exitPrice,
    sim.wouldFill ? "WOULD_FILL" : "WOULD_REJECT",
    sim.fillPrice, sim.slippage,
    paperPnl, Math.round(shadowPnl * 100) / 100,
    new Date().toISOString(),
  ).run();

  return id;
}
