/**
 * Alternative Gene Implementations
 *
 * Each Gene slot can have multiple strategy implementations. Strategies are
 * registered by key and dispatched by the Genome orchestrator based on the
 * active variant's strategy_key.
 *
 * Currently provides:
 *   - Scanner: baseline (edge-based) vs trend-following
 *   - Monitor: baseline (fixed thresholds) vs adaptive (volatility-adjusted)
 */

import type { MarketSnapshot, ArbSignal, FundConfig } from "./types";
import type { ScannerInput, ScannerOutput, MonitorOutput } from "./gene-interface";
import type { MonitorAction, MonitorResult } from "./monitor";
import { scan, analyze } from "./scan";
import { monitor, executeMonitorActions } from "./monitor";
import { fetchCurrentPrice } from "./price";

// ─── Strategy Registry Pattern ──────────────────────────

export type ScannerStrategy = (input: ScannerInput) => Promise<ScannerOutput>;
export type MonitorStrategy = (
  db: D1Database,
  funds: FundConfig[],
  variantConfig?: Record<string, unknown>,
) => Promise<MonitorOutput>;

const scannerStrategies = new Map<string, ScannerStrategy>();
const monitorStrategies = new Map<string, MonitorStrategy>();

export function getScannerStrategy(key: string): ScannerStrategy {
  return scannerStrategies.get(key) ?? scannerStrategies.get("baseline")!;
}

export function getMonitorStrategy(key: string): MonitorStrategy {
  return monitorStrategies.get(key) ?? monitorStrategies.get("baseline")!;
}

// ─── Scanner: v1-baseline ───────────────────────────────
// Standard edge-based signal detection with volume/liquidity filtering.
// Treats all signal types equally, sorts by edge descending.

function endDateCutoff(windowDays: number | undefined): string | null {
  if (!windowDays || windowDays <= 0) return null;
  return new Date(Date.now() + windowDays * 86_400_000).toISOString();
}

function applyMarketFilters(markets: MarketSnapshot[], input: ScannerInput, volumeMultiplier = 1): MarketSnapshot[] {
  const cutoff = endDateCutoff(input.endDateWindowDays);
  return markets.filter(m => {
    if (m.volume24hr < input.minVolume * volumeMultiplier) return false;
    if (m.liquidity < input.minLiquidity) return false;
    if (cutoff && m.endDate && m.endDate > cutoff) return false;
    return true;
  });
}

async function scannerBaseline(input: ScannerInput): Promise<ScannerOutput> {
  const { markets, totalFetched } = await scan(input.scanLimit);
  const filtered = applyMarketFilters(markets, input);
  const signals = analyze(filtered, new Date().toISOString());
  const avgEdge = signals.length > 0
    ? Math.round((signals.reduce((s, x) => s + x.edge, 0) / signals.length) * 100) / 100
    : 0;
  return { markets, filtered, signals, totalFetched, avgEdge };
}

scannerStrategies.set("baseline", scannerBaseline);

// ─── Scanner: v2-trend-following ────────────────────────
// Prioritizes markets with consistent directional price movement.
// Filters out SPREAD signals (no directional view), boosts MISPRICING
// signals where the mispricing direction aligns with recent volume trends.
// Applies a higher confidence floor (0.35 vs default 0.20).

async function scannerTrendFollowing(input: ScannerInput): Promise<ScannerOutput> {
  const { markets, totalFetched } = await scan(input.scanLimit);
  const filtered = applyMarketFilters(markets, input, 1.5);
  const rawSignals = analyze(filtered, new Date().toISOString());

  const signals = rawSignals
    .filter(s => s.type !== "SPREAD")
    .filter(s => s.confidence >= 0.35)
    .map(s => {
      const volumeBoost = Math.min(1.5, s.prices["volume24hr"] as number / 50000);
      return { ...s, edge: s.edge * volumeBoost };
    })
    .sort((a, b) => b.edge - a.edge);

  const avgEdge = signals.length > 0
    ? Math.round((signals.reduce((s, x) => s + x.edge, 0) / signals.length) * 100) / 100
    : 0;

  return { markets, filtered, signals, totalFetched, avgEdge };
}

scannerStrategies.set("trend-following", scannerTrendFollowing);

// ─── Monitor: v1-baseline ───────────────────────────────
// Fixed take-profit, trailing-stop, and probability reversal thresholds
// as defined per fund configuration.

async function monitorBaseline(db: D1Database, funds: FundConfig[]): Promise<MonitorOutput> {
  const result = await monitor(db, funds);
  await executeMonitorActions(db, result);
  return result;
}

monitorStrategies.set("baseline", monitorBaseline);

// ─── Monitor: v2-adaptive ───────────────────────────────
// Dynamically adjusts thresholds based on position age and P&L trajectory.
// - Young positions (< 3 days): wider stop-loss, no take-profit trigger
// - Profitable positions: trailing stop tightens as gain increases
// - Losing positions: stop-loss remains fixed (no loosening)

async function monitorAdaptive(db: D1Database, funds: FundConfig[]): Promise<MonitorOutput> {
  const result = await monitor(db, funds, {
    adaptiveMode: true,
    youngPositionDays: 3,
    trailingTightenFactor: 0.5,
  });
  await executeMonitorActions(db, result);
  return result;
}

monitorStrategies.set("adaptive", monitorAdaptive);

// ─── Scanner: llm-config ────────────────────────────────
// Behavioral overrides driven by LLM-generated JSON config (Phase 3.5).
// Config fields honored: minVolumeMultiplier, edgeBoost, confidenceFloor, excludeTypes.

async function scannerLLMConfig(input: ScannerInput): Promise<ScannerOutput> {
  const cfg = input.variantConfig ?? {};
  const volMul = typeof cfg.minVolumeMultiplier === "number" ? cfg.minVolumeMultiplier : 1.0;
  const edgeBoost = typeof cfg.edgeBoost === "number" ? cfg.edgeBoost : 0.0;
  const confFloor = typeof cfg.confidenceFloor === "number" ? cfg.confidenceFloor : 0.0;
  const excludeTypes = Array.isArray(cfg.excludeTypes) ? cfg.excludeTypes as string[] : [];

  const { markets, totalFetched } = await scan(input.scanLimit);
  const filtered = applyMarketFilters(markets, input, volMul);
  const rawSignals = analyze(filtered, new Date().toISOString());

  const signals = rawSignals
    .filter(s => !excludeTypes.includes(s.type))
    .filter(s => s.confidence >= confFloor)
    .map(s => edgeBoost > 0 ? { ...s, edge: s.edge - edgeBoost } : s)
    .filter(s => s.edge > 0)
    .sort((a, b) => b.edge - a.edge);

  const avgEdge = signals.length > 0
    ? Math.round((signals.reduce((s, x) => s + x.edge, 0) / signals.length) * 100) / 100
    : 0;
  return { markets, filtered, signals, totalFetched, avgEdge };
}

scannerStrategies.set("llm-config", scannerLLMConfig);

// ─── Monitor: llm-config ────────────────────────────────
// Behavioral overrides driven by LLM-generated JSON config (Phase 3.5).
// Config fields honored: adaptiveMode, youngPositionDays, trailingTightenFactor.

async function monitorLLMConfig(
  db: D1Database,
  funds: FundConfig[],
  variantConfig?: Record<string, unknown>,
): Promise<MonitorOutput> {
  const cfg = variantConfig ?? {};
  const result = await monitor(db, funds, {
    adaptiveMode: typeof cfg.adaptiveMode === "boolean" ? cfg.adaptiveMode : false,
    youngPositionDays: typeof cfg.youngPositionDays === "number" ? cfg.youngPositionDays : 3,
    trailingTightenFactor: typeof cfg.trailingTightenFactor === "number" ? cfg.trailingTightenFactor : 0.5,
  });
  await executeMonitorActions(db, result);
  return result;
}

monitorStrategies.set("llm-config", monitorLLMConfig);

// ─── Registration helpers ───────────────────────────────

export function listScannerStrategies(): string[] {
  return [...scannerStrategies.keys()];
}

export function listMonitorStrategies(): string[] {
  return [...monitorStrategies.keys()];
}
