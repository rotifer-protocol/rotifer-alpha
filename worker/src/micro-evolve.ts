import type { FundConfig } from "./types";
import { PERFORMANCE_REALIZED_TRADE_WHERE_SQL } from "./accounting";
import { fundTier, getBound, clampParam } from "./param-bounds";

/**
 * Data-driven micro-evolution engine.
 *
 * Triggered per-fund when >=20 closed trades accumulate since last micro-evolve.
 * Analyzes recent trade outcomes to compute a local gradient for evolvable params,
 * then nudges each param by ±2% of its range toward better performance.
 *
 * Uses tier-aware param bounds from param-bounds.ts (shared with PBT evolve.ts)
 * so medium/large funds are not incorrectly clamped to small-tier limits.
 */

const MICRO_TRADE_THRESHOLD_DEFAULT = 20;
const MICRO_ADJUST_RATIO_DEFAULT = 0.02;

export interface MicroEvoOptions {
  /** Override the adjustment ratio (fraction of param range per nudge). Default 0.02. */
  adjustRatio?: number;
  /** Override minimum closed trades before nudge triggers. Default 20. */
  tradeThreshold?: number;
}

export interface MicroAdjustment {
  param: string;
  before: number;
  after: number;
  direction: "up" | "down";
}

export interface MicroEvolveResult {
  fundId: string;
  fundName: string;
  triggered: boolean;
  tradesSinceLast: number;
  adjustments: MicroAdjustment[];
  trigger: string;
}

interface ClosedTrade {
  pnl: number;
  status: string;
  monitor_reason: string | null;
  closed_at: string;
  amount: number;
  entry_price: number;
  direction: string;
  max_hold_days_used?: number;
}

export async function checkAndRunMicroEvolution(
  db: D1Database,
  funds: FundConfig[],
  opts: MicroEvoOptions = {},
): Promise<MicroEvolveResult[]> {
  const MICRO_TRADE_THRESHOLD = opts.tradeThreshold ?? MICRO_TRADE_THRESHOLD_DEFAULT;
  const MICRO_ADJUST_RATIO = opts.adjustRatio ?? MICRO_ADJUST_RATIO_DEFAULT;
  const results: MicroEvolveResult[] = [];
  const now = new Date().toISOString();

  for (const fund of funds) {
    const meta = await db.prepare(
      "SELECT last_micro_evolve_at, micro_evolve_count FROM fund_configs WHERE id = ?",
    ).bind(fund.id).first<{ last_micro_evolve_at: string | null; micro_evolve_count: number }>();

    const lastMicro = meta?.last_micro_evolve_at ?? "1970-01-01T00:00:00Z";

    const closedSinceLast = await db.prepare(
      `SELECT pnl, status, monitor_reason, closed_at, amount, entry_price, direction
       FROM paper_trades
       WHERE fund_id = ? AND ${PERFORMANCE_REALIZED_TRADE_WHERE_SQL}
       AND closed_at > ?
       ORDER BY closed_at ASC`,
    ).bind(fund.id, lastMicro).all();

    const trades = (closedSinceLast.results ?? []) as unknown as ClosedTrade[];

    if (trades.length < MICRO_TRADE_THRESHOLD) {
      results.push({
        fundId: fund.id,
        fundName: fund.name,
        triggered: false,
        tradesSinceLast: trades.length,
        adjustments: [],
        trigger: `${trades.length}/${MICRO_TRADE_THRESHOLD} trades`,
      });
      continue;
    }

    const tier = fundTier(fund.initialBalance);
    const adjustments = analyzeAndAdjust(trades, fund, tier, MICRO_ADJUST_RATIO);

    if (adjustments.length > 0) {
      const setClauses: string[] = [];
      const values: unknown[] = [];

      const fieldMap: Record<string, string> = {
        minEdge: "min_edge",
        minConfidence: "min_confidence",
        maxPerEvent: "max_per_event",
        maxOpenPositions: "max_open_positions",
        stopLossPercent: "stop_loss_percent",
        maxHoldDays: "max_hold_days",
        takeProfitPercent: "take_profit_percent",
        trailingStopPercent: "trailing_stop_percent",
        probReversalThreshold: "prob_reversal_threshold",
        sizingBase: "sizing_base",
        sizingScale: "sizing_scale",
        maxSameEventPositions: "max_same_event_positions",
        eventFamilyCooldownHours: "event_family_cooldown_hours",
        maxCategoryFraction: "max_category_fraction",
      };

      for (const adj of adjustments) {
        const col = fieldMap[adj.param];
        if (col) {
          setClauses.push(`${col} = ?`);
          values.push(adj.after);
        }
      }

      setClauses.push("last_micro_evolve_at = ?", "micro_evolve_count = ?", "updated_at = ?");
      values.push(now, (meta?.micro_evolve_count ?? 0) + 1, now);
      values.push(fund.id);

      await db.prepare(
        `UPDATE fund_configs SET ${setClauses.join(", ")} WHERE id = ?`,
      ).bind(...values).run();

      const paramsBefore: Record<string, unknown> = {};
      const paramsAfter: Record<string, unknown> = {};
      for (const adj of adjustments) {
        paramsBefore[adj.param] = adj.before;
        paramsAfter[adj.param] = adj.after;
      }
      await db.prepare(
        `INSERT INTO evolution_log (id, epoch, executed_at, action, fund_id, params_before, params_after, fitness_before, fitness_after, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        -1,
        now,
        "MICRO_EVOLUTION",
        fund.id,
        JSON.stringify(paramsBefore),
        JSON.stringify(paramsAfter),
        null,
        null,
        `Data-driven micro-adjustment from ${trades.length} trades`,
      ).run();
    } else {
      await db.prepare(
        "UPDATE fund_configs SET last_micro_evolve_at = ?, updated_at = ? WHERE id = ?",
      ).bind(now, now, fund.id).run();
    }

    results.push({
      fundId: fund.id,
      fundName: fund.name,
      triggered: true,
      tradesSinceLast: trades.length,
      adjustments,
      trigger: `${trades.length} trades since last micro-evolve`,
    });
  }

  return results;
}

export function analyzeAndAdjust(
  trades: ClosedTrade[],
  fund: FundConfig,
  tier: "small" | "medium" | "large",
  adjustRatio: number,
): MicroAdjustment[] {
  const adjustments: MicroAdjustment[] = [];
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const winRate = trades.filter(t => t.pnl > 0).length / trades.length;
  const avgPnl = totalPnl / trades.length;

  const stopLossCount = trades.filter(t => t.status === "STOPPED").length;
  const profitTakenCount = trades.filter(t => t.status === "PROFIT_TAKEN").length;
  const trailingStoppedCount = trades.filter(t => t.status === "TRAILING_STOPPED").length;
  const reversedCount = trades.filter(t => t.status === "REVERSED").length;
  const expiredCount = trades.filter(t => t.status === "EXPIRED").length;

  // --- Stop-loss tuning ---
  const stopLossRate = stopLossCount / trades.length;
  if (stopLossRate > 0.4) {
    adjustments.push(nudge("stopLossPercent", fund, tier, "up", adjustRatio));
  } else if (stopLossRate < 0.1 && avgPnl < 0) {
    adjustments.push(nudge("stopLossPercent", fund, tier, "down", adjustRatio));
  }

  // --- Take-profit tuning (v2: bidirectional with deadband, 2026-05-20) ---
  //
  // PRIOR BUG (v1): the up-trigger was `avgTakeReturn > fund.takeProfitPercent * 0.8`.
  // PROFIT_TAKEN-state trades by *definition* satisfy `pnl/amount ≥ takeProfitPercent`,
  // and 5-min monitor-cycle slippage typically pushes the realized value 10-30% above
  // the threshold.  The old judge was therefore permanently true whenever any profit
  // was taken, creating a one-way upward drift that pushed all 15 funds from the 0.25
  // default to 0.45-1.16 by 2026-05-20 (none ever decreased).
  //
  // RESULT (v1 bug evidence): take-profit rarely fired (PROFIT_TAKEN 136 vs STOPPED 315
  // over 14 days = 1:2.3 imbalance), since most positions could not realistically reach
  // the 50%+ threshold the bug had pushed funds to.
  //
  // FIX (v2 bidirectional + deadband):
  //   • Down-trigger (NEW): profit-taken rate < 10% AND stop-loss rate > 30%
  //     → threshold is too high; positions get stopped out before reaching it.
  //   • Up-trigger (TIGHTENED): profit-taken rate > 20% AND avgTakeReturn > 1.5×
  //     → threshold-overshoot must be substantial, not just slippage.
  //   • Deadband (10% ≤ profitTakenRate ≤ 20%): no adjustment, prevents oscillation
  //     around the boundary.
  const profitTakenRate = profitTakenCount / trades.length;
  const stopLossRateForTP = stopLossCount / trades.length;

  if (profitTakenRate < 0.10 && stopLossRateForTP > 0.30) {
    adjustments.push(nudge("takeProfitPercent", fund, tier, "down", adjustRatio));
  } else if (profitTakenRate > 0.20 && profitTakenCount > 0) {
    const postProfitTrades = trades.filter(t => t.status === "PROFIT_TAKEN");
    const avgTakeReturn = postProfitTrades.reduce((s, t) => s + t.pnl / t.amount, 0) / postProfitTrades.length;
    if (avgTakeReturn > fund.takeProfitPercent * 1.5) {
      adjustments.push(nudge("takeProfitPercent", fund, tier, "up", adjustRatio));
    }
  }

  // --- Trailing stop tuning ---
  if (trailingStoppedCount / trades.length > 0.3) {
    adjustments.push(nudge("trailingStopPercent", fund, tier, "up", adjustRatio));
  } else if (trailingStoppedCount === 0 && profitTakenCount > 3) {
    adjustments.push(nudge("trailingStopPercent", fund, tier, "down", adjustRatio));
  }

  // --- Probability reversal tuning ---
  if (reversedCount / trades.length > 0.25) {
    adjustments.push(nudge("probReversalThreshold", fund, tier, "down", adjustRatio));
  } else if (reversedCount === 0 && stopLossRate > 0.3) {
    adjustments.push(nudge("probReversalThreshold", fund, tier, "down", adjustRatio));
  }

  // --- Expiry tuning ---
  if (expiredCount / trades.length > 0.3) {
    adjustments.push(nudge("maxHoldDays", fund, tier, "down", adjustRatio));
  } else if (expiredCount === 0 && avgPnl > 0) {
    adjustments.push(nudge("maxHoldDays", fund, tier, "up", adjustRatio));
  }

  // --- Sizing tuning ---
  if (totalPnl > 0 && winRate > 0.55) {
    adjustments.push(nudge("sizingBase", fund, tier, "up", adjustRatio));
  } else if (totalPnl < 0 && winRate < 0.4) {
    adjustments.push(nudge("sizingBase", fund, tier, "down", adjustRatio));
  }

  return adjustments.filter(a => a.before !== a.after);
}

function nudge(
  param: string,
  fund: FundConfig,
  tier: "small" | "medium" | "large",
  direction: "up" | "down",
  adjustRatio: number,
): MicroAdjustment {
  const bound = getBound(tier, param);
  const current = (fund as any)[param] as number;
  if (typeof current !== "number" || !bound) {
    return { param, before: current ?? 0, after: current ?? 0, direction };
  }

  const range = bound.max - bound.min;
  const delta = range * adjustRatio;
  const newVal = direction === "up"
    ? clampParam(tier, param, current + delta)
    : clampParam(tier, param, current - delta);

  return { param, before: current, after: newVal, direction };
}
