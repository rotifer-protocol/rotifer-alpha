/**
 * RiskMonitor Durable Object — high-frequency stop-loss sentinel.
 *
 * Uses DO alarms to wake every 60s, read mark prices from D1.last_price
 * (refreshed every 5min by price-refresh.ts cron), and check stop-loss
 * thresholds for all open positions. When a breach is detected, closes
 * the trade in D1 and notifies the LiveHub for real-time UI updates.
 *
 * D-Lite (2026-05-10): no longer fetches Gamma API per-alarm. The DO
 * runs at 60s cadence but the underlying mark refreshes at 5min — this
 * means stop-loss reaction has up to 5min latency to live market moves
 * (acceptable for paper trading, and the previous Gamma 24h MA was a
 * 24-HOUR-LAG mark, so this is still an order of magnitude improvement).
 * Stale rows are skipped — better to wait one cron tick than act wrongly.
 *
 * Architecture:
 *   Worker POST /arm   → stores fund configs + sets first alarm
 *   DO alarm()         → reads open trades + last_price, evaluates risk
 *   DO alarm()         → re-arms for next cycle (self-sustaining loop)
 *   Worker POST /disarm → cancels alarm loop
 */

import type { FundConfig, Settlement, AgentEvent } from "./types";
import { calcUnrealizedPnl, isStale } from "./price";
import { isUnreasonableLoss } from "./risk-policy";
import { getExecutionMode, recordShadowClose, isKillSwitchActive } from "./execution";

const ALARM_INTERVAL_MS = 60_000;

interface MonitorState {
  armed: boolean;
  funds: FundConfig[];
}

export class RiskMonitor {
  private state: DurableObjectState;
  private env: { DB: D1Database; LIVE_HUB: DurableObjectNamespace } | null = null;

  constructor(state: DurableObjectState, env: unknown) {
    this.state = state;
    this.env = env as { DB: D1Database; LIVE_HUB: DurableObjectNamespace } | null;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/arm" && request.method === "POST") {
      const { funds } = await request.json() as { funds: FundConfig[] };
      await this.state.storage.put<MonitorState>("config", { armed: true, funds });
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      return Response.json({ ok: true, nextAlarm: ALARM_INTERVAL_MS });
    }

    if (url.pathname === "/disarm" && request.method === "POST") {
      await this.state.storage.put<MonitorState>("config", { armed: false, funds: [] });
      await this.state.storage.deleteAlarm();
      return Response.json({ ok: true, disarmed: true });
    }

    if (url.pathname === "/status") {
      const config = await this.state.storage.get<MonitorState>("config");
      const alarm = await this.state.storage.getAlarm();
      return Response.json({
        armed: config?.armed ?? false,
        fundCount: config?.funds?.length ?? 0,
        nextAlarm: alarm,
      });
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const config = await this.state.storage.get<MonitorState>("config");
    if (!config?.armed || !config.funds.length || !this.env) {
      return;
    }

    // KILL_SWITCH check (round-2 fix, 2026-05-10): DO alarms run independently
    // of runPipeline(), so the existing kill switch in index.ts only stopped
    // the cron-driven pipeline — the DO kept firing every 60s and triggering
    // stop-loss closures. While kill switch is on we still re-arm the DO so
    // it can resume immediately when the operator flips the switch off, but
    // we skip the actual risk scan to prevent acting on poisoned marks.
    const killed = await isKillSwitchActive(this.env.DB);
    if (!killed) {
      try {
        await this.runRiskScan(config.funds);
      } catch (e) {
        console.error("RiskMonitor alarm error:", e);
      }
    }

    if (config.armed) {
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  private async runRiskScan(funds: FundConfig[]): Promise<void> {
    const db = this.env!.DB;
    const now = new Date();
    const ts = now.toISOString();
    const mode = await getExecutionMode(db);

    const openTrades = await db.prepare(
      "SELECT * FROM paper_trades WHERE status = 'OPEN'",
    ).all();
    if (!openTrades.results || openTrades.results.length === 0) return;

    const trades = openTrades.results as any[];
    const nowMs = now.getTime();
    const stopped: Settlement[] = [];

    for (const trade of trades) {
      const fund = funds.find(f => f.id === trade.fund_id);
      if (!fund) continue;

      // D-Lite: read mark from D1 (price-refresh.ts cron, 5min cadence).
      // Stale → skip; never act on stale data (prevents jitter from CLOB
      // outages bleeding into live decisions).
      const lastPrice = trade.last_price;
      if (typeof lastPrice !== "number" || isStale(trade.last_price_updated_at, nowMs)) {
        continue;
      }
      const currentPrice = lastPrice;

      const unrealizedPnl = calcUnrealizedPnl(trade.direction, trade.shares, trade.amount, currentPrice);
      // Track 3 sanity guard (2026-05-10): defer stop-loss on implausible mark.
      if (isUnreasonableLoss(unrealizedPnl, trade.amount)) continue;
      const lossPct = -unrealizedPnl / trade.amount;

      if (lossPct >= fund.stopLossPercent) {
        const closeReason = `Stop loss triggered at ${(lossPct * 100).toFixed(1)}% (threshold ${(fund.stopLossPercent * 100).toFixed(1)}%)`;
        await db.prepare(
          "UPDATE paper_trades SET status = 'STOPPED', exit_price = ?, pnl = ?, closed_at = ?, monitor_reason = ? WHERE id = ?",
        ).bind(currentPrice, unrealizedPnl, ts, closeReason, trade.id).run();

        if (mode === "shadow") {
          await recordShadowClose(db, trade.id, trade.fund_id, trade.market_id, trade.slug ?? "", trade.question, trade.direction, currentPrice, trade.shares, unrealizedPnl);
        }

        stopped.push({
          fundId: trade.fund_id,
          fundEmoji: fund.emoji,
          slug: trade.slug ?? "",
          question: trade.question,
          pnl: unrealizedPnl,
          direction: trade.direction,
          entryPrice: trade.entry_price,
          exitPrice: currentPrice,
          status: "STOPPED",
        });
      }
    }

    for (const s of stopped) {
      await this.broadcast({
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
          reason: "Stop loss triggered (real-time monitor).",
        },
      });
    }
  }

  private async broadcast(event: AgentEvent): Promise<void> {
    if (!this.env?.LIVE_HUB) return;
    try {
      const id = this.env.LIVE_HUB.idFromName("singleton");
      const stub = this.env.LIVE_HUB.get(id);
      await stub.fetch("http://internal/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      });
    } catch (e) {
      console.error("RiskMonitor broadcast failed:", e);
    }
  }
}
