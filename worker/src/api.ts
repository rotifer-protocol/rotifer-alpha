import type { Env, FundConfig } from "./types";
import { corsHeaders } from "./auth";
import { listVariants, getLineage, getEvolutionLog, getAllActiveVariants, getCurrentEpoch } from "./gene-variants";
import { GENE_REGISTRY, type GeneMeta } from "./gene-interface";
import {
  calculateCurrentPositionValue,
  calculateOpenPositionStats,
  calculateReturnPct,
  calculateTotalValue,
  type OpenTradeWithMark,
  OPEN_TRADE_MARK_COLUMNS_SQL,
  PERFORMANCE_REALIZED_TRADE_WHERE_SQL,
} from "./accounting";
import { calcUnrealizedPnl, isStale } from "./price";
import {
  countsTowardPerformance,
  getCloseReasonCode,
  getCloseReasonText,
  PERFORMANCE_MONITOR_REASON_SQL,
  SYSTEM_INVALIDATION_MONITOR_REASON_SQL,
  toDisplayTradeStatus,
} from "./trade-semantics";
import { getSystemConfig, getHeartbeat, getPipelineErrors } from "./execution";
import { piggybackRiskCheck } from "./risk";

/**
 * Read-only GET endpoints for the frontend.
 * No authentication required (public data).
 */
export async function handleApi(
  path: string,
  req: Request,
  env: Env,
  funds: FundConfig[],
): Promise<Response | null> {
  const origin = req.headers.get("Origin");
  const headers = corsHeaders(origin);

  if (path === "/api/funds") {
    return await apiFunds(env.DB, funds, headers);
  }
  if (path.startsWith("/api/funds/")) {
    const fundId = path.slice("/api/funds/".length);
    return await apiFundDetail(env.DB, funds, fundId, headers);
  }
  if (path === "/api/trades") {
    return await apiTrades(env.DB, req, headers);
  }
  if (path === "/api/signals") {
    return await apiSignals(env.DB, req, headers);
  }
  if (path === "/api/snapshots") {
    return await apiSnapshots(env.DB, req, headers);
  }
  if (path === "/api/events") {
    return await apiEvents(env.DB, req, headers);
  }
  if (path === "/api/shadow") {
    return await apiShadow(env.DB, req, headers);
  }
  if (path === "/api/system") {
    return await apiSystem(env.DB, headers);
  }
  if (path === "/api/gene-variants") {
    return await apiGeneVariants(env.DB, req, headers);
  }
  if (path === "/api/gene-lineage") {
    return await apiGeneLineage(env.DB, req, headers);
  }
  if (path === "/api/gene-evolution") {
    return await apiGeneEvolution(env.DB, req, headers);
  }
  if (path === "/api/heartbeat") {
    const heartbeat = await getHeartbeat(env.DB);
    return Response.json({ heartbeat }, { headers });
  }
  if (path === "/api/health") {
    const config = await getSystemConfig(env.DB);
    return Response.json(
      {
        status: config.KILL_SWITCH === "true" ? "halted" : "ok",
        executionMode: config.EXECUTION_MODE || "paper",
        killSwitch: config.KILL_SWITCH === "true",
        timestamp: new Date().toISOString(),
        funds: funds.length,
      },
      { headers },
    );
  }

  // ─── Diagnostics (read-only) ────────────────────────────
  if (path === "/api/diagnostics") {
    const [errors, config, heartbeat] = await Promise.all([
      getPipelineErrors(env.DB, 50),
      getSystemConfig(env.DB),
      getHeartbeat(env.DB),
    ]);
    return Response.json({
      errors,
      killSwitch: config.KILL_SWITCH === "true",
      executionMode: config.EXECUTION_MODE || "paper",
      skipByFund: (heartbeat as any)?.skipByFund ?? {},
    }, { headers });
  }

  // ─── Admin write actions (requires API_TOKEN header) ────
  if (path === "/api/admin/system-config" && req.method === "POST") {
    const token = req.headers.get("X-Admin-Token") ?? "";
    if (!env.API_TOKEN || token !== env.API_TOKEN) {
      return Response.json({ error: "Unauthorized" }, { status: 401, headers });
    }
    let body: { killSwitch?: boolean; executionMode?: string };
    try {
      body = await req.json() as any;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400, headers });
    }
    const db = env.DB;
    const ts = new Date().toISOString();
    if (typeof body.killSwitch === "boolean") {
      await db.prepare("INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('KILL_SWITCH', ?, ?)")
        .bind(body.killSwitch ? "true" : "false", ts).run();
    }
    if (body.executionMode === "paper" || body.executionMode === "shadow" || body.executionMode === "live") {
      await db.prepare("INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES ('EXECUTION_MODE', ?, ?)")
        .bind(body.executionMode, ts).run();
    }
    return Response.json({ ok: true }, { headers });
  }

  return null;
}

/**
 * Live mark-to-market stats from paper_trades.
 * Total value must be initial + realized + unrealized.
 * Open principal is already part of cash accounting and must not be added again.
 *
 * D-Lite (2026-05-10): reads last_price from D1 (no per-request fetchPrices()).
 * staleCount surfaces positions whose last_price is too old (or NULL) so the
 * UI can warn users instead of silently inflating numbers.
 */
async function getFundLiveStats(
  db: D1Database,
  fundId: string,
  initialBalance: number,
): Promise<{
  openPositions: number;
  totalValue: number;
  returnPct: number;
  winRate: number;
  winCount: number;
  lossCount: number;
  realizedPnl: number;
  unrealizedPnl: number;
  staleCount: number;
}> {
  const openTradesResult = await db.prepare(
    `SELECT ${OPEN_TRADE_MARK_COLUMNS_SQL} FROM paper_trades WHERE fund_id = ? AND status = 'OPEN'`,
  ).bind(fundId).all<OpenTradeWithMark>();
  const openTrades = openTradesResult.results ?? [];
  const openStats = calculateOpenPositionStats(openTrades);

  const resolved = await db.prepare(
    `SELECT
       COALESCE(SUM(pnl),0) as pnl,
       COUNT(CASE WHEN pnl > 0 THEN 1 END) as wins,
       COUNT(CASE WHEN pnl < 0 THEN 1 END) as losses
     FROM paper_trades
     WHERE fund_id = ? AND ${PERFORMANCE_REALIZED_TRADE_WHERE_SQL}`,
  ).bind(fundId).first<{ pnl: number; wins: number; losses: number }>();

  const realizedPnl = Number(resolved?.pnl ?? 0);
  const unrealizedPnl = openStats.unrealizedPnl;
  const totalValue = calculateTotalValue(initialBalance, realizedPnl, unrealizedPnl);
  const returnPct = calculateReturnPct(initialBalance, totalValue);
  const w = Number(resolved?.wins ?? 0);
  const l = Number(resolved?.losses ?? 0);
  const winRate = (w + l) > 0 ? w / (w + l) : 0;

  return {
    openPositions: openStats.openPositions,
    totalValue,
    returnPct,
    winRate,
    winCount: w,
    lossCount: l,
    realizedPnl,
    unrealizedPnl,
    staleCount: openStats.staleCount,
  };
}

/**
 * D-Lite: enrich OPEN trade rows with live mark-to-market fields using
 * last_price already SELECTed from paper_trades (no fetchPrices). Stale
 * rows return null current_price/value so the UI can render a "stale"
 * indicator instead of misleading numbers.
 *
 * Pre-condition: trade rows MUST come from `SELECT * FROM paper_trades`
 * (or any select that includes last_price + last_price_updated_at).
 */
function enrichTradesWithLivePrices(
  trades: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const nowMs = Date.now();
  return trades.map(trade => {
    if (trade.status !== "OPEN") return trade;

    const lastPrice = trade.last_price;
    const updatedAt = trade.last_price_updated_at as string | null | undefined;
    if (typeof lastPrice !== "number" || isStale(updatedAt, nowMs)) {
      return { ...trade, current_price: null, current_value: null, unrealized_pnl: null, live_return_pct: null };
    }

    const amount = Number(trade.amount ?? 0);
    const shares = Number(trade.shares ?? 0);
    const unrealizedPnl = calcUnrealizedPnl(String(trade.direction ?? ""), shares, amount, lastPrice);
    const currentValue = calculateCurrentPositionValue(amount, unrealizedPnl);
    const liveReturnPct = amount > 0 ? (unrealizedPnl / amount) * 100 : 0;

    return {
      ...trade,
      current_price: Math.round(lastPrice * 1000) / 1000,
      current_value: Math.round(currentValue * 100) / 100,
      unrealized_pnl: Math.round(unrealizedPnl * 100) / 100,
      live_return_pct: Math.round(liveReturnPct * 100) / 100,
    };
  });
}

function decorateTradeRecord(
  trade: Record<string, unknown>,
): Record<string, unknown> {
  const rawStatus = String(trade.status ?? "");
  const displayStatus = toDisplayTradeStatus(rawStatus, trade.monitor_reason);

  return {
    ...trade,
    raw_status: rawStatus,
    status: displayStatus,
    close_reason_code: getCloseReasonCode(rawStatus, trade.monitor_reason),
    close_reason: getCloseReasonText(rawStatus, trade.monitor_reason),
    counts_toward_performance: countsTowardPerformance(rawStatus, trade.monitor_reason),
    is_system_closed: displayStatus === "INVALIDATED",
  };
}

async function apiFunds(
  db: D1Database,
  funds: FundConfig[],
  headers: HeadersInit,
): Promise<Response> {
  const result = [];
  for (const fund of funds) {
    const snap = await db.prepare(
      "SELECT * FROM portfolio_snapshots WHERE fund_id = ? ORDER BY date DESC LIMIT 1",
    ).bind(fund.id).first();

    const live = await getFundLiveStats(db, fund.id, fund.initialBalance);

    result.push({
      id: fund.id,
      name: fund.name,
      emoji: fund.emoji,
      motto: fund.motto,
      initialBalance: fund.initialBalance,
      totalValue: Math.round(live.totalValue * 100) / 100,
      returnPct: Math.round(live.returnPct * 100) / 100,
      winRate: live.winRate,
      winCount: live.winCount,
      lossCount: live.lossCount,
      realizedPnl: Math.round(live.realizedPnl * 100) / 100,
      unrealizedPnl: Math.round(live.unrealizedPnl * 100) / 100,
      openPositions: live.openPositions,
      // D-Lite (2026-05-10): positions whose last_price is NULL or older than
      // PRICE_STALE_THRESHOLD_MS — UI uses to render a stale-price warning.
      staleCount: live.staleCount,
      monthlyTarget: fund.monthlyTarget,
      drawdownLimit: fund.drawdownLimit,
      frozen: (snap as any)?.frozen_until
        ? new Date((snap as any).frozen_until) > new Date()
        : false,
    });
  }

  result.sort((a, b) => b.totalValue - a.totalValue);
  return Response.json({ funds: result }, { headers });
}

async function apiFundDetail(
  db: D1Database,
  funds: FundConfig[],
  fundId: string,
  headers: HeadersInit,
): Promise<Response> {
  const fund = funds.find(f => f.id === fundId);
  if (!fund) {
    return Response.json({ error: "Fund not found" }, { status: 404, headers });
  }

  const snap = await db.prepare(
    "SELECT * FROM portfolio_snapshots WHERE fund_id = ? ORDER BY date DESC LIMIT 1",
  ).bind(fund.id).first();

  let live = await getFundLiveStats(db, fund.id, fund.initialBalance);

  // D-Lite: piggybackRiskCheck reads last_price from D1 directly — no priceMap arg.
  const triggered = await piggybackRiskCheck(db, fund.id, fund);
  if (triggered.length > 0) {
    live = await getFundLiveStats(db, fund.id, fund.initialBalance);
  }

  const configRow = await db.prepare(
    "SELECT * FROM fund_configs WHERE id = ?",
  ).bind(fund.id).first();

  const config = configRow ? {
    allowedTypes: JSON.parse(String((configRow as any).allowed_types || "[]")),
    monthlyTarget: (configRow as any).monthly_target,
    minEdge: (configRow as any).min_edge,
    minConfidence: (configRow as any).min_confidence,
    minVolume: (configRow as any).min_volume,
    minLiquidity: (configRow as any).min_liquidity,
    maxPerEvent: (configRow as any).max_per_event,
    maxOpenPositions: (configRow as any).max_open_positions,
    stopLossPercent: (configRow as any).stop_loss_percent,
    maxHoldDays: (configRow as any).max_hold_days,
    sizingMode: (configRow as any).sizing_mode,
    sizingBase: (configRow as any).sizing_base,
    sizingScale: (configRow as any).sizing_scale,
    drawdownLimit: (configRow as any).drawdown_limit,
    drawdownSoftLimit: (configRow as any).drawdown_soft_limit,
    takeProfitPercent: (configRow as any).take_profit_percent,
    trailingStopPercent: (configRow as any).trailing_stop_percent,
    probReversalThreshold: (configRow as any).prob_reversal_threshold,
    generation: (configRow as any).generation,
    parentId: (configRow as any).parent_id,
  } : {
    allowedTypes: fund.allowedTypes,
    monthlyTarget: fund.monthlyTarget,
    minEdge: fund.minEdge,
    minConfidence: fund.minConfidence,
    minVolume: fund.minVolume,
    minLiquidity: fund.minLiquidity,
    maxPerEvent: fund.maxPerEvent,
    maxOpenPositions: fund.maxOpenPositions,
    stopLossPercent: fund.stopLossPercent,
    maxHoldDays: fund.maxHoldDays,
    takeProfitPercent: fund.takeProfitPercent,
    trailingStopPercent: fund.trailingStopPercent,
    probReversalThreshold: fund.probReversalThreshold,
    sizingMode: fund.sizingMode,
    sizingBase: fund.sizingBase,
    sizingScale: fund.sizingScale,
    drawdownLimit: fund.drawdownLimit,
    drawdownSoftLimit: fund.drawdownSoftLimit,
    generation: 0,
    parentId: null,
  };

  return Response.json({
    fund: {
      id: fund.id,
      name: fund.name,
      emoji: fund.emoji,
      motto: fund.motto,
      initialBalance: fund.initialBalance,
      totalValue: Math.round(live.totalValue * 100) / 100,
      returnPct: Math.round(live.returnPct * 100) / 100,
      winRate: live.winRate,
      openPositions: live.openPositions,
      monthlyTarget: fund.monthlyTarget,
      frozen: (snap as any)?.frozen_until
        ? new Date((snap as any).frozen_until) > new Date()
        : false,
      winCount: live.winCount,
      lossCount: live.lossCount,
      realizedPnl: Math.round(live.realizedPnl * 100) / 100,
      unrealizedPnl: Math.round(live.unrealizedPnl * 100) / 100,
      staleCount: live.staleCount,
      config,
    },
  }, { headers });
}

async function apiTrades(
  db: D1Database,
  req: Request,
  headers: HeadersInit,
): Promise<Response> {
  const url = new URL(req.url);
  const status = (url.searchParams.get("status") || "all").toUpperCase();
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
  const fundId = url.searchParams.get("fund");

  let query = "SELECT * FROM paper_trades";
  const conditions: string[] = [];
  const bindings: any[] = [];

  if (status !== "ALL") {
    if (status === "CLOSED") {
      conditions.push("status != 'OPEN'");
    } else if (status === "INVALIDATED") {
      conditions.push("status = 'EXPIRED'");
      conditions.push(SYSTEM_INVALIDATION_MONITOR_REASON_SQL);
    } else if (status === "EXPIRED") {
      conditions.push("status = 'EXPIRED'");
      conditions.push(PERFORMANCE_MONITOR_REASON_SQL);
    } else {
      conditions.push("status = ?");
      bindings.push(status);
    }
  }
  if (fundId) {
    conditions.push("fund_id = ?");
    bindings.push(fundId);
  }
  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }
  query += " ORDER BY COALESCE(closed_at, opened_at) DESC LIMIT ?";
  bindings.push(limit);

  const stmt = db.prepare(query);
  const result = await stmt.bind(...bindings).all();
  const trades = enrichTradesWithLivePrices((result.results || []) as Array<Record<string, unknown>>)
    .map(decorateTradeRecord);

  return Response.json(
    { trades, total: trades.length },
    { headers },
  );
}

async function apiSignals(
  db: D1Database,
  req: Request,
  headers: HeadersInit,
): Promise<Response> {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "30"), 100);

  const result = await db.prepare(
    "SELECT * FROM signals ORDER BY created_at DESC LIMIT ?",
  ).bind(limit).all();

  return Response.json(
    { signals: result.results || [], total: result.results?.length ?? 0 },
    { headers },
  );
}

async function apiEvents(
  db: D1Database,
  req: Request,
  headers: HeadersInit,
): Promise<Response> {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "30"), 100);

  const events: Array<{ type: string; timestamp: string; payload: Record<string, unknown> }> = [];

  const scans = await db.prepare(
    "SELECT scanned_at, total_fetched, markets_filtered, signals_found, avg_edge FROM scans ORDER BY scanned_at DESC LIMIT ?",
  ).bind(Math.ceil(limit / 3)).all();
  for (const s of scans.results || []) {
    const row = s as Record<string, unknown>;
    events.push({
      type: "SCAN_COMPLETE",
      timestamp: String(row.scanned_at),
      payload: {
        totalFetched: row.total_fetched,
        marketsFiltered: row.markets_filtered,
        signalsFound: row.signals_found,
        avgEdge: row.avg_edge,
      },
    });
  }

  const trades = await db.prepare(
    `SELECT fund_id, question, direction, amount, status, pnl, slug, opened_at, closed_at,
            entry_price, exit_price, monitor_reason
     FROM paper_trades
     ORDER BY COALESCE(closed_at, opened_at) DESC
     LIMIT ?`,
  ).bind(Math.ceil(limit / 2)).all();
  for (const t of trades.results || []) {
    const row = t as Record<string, unknown>;
    if (row.status === "OPEN") {
      events.push({
        type: "TRADE_OPENED",
        timestamp: String(row.opened_at),
        payload: {
          fundId: row.fund_id,
          fundName: row.fund_id,
          amount: row.amount,
          slug: row.slug ?? "",
          question: row.question,
          direction: row.direction,
          price: row.entry_price,
          entryPrice: row.entry_price,
        },
      });
    } else {
      const displayStatus = toDisplayTradeStatus(row.status, row.monitor_reason);
      const statusMap: Record<string, string> = {
        STOPPED: "TRADE_STOPPED",
        EXPIRED: "TRADE_EXPIRED",
        INVALIDATED: "TRADE_INVALIDATED",
        PROFIT_TAKEN: "TRADE_PROFIT_TAKEN",
        TRAILING_STOPPED: "TRADE_TRAILING_STOPPED",
        REVERSED: "TRADE_REVERSED",
        RESOLVED: "TRADE_SETTLED",
      };
      const type = statusMap[displayStatus] ?? "TRADE_SETTLED";
      events.push({
        type,
        timestamp: String(row.closed_at || row.opened_at),
        payload: {
          fundId: row.fund_id,
          fundName: row.fund_id,
          pnl: row.pnl,
          slug: row.slug ?? "",
          question: row.question,
          direction: row.direction,
          entryPrice: row.entry_price,
          exitPrice: row.exit_price,
          rawStatus: row.status,
          status: displayStatus,
          closeReasonCode: getCloseReasonCode(row.status, row.monitor_reason),
          reason: getCloseReasonText(row.status, row.monitor_reason),
        },
      });
    }
  }

  const signals = await db.prepare(
    `SELECT signal_id, type, market_id, slug, question, description, edge, confidence, direction, prices, created_at
     FROM signals
     ORDER BY created_at DESC
     LIMIT ?`,
  ).bind(Math.ceil(limit / 3)).all();
  for (const s of signals.results || []) {
    const row = s as Record<string, unknown>;
    events.push({
      type: "SIGNAL_FOUND",
      timestamp: String(row.created_at),
      payload: {
        signalId: row.signal_id,
        type: row.type,
        edge: row.edge,
        confidence: row.confidence,
        direction: row.direction,
        marketId: row.market_id,
        slug: row.slug ?? "",
        question: row.question,
        description: row.description,
        prices: row.prices,
      },
    });
  }

  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return Response.json(
    { events: events.slice(0, limit) },
    { headers },
  );
}

async function apiSnapshots(
  db: D1Database,
  req: Request,
  headers: HeadersInit,
): Promise<Response> {
  const url = new URL(req.url);
  const fundId = url.searchParams.get("fund");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "30"), 90);

  if (fundId) {
    const result = await db.prepare(
      "SELECT * FROM portfolio_snapshots WHERE fund_id = ? ORDER BY date DESC LIMIT ?",
    ).bind(fundId, limit).all();
    return Response.json({ snapshots: result.results || [] }, { headers });
  }

  const result = await db.prepare(
    "SELECT * FROM portfolio_snapshots ORDER BY date DESC LIMIT ?",
  ).bind(limit * 5).all();
  return Response.json({ snapshots: result.results || [] }, { headers });
}

async function apiShadow(
  db: D1Database,
  req: Request,
  headers: HeadersInit,
): Promise<Response> {
  const url = new URL(req.url);
  const fundId = url.searchParams.get("fund");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);

  try {
    let query = "SELECT * FROM shadow_orders";
    const bindings: any[] = [];

    if (fundId) {
      query += " WHERE fund_id = ?";
      bindings.push(fundId);
    }
    query += " ORDER BY created_at DESC LIMIT ?";
    bindings.push(limit);

    const result = await db.prepare(query).bind(...bindings).all();
    const orders = result.results || [];

    const wouldFill = orders.filter((o: any) => o.status === "WOULD_FILL").length;
    const wouldReject = orders.filter((o: any) => o.status === "WOULD_REJECT").length;

    const paired = orders.filter((o: any) => o.paper_pnl !== null && o.shadow_pnl !== null);
    const avgSlippageImpact = paired.length > 0
      ? paired.reduce((sum: number, o: any) => sum + ((o.paper_pnl as number) - (o.shadow_pnl as number)), 0) / paired.length
      : 0;
    const totalPaperPnl = paired.reduce((sum: number, o: any) => sum + (o.paper_pnl as number), 0);
    const totalShadowPnl = paired.reduce((sum: number, o: any) => sum + (o.shadow_pnl as number), 0);

    return Response.json({
      orders,
      total: orders.length,
      summary: {
        wouldFill,
        wouldReject,
        fillRate: orders.length > 0 ? Math.round((wouldFill / orders.length) * 100) : 0,
        avgSlippageImpact: Math.round(avgSlippageImpact * 100) / 100,
        totalPaperPnl: Math.round(totalPaperPnl * 100) / 100,
        totalShadowPnl: Math.round(totalShadowPnl * 100) / 100,
        pnlDivergence: Math.round((totalPaperPnl - totalShadowPnl) * 100) / 100,
      },
    }, { headers });
  } catch {
    return Response.json({ orders: [], total: 0, summary: null }, { headers });
  }
}

async function apiSystem(
  db: D1Database,
  headers: HeadersInit,
): Promise<Response> {
  const config = await getSystemConfig(db);
  return Response.json({
    killSwitch: config.KILL_SWITCH === "true",
    executionMode: config.EXECUTION_MODE || "paper",
    config,
  }, { headers });
}

// ─── Gene Evolution APIs ────────────────────────────────

function localizeRegistry(registry: GeneMeta[], lang: string) {
  if (lang !== "zh") return registry;
  return registry.map(r => ({
    ...r,
    name: r.nameZh || r.name,
  }));
}

async function apiGeneVariants(
  db: D1Database,
  req: Request,
  headers: HeadersInit,
): Promise<Response> {
  const url = new URL(req.url);
  const geneId = url.searchParams.get("gene") ?? undefined;
  const lang = url.searchParams.get("lang") ?? "en";
  const variants = await listVariants(db, geneId);
  const active = await getAllActiveVariants(db);

  const localizedVariants = lang === "zh"
    ? variants.map(v => ({ ...v, description: v.descriptionZh || v.description }))
    : variants;

  return Response.json({
    variants: localizedVariants,
    activeConfig: Object.fromEntries(active),
    registry: localizeRegistry(GENE_REGISTRY, lang),
  }, { headers });
}

async function apiGeneLineage(
  db: D1Database,
  req: Request,
  headers: HeadersInit,
): Promise<Response> {
  const url = new URL(req.url);
  const geneId = url.searchParams.get("gene") ?? undefined;
  const lineage = await getLineage(db, geneId);
  return Response.json({ lineage }, { headers });
}

async function apiGeneEvolution(
  db: D1Database,
  req: Request,
  headers: HeadersInit,
): Promise<Response> {
  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const log = await getEvolutionLog(db, limit);
  const epoch = await getCurrentEpoch(db);
  return Response.json({ epoch, log }, { headers });
}
