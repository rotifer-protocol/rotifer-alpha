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
  /** Feature flag: set to "true" to route pipeline through runGenomePipeline (Genome orchestrator).
   *  Default "false" keeps the legacy runPipeline path. Rollback: set back to "false" and redeploy. */
  ENABLE_GENOME_PIPELINE?: string;
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
  // 2026-05-04: 机构型基金（如 Beluga $100K / Leviathan $1M）参与 fitness 排名展示，
  // 但不参与 PBT mutate——因为它们的参数（maxPerEvent / sizingBase 等）远超 PARAM_BOUNDS 上限，
  // 强行 mutate 会被 clamp 回小基金范围，破坏策略空间。
  // 见 internal/plan/rotifer-petri/petri-phase-0-5-implementation.md "机构型基金" 章节。
  evolveExempt?: boolean;
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
  // ─── 机构型基金（2026-05-04 新增，evolveExempt: true 不参与 PBT mutate）────
  // 战略目的：验证产品 + 协议在更大资金量级下的承载能力（"先犯错，后修正" 路径）。
  // 当前阶段 paper trade，不消耗真实流动性；为 Phase 4 真钱化前预演 slippage 与策略空间。
  {
    id: "beluga", name: "白鲸", emoji: "🐋",
    motto: "稳健，只吃大机会",
    initialBalance: 100000, monthlyTarget: 0.04,
    drawdownLimit: 0.15, drawdownSoftLimit: 0.08,
    allowedTypes: ["MISPRICING", "MULTI_OUTCOME_ARB"],
    minEdge: 1.5, minConfidence: 0.4, minVolume: 30000, minLiquidity: 20000,
    maxPerEvent: 8000, maxOpenPositions: 8,
    stopLossPercent: 0.10, maxHoldDays: 14,
    takeProfitPercent: 0.20, trailingStopPercent: 0.10, probReversalThreshold: 0.20,
    sizingMode: "edge", sizingBase: 2000, sizingScale: 4000,
    evolveExempt: true,
  },
  {
    id: "leviathan", name: "巨兽", emoji: "🦑",
    motto: "流动性策略家",
    initialBalance: 1000000, monthlyTarget: 0.05,
    drawdownLimit: 0.20, drawdownSoftLimit: 0.10,
    allowedTypes: ["MISPRICING", "MULTI_OUTCOME_ARB", "SPREAD"],
    minEdge: 1.5, minConfidence: 0.3, minVolume: 100000, minLiquidity: 50000,
    maxPerEvent: 50000, maxOpenPositions: 5,
    stopLossPercent: 0.12, maxHoldDays: 21,
    takeProfitPercent: 0.30, trailingStopPercent: 0.15, probReversalThreshold: 0.20,
    sizingMode: "confidence", sizingBase: 10000, sizingScale: 30000,
    evolveExempt: true,
  },
];
