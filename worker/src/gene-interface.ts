/**
 * Gene Interface Layer
 *
 * Defines the typed input/output contracts that each pipeline step must conform
 * to, so individual steps can be lifted out into stand-alone Gene artefacts in
 * future iterations.
 */

import type { ArbSignal, FundConfig, MarketSnapshot, TradeAction, AgentEvent } from "./types";
import type { MonitorAction, MonitorResult } from "./monitor";
import type { MicroEvolveResult } from "./micro-evolve";
import type { EvolutionReport } from "./evolve";

// ─── Scanner Gene ───────────────────────────────────────

export interface ScannerInput {
  scanLimit: number;
  minVolume: number;
  minLiquidity: number;
  /** Only include markets resolving within this many days. 0 = no filter (default). */
  endDateWindowDays?: number;
}

export interface ScannerOutput {
  markets: MarketSnapshot[];
  filtered: MarketSnapshot[];
  signals: ArbSignal[];
  totalFetched: number;
  avgEdge: number;
}

// ─── Risk Gene ──────────────────────────────────────────

export interface RiskInput {
  funds: FundConfig[];
}

export interface RiskOutput {
  stopped: Array<{ fundId: string; fundEmoji: string; slug: string; question: string; pnl: number; entryPrice: number; exitPrice: number }>;
  expired: Array<{ fundId: string; fundEmoji: string; slug: string; question: string; pnl: number }>;
}

// ─── Monitor Gene ───────────────────────────────────────

export interface MonitorInput {
  funds: FundConfig[];
}

export interface MonitorOutput {
  actions: MonitorAction[];
  highWaterMarkUpdates: MonitorResult["highWaterMarkUpdates"];
}

// ─── Trader Gene ────────────────────────────────────────

export interface TraderInput {
  signals: ArbSignal[];
  markets: MarketSnapshot[];
  funds: FundConfig[];
  timestamp: string;
}

export interface TraderOutput {
  trades: TradeAction[];
}

// ─── Settler Gene ───────────────────────────────────────

export interface SettlerInput {
  markets: MarketSnapshot[];
  funds: FundConfig[];
}

export interface SettlerOutput {
  settlements: Array<{ fundId: string; fundEmoji: string; slug: string; question: string; pnl: number; entryPrice: number; exitPrice: number }>;
}

// ─── Evolver Gene ───────────────────────────────────────

export interface EvolverInput {
  mode: "micro" | "macro";
  funds: FundConfig[];
}

export interface MicroEvolverOutput {
  results: MicroEvolveResult[];
}

export interface MacroEvolverOutput {
  report: EvolutionReport;
}

// ─── Genome Pipeline Result ─────────────────────────────

export interface GenomePipelineResult {
  scanner: ScannerOutput;
  risk: RiskOutput;
  monitor: MonitorOutput;
  settler: SettlerOutput;
  trader: TraderOutput;
  microEvolver: MicroEvolverOutput;
  events: AgentEvent[];
  timestamp: string;
}

// ─── Gene Metadata ──────────────────────────────────────
//
// Fidelity classification (RotiferGeneSpec § 4.2):
//   - "hybrid"  = requires external network calls (API, WebSocket)
//   - "native"  = pure computation, no external I/O
//   - "wrapped" = thin wrapper around external service
//
// Casing note: GeneFidelity here uses lowercase ("native" | "hybrid" | "wrapped")
// as a TypeScript runtime enum for internal dispatch. The corresponding
// phenotypes/*.phenotype.json files use UPPERCASE ("NATIVE" | "HYBRID" | "WRAPPED")
// per RotiferGeneSpec § 4.2. Both must agree semantically; the phenotype.json
// files are the authoritative source when published to Cloud Registry.
//
// All steps currently run as in-repo embedded modules (lifecycleStatus: "embedded").
// The fidelity field reflects the *target* form for when Genes are lifted into
// stand-alone artefacts and published to the Cloud Registry.

export type GeneFidelity = "native" | "wrapped" | "hybrid";
export type GeneLifecycleStatus = "embedded" | "published" | "trial" | "active";

export interface GeneMeta {
  id: string;
  name: string;
  nameZh?: string;
  version: string;
  fidelity: GeneFidelity;
  lifecycleStatus: GeneLifecycleStatus;
  inputSchema: string;
  outputSchema: string;
  externalDependencies?: string[];
}

export const GENE_REGISTRY: GeneMeta[] = [
  {
    id: "polymarket-scanner",
    name: "Polymarket Scanner",
    nameZh: "信号扫描器",
    version: "0.1.0",
    fidelity: "hybrid",
    lifecycleStatus: "embedded",
    inputSchema: "ScannerInput",
    outputSchema: "ScannerOutput",
    externalDependencies: ["gamma-api.polymarket.com"],
  },
  {
    id: "polymarket-risk",
    name: "Polymarket Risk Manager",
    nameZh: "风控管理器",
    version: "0.1.0",
    fidelity: "native",
    lifecycleStatus: "embedded",
    inputSchema: "RiskInput",
    outputSchema: "RiskOutput",
  },
  {
    id: "polymarket-monitor",
    name: "Polymarket Active Monitor",
    nameZh: "持仓监控器",
    version: "0.1.0",
    fidelity: "hybrid",
    lifecycleStatus: "embedded",
    inputSchema: "MonitorInput",
    outputSchema: "MonitorOutput",
    externalDependencies: ["gamma-api.polymarket.com"],
  },
  {
    id: "polymarket-settler",
    name: "Polymarket Market Settler",
    nameZh: "结算清算器",
    version: "0.1.0",
    fidelity: "native",
    lifecycleStatus: "embedded",
    inputSchema: "SettlerInput",
    outputSchema: "SettlerOutput",
  },
  {
    id: "polymarket-trader",
    name: "Polymarket Paper Trader",
    nameZh: "模拟交易器",
    version: "0.1.0",
    fidelity: "native",
    lifecycleStatus: "embedded",
    inputSchema: "TraderInput",
    outputSchema: "TraderOutput",
  },
  {
    id: "polymarket-evolver",
    name: "Polymarket Strategy Evolver",
    nameZh: "策略进化器",
    version: "0.1.0",
    fidelity: "native",
    lifecycleStatus: "embedded",
    inputSchema: "EvolverInput",
    outputSchema: "MicroEvolverOutput | MacroEvolverOutput",
  },
];
