/**
 * Genome Orchestrator
 *
 * Wraps the pipeline stages as composable steps with typed I/O.
 * Orchestration pattern: Seq { risk → scanner → settler → monitor → trader → micro-evolver }
 *
 * Currently each step is implemented as an in-repo module. The Gene-compatible
 * I/O contracts are defined in `gene-interface.ts` so that individual steps can
 * be lifted out into stand-alone artefacts in future iterations.
 */

import type { Env, FundConfig, AgentEvent, AgentEventType } from "./types";
import type {
  ScannerInput, ScannerOutput,
  RiskOutput,
  MonitorOutput,
  SettlerOutput,
  TraderOutput,
  MicroEvolverOutput,
  GenomePipelineResult,
} from "./gene-interface";
import { GENE_REGISTRY } from "./gene-interface";

import { scan, analyze } from "./scan";
import { checkRiskLimits } from "./risk";
import { monitor, executeMonitorActions } from "./monitor";
import { settle } from "./settle";
import { paperTrade } from "./trade";
import type { SkipReasonEntry } from "./trade";
import { checkAndRunMicroEvolution } from "./micro-evolve";
import { broadcast, sendSignals, sendTrades, sendSummary } from "./notify";
import { getActiveVariant, recordTradeResult } from "./gene-variants";
import { getScannerStrategy, getMonitorStrategy } from "./gene-strategies";
import { checkAndRunCodeEvolution } from "./code-evolver";
import { PHENOTYPE_REGISTRY } from "./phenotypes/index";
import { storeHeartbeat } from "./execution";

// ─── GENE_REGISTRY ↔ Phenotype consistency check ────────
//
// Validates that GENE_REGISTRY fidelity values match phenotype.json fidelity
// (lowercase runtime ↔ UPPERCASE protocol layer, per RotiferGeneSpec § 4.2).
// Called once at the start of runGenomePipeline — logs warnings, does NOT throw,
// to avoid blocking production pipelines over documentation drift.
//
// Per ADR-273 D7: any commit that changes GENE_REGISTRY or phenotype.json
// must keep both in sync. This check serves as a runtime reminder.

const FIDELITY_UP: Record<string, string> = {
  native: "NATIVE",
  hybrid: "HYBRID",
  wrapped: "WRAPPED",
};

let _consistencyChecked = false;

function checkGenomeConsistency(): void {
  if (_consistencyChecked) return;
  _consistencyChecked = true;

  const phenotypeMap = new Map(PHENOTYPE_REGISTRY.map(p => [p.gene, p.fidelity]));

  for (const gene of GENE_REGISTRY) {
    const expected = phenotypeMap.get(gene.id);
    if (!expected) {
      console.warn(`[Genome] No phenotype.json found for Gene "${gene.id}" — publish to Cloud Registry will fail`);
      continue;
    }
    const runtimeUpper = FIDELITY_UP[gene.fidelity] ?? gene.fidelity.toUpperCase();
    if (runtimeUpper !== expected) {
      console.warn(
        `[Genome] Fidelity mismatch for "${gene.id}": ` +
        `GENE_REGISTRY="${gene.fidelity}" (→ "${runtimeUpper}") vs ` +
        `phenotype.json="${expected}". ` +
        `Update gene-interface.ts or ${gene.id.replace("polymarket-", "")}.phenotype.json (ADR-273 D7).`,
      );
    }
  }
}

// ─── Gene Step: Scanner (variant-aware) ─────────────────

async function runScannerGene(
  input: ScannerInput,
  strategyKey = "baseline",
): Promise<ScannerOutput> {
  const strategy = getScannerStrategy(strategyKey);
  return strategy(input);
}

// ─── Gene Step: Risk ────────────────────────────────────

async function runRiskGene(
  db: D1Database,
  funds: FundConfig[],
): Promise<RiskOutput> {
  return await checkRiskLimits(db, funds);
}

// ─── Gene Step: Monitor (variant-aware) ─────────────────

async function runMonitorGene(
  db: D1Database,
  funds: FundConfig[],
  strategyKey = "baseline",
): Promise<MonitorOutput> {
  const strategy = getMonitorStrategy(strategyKey);
  return strategy(db, funds);
}

// ─── Gene Step: Settler ─────────────────────────────────

async function runSettlerGene(
  db: D1Database,
  markets: import("./types").MarketSnapshot[],
  funds: FundConfig[],
): Promise<SettlerOutput> {
  const settlements = await settle(db, markets, funds);
  return { settlements };
}

// ─── Gene Step: Trader ──────────────────────────────────

async function runTraderGene(
  db: D1Database,
  signals: import("./types").ArbSignal[],
  markets: import("./types").MarketSnapshot[],
  funds: FundConfig[],
  ts: string,
): Promise<import("./trade").PaperTradeResult> {
  return await paperTrade(db, signals, markets, funds, ts);
}

// ─── Gene Step: Micro-Evolver ───────────────────────────

async function runMicroEvolverGene(
  db: D1Database,
  funds: FundConfig[],
): Promise<MicroEvolverOutput> {
  const results = await checkAndRunMicroEvolution(db, funds);
  return { results };
}

// ─── Genome Orchestrator ────────────────────────────────

export async function runGenomePipeline(
  env: Env,
  funds: FundConfig[],
): Promise<GenomePipelineResult> {
  checkGenomeConsistency();

  const ts = new Date().toISOString();
  const events: AgentEvent[] = [];

  function emit(type: AgentEventType, payload: Record<string, unknown>): void {
    events.push({ type, timestamp: ts, payload });
  }

  // Load active Gene variants for dispatch
  const scannerVariant = await getActiveVariant(env.DB, "polymarket-scanner");
  const monitorVariant = await getActiveVariant(env.DB, "polymarket-monitor");
  const scannerKey = scannerVariant?.strategyKey ?? "baseline";
  const monitorKey = monitorVariant?.strategyKey ?? "baseline";

  // Step 1: Risk checks (stop-loss, expiry)
  const risk = await runRiskGene(env.DB, funds);

  for (const s of risk.stopped) {
    emit("TRADE_STOPPED", {
      fundId: s.fundId,
      fundEmoji: s.fundEmoji,
      slug: s.slug,
      question: s.question,
      pnl: s.pnl,
      entryPrice: s.entryPrice,
      exitPrice: s.exitPrice,
      reason: "Stop loss triggered.",
    });
  }
  for (const e of risk.expired) {
    emit("TRADE_EXPIRED", {
      fundId: e.fundId,
      fundEmoji: e.fundEmoji,
      slug: e.slug,
      question: e.question,
      pnl: e.pnl,
      entryPrice: e.entryPrice,
      exitPrice: e.exitPrice,
      reason: "Max hold window reached.",
    });
  }

  // Step 2: Scanner
  let scanner: ScannerOutput;
  try {
    scanner = await runScannerGene({
      scanLimit: Number(env.SCAN_LIMIT) || 200,
      minVolume: Number(env.MIN_VOLUME) || 5000,
      minLiquidity: Number(env.MIN_LIQUIDITY) || 5000,
    }, scannerKey);
  } catch (e) {
    emit("ERROR", { stage: "scan", message: String(e) });
    return {
      scanner: { markets: [], filtered: [], signals: [], totalFetched: 0, avgEdge: 0 },
      risk,
      monitor: { actions: [], highWaterMarkUpdates: [] },
      settler: { settlements: [] },
      trader: { trades: [] },
      microEvolver: { results: [] },
      events,
      timestamp: ts,
    };
  }

  await recordScan(env.DB, crypto.randomUUID(), ts, scanner);

  const topMarkets = [...scanner.filtered]
    .sort((a, b) => b.volume24hr - a.volume24hr)
    .slice(0, 5)
    .map(m => ({ question: m.question, volume24hr: Math.round(m.volume24hr), liquidity: Math.round(m.liquidity) }));

  emit("SCAN_COMPLETE", {
    totalFetched: scanner.totalFetched,
    marketsFiltered: scanner.filtered.length,
    signalsFound: scanner.signals.length,
    avgEdge: scanner.avgEdge,
    topMarkets,
  });

  for (const sig of scanner.signals) {
    emit("SIGNAL_FOUND", {
      signalId: sig.signalId, type: sig.type, slug: sig.slug, question: sig.question,
      edge: sig.edge, confidence: sig.confidence, direction: sig.direction,
      volume24hr: sig.prices["volume24hr"] ?? 0,
      liquidity: sig.prices["liquidity"] ?? 0,
    });
  }

  // Step 3: Settler
  const settler = await runSettlerGene(env.DB, scanner.markets, funds);
  for (const s of settler.settlements) {
    emit("TRADE_SETTLED", {
      fundId: s.fundId,
      fundEmoji: s.fundEmoji,
      slug: s.slug,
      question: s.question,
      pnl: s.pnl,
      entryPrice: s.entryPrice,
      exitPrice: s.exitPrice,
      reason: "Market resolved on Polymarket.",
    });
  }

  // Step 4: Monitor (active selling)
  const monitorOut = await runMonitorGene(env.DB, funds, monitorKey);
  for (const ma of monitorOut.actions) {
    const eventType = ma.newStatus === "PROFIT_TAKEN" ? "TRADE_PROFIT_TAKEN"
      : ma.newStatus === "TRAILING_STOPPED" ? "TRADE_TRAILING_STOPPED"
      : "TRADE_REVERSED";
    emit(eventType as AgentEventType, {
      fundId: ma.fundId,
      slug: ma.slug,
      question: ma.question,
      pnl: ma.pnl,
      reason: ma.reason,
      entryPrice: ma.entryPrice,
      exitPrice: ma.currentPrice,
    });
  }

  // Step 5: Trader
  const traderResult = await runTraderGene(env.DB, scanner.signals, scanner.filtered, funds, ts);
  const trader = { trades: traderResult.trades };
  const traderSkipReasons: SkipReasonEntry[] = traderResult.skipReasons;
  for (const t of trader.trades) {
    emit("TRADE_OPENED", {
      fundId: t.fundId, fundName: t.fundName, fundEmoji: t.fundEmoji,
      signalId: t.signalId, slug: t.slug, question: t.question,
      direction: t.direction, price: t.price, amount: t.amount,
    });
  }

  // Step 6: Micro-Evolution
  const microEvolver = await runMicroEvolverGene(env.DB, funds);
  for (const mr of microEvolver.results) {
    if (!mr.triggered) continue;
    emit("MICRO_EVOLUTION", {
      fundId: mr.fundId,
      fundName: mr.fundName,
      adjustedParams: mr.adjustments.length,
      adjustments: mr.adjustments,
      trigger: mr.trigger,
    });
  }

  // Step 7: Code Evolution
  let codeEvoResult;
  try {
    codeEvoResult = await checkAndRunCodeEvolution(env.DB);
    if (codeEvoResult.triggered) {
      emit("CODE_EVOLUTION", {
        epoch: codeEvoResult.epoch,
        promotions: codeEvoResult.promotions.length,
        eliminations: codeEvoResult.eliminations.length,
        evaluations: codeEvoResult.evaluations.map(e => ({
          geneId: e.geneId,
          variantCount: e.variants.length,
          best: e.bestVariant,
        })),
      });
    }
  } catch {
    // non-critical — code evolution failure doesn't block pipeline
  }

  // Record trade results for active scanner/monitor variants (scoring)
  try {
    for (const s of settler.settlements) {
      if (scannerVariant) await recordTradeResult(env.DB, scannerVariant.id, s.pnl, s.pnl > 0);
    }
    for (const ma of monitorOut.actions) {
      if (monitorVariant) await recordTradeResult(env.DB, monitorVariant.id, ma.pnl, ma.pnl > 0);
    }
  } catch {
    // non-critical
  }

  // Broadcast all collected events
  for (const event of events) {
    await broadcast(env, event);
  }

  // Store heartbeat BEFORE Telegram notifications so it always runs even if Telegram fails.
  // This fixes the regression where a Telegram API error would silently prevent heartbeat updates.
  await storeHeartbeat(env.DB, {
    lastScanAt: ts,
    totalFetched: scanner.totalFetched,
    marketsFiltered: scanner.filtered.length,
    signalsFound: scanner.signals.length,
    tradesOpened: trader.trades.length,
    settlementsProcessed: settler.settlements.length,
    monitorActions: monitorOut.actions.length,
    riskStops: risk.stopped.length,
    riskExpired: risk.expired.length,
    skipSummary: aggregateSkipReasonsLocal(traderSkipReasons),
    skipByFund: aggregateSkipReasonsByFundLocal(traderSkipReasons),
  });

  // Telegram notifications (non-critical — failure must not block pipeline)
  try {
    const { ok, fail } = await sendSignals(env, scanner.signals);
    if (trader.trades.length > 0) await sendTrades(env, trader.trades);
    await sendSummary(env, scanner.filtered.length, scanner.signals.length, scanner.avgEdge, ok, fail, trader.trades, ts);
  } catch (e) {
    console.error("[Genome] Telegram notification failed (non-critical):", e);
  }

  return {
    scanner,
    risk,
    monitor: monitorOut,
    settler,
    trader,
    microEvolver,
    events,
    timestamp: ts,
  };
}

// 2026-05-04: Local skip reason aggregators (mirror index.ts helpers).
// Keep local copies to avoid cross-file circular dependency between index.ts and genome.ts.
function aggregateSkipReasonsLocal(reasons: SkipReasonEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of reasons) {
    counts[r.code] = (counts[r.code] ?? 0) + 1;
  }
  return counts;
}

function aggregateSkipReasonsByFundLocal(reasons: SkipReasonEntry[]): Record<string, Record<string, number>> {
  const byFund: Record<string, Record<string, number>> = {};
  for (const r of reasons) {
    byFund[r.fundId] = byFund[r.fundId] ?? {};
    byFund[r.fundId][r.code] = (byFund[r.fundId][r.code] ?? 0) + 1;
  }
  return byFund;
}

// ─── Genome Blueprint (for future export) ───────────────

export const GENOME_BLUEPRINT = {
  id: "petri-polymarket-pipeline",
  version: "0.1.0",
  description: "Polymarket trading pipeline with dual-layer evolution (PBT)",
  orchestration: {
    type: "Seq" as const,
    steps: [
      { gene: "polymarket-risk", id: "risk" },
      { gene: "polymarket-scanner", id: "scan" },
      { gene: "polymarket-settler", id: "settle", input: { markets: "{{scan.output.markets}}" } },
      { gene: "polymarket-monitor", id: "monitor" },
      { gene: "polymarket-trader", id: "trade", input: { signals: "{{scan.output.signals}}" } },
      { gene: "polymarket-evolver", id: "micro", input: { mode: "micro" } },
    ],
  },
};

// ─── Genome Blueprint Export / Import ────────────────────

export function exportGenomeBlueprint(): string {
  return JSON.stringify(GENOME_BLUEPRINT, null, 2);
}

export function importGenomeBlueprint(json: string): typeof GENOME_BLUEPRINT {
  const parsed = JSON.parse(json);
  if (!parsed.id || !parsed.orchestration?.steps) {
    throw new Error("Invalid Genome Blueprint: missing id or orchestration.steps");
  }
  return parsed;
}

// ─── Internal helpers ───────────────────────────────────

async function recordScan(
  db: D1Database,
  scanId: string,
  ts: string,
  scanner: ScannerOutput,
): Promise<void> {
  await db.prepare(
    `INSERT INTO scans (id, scanned_at, total_fetched, markets_filtered, signals_found, avg_edge)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(scanId, ts, scanner.totalFetched, scanner.filtered.length, scanner.signals.length, scanner.avgEdge).run();

  for (const sig of scanner.signals) {
    await db.prepare(
      `INSERT INTO signals (id, scan_id, type, question, market_id, slug, direction, edge, confidence, prices, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      sig.signalId, scanId, sig.type, sig.question, sig.marketId,
      sig.slug ?? "", sig.direction, sig.edge, sig.confidence,
      JSON.stringify(sig.prices), ts,
    ).run();
  }
}
