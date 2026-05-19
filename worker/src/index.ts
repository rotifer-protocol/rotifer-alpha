// Polymarket Arbitrage Agent — Cloudflare Worker
// Five-Fund Paper Trading System with Evolution Engine
//
// Pipeline routing:
//   ENABLE_GENOME_PIPELINE=false (default) → legacy runPipeline (direct module calls)
//   ENABLE_GENOME_PIPELINE=true            → runGenomePipeline (Genome orchestrator + variant dispatch)
//   Rollback: set ENABLE_GENOME_PIPELINE=false in wrangler.toml and redeploy.
// Cron: every-5min scan+trade, daily 01:00 report, weekly Sun 00:00 evolve

import type { Env, AgentEvent, FundConfig } from "./types";
import { DEFAULT_FUNDS } from "./types";
import { scan, analyze } from "./scan";
import { paperTrade } from "./trade";
import { settle } from "./settle";
import { checkRiskLimits } from "./risk";
import { runEvolution, loadFundsFromDB, initializeFunds, apiEvolution } from "./evolve";
import { sendSignals, sendTrades, sendSummary, sendDailyReport, broadcast } from "./notify";
import { handleApi } from "./api";
import { requireAuth, handleCors, corsHeaders } from "./auth";
import { calcUnrealizedPnl, isStale } from "./price";
import { refreshOpenPrices } from "./price-refresh";
import { monitor, executeMonitorActions } from "./monitor";
import { checkAndRunMicroEvolution } from "./micro-evolve";
import {
  calculateCashBalance,
  calculateTotalValue,
  PERFORMANCE_REALIZED_TRADE_WHERE_SQL,
} from "./accounting";
import {
  isKillSwitchActive,
  getExecutionMode,
  setKillSwitch,
  getSystemConfig,
  setExecutionMode,
  storeHeartbeat,
  workerHeartbeatContext,
  type ExecutionMode,
  type PipelineHeartbeat,
} from "./execution";
import type { SkipReasonEntry } from "./trade";
import { resetCircuitBreakerEpochs } from "./circuit-breaker";
import { runGenomePipeline } from "./genome";
export { LiveHub } from "./ws-hub";
export { RiskMonitor } from "./risk-monitor";

// ─── Fund Loading ────────────────────────────────────────

async function getFunds(db: D1Database): Promise<FundConfig[]> {
  try {
    const dbFunds = await loadFundsFromDB(db);
    if (dbFunds && dbFunds.length > 0) return dbFunds;
  } catch {
    // fund_configs table may not exist yet
  }
  return DEFAULT_FUNDS;
}

// ─── Record & Snapshot ───────────────────────────────────

async function recordScan(
  db: D1Database,
  scanId: string,
  at: string,
  fetched: number,
  filtered: number,
  sigs: import("./types").ArbSignal[],
): Promise<void> {
  const avg = sigs.length > 0
    ? Math.round((sigs.reduce((s, x) => s + x.edge, 0) / sigs.length) * 100) / 100
    : 0;
  await db.prepare(
    "INSERT INTO scans (id, scanned_at, total_fetched, markets_filtered, signals_found, avg_edge) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(scanId, at, fetched, filtered, sigs.length, avg).run();

  for (const sig of sigs) {
    await db.prepare(
      "INSERT INTO signals (id, scan_id, signal_id, type, market_id, slug, question, description, edge, confidence, direction, prices, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      crypto.randomUUID(), scanId, sig.signalId, sig.type, sig.marketId, sig.slug,
      sig.question, sig.description, sig.edge, sig.confidence, sig.direction,
      JSON.stringify(sig.prices), sig.timestamp,
    ).run();
  }
}

async function takeSnapshot(db: D1Database, date: string, funds: FundConfig[]): Promise<void> {
  // D-Lite: read mark from D1.last_price (refreshed every 5min by
  // price-refresh.ts cron). Stale rows contribute 0 to unrealized — see
  // calculateOpenPositionStats() for stale-treatment policy. Snapshots
  // are written daily at UTC 00:00 so a stale row at snapshot time is rare
  // (5min stale threshold << 24h between snapshots).
  const allOpen = await db.prepare(
    `SELECT id, fund_id, market_id, direction, entry_price, shares, amount,
            last_price, last_price_updated_at
     FROM paper_trades WHERE status = 'OPEN'`,
  ).all();
  const openTrades = (allOpen.results ?? []) as any[];
  const snapshotNowMs = Date.now();

  for (const fund of funds) {
    const fundOpenTrades = openTrades.filter((t: any) => t.fund_id === fund.id);
    const openCount = fundOpenTrades.length;
    const invested = fundOpenTrades.reduce((s: number, t: any) => s + (t.amount as number), 0);

    let unrealizedPnl = 0;
    for (const t of fundOpenTrades) {
      const price = t.last_price;
      if (typeof price !== "number") continue;
      if (isStale(t.last_price_updated_at, snapshotNowMs)) continue;
      unrealizedPnl += calcUnrealizedPnl(t.direction, t.shares, t.amount, price);
    }
    unrealizedPnl = Math.round(unrealizedPnl * 100) / 100;

    const resolved = await db.prepare(
      `SELECT
         COALESCE(SUM(pnl),0) as pnl,
         COUNT(CASE WHEN pnl > 0 THEN 1 END) as wins,
         COUNT(CASE WHEN pnl < 0 THEN 1 END) as losses
       FROM paper_trades
       WHERE fund_id = ? AND ${PERFORMANCE_REALIZED_TRADE_WHERE_SQL}`,
    ).bind(fund.id).first<{ pnl: number; wins: number; losses: number }>();

    const realizedPnl = resolved?.pnl ?? 0;
    const cash = calculateCashBalance(fund.initialBalance, invested, realizedPnl);
    const totalValue = calculateTotalValue(fund.initialBalance, realizedPnl, unrealizedPnl);
    const wins = resolved?.wins ?? 0;
    const losses = resolved?.losses ?? 0;
    const winRate = (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) / 100 : 0;
    const drawdown = (fund.initialBalance - totalValue) / fund.initialBalance;
    const frozen = drawdown >= fund.drawdownLimit
      ? new Date(Date.now() + 86400000).toISOString()
      : null;

    await db.prepare(
      "INSERT OR REPLACE INTO portfolio_snapshots (id, fund_id, date, cash_balance, open_positions, unrealized_pnl, realized_pnl, total_value, win_count, loss_count, win_rate, monthly_target, drawdown_limit, frozen_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      `${fund.id}:${date}`, fund.id, date, cash, openCount, unrealizedPnl,
      realizedPnl, totalValue, wins, losses, winRate,
      fund.monthlyTarget, fund.drawdownLimit, frozen,
    ).run();
  }
}

// ─── Heartbeat helpers ───────────────────────────────────

function aggregateSkipReasons(reasons: SkipReasonEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of reasons) {
    counts[r.code] = (counts[r.code] ?? 0) + 1;
  }
  return counts;
}

// 2026-05-04: Per-fund skip breakdown for diagnostics (e.g. "why does turtle never trade?")
// Returns: { fundId: { skipCode: count } }
function aggregateSkipReasonsByFund(reasons: SkipReasonEntry[]): Record<string, Record<string, number>> {
  const byFund: Record<string, Record<string, number>> = {};
  for (const r of reasons) {
    byFund[r.fundId] = byFund[r.fundId] ?? {};
    byFund[r.fundId][r.code] = (byFund[r.fundId][r.code] ?? 0) + 1;
  }
  return byFund;
}

// ─── Pipeline ────────────────────────────────────────────

async function runPipeline(env: Env, funds: FundConfig[]): Promise<Record<string, unknown>> {
  const ts = new Date().toISOString();
  const scanId = crypto.randomUUID();

  if (await isKillSwitchActive(env.DB)) {
    console.warn("KILL_SWITCH active — pipeline halted");
    await broadcast(env, {
      type: "ERROR",
      timestamp: ts,
      payload: { stage: "kill_switch", message: "Trading halted by kill switch" },
    });
    return { halted: true, reason: "KILL_SWITCH", timestamp: ts };
  }

  // ─── Phase A: D-Lite price refresh (ADR-273 path-A) ──────
  // Runs BEFORE risk/monitor/scan/trade so all downstream decisions read the
  // freshest mark-to-market price from D1.last_price (CLOB mid). Failures here
  // do NOT halt the pipeline — stale positions are tolerated and surfaced via
  // staleCount; isStale() callers decide local fallback policy.
  let priceRefresh = { totalOpen: 0, refreshed: 0, fetchFailed: 0, missingTokenId: 0, backfilledTokenIds: 0 };
  try {
    const r = await refreshOpenPrices(env.DB);
    priceRefresh = {
      totalOpen: r.totalOpen,
      refreshed: r.refreshed,
      fetchFailed: r.fetchFailed,
      missingTokenId: r.missingTokenId,
      backfilledTokenIds: r.backfilledTokenIds,
    };
  } catch (e) {
    console.error("Price refresh failed (non-fatal):", e);
  }

  const riskResult = await checkRiskLimits(env.DB, funds);

  for (const s of riskResult.stopped) {
    await broadcast(env, {
      type: "TRADE_STOPPED",
      timestamp: ts,
      payload: {
        fundId: s.fundId,
        fundEmoji: s.fundEmoji,
        slug: s.slug,
        question: s.question,
        pnl: s.pnl,
        entryPrice: s.entryPrice,
        exitPrice: s.exitPrice,
        reason: "Stop loss triggered.",
      },
    });
  }
  for (const e of riskResult.expired) {
    await broadcast(env, {
      type: "TRADE_EXPIRED",
      timestamp: ts,
      payload: {
        fundId: e.fundId,
        fundEmoji: e.fundEmoji,
        slug: e.slug,
        question: e.question,
        pnl: e.pnl,
        entryPrice: e.entryPrice,
        exitPrice: e.exitPrice,
        reason: "Max hold window reached.",
      },
    });
  }

  const scanLimit = Number(env.SCAN_LIMIT) || 200;
  const minVolume = Number(env.MIN_VOLUME) || 5000;
  const minLiquidity = Number(env.MIN_LIQUIDITY) || 5000;

  let markets, totalFetched;
  try {
    const result = await scan(scanLimit);
    markets = result.markets;
    totalFetched = result.totalFetched;
  } catch (e) {
    console.error("Scan failed, skipping cycle:", e);
    await broadcast(env, {
      type: "ERROR",
      timestamp: ts,
      payload: { stage: "scan", message: String(e) },
    });
    return { error: "scan_failed", timestamp: ts };
  }

  const filtered = markets.filter(m => m.volume24hr >= minVolume && m.liquidity >= minLiquidity);
  const sigs = analyze(filtered, ts);
  const avg = sigs.length > 0
    ? Math.round((sigs.reduce((s, x) => s + x.edge, 0) / sigs.length) * 100) / 100
    : 0;

  await recordScan(env.DB, scanId, ts, totalFetched, filtered.length, sigs);

  const topMarkets = [...filtered]
    .sort((a, b) => b.volume24hr - a.volume24hr)
    .slice(0, 5)
    .map(m => ({ question: m.question, volume24hr: Math.round(m.volume24hr), liquidity: Math.round(m.liquidity) }));

  await broadcast(env, {
    type: "SCAN_COMPLETE",
    timestamp: ts,
    payload: { scanId, totalFetched, marketsFiltered: filtered.length, signalsFound: sigs.length, avgEdge: avg, topMarkets },
  });

  for (const sig of sigs) {
    await broadcast(env, {
      type: "SIGNAL_FOUND",
      timestamp: ts,
      payload: {
        signalId: sig.signalId, type: sig.type, slug: sig.slug, question: sig.question,
        edge: sig.edge, confidence: sig.confidence, direction: sig.direction,
        volume24hr: sig.prices["volume24hr"] ?? 0,
        liquidity: sig.prices["liquidity"] ?? 0,
      },
    });
  }

  const settlements = await settle(env.DB, markets, funds);
  for (const s of settlements) {
    await broadcast(env, {
      type: "TRADE_SETTLED",
      timestamp: ts,
      payload: {
        fundId: s.fundId,
        fundEmoji: s.fundEmoji,
        slug: s.slug,
        question: s.question,
        pnl: s.pnl,
        entryPrice: s.entryPrice,
        exitPrice: s.exitPrice,
        reason: "Market resolved on Polymarket.",
      },
    });
  }

  const monitorResult = await monitor(env.DB, funds);
  await executeMonitorActions(env.DB, monitorResult);
  for (const ma of monitorResult.actions) {
    const eventType = ma.newStatus === "PROFIT_TAKEN" ? "TRADE_PROFIT_TAKEN"
      : ma.newStatus === "TRAILING_STOPPED" ? "TRADE_TRAILING_STOPPED"
      : "TRADE_REVERSED";
    await broadcast(env, {
      type: eventType as import("./types").AgentEventType,
      timestamp: ts,
      payload: {
        fundId: ma.fundId,
        slug: ma.slug,
        question: ma.question,
        pnl: ma.pnl,
        reason: ma.reason,
        entryPrice: ma.entryPrice,
        exitPrice: ma.currentPrice,
      },
    });
  }

  const tradeResult = await paperTrade(env.DB, sigs, filtered, funds, ts);
  const trades = tradeResult.trades;
    for (const t of trades) {
    await broadcast(env, {
      type: "TRADE_OPENED",
      timestamp: ts,
      payload: { fundId: t.fundId, fundName: t.fundName, fundEmoji: t.fundEmoji, signalId: t.signalId, slug: t.slug, question: t.question, direction: t.direction, price: t.price, amount: t.amount },
    });
  }

  const { ok, fail } = await sendSignals(env, sigs);
  if (trades.length > 0) await sendTrades(env, trades);
  await sendSummary(env, filtered.length, sigs.length, avg, ok, fail, trades, ts);

  const summary: Record<string, unknown> = {
    scannedAt: ts,
    totalFetched,
    marketsFiltered: filtered.length,
    signalsFound: sigs.length,
    delivered: ok,
    failed: fail,
    tradesOpened: trades.length,
    settlementsProcessed: settlements.length,
    riskStops: riskResult.stopped.length,
    riskExpired: riskResult.expired.length,
    monitorActions: monitorResult.actions.length,
    microEvolutions: 0,
  };

  const microResults = await checkAndRunMicroEvolution(env.DB, funds);
  for (const mr of microResults) {
    if (!mr.triggered) continue;
    summary.microEvolutions = (summary.microEvolutions as number) + 1;
    await broadcast(env, {
      type: "MICRO_EVOLUTION",
      timestamp: ts,
      payload: {
        fundId: mr.fundId,
        fundName: mr.fundName,
        adjustedParams: mr.adjustments.length,
        adjustments: mr.adjustments,
        trigger: mr.trigger,
      } as unknown as Record<string, unknown>,
    });
  }

  await storeHeartbeat(env.DB, {
    lastScanAt: ts,
    worker: workerHeartbeatContext(env, "legacy"),
    totalFetched,
    marketsFiltered: filtered.length,
    signalsFound: sigs.length,
    tradesOpened: trades.length,
    settlementsProcessed: settlements.length,
    monitorActions: monitorResult.actions.length,
    riskStops: riskResult.stopped.length,
    riskExpired: riskResult.expired.length,
    skipSummary: aggregateSkipReasons(tradeResult.skipReasons),
    skipByFund: aggregateSkipReasonsByFund(tradeResult.skipReasons),
    priceRefresh,
  });

  await armRiskMonitor(env, funds);

  return summary;
}

async function runDailyReport(env: Env, funds: FundConfig[]): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await takeSnapshot(env.DB, today, funds);
  await sendDailyReport(env, funds);

  // Reset circuit breaker epochs at start of new trading day
  // (ALPHA-001 §9: epoch = 24h rolling window reset at 01:00 UTC)
  const balanceMap = new Map<string, number>();
  for (const fund of funds) {
    const balRow = await env.DB.prepare(
      "SELECT balance FROM fund_balances WHERE fund_id = ? LIMIT 1",
    ).first<{ balance: number }>(fund.id);
    balanceMap.set(fund.id, balRow?.balance ?? fund.initialBalance);
  }
  await resetCircuitBreakerEpochs(env.DB, balanceMap);

  const snapPayload: import("./types").SnapshotPayload = { funds: [] };
  for (const fund of funds) {
    const snap = await env.DB.prepare(
      "SELECT * FROM portfolio_snapshots WHERE fund_id = ? ORDER BY date DESC LIMIT 1",
    ).bind(fund.id).first() as any;
    const totalValue = snap?.total_value ?? fund.initialBalance;
    snapPayload.funds.push({
      id: fund.id,
      name: fund.name,
      emoji: fund.emoji,
      totalValue,
      returnPct: Math.round(((totalValue - fund.initialBalance) / fund.initialBalance) * 10000) / 100,
      winRate: snap?.win_rate ?? 0,
      openPositions: snap?.open_positions ?? 0,
      frozen: snap?.frozen_until ? new Date(snap.frozen_until) > new Date() : false,
    });
  }
  await broadcast(env, {
    type: "SNAPSHOT_UPDATED",
    timestamp: new Date().toISOString(),
    payload: snapPayload as unknown as Record<string, unknown>,
  });
}

// ─── Risk Monitor ────────────────────────────────────────

async function armRiskMonitor(env: Env, funds: FundConfig[]): Promise<void> {
  try {
    const id = env.RISK_MONITOR.idFromName("singleton");
    const stub = env.RISK_MONITOR.get(id);
    await stub.fetch("http://internal/arm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ funds }),
    });
  } catch (e) {
    console.error("Failed to arm RiskMonitor:", e);
  }
}

// ─── Entry ───────────────────────────────────────────────

export default {
  async scheduled(ev: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const funds = await getFunds(env.DB);
    const cron = ev.cron;

    if (cron === "0 0 * * *") {
      // Adaptive evolution check (daily 00:00 UTC).
      // runEvolution() internally applies the adaptive decision logic:
      //   MIN_EPOCH_DAYS / MAX_EPOCH_DAYS / TARGET_TRADES / tier-aware MIN_TRADES_FOR_EVAL.
      // Kill-switch guard: skip if operator has halted the system to avoid scoring
      // gene variants against poisoned/rollback-state trade data.
      ctx.waitUntil((async () => {
        if (await isKillSwitchActive(env.DB)) {
          console.warn("[Evolution] Skipped — KILL_SWITCH is active");
          return;
        }
        await runEvolution(env);
      })().catch(e => {
        console.error("Evolution failed:", e);
      }));
    } else if (cron === "0 1 * * *") {
      ctx.waitUntil(runDailyReport(env, funds).catch(e => {
        console.error("Daily report failed:", e);
      }));
    } else {
      const useGenome = env.ENABLE_GENOME_PIPELINE === "true";
      const pipelineRun = useGenome
        ? runGenomePipeline(env, funds)
        : runPipeline(env, funds);
      ctx.waitUntil(pipelineRun.catch(e => {
        console.error(`Pipeline failed [${useGenome ? "genome" : "legacy"}]:`, e);
      }));
    }
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const corsResponse = handleCors(req);
    if (corsResponse) return corsResponse;

    const url = new URL(req.url);
    const path = url.pathname;
    const origin = req.headers.get("Origin");
    const funds = await getFunds(env.DB);

    // WebSocket upgrade → route to Durable Object
    if (path === "/ws") {
      const upgradeHeader = req.headers.get("Upgrade");
      if (upgradeHeader !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const id = env.LIVE_HUB.idFromName("singleton");
      const stub = env.LIVE_HUB.get(id);
      return stub.fetch(req);
    }

    // Read-only API endpoints (no auth required)
    if (path.startsWith("/api/")) {
      if (path === "/api/evolution") {
        return apiEvolution(env.DB, req, corsHeaders(origin));
      }
      const apiResponse = await handleApi(path, req, env, funds);
      if (apiResponse) return apiResponse;
    }

    // Write endpoints (auth required)
    if (path === "/run" && req.method === "POST") {
      const authError = requireAuth(req, env);
      if (authError) return authError;
      try {
        const useGenome = env.ENABLE_GENOME_PIPELINE === "true";
        const result = useGenome
          ? await runGenomePipeline(env, funds)
          : await runPipeline(env, funds);
        return Response.json({ ...result, _pipeline: useGenome ? "genome" : "legacy" }, { headers: corsHeaders(origin) });
      } catch (e: unknown) {
        console.error("Manual run failed:", e);
        return Response.json(
          { error: "Internal error" },
          { status: 500, headers: corsHeaders(origin) },
        );
      }
    }

    if (path === "/report" && req.method === "POST") {
      const authError = requireAuth(req, env);
      if (authError) return authError;
      try {
        await runDailyReport(env, funds);
        return Response.json({ ok: true }, { headers: corsHeaders(origin) });
      } catch (e: unknown) {
        console.error("Manual report failed:", e);
        return Response.json(
          { error: "Internal error" },
          { status: 500, headers: corsHeaders(origin) },
        );
      }
    }

    if (path === "/evolve" && req.method === "POST") {
      const authError = requireAuth(req, env);
      if (authError) return authError;
      try {
        // Manual /evolve bypasses the adaptive gate (forceRun=true) so operators can
        // trigger a catch-up epoch (e.g. after a missed Sunday due to kill-switch or bug).
        const report = await runEvolution(env, /* forceRun */ true);
        return Response.json(report, { headers: corsHeaders(origin) });
      } catch (e: unknown) {
        console.error("Manual evolution failed:", e);
        return Response.json(
          { error: "Internal error" },
          { status: 500, headers: corsHeaders(origin) },
        );
      }
    }

    if (path === "/init-funds" && req.method === "POST") {
      const authError = requireAuth(req, env);
      if (authError) return authError;
      try {
        await initializeFunds(env.DB);
        return Response.json({ ok: true, funds: DEFAULT_FUNDS.length }, { headers: corsHeaders(origin) });
      } catch (e: unknown) {
        console.error("Fund init failed:", e);
        return Response.json(
          { error: "Internal error" },
          { status: 500, headers: corsHeaders(origin) },
        );
      }
    }

    if (path === "/kill-switch" && req.method === "POST") {
      const authError = requireAuth(req, env);
      if (authError) return authError;
      try {
        const body = await req.json() as { active: boolean };
        await setKillSwitch(env.DB, body.active);
        await broadcast(env, {
          type: body.active ? "ERROR" : "CONNECTED",
          timestamp: new Date().toISOString(),
          payload: { killSwitch: body.active, message: body.active ? "Kill switch ACTIVATED" : "Kill switch deactivated" },
        });
        return Response.json({ ok: true, killSwitch: body.active }, { headers: corsHeaders(origin) });
      } catch (e: unknown) {
        return Response.json({ error: "Internal error" }, { status: 500, headers: corsHeaders(origin) });
      }
    }

    if (path === "/execution-mode" && req.method === "POST") {
      const authError = requireAuth(req, env);
      if (authError) return authError;
      try {
        const body = await req.json() as { mode: ExecutionMode };
        if (body.mode !== "paper" && body.mode !== "shadow") {
          return Response.json({ error: "Invalid mode" }, { status: 400, headers: corsHeaders(origin) });
        }
        await setExecutionMode(env.DB, body.mode);
        return Response.json({ ok: true, mode: body.mode }, { headers: corsHeaders(origin) });
      } catch (e: unknown) {
        return Response.json({ error: "Internal error" }, { status: 500, headers: corsHeaders(origin) });
      }
    }

    // One-time cleanup: invalidate duplicate closed trades caused by the
    // missing re-entry cooldown (pre-fix period: 2026-04 → 2026-05-16).
    // Keeps the EARLIEST trade per (fund_id, market_id, calendar day).
    // Safe to call multiple times — already-MIGRATED rows are excluded.
    //
    // Use ?dry_run=1 to preview without writing; default is dry-run (require
    // ?execute=1 to actually write — safer default for a destructive operation).
    if (path === "/admin/dedup-trades" && req.method === "POST") {
      const authError = requireAuth(req, env);
      if (authError) return authError;
      const db = env.DB;
      const u = new URL(req.url);
      const execute = u.searchParams.get("execute") === "1";

      // Application-layer grouping: avoids the SQLite GROUP BY pitfall where
      // MIN(id) (random UUID) is not the earliest trade. We fetch all eligible
      // rows ordered by (fund, market, day, opened_at, id) and keep the first
      // row of each group in JS — guaranteed to be the chronologically earliest.
      //
      // Filter rationale:
      //   status IN (...REALIZED 6 statuses including EXPIRED): EXPIRED is a
      //     legitimate close path (max-hold timeout) and must be subject to
      //     dedup, not excluded.
      //   monitor_reason NOT LIKE 'MIGRATED:%': excludes both prior MIGRATED
      //     legacy rows and rows already invalidated by a previous run of
      //     this endpoint (idempotent).
      const eligibleSql = `
        SELECT id, fund_id, market_id, opened_at, pnl, status
        FROM paper_trades
        WHERE status IN ('RESOLVED','STOPPED','EXPIRED','PROFIT_TAKEN','TRAILING_STOPPED','REVERSED')
          AND (monitor_reason IS NULL OR monitor_reason NOT LIKE 'MIGRATED:%')
        ORDER BY fund_id, market_id, DATE(opened_at), opened_at, id
      `;
      const rowsResult = await db.prepare(eligibleSql).all<{
        id: string; fund_id: string; market_id: string; opened_at: string; pnl: number | null; status: string;
      }>();
      const rows = rowsResult.results ?? [];

      // Group by (fund_id, market_id, day) — keep first (earliest opened_at).
      const seen = new Set<string>();
      const toInvalidate: typeof rows = [];
      for (const r of rows) {
        const day = (r.opened_at ?? "").slice(0, 10);
        const key = `${r.fund_id}|${r.market_id}|${day}`;
        if (seen.has(key)) {
          toInvalidate.push(r);
        } else {
          seen.add(key);
        }
      }

      // Per-fund stats for dry-run preview & post-execute reporting
      const byFund: Record<string, { count: number; pnl_drop: number }> = {};
      let totalPnlDrop = 0;
      for (const r of toInvalidate) {
        const s = (byFund[r.fund_id] ??= { count: 0, pnl_drop: 0 });
        const pnl = Number(r.pnl ?? 0);
        s.count += 1;
        s.pnl_drop += pnl;
        totalPnlDrop += pnl;
      }

      if (toInvalidate.length === 0) {
        return Response.json(
          { mode: execute ? "execute" : "dry_run", invalidated: 0, message: "No duplicates found" },
          { headers: corsHeaders(origin) },
        );
      }

      if (!execute) {
        return Response.json({
          mode: "dry_run",
          would_invalidate: toInvalidate.length,
          total_pnl_drop: Math.round(totalPnlDrop * 100) / 100,
          per_fund: byFund,
          hint: "Re-run with ?execute=1 to actually invalidate these trades",
        }, { headers: corsHeaders(origin) });
      }

      // Execute — chunked UPDATE to avoid D1 statement size limits
      const now = new Date().toISOString();
      const ids = toInvalidate.map(r => r.id);
      let invalidated = 0;
      for (let i = 0; i < ids.length; i += 50) {
        const chunk = ids.slice(i, i + 50);
        const placeholders = chunk.map(() => "?").join(",");
        const result = await db.prepare(
          `UPDATE paper_trades SET status = 'EXPIRED',
                  monitor_reason = 'MIGRATED: duplicate — pre-cooldown bug',
                  closed_at = COALESCE(closed_at, ?)
           WHERE id IN (${placeholders})`,
        ).bind(now, ...chunk).run();
        invalidated += result.meta?.changes ?? 0;
      }
      return Response.json({
        mode: "execute",
        invalidated,
        total_pnl_drop: Math.round(totalPnlDrop * 100) / 100,
        per_fund: byFund,
        message: `Invalidated ${invalidated} duplicate trades`,
      }, { headers: corsHeaders(origin) });
    }

    if (path === "/risk-monitor") {
      const id = env.RISK_MONITOR.idFromName("singleton");
      const stub = env.RISK_MONITOR.get(id);
      if (req.method === "GET") {
        return stub.fetch("http://internal/status");
      }
      const authError = requireAuth(req, env);
      if (authError) return authError;
      const body = await req.json() as { action: string };
      if (body.action === "arm") {
        return stub.fetch("http://internal/arm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ funds }),
        });
      }
      if (body.action === "disarm") {
        return stub.fetch("http://internal/disarm", { method: "POST" });
      }
      return Response.json({ error: "Invalid action" }, { status: 400, headers: corsHeaders(origin) });
    }

    // Info endpoint
    return Response.json(
      {
      name: "petri-polymarket-agent",
        version: "3.1.0",
        status: "experimental",
        funds: funds.map(f => ({
          id: f.id, name: f.name, emoji: f.emoji, motto: f.motto,
          monthlyTarget: `+${f.monthlyTarget * 100}%`,
          initialBalance: f.initialBalance,
        })),
        schedule: {
          scan: "every 5 min",
          riskMonitor: "every 60s (Durable Object alarm)",
          dailyReport: "0 1 * * * (UTC 01:00 = BJ 09:00)",
          evolution: "0 0 * * SUN (Sunday UTC 00:00 = BJ 08:00)",
        },
        endpoints: {
          "GET /api/funds": "Fund rankings and stats",
          "GET /api/trades": "Trade history (query: status, fund, limit)",
          "GET /api/signals": "Recent signals (query: limit)",
          "GET /api/snapshots": "Portfolio snapshots (query: fund, limit)",
          "GET /api/market-drivers": "Top markets by realized PnL in time window (query: hours=1|3|12|24|72|168, default 3)",
          "GET /api/evolution": "Evolution log and epoch history",
          "GET /api/shadow": "Shadow order log and paper-vs-shadow comparison (query: fund, limit)",
          "GET /api/system": "System config (kill switch, execution mode)",
          "GET /api/heartbeat": "Pipeline heartbeat (last scan time, skip reasons)",
          "GET /api/health": "Health check (includes kill switch + mode)",
          "WS /ws": "Real-time event stream (WebSocket)",
          "POST /run": "Manual scan+trade (auth required)",
          "POST /report": "Manual daily report (auth required)",
          "POST /evolve": "Manual evolution trigger (auth required)",
          "POST /init-funds": "Initialize fund configs in D1 (auth required)",
          "POST /kill-switch": "Toggle kill switch (auth required, body: {active: boolean})",
          "POST /execution-mode": "Set execution mode (auth required, body: {mode: 'paper'|'shadow'})",
          "GET /risk-monitor": "Risk monitor status",
          "POST /risk-monitor": "Arm/disarm risk monitor (auth required, body: {action: 'arm'|'disarm'})",
        },
      },
      { headers: corsHeaders(origin) },
    );
  },
};
