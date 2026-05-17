import type { Env, FundConfig } from "./types";
import { corsHeaders } from "./auth";
import { listVariants, getLineage, getEvolutionLog, getAllActiveVariants, getCurrentEpoch, ensureStaticG1LineageBackfill, ensureNonNegativePetriScores, ensureSaneActiveVariant } from "./gene-variants";
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
import { getSystemConfig, getHeartbeat, getPipelineErrors, getSkipByFund } from "./execution";
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
  if (path === "/api/market-drivers") {
    return await apiMarketDrivers(env.DB, req, headers);
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
    const [errors, config, heartbeat, skipByFund] = await Promise.all([
      getPipelineErrors(env.DB, 50),
      getSystemConfig(env.DB),
      getHeartbeat(env.DB),
      getSkipByFund(env.DB),
    ]);
    return Response.json({
      errors,
      killSwitch: config.KILL_SWITCH === "true",
      executionMode: config.EXECUTION_MODE || "paper",
      skipByFund,
      pipelineRunning: (heartbeat as any)?.pipelineRunning ?? false,
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

  // ── Evolution events from evolution_log ───────────────────────────────────
  // Reconstructs MICRO_EVOLUTION (individual rows) and EVOLUTION_COMPLETED
  // (one synthetic event per epoch, grouping all per-fund mutation rows).
  // Note: SKIP-only epochs have no DB rows and are intentionally omitted.
  const evoRows = await db.prepare(
    `SELECT el.epoch, el.executed_at, el.action, el.fund_id,
            el.params_before, el.params_after, el.fitness_before, el.reason,
            fc.name AS fund_name
     FROM evolution_log el
     LEFT JOIN fund_configs fc ON el.fund_id = fc.id
     ORDER BY el.executed_at DESC
     LIMIT ?`,
  ).bind(Math.ceil(limit / 2)).all();

  type EpochBucket = {
    latestAt: string;
    actions: string[];
    mutations: Array<Record<string, unknown>>;
  };
  const epochMap = new Map<number, EpochBucket>();

  for (const r of evoRows.results || []) {
    const row = r as Record<string, unknown>;
    const action = String(row.action);
    const executedAt = String(row.executed_at);
    const fundId = String(row.fund_id);
    const fundName = String(row.fund_name ?? fundId);
    const epoch = Number(row.epoch);

    // Diff params_before vs params_after to recover the changed parameter list
    let changedParams: string[] = [];
    let adjustments: Array<{ param: string; before: unknown; after: unknown }> = [];
    try {
      const before = JSON.parse(String(row.params_before)) as Record<string, unknown>;
      const after = JSON.parse(String(row.params_after)) as Record<string, unknown>;
      changedParams = Object.keys({ ...before, ...after })
        .filter(k => String(before[k]) !== String(after[k]));
      adjustments = changedParams.map(k => ({ param: k, before: before[k], after: after[k] }));
    } catch { /* malformed JSON — skip diff */ }

    if (action === "MICRO_EVOLUTION") {
      events.push({
        type: "MICRO_EVOLUTION",
        timestamp: executedAt,
        payload: {
          fundId,
          fundName,
          adjustedParams: adjustments.length,
          adjustments,
          trigger: String(row.reason ?? ""),
        },
      });
    } else {
      // Non-micro rows → group by epoch for EVOLUTION_COMPLETED synthesis
      const bucket = epochMap.get(epoch) ?? { latestAt: executedAt, actions: [], mutations: [] };
      if (executedAt > bucket.latestAt) bucket.latestAt = executedAt;
      bucket.actions.push(action);
      bucket.mutations.push({
        fundId,
        fundName,
        action,
        fitnessBefore: row.fitness_before != null ? Number(row.fitness_before) : null,
        changedParams,
      });
      epochMap.set(epoch, bucket);
    }
  }

  // Emit one EVOLUTION_COMPLETED per epoch that had mutations
  for (const [epoch, bucket] of epochMap.entries()) {
    // Map per-fund actions back to epoch-level action (mirrors evolve.ts logic)
    const dominantAction = bucket.actions.some(a => a === "PBT_INHERIT_MUTATE")
      ? "STANDARD_PBT"
      : bucket.actions.some(a => a === "GLOBAL_RESET")
        ? "GLOBAL_RESET"
        : "SKIP_ALL_GOOD";
    events.push({
      type: "EVOLUTION_COMPLETED",
      timestamp: bucket.latestAt,
      payload: { epoch, action: dominantAction, mutations: bucket.mutations },
    });
  }
  // ── End evolution events ──────────────────────────────────────────────────

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
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "30"), 92);

  if (fundId) {
    const result = await db.prepare(
      "SELECT * FROM portfolio_snapshots WHERE fund_id = ? ORDER BY date DESC LIMIT ?",
    ).bind(fundId, limit).all();
    return Response.json({ snapshots: result.results || [] }, { headers });
  }

  const result = await db.prepare(
    "SELECT * FROM portfolio_snapshots ORDER BY date DESC LIMIT ?",
  ).bind(limit * 5).all();

  // Always query the true system start date independently of the sliding limit window.
  // This prevents daysRunning from decreasing as the window shrinks relative to total records.
  const startRow = await db.prepare(
    "SELECT MIN(date) as start_date FROM portfolio_snapshots",
  ).first<{ start_date: string | null }>();

  return Response.json({
    snapshots: result.results || [],
    startDate: startRow?.start_date ?? null,
  }, { headers });
}

/**
 * Market drivers — aggregate realized PnL by market in a recent time window.
 *
 * Powers the "Recent Market Drivers" card on the arena page (added 2026-05-11).
 * Only realized PnL is attributed (closed trades within the window). Unrealized
 * mark drift on long-held open positions is intentionally excluded — without
 * intra-day snapshot history we can't reliably attribute it to specific markets.
 *
 * Query params:
 *   - hours: window length in hours (1 / 3 / 12 / 24, default 3, max 168)
 *
 * Response:
 *   - windowHours, windowStart, windowEnd: window metadata
 *   - totalNet, totalAbs, totalCount: aggregate stats over ALL trades closed in window
 *   - drivers: top 10 markets by abs(net_pnl), each with net/profit/loss split + counts
 */
async function apiMarketDrivers(
  db: D1Database,
  req: Request,
  headers: HeadersInit,
): Promise<Response> {
  const url = new URL(req.url);
  const ALLOWED = [1, 3, 12, 24, 72, 168];
  const hoursRaw = parseInt(url.searchParams.get("hours") || "3", 10);
  const hours = Number.isFinite(hoursRaw) && ALLOWED.includes(hoursRaw) ? hoursRaw : 3;
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const driversResult = await db.prepare(
    `SELECT
       market_id,
       MAX(question) AS question,
       MAX(slug) AS slug,
       SUM(COALESCE(pnl, 0)) AS net_pnl,
       SUM(CASE WHEN COALESCE(pnl, 0) > 0 THEN COALESCE(pnl, 0) ELSE 0 END) AS gross_profit,
       SUM(CASE WHEN COALESCE(pnl, 0) < 0 THEN COALESCE(pnl, 0) ELSE 0 END) AS gross_loss,
       COUNT(*) AS trade_count,
       COUNT(DISTINCT fund_id) AS fund_count,
       MAX(closed_at) AS last_closed_at
     FROM paper_trades
     WHERE closed_at >= ?
       AND status NOT IN ('OPEN', 'INVALID_PRICE')
     GROUP BY market_id
     ORDER BY ABS(SUM(COALESCE(pnl, 0))) DESC
     LIMIT 10`,
  ).bind(cutoff).all();

  const drivers = (driversResult.results ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      marketId: String(row.market_id ?? ""),
      question: row.question == null ? null : String(row.question),
      slug: row.slug == null ? null : String(row.slug),
      netPnl: Math.round(Number(row.net_pnl ?? 0) * 100) / 100,
      grossProfit: Math.round(Number(row.gross_profit ?? 0) * 100) / 100,
      grossLoss: Math.round(Number(row.gross_loss ?? 0) * 100) / 100,
      tradeCount: Number(row.trade_count ?? 0),
      fundCount: Number(row.fund_count ?? 0),
      lastClosedAt: row.last_closed_at == null ? null : String(row.last_closed_at),
    };
  });

  const totalsRow = await db.prepare(
    `SELECT
       SUM(COALESCE(pnl, 0)) AS total_net,
       SUM(ABS(COALESCE(pnl, 0))) AS total_abs,
       COUNT(*) AS total_count
     FROM paper_trades
     WHERE closed_at >= ?
       AND status NOT IN ('OPEN', 'INVALID_PRICE')`,
  ).bind(cutoff).first<{ total_net: number; total_abs: number; total_count: number }>();

  return Response.json(
    {
      windowHours: hours,
      windowStart: cutoff,
      windowEnd: new Date().toISOString(),
      totalNet: Math.round(Number(totalsRow?.total_net ?? 0) * 100) / 100,
      totalAbs: Math.round(Number(totalsRow?.total_abs ?? 0) * 100) / 100,
      totalCount: Number(totalsRow?.total_count ?? 0),
      drivers,
    },
    { headers },
  );
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

/**
 * Static fallback map for Chinese descriptions.
 * Applied when `description_zh` is NULL in the DB (variants seeded after migration 008
 * and PBT-generated generations that inherit the same English description).
 * This is the worker-side equivalent of schema/020-description-zh-backfill.sql.
 */
const ZH_DESCRIPTION_FALLBACKS: Array<{ prefix: string; zh: string }> = [
  { prefix: "Gradient-based micro-evolution",    zh: "基于梯度的微进化，±2% 参数边界" },
  { prefix: "Aggressive micro-evolver",          zh: "激进微进化器：4% 参数调整率，15 笔交易触发阈值，适应速度更快" },
  { prefix: "Conservative risk",                 zh: "保守风控：止损和最大持仓阈值收紧至 0.8×，更快止损" },
  { prefix: "High-edge trader",                  zh: "高边缘交易器：要求边缘值 ≥ 2× 基金最小边缘，减少交易次数，提升确信度" },
  { prefix: "Edge-ranked signal allocation",     zh: "基于边缘排序的信号分配与仓位管理" },
  { prefix: "Trend-following scanner",           zh: "趋势跟踪扫描器：过滤 SPREAD 信号，结合成交量对齐提升 MISPRICING，置信度下限 0.35，成交量要求 1.5×" },
  { prefix: "Adaptive monitor",                  zh: "自适应监控器：对年轻持仓（< 3 天）放宽止损，随收益增加收紧追踪止损" },
  { prefix: "More cautious with new positions",  zh: "对新持仓更加保守，允许盈利持续奔跑，采用 LLM 驱动的参数配置" },
];

function resolveZhDescription(descriptionZh: string | null, description: string | null): string | null {
  if (descriptionZh) return descriptionZh;
  if (!description) return null;
  for (const { prefix, zh } of ZH_DESCRIPTION_FALLBACKS) {
    if (description.startsWith(prefix)) return zh;
  }
  return null;
}

async function apiGeneVariants(
  db: D1Database,
  req: Request,
  headers: HeadersInit,
): Promise<Response> {
  const url = new URL(req.url);
  const geneId = url.searchParams.get("gene") ?? undefined;
  const lang = url.searchParams.get("lang") ?? "en";
  await ensureNonNegativePetriScores(db);
  await Promise.all(GENE_REGISTRY.map(g => ensureSaneActiveVariant(db, g.id).catch(() => null)));
  const variants = await listVariants(db, geneId);
  const active = await getAllActiveVariants(db);

  const localizedVariants = lang === "zh"
    ? variants.map(v => ({
        ...v,
        description: resolveZhDescription(v.descriptionZh, v.description) ?? v.description,
      }))
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
  await ensureStaticG1LineageBackfill(db);
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
  await ensureNonNegativePetriScores(db);
  const log = await getEvolutionLog(db, limit);
  const epoch = await getCurrentEpoch(db);
  return Response.json({ epoch, log }, { headers });
}
