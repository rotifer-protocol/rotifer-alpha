import type { Env, FundConfig, AgentEvent } from "./types";
import { DEFAULT_FUNDS } from "./types";
import { broadcast } from "./notify";
import { PERFORMANCE_REALIZED_TRADE_WHERE_SQL } from "./accounting";

// ─── Parameter Boundaries ───────────────────────────────

interface ParamBound {
  min: number;
  max: number;
  integer?: boolean;
}

const PARAM_BOUNDS: Record<string, ParamBound> = {
  minEdge:          { min: 0,    max: 10 },
  minConfidence:    { min: 0,    max: 1 },
  minVolume:        { min: 1000, max: 100000, integer: true },
  minLiquidity:     { min: 1000, max: 100000, integer: true },
  maxPerEvent:      { min: 50,   max: 2000,   integer: true },
  maxOpenPositions: { min: 3,    max: 20,     integer: true },
  monthlyTarget:    { min: 0.01, max: 0.30 },
  drawdownLimit:    { min: 0.05, max: 0.50 },
  stopLossPercent:  { min: 0.05, max: 0.30 },
  maxHoldDays:      { min: 3,    max: 30,     integer: true },
  sizingBase:           { min: 50,   max: 500,    integer: true },
  sizingScale:          { min: 0,    max: 500,    integer: true },
  takeProfitPercent:    { min: 0.05, max: 2.0 },
  trailingStopPercent:  { min: 0.03, max: 0.50 },
  probReversalThreshold: { min: 0.05, max: 0.50 },
};

const EVOLVABLE_PARAMS = Object.keys(PARAM_BOUNDS);

function clampParam(name: string, value: number): number {
  const bound = PARAM_BOUNDS[name];
  if (!bound) return value;
  let v = Math.max(bound.min, Math.min(bound.max, value));
  if (bound.integer) v = Math.round(v);
  return Math.round(v * 10000) / 10000;
}

// ─── Fitness Function ───────────────────────────────────

interface FitnessInput {
  fundId: string;
  initialBalance: number;
}

interface FitnessResult {
  fundId: string;
  fitness: number;
  sharpe: number;
  winRate: number;
  maxDrawdown: number;
  complexity: number;
  tradeCount: number;
}

async function calculateFitness(
  db: D1Database,
  input: FitnessInput,
  fund: FundConfig,
  lookbackDays: number = 28,
): Promise<FitnessResult> {
  const cutoff = new Date(Date.now() - lookbackDays * 86400000).toISOString();

  const trades = await db.prepare(
    `SELECT pnl, closed_at FROM paper_trades
     WHERE fund_id = ? AND ${PERFORMANCE_REALIZED_TRADE_WHERE_SQL}
     AND closed_at >= ?
     ORDER BY closed_at ASC`,
  ).bind(input.fundId, cutoff).all();

  const results = (trades.results || []) as any[];
  const tradeCount = results.length;

  if (tradeCount < 3) {
    return {
      fundId: input.fundId,
      fitness: 0,
      sharpe: 0,
      winRate: 0,
      maxDrawdown: 0,
      complexity: 0,
      tradeCount,
    };
  }

  const pnls = results.map(r => r.pnl as number);
  const wins = pnls.filter(p => p > 0).length;
  const winRate = wins / tradeCount;

  const meanPnl = pnls.reduce((s, p) => s + p, 0) / tradeCount;
  const variance = pnls.reduce((s, p) => s + (p - meanPnl) ** 2, 0) / tradeCount;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? meanPnl / stdDev : 0;

  let peak = input.initialBalance;
  let cumulative = input.initialBalance;
  let maxDrawdown = 0;
  for (const pnl of pnls) {
    cumulative += pnl;
    if (cumulative > peak) peak = cumulative;
    const dd = (peak - cumulative) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const defaults = DEFAULT_FUNDS.find(f => f.id === input.fundId) || DEFAULT_FUNDS[0];
  let paramDeviation = 0;
  let paramCount = 0;
  for (const param of EVOLVABLE_PARAMS) {
    const bound = PARAM_BOUNDS[param];
    if (!bound) continue;
    const range = bound.max - bound.min;
    if (range <= 0) continue;
    const current = (fund as any)[param] as number;
    const defaultVal = (defaults as any)[param] as number;
    if (typeof current !== "number" || typeof defaultVal !== "number") continue;
    paramDeviation += ((current - defaultVal) / range) ** 2;
    paramCount++;
  }
  const complexity = paramCount > 0 ? Math.sqrt(paramDeviation / paramCount) : 0;

  // F(g) = Sharpe * 0.4 + WinRate * 0.2 + (1-MaxDD) * 0.3 - Complexity * 0.1
  const fitness =
    sharpe * 0.4 +
    winRate * 0.2 +
    (1 - maxDrawdown) * 0.3 -
    complexity * 0.1;

  return {
    fundId: input.fundId,
    fitness: Math.round(fitness * 10000) / 10000,
    sharpe: Math.round(sharpe * 10000) / 10000,
    winRate: Math.round(winRate * 10000) / 10000,
    maxDrawdown: Math.round(maxDrawdown * 10000) / 10000,
    complexity: Math.round(complexity * 10000) / 10000,
    tradeCount,
  };
}

// ─── Mutation ───────────────────────────────────────────

function mutateParams(fund: FundConfig): Partial<FundConfig> {
  const mutated: Record<string, number> = {};

  for (const param of EVOLVABLE_PARAMS) {
    const bound = PARAM_BOUNDS[param];
    if (!bound) continue;
    const current = (fund as any)[param] as number;
    if (typeof current !== "number") continue;

    // Gaussian noise: sigma = 5% of parameter range
    const range = bound.max - bound.min;
    const sigma = range * 0.05;
    const noise = gaussianRandom() * sigma;
    mutated[param] = clampParam(param, current + noise);
  }

  // Keep drawdownSoftLimit at 50% of drawdownLimit
  if (mutated.drawdownLimit !== undefined) {
    mutated.drawdownSoftLimit = clampParam(
      "drawdownLimit",
      mutated.drawdownLimit * 0.5,
    );
  }

  return mutated as unknown as Partial<FundConfig>;
}

function gaussianRandom(): number {
  // Box-Muller transform
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ─── Meta-Control Rules ─────────────────────────────────

type EvolutionAction = "SKIP_INSUFFICIENT" | "SKIP_ALL_GOOD" | "GLOBAL_RESET" | "STANDARD_PBT";

function decideEvolutionAction(results: FitnessResult[]): EvolutionAction {
  const totalTrades = results.reduce((s, r) => s + r.tradeCount, 0);
  if (totalTrades < 10) return "SKIP_INSUFFICIENT";

  const allGood = results.every(r => r.fitness > 0.6);
  if (allGood) return "SKIP_ALL_GOOD";

  const allBad = results.every(r => r.fitness < 0.2);
  if (allBad) return "GLOBAL_RESET";

  return "STANDARD_PBT";
}

// ─── Fund Config DB Helpers ─────────────────────────────

function fundToRow(fund: FundConfig): Record<string, unknown> {
  return {
    id: fund.id,
    name: fund.name,
    emoji: fund.emoji,
    motto: fund.motto,
    initial_balance: fund.initialBalance,
    monthly_target: fund.monthlyTarget,
    drawdown_limit: fund.drawdownLimit,
    drawdown_soft_limit: fund.drawdownSoftLimit,
    allowed_types: JSON.stringify(fund.allowedTypes),
    min_edge: fund.minEdge,
    min_confidence: fund.minConfidence,
    min_volume: fund.minVolume,
    min_liquidity: fund.minLiquidity,
    max_per_event: fund.maxPerEvent,
    max_open_positions: fund.maxOpenPositions,
    stop_loss_percent: fund.stopLossPercent,
    max_hold_days: fund.maxHoldDays,
    sizing_mode: fund.sizingMode,
    sizing_base: fund.sizingBase,
    sizing_scale: fund.sizingScale,
    take_profit_percent: fund.takeProfitPercent,
    trailing_stop_percent: fund.trailingStopPercent,
    prob_reversal_threshold: fund.probReversalThreshold,
  };
}

function rowToFund(row: any): FundConfig {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    motto: row.motto,
    initialBalance: row.initial_balance,
    monthlyTarget: row.monthly_target,
    drawdownLimit: row.drawdown_limit,
    drawdownSoftLimit: row.drawdown_soft_limit,
    allowedTypes: JSON.parse(row.allowed_types),
    minEdge: row.min_edge,
    minConfidence: row.min_confidence,
    minVolume: row.min_volume,
    minLiquidity: row.min_liquidity,
    maxPerEvent: row.max_per_event,
    maxOpenPositions: row.max_open_positions,
    stopLossPercent: row.stop_loss_percent,
    maxHoldDays: row.max_hold_days,
    takeProfitPercent: row.take_profit_percent ?? 0.25,
    trailingStopPercent: row.trailing_stop_percent ?? 0.10,
    probReversalThreshold: row.prob_reversal_threshold ?? 0.15,
    sizingMode: row.sizing_mode,
    sizingBase: row.sizing_base,
    sizingScale: row.sizing_scale,
  };
}

export async function loadFundsFromDB(db: D1Database): Promise<FundConfig[] | null> {
  const rows = await db.prepare(
    "SELECT * FROM fund_configs ORDER BY id",
  ).all();
  if (!rows.results || rows.results.length === 0) return null;
  return rows.results.map(rowToFund);
}

export async function initializeFunds(db: D1Database): Promise<void> {
  const ts = new Date().toISOString();
  for (const fund of DEFAULT_FUNDS) {
    const row = fundToRow(fund);
    await db.prepare(
      `INSERT OR IGNORE INTO fund_configs
       (id, name, emoji, motto, initial_balance, monthly_target,
        drawdown_limit, drawdown_soft_limit, allowed_types,
        min_edge, min_confidence, min_volume, min_liquidity,
        max_per_event, max_open_positions, stop_loss_percent,
        max_hold_days, sizing_mode, sizing_base, sizing_scale,
        take_profit_percent, trailing_stop_percent, prob_reversal_threshold,
        generation, parent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    ).bind(
      row.id, row.name, row.emoji, row.motto, row.initial_balance,
      row.monthly_target, row.drawdown_limit, row.drawdown_soft_limit,
      row.allowed_types, row.min_edge, row.min_confidence,
      row.min_volume, row.min_liquidity, row.max_per_event,
      row.max_open_positions, row.stop_loss_percent, row.max_hold_days,
      row.sizing_mode, row.sizing_base, row.sizing_scale,
      row.take_profit_percent, row.trailing_stop_percent, row.prob_reversal_threshold,
      ts, ts,
    ).run();
  }
}

async function getEpoch(db: D1Database): Promise<number> {
  const r = await db.prepare(
    "SELECT MAX(epoch) as max_epoch FROM evolution_log",
  ).first<{ max_epoch: number | null }>();
  return (r?.max_epoch ?? 0) + 1;
}

async function updateFundParams(
  db: D1Database,
  fundId: string,
  params: Partial<FundConfig>,
  generation: number,
  parentId: string | null,
): Promise<void> {
  const ts = new Date().toISOString();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  const fieldMap: Record<string, string> = {
    minEdge: "min_edge",
    minConfidence: "min_confidence",
    minVolume: "min_volume",
    minLiquidity: "min_liquidity",
    maxPerEvent: "max_per_event",
    maxOpenPositions: "max_open_positions",
    monthlyTarget: "monthly_target",
    drawdownLimit: "drawdown_limit",
    drawdownSoftLimit: "drawdown_soft_limit",
    stopLossPercent: "stop_loss_percent",
    maxHoldDays: "max_hold_days",
    sizingBase: "sizing_base",
    sizingScale: "sizing_scale",
    takeProfitPercent: "take_profit_percent",
    trailingStopPercent: "trailing_stop_percent",
    probReversalThreshold: "prob_reversal_threshold",
  };

  for (const [key, column] of Object.entries(fieldMap)) {
    if ((params as any)[key] !== undefined) {
      setClauses.push(`${column} = ?`);
      values.push((params as any)[key]);
    }
  }

  setClauses.push("generation = ?", "parent_id = ?", "updated_at = ?");
  values.push(generation, parentId, ts);
  values.push(fundId);

  await db.prepare(
    `UPDATE fund_configs SET ${setClauses.join(", ")} WHERE id = ?`,
  ).bind(...values).run();
}

async function logEvolution(
  db: D1Database,
  epoch: number,
  action: string,
  fundId: string,
  paramsBefore: Record<string, unknown>,
  paramsAfter: Record<string, unknown>,
  fitnessBefore: number | null,
  fitnessAfter: number | null,
  reason: string,
): Promise<void> {
  await db.prepare(
    `INSERT INTO evolution_log
     (id, epoch, executed_at, action, fund_id, params_before, params_after, fitness_before, fitness_after, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    epoch,
    new Date().toISOString(),
    action,
    fundId,
    JSON.stringify(paramsBefore),
    JSON.stringify(paramsAfter),
    fitnessBefore,
    fitnessAfter,
    reason,
  ).run();
}

// ─── Evolution Engine ───────────────────────────────────

export interface EvolutionReport {
  epoch: number;
  action: EvolutionAction;
  fitnessResults: FitnessResult[];
  mutations: Array<{
    fundId: string;
    fundName: string;
    action: string;
    fitnessBefore: number;
    changedParams: string[];
  }>;
}

export async function runEvolution(env: Env): Promise<EvolutionReport> {
  const db = env.DB;
  const epoch = await getEpoch(db);
  const ts = new Date().toISOString();

  await broadcast(env, {
    type: "EVOLUTION_STARTED",
    timestamp: ts,
    payload: { epoch },
  });

  let funds = await loadFundsFromDB(db);
  if (!funds || funds.length === 0) {
    await initializeFunds(db);
    funds = DEFAULT_FUNDS;
  }

  const fitnessResults: FitnessResult[] = [];
  for (const fund of funds) {
    const result = await calculateFitness(
      db,
      { fundId: fund.id, initialBalance: fund.initialBalance },
      fund,
    );
    fitnessResults.push(result);
  }

  fitnessResults.sort((a, b) => b.fitness - a.fitness);

  const action = decideEvolutionAction(fitnessResults);
  const mutations: EvolutionReport["mutations"] = [];

  if (action === "SKIP_INSUFFICIENT" || action === "SKIP_ALL_GOOD") {
    for (const fr of fitnessResults) {
      await logEvolution(db, epoch, action, fr.fundId, {}, {}, fr.fitness, fr.fitness, action);
    }
  } else if (action === "GLOBAL_RESET") {
    for (const fund of funds) {
      // Skip evolveExempt funds (institutional like Beluga/Leviathan)——their parameters
      // exceed PARAM_BOUNDS upper limits; resetting them would clamp into small-fund range.
      if (fund.evolveExempt) {
        const fr = fitnessResults.find(f => f.fundId === fund.id);
        await logEvolution(db, epoch, "EVOLVE_EXEMPT", fund.id, {}, {}, fr?.fitness ?? null, fr?.fitness ?? null, "Institutional fund, exempt from PBT mutation");
        continue;
      }
      const defaultFund = DEFAULT_FUNDS.find(f => f.id === fund.id);
      if (!defaultFund) continue;

      const before = extractEvolvableParams(fund);
      const resetted = mutateParams(defaultFund);
      const after = { ...extractEvolvableParams(defaultFund), ...resetted };

      await updateFundParams(db, fund.id, resetted, epoch, null);
      const fr = fitnessResults.find(f => f.fundId === fund.id);
      await logEvolution(db, epoch, "GLOBAL_RESET", fund.id, before, after, fr?.fitness ?? null, null, "All funds below 0.2 fitness");

      mutations.push({
        fundId: fund.id,
        fundName: fund.name,
        action: "GLOBAL_RESET",
        fitnessBefore: fr?.fitness ?? 0,
        changedParams: Object.keys(resetted),
      });
    }
  } else {
    // STANDARD_PBT: worst fund inherits best fund's params + mutation
    // Exclude evolveExempt funds (institutional Beluga/Leviathan) — they participate in
    // fitness ranking display but not in PBT mutate, because their parameters
    // (maxPerEvent / sizingBase / minVolume) exceed PARAM_BOUNDS upper limits and would
    // be clamped back to small-fund range, destroying their strategy space.
    const evolvableResults = fitnessResults.filter(fr => {
      const fund = funds.find(f => f.id === fr.fundId);
      return fund && !fund.evolveExempt;
    });

    if (evolvableResults.length < 2) {
      for (const fr of fitnessResults) {
        await logEvolution(db, epoch, "SKIP_INSUFFICIENT", fr.fundId, {}, {}, fr.fitness, fr.fitness, "Fewer than 2 evolvable funds available for PBT");
      }
      const skipReport: EvolutionReport = {
        epoch,
        action: "SKIP_INSUFFICIENT",
        fitnessResults,
        mutations: [],
      };
      await broadcast(env, {
        type: "EVOLUTION_COMPLETED",
        timestamp: new Date().toISOString(),
        payload: skipReport as unknown as Record<string, unknown>,
      });
      return skipReport;
    }

    const best = evolvableResults[0];
    const worst = evolvableResults[evolvableResults.length - 1];

    const bestFund = funds.find(f => f.id === best.fundId)!;
    const worstFund = funds.find(f => f.id === worst.fundId)!;

    const worstBefore = extractEvolvableParams(worstFund);
    const inherited = extractEvolvableParams(bestFund);
    const mutatedDelta = mutateParams(bestFund);
    const newParams = { ...inherited };
    for (const [key, val] of Object.entries(mutatedDelta)) {
      if (val !== undefined) (newParams as any)[key] = val;
    }

    // Preserve identity fields
    const preservedFields: Partial<FundConfig> = {};
    for (const [key, val] of Object.entries(newParams)) {
      (preservedFields as any)[key] = val;
    }

    await updateFundParams(db, worst.fundId, preservedFields, epoch, best.fundId);
    await logEvolution(
      db, epoch, "PBT_INHERIT_MUTATE", worst.fundId,
      worstBefore, newParams,
      worst.fitness, null,
      `Inherited from ${best.fundId} (fitness ${best.fitness}) + mutation`,
    );

    const changedParams = Object.keys(newParams).filter(k => {
      return (worstBefore as any)[k] !== (newParams as any)[k];
    });

    mutations.push({
      fundId: worst.fundId,
      fundName: worstFund.name,
      action: "PBT_INHERIT_MUTATE",
      fitnessBefore: worst.fitness,
      changedParams,
    });

    // Log unchanged funds (evolveExempt institutional funds tagged EVOLVE_EXEMPT)
    for (const fr of fitnessResults) {
      if (fr.fundId === worst.fundId) continue;
      const fund = funds.find(f => f.id === fr.fundId);
      const logAction = fund?.evolveExempt ? "EVOLVE_EXEMPT" : "UNCHANGED";
      const reason = fund?.evolveExempt
        ? "Institutional fund, exempt from PBT mutation"
        : "Not worst performer";
      await logEvolution(db, epoch, logAction, fr.fundId, {}, {}, fr.fitness, fr.fitness, reason);
    }
  }

  const report: EvolutionReport = { epoch, action, fitnessResults, mutations };

  await broadcast(env, {
    type: "EVOLUTION_COMPLETED",
    timestamp: new Date().toISOString(),
    payload: report as unknown as Record<string, unknown>,
  });

  await sendEvolutionTelegram(env, report);

  return report;
}

function extractEvolvableParams(fund: FundConfig): Record<string, number> {
  const params: Record<string, number> = {};
  for (const key of EVOLVABLE_PARAMS) {
    const val = (fund as any)[key];
    if (typeof val === "number") params[key] = val;
  }
  return params;
}

// ─── Telegram Evolution Report ──────────────────────────

function esc(t: string): string {
  return String(t).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function escN(n: number): string {
  return String(n).replace(/\./g, "\\.");
}

async function sendEvolutionTelegram(env: Env, report: EvolutionReport): Promise<void> {
  const lines = [
    `🧬 *进化报告 \\— Epoch ${report.epoch}*`,
    ``,
    `📋 *决策:* ${esc(actionLabel(report.action))}`,
    ``,
    `📊 *适应度排名:*`,
  ];

  const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
  for (let i = 0; i < report.fitnessResults.length; i++) {
    const fr = report.fitnessResults[i];
    lines.push(
      `${medals[i] || `${i + 1}.`} \`${esc(fr.fundId)}\` F\\(g\\)=${escN(fr.fitness)} \\| Sharpe=${escN(fr.sharpe)} WR=${escN(fr.winRate)} DD=${escN(fr.maxDrawdown)} \\(${fr.tradeCount} trades\\)`,
    );
  }

  if (report.mutations.length > 0) {
    lines.push(``, `🔬 *变异:*`);
    for (const m of report.mutations) {
      lines.push(
        `  ${esc(m.fundName)}: ${esc(m.action)} \\(F\\(g\\) was ${escN(m.fitnessBefore)}\\)`,
      );
      if (m.changedParams.length > 0) {
        lines.push(`  Changed: \`${esc(m.changedParams.join(", "))}\``);
      }
    }
  }

  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: lines.join("\n"),
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.error("Evolution TG report failed:", e);
  }
}

function actionLabel(action: EvolutionAction): string {
  switch (action) {
    case "SKIP_INSUFFICIENT": return "跳过——样本不足 (<10 trades)";
    case "SKIP_ALL_GOOD": return "跳过——全体表现良好 (F(g)>0.6)";
    case "GLOBAL_RESET": return "全局重置——全体低迷 (F(g)<0.2)";
    case "STANDARD_PBT": return "标准 PBT——末位继承 + 变异";
  }
}

// ─── Read-only API for evolution data ───────────────────

export async function apiEvolution(
  db: D1Database,
  req: Request,
  headers: HeadersInit,
): Promise<Response> {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 100);

  const logs = await db.prepare(
    "SELECT * FROM evolution_log ORDER BY epoch DESC, executed_at DESC LIMIT ?",
  ).bind(limit).all();

  const epochStats = await db.prepare(
    `SELECT epoch, COUNT(*) as actions,
            MIN(executed_at) as started_at,
            GROUP_CONCAT(DISTINCT action) as action_types
     FROM evolution_log
     GROUP BY epoch
     ORDER BY epoch DESC
     LIMIT 20`,
  ).all();

  const lineage = await db.prepare(
    "SELECT id, name, emoji, generation, parent_id FROM fund_configs ORDER BY id",
  ).all();

  return Response.json({
    logs: logs.results || [],
    epochs: epochStats.results || [],
    lineage: lineage.results || [],
  }, { headers });
}
