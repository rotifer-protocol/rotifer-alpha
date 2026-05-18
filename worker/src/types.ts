export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  API_TOKEN: string;
  LIVE_HUB: DurableObjectNamespace;
  RISK_MONITOR: DurableObjectNamespace;
  SCAN_LIMIT?: string;
  MIN_VOLUME?: string;
  MIN_LIQUIDITY?: string;
  /** Only scan markets resolving within this many days. Unset = no filter. */
  SCAN_END_DATE_WINDOW_DAYS?: string;
  /** Trades across all active gene variants before code evolution epoch triggers. Default 10. */
  EPOCH_TRADE_THRESHOLD?: string;
  /** Minimum trades per variant required for evaluation. Default 3. */
  MIN_TRADES_FOR_EVAL?: string;
  /** Run challenger variants once every N 5-minute pipeline buckets. 0 disables exploration. */
  GENE_EXPLORATION_INTERVAL?: string;
  /** Feature flag: set to "true" to route pipeline through runGenomePipeline (Genome orchestrator).
   *  Default "false" keeps the legacy runPipeline path. Rollback: set back to "false" and redeploy. */
  ENABLE_GENOME_PIPELINE?: string;
  /** Cloudflare Workers AI binding — used for Phase 3.5 LLM variant config generation. */
  AI?: {
    run(
      model: string,
      input: { messages: Array<{ role: string; content: string }>; max_tokens?: number },
    ): Promise<{ response?: string }>;
  };
}

export interface MarketSnapshot {
  id: string;
  question: string;
  slug: string;
  outcomes: string[];
  outcomePrices: number[];
  bestBid: number;
  bestAsk: number;
  spread: number;
  volume24hr: number;
  liquidity: number;
  endDate: string;
  eventSlug: string;
  eventTitle: string;
  active: boolean;
  closed: boolean;
}

export type SignalType = "MISPRICING" | "MULTI_OUTCOME_ARB" | "SPREAD";

export interface ArbSignal {
  signalId: string;
  type: SignalType;
  marketId: string;
  slug: string;
  question: string;
  description: string;
  edge: number;
  confidence: number;
  direction: string;
  prices: Record<string, number>;
  timestamp: string;
  resolvedMarketId?: string;
}

export interface FundConfig {
  id: string;
  name: string;
  emoji: string;
  motto: string;
  initialBalance: number;
  monthlyTarget: number;
  drawdownLimit: number;
  drawdownSoftLimit: number;
  allowedTypes: string[];
  minEdge: number;
  minConfidence: number;
  minVolume: number;
  minLiquidity: number;
  maxPerEvent: number;
  maxOpenPositions: number;
  stopLossPercent: number;
  maxHoldDays: number;
  takeProfitPercent: number;
  trailingStopPercent: number;
  probReversalThreshold: number;
  sizingMode: "fixed" | "confidence" | "edge" | "edge_confidence";
  sizingBase: number;
  sizingScale: number;
  // evolveExempt removed (ADR-274 D4): tier-aware PARAM_BOUNDS replaces the need for
  // an exemption flag. All funds now evolve within their own tier's bounds.
  // Market Impact Gate (2026-05-18): max fraction of market liquidity a single order
  // may consume. Prevents trading in thin markets where our order causes price impact.
  // Optional — defaults to 0.15 (15%) if not set. Evolvable via PARAM_BOUNDS_INVARIANT.
  maxMarketImpactRatio?: number;
}

export type TradeStatus =
  | "OPEN"
  | "RESOLVED"
  | "STOPPED"
  | "EXPIRED"
  | "PROFIT_TAKEN"
  | "TRAILING_STOPPED"
  | "REVERSED"
  | "INVALIDATED";

export interface TradeAction {
  fundId: string;
  fundEmoji: string;
  fundName: string;
  signalId: string;
  slug: string;
  question: string;
  direction: string;
  price: number;
  amount: number;
  shares: number;
}

export interface Settlement {
  fundId: string;
  fundEmoji: string;
  slug: string;
  question: string;
  pnl: number;
  direction: string;
  entryPrice: number;
  exitPrice: number;
  status: TradeStatus;
}

// ─── AgentEvent Protocol ────────────────────────────────

export type AgentEventType =
  | "CONNECTED"
  | "SCAN_COMPLETE"
  | "SIGNAL_FOUND"
  | "TRADE_OPENED"
  | "TRADE_STOPPED"
  | "TRADE_EXPIRED"
  | "TRADE_INVALIDATED"
  | "TRADE_SETTLED"
  | "SNAPSHOT_UPDATED"
  | "EVOLUTION_STARTED"
  | "EVOLUTION_COMPLETED"
  | "TRADE_PROFIT_TAKEN"
  | "TRADE_TRAILING_STOPPED"
  | "TRADE_REVERSED"
  | "MICRO_EVOLUTION"
  | "CODE_EVOLUTION"
  | "FUND_FROZEN"
  | "FUND_UNFROZEN"
  | "ERROR";

export interface AgentEvent {
  type: AgentEventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface ScanCompletePayload {
  scanId: string;
  totalFetched: number;
  marketsFiltered: number;
  signalsFound: number;
  avgEdge: number;
}

export interface SignalFoundPayload {
  signalId: string;
  type: SignalType;
  question: string;
  edge: number;
  confidence: number;
  direction: string;
}

export interface TradeOpenedPayload {
  fundId: string;
  fundName: string;
  fundEmoji: string;
  signalId: string;
  question: string;
  direction: string;
  price: number;
  amount: number;
}

export interface TradeClosedPayload {
  fundId: string;
  fundName: string;
  fundEmoji: string;
  question: string;
  pnl: number;
  direction: string;
  entryPrice: number;
  exitPrice: number;
  reason: string;
}

export interface SnapshotPayload {
  funds: Array<{
    id: string;
    name: string;
    emoji: string;
    totalValue: number;
    returnPct: number;
    winRate: number;
    openPositions: number;
    frozen: boolean;
  }>;
}

// ─── Default Fund Configurations ────────────────────────

export function sizing(config: FundConfig, sig: ArbSignal): number {
  switch (config.sizingMode) {
    case "fixed":
      return config.sizingBase;
    case "confidence":
      return Math.round(config.sizingBase + sig.confidence * config.sizingScale);
    case "edge":
      return Math.min(config.sizingBase + config.sizingScale, Math.round(config.sizingBase * (sig.edge / 1.5)));
    case "edge_confidence":
      return Math.round(config.sizingBase * (1 + sig.edge * sig.confidence * config.sizingScale / 100));
    default:
      return config.sizingBase;
  }
}

export const DEFAULT_FUNDS: FundConfig[] = [
  {
    id: "turtle", name: "海龟", emoji: "🐢",
    motto: "少即是多，确定性高于一切",
    initialBalance: 10000, monthlyTarget: 0.03,
    drawdownLimit: 0.10, drawdownSoftLimit: 0.05,
    // 2026-05-04 修订（"海龟从未下单" bug 修复）：
    // - allowedTypes 加入 MULTI_OUTCOME_ARB（多选一套利对保守型基金合适，不引入 SPREAD 流动性风险）
    // - minVolume 20000→10000（仍是 5 小基金中最高，但不再排除中等流动性市场）
    // - minEdge 2→1.5（小幅放宽，仍比猎豹保守）
    // 详见 internal/plan/rotifer-petri/petri-phase-0-5-implementation.md "海龟基金诊断" 章节。
    allowedTypes: ["MISPRICING", "MULTI_OUTCOME_ARB"],
    minEdge: 1.5, minConfidence: 0.5, minVolume: 10000, minLiquidity: 10000,
    maxPerEvent: 200, maxOpenPositions: 5,
    stopLossPercent: 0.05, maxHoldDays: 7,
    takeProfitPercent: 0.15, trailingStopPercent: 0.08, probReversalThreshold: 0.15,
    sizingMode: "fixed", sizingBase: 200, sizingScale: 0,
  },
  {
    id: "cheetah", name: "猎豹", emoji: "🐆",
    motto: "机会属于敢于出手的人",
    initialBalance: 10000, monthlyTarget: 0.08,
    drawdownLimit: 0.20, drawdownSoftLimit: 0.10,
    allowedTypes: ["MISPRICING", "MULTI_OUTCOME_ARB"],
    minEdge: 1, minConfidence: 0.2, minVolume: 5000, minLiquidity: 5000,
    maxPerEvent: 800, maxOpenPositions: 10,
    stopLossPercent: 0.15, maxHoldDays: 14,
    takeProfitPercent: 0.30, trailingStopPercent: 0.12, probReversalThreshold: 0.20,
    sizingMode: "confidence", sizingBase: 100, sizingScale: 300,
  },
  {
    id: "octopus", name: "章鱼", emoji: "🐙",
    motto: "用数据说话，让公式决策",
    initialBalance: 10000, monthlyTarget: 0.05,
    drawdownLimit: 0.15, drawdownSoftLimit: 0.08,
    allowedTypes: ["MISPRICING", "SPREAD"],
    minEdge: 0, minConfidence: 0, minVolume: 5000, minLiquidity: 5000,
    maxPerEvent: 600, maxOpenPositions: 8,
    stopLossPercent: 0.10, maxHoldDays: 10,
    takeProfitPercent: 0.25, trailingStopPercent: 0.10, probReversalThreshold: 0.15,
    sizingMode: "edge", sizingBase: 100, sizingScale: 300,
  },
  {
    id: "shark", name: "鲨鱼", emoji: "🦈",
    motto: "大胆出击，快速收割",
    initialBalance: 10000, monthlyTarget: 0.15,
    drawdownLimit: 0.30, drawdownSoftLimit: 0.15,
    allowedTypes: ["MISPRICING", "MULTI_OUTCOME_ARB", "SPREAD"],
    minEdge: 0.5, minConfidence: 0.1, minVolume: 3000, minLiquidity: 3000,
    maxPerEvent: 2400, maxOpenPositions: 15,
    stopLossPercent: 0.20, maxHoldDays: 21,
    takeProfitPercent: 0.50, trailingStopPercent: 0.18, probReversalThreshold: 0.25,
    sizingMode: "confidence", sizingBase: 150, sizingScale: 500,
  },
  {
    id: "gambler", name: "蜜獾", emoji: "🎲",
    motto: "无所畏惧，绝不退让",
    initialBalance: 10000, monthlyTarget: 0.30,
    drawdownLimit: 0.50, drawdownSoftLimit: 0.25,
    allowedTypes: ["MISPRICING", "MULTI_OUTCOME_ARB", "SPREAD"],
    minEdge: 0, minConfidence: 0, minVolume: 1000, minLiquidity: 1000,
    maxPerEvent: 5000, maxOpenPositions: 20,
    stopLossPercent: 0.30, maxHoldDays: 30,
    takeProfitPercent: 1.00, trailingStopPercent: 0.25, probReversalThreshold: 0.30,
    sizingMode: "edge_confidence", sizingBase: 100, sizingScale: 200,
  },
  // ─── Medium tier ($100K) — ADR-274 D7: same personality × 10× capital ────────
  {
    id: "turtle_m", name: "海龟·M", emoji: "🐢",
    motto: "少即是多，确定性高于一切",
    initialBalance: 100000, monthlyTarget: 0.03,
    drawdownLimit: 0.10, drawdownSoftLimit: 0.05,
    allowedTypes: ["MISPRICING", "MULTI_OUTCOME_ARB"],
    minEdge: 1.5, minConfidence: 0.5, minVolume: 50000, minLiquidity: 30000,
    maxPerEvent: 2000, maxOpenPositions: 5,
    stopLossPercent: 0.05, maxHoldDays: 7,
    takeProfitPercent: 0.15, trailingStopPercent: 0.08, probReversalThreshold: 0.15,
    sizingMode: "fixed", sizingBase: 2000, sizingScale: 0,
  },
  {
    id: "cheetah_m", name: "猎豹·M", emoji: "🐆",
    motto: "机会属于敢于出手的人",
    initialBalance: 100000, monthlyTarget: 0.08,
    drawdownLimit: 0.20, drawdownSoftLimit: 0.10,
    allowedTypes: ["MISPRICING", "MULTI_OUTCOME_ARB"],
    minEdge: 1, minConfidence: 0.2, minVolume: 20000, minLiquidity: 15000,
    maxPerEvent: 8000, maxOpenPositions: 10,
    stopLossPercent: 0.15, maxHoldDays: 14,
    takeProfitPercent: 0.30, trailingStopPercent: 0.12, probReversalThreshold: 0.20,
    sizingMode: "confidence", sizingBase: 1000, sizingScale: 3000,
  },
  {
    id: "octopus_m", name: "章鱼·M", emoji: "🐙",
    motto: "用数据说话，让公式决策",
    initialBalance: 100000, monthlyTarget: 0.05,
    drawdownLimit: 0.15, drawdownSoftLimit: 0.08,
    allowedTypes: ["MISPRICING", "SPREAD"],
    minEdge: 0, minConfidence: 0, minVolume: 20000, minLiquidity: 15000,
    maxPerEvent: 6000, maxOpenPositions: 8,
    stopLossPercent: 0.10, maxHoldDays: 10,
    takeProfitPercent: 0.25, trailingStopPercent: 0.10, probReversalThreshold: 0.15,
    sizingMode: "edge", sizingBase: 1000, sizingScale: 3000,
  },
  {
    id: "shark_m", name: "鲨鱼·M", emoji: "🦈",
    motto: "大胆出击，快速收割",
    initialBalance: 100000, monthlyTarget: 0.15,
    drawdownLimit: 0.30, drawdownSoftLimit: 0.15,
    allowedTypes: ["MISPRICING", "MULTI_OUTCOME_ARB", "SPREAD"],
    minEdge: 0.5, minConfidence: 0.1, minVolume: 15000, minLiquidity: 10000,
    maxPerEvent: 15000, maxOpenPositions: 15,
    stopLossPercent: 0.20, maxHoldDays: 21,
    takeProfitPercent: 0.50, trailingStopPercent: 0.18, probReversalThreshold: 0.25,
    sizingMode: "confidence", sizingBase: 1500, sizingScale: 5000,
  },
  {
    id: "gambler_m", name: "蜜獾·M", emoji: "🎲",
    motto: "无所畏惧，绝不退让",
    initialBalance: 100000, monthlyTarget: 0.30,
    drawdownLimit: 0.50, drawdownSoftLimit: 0.25,
    allowedTypes: ["MISPRICING", "MULTI_OUTCOME_ARB", "SPREAD"],
    minEdge: 0, minConfidence: 0, minVolume: 5000, minLiquidity: 5000,
    maxPerEvent: 30000, maxOpenPositions: 20,
    stopLossPercent: 0.30, maxHoldDays: 30,
    takeProfitPercent: 1.00, trailingStopPercent: 0.25, probReversalThreshold: 0.30,
    sizingMode: "edge_confidence", sizingBase: 1000, sizingScale: 2000,
  },
  // ─── Large tier ($1M) — ADR-274 D7: same personality × 100× capital ─────────
  // Constrained by Polymarket liquidity reality: minVolume/minLiquidity filters
  // to large-enough markets; experiment observes capital absorption at scale.
  {
    id: "turtle_l", name: "海龟·L", emoji: "🐢",
    motto: "少即是多，确定性高于一切",
    initialBalance: 1000000, monthlyTarget: 0.03,
    drawdownLimit: 0.10, drawdownSoftLimit: 0.05,
    allowedTypes: ["MISPRICING", "MULTI_OUTCOME_ARB"],
    minEdge: 1.5, minConfidence: 0.5, minVolume: 150000, minLiquidity: 100000,
    maxPerEvent: 20000, maxOpenPositions: 5,
    stopLossPercent: 0.05, maxHoldDays: 7,
    takeProfitPercent: 0.15, trailingStopPercent: 0.08, probReversalThreshold: 0.15,
    sizingMode: "fixed", sizingBase: 20000, sizingScale: 0,
  },
  {
    id: "cheetah_l", name: "猎豹·L", emoji: "🐆",
    motto: "机会属于敢于出手的人",
    initialBalance: 1000000, monthlyTarget: 0.08,
    drawdownLimit: 0.20, drawdownSoftLimit: 0.10,
    allowedTypes: ["MISPRICING", "MULTI_OUTCOME_ARB"],
    minEdge: 1, minConfidence: 0.2, minVolume: 80000, minLiquidity: 60000,
    maxPerEvent: 80000, maxOpenPositions: 10,
    stopLossPercent: 0.15, maxHoldDays: 14,
    takeProfitPercent: 0.30, trailingStopPercent: 0.12, probReversalThreshold: 0.20,
    sizingMode: "confidence", sizingBase: 10000, sizingScale: 30000,
  },
  {
    id: "octopus_l", name: "章鱼·L", emoji: "🐙",
    motto: "用数据说话，让公式决策",
    initialBalance: 1000000, monthlyTarget: 0.05,
    drawdownLimit: 0.15, drawdownSoftLimit: 0.08,
    allowedTypes: ["MISPRICING", "SPREAD"],
    minEdge: 0, minConfidence: 0, minVolume: 80000, minLiquidity: 60000,
    maxPerEvent: 60000, maxOpenPositions: 8,
    stopLossPercent: 0.10, maxHoldDays: 10,
    takeProfitPercent: 0.25, trailingStopPercent: 0.10, probReversalThreshold: 0.15,
    sizingMode: "edge", sizingBase: 10000, sizingScale: 30000,
  },
  {
    id: "shark_l", name: "鲨鱼·L", emoji: "🦈",
    motto: "大胆出击，快速收割",
    initialBalance: 1000000, monthlyTarget: 0.15,
    drawdownLimit: 0.30, drawdownSoftLimit: 0.15,
    allowedTypes: ["MISPRICING", "MULTI_OUTCOME_ARB", "SPREAD"],
    minEdge: 0.5, minConfidence: 0.1, minVolume: 50000, minLiquidity: 40000,
    maxPerEvent: 100000, maxOpenPositions: 15,
    stopLossPercent: 0.20, maxHoldDays: 21,
    takeProfitPercent: 0.50, trailingStopPercent: 0.18, probReversalThreshold: 0.25,
    sizingMode: "confidence", sizingBase: 15000, sizingScale: 50000,
  },
  {
    id: "gambler_l", name: "蜜獾·L", emoji: "🎲",
    motto: "无所畏惧，绝不退让",
    initialBalance: 1000000, monthlyTarget: 0.30,
    drawdownLimit: 0.50, drawdownSoftLimit: 0.25,
    allowedTypes: ["MISPRICING", "MULTI_OUTCOME_ARB", "SPREAD"],
    minEdge: 0, minConfidence: 0, minVolume: 20000, minLiquidity: 15000,
    maxPerEvent: 200000, maxOpenPositions: 20,
    stopLossPercent: 0.30, maxHoldDays: 30,
    takeProfitPercent: 1.00, trailingStopPercent: 0.25, probReversalThreshold: 0.30,
    sizingMode: "edge_confidence", sizingBase: 10000, sizingScale: 20000,
  },
];
