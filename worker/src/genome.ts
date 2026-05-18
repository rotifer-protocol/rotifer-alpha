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
import { ensureSaneActiveVariant, getActiveVariant, listVariants } from "./gene-variants";
import { recordVariantOutcomes, selectPipelineVariant } from "./gene-evaluation";
import {
  getScannerStrategy, getMonitorStrategy,
  getRiskStrategy, getTraderStrategy, getMicroEvolverStrategy,
} from "./gene-strategies";
import { checkAndRunCodeEvolution } from "./code-evolver";
import { PHENOTYPE_REGISTRY } from "./phenotypes/index";
import { isKillSwitchActive, storeHeartbeat, storeError, storeSkipByFund, workerHeartbeatContext } from "./execution";
import { refreshOpenPrices } from "./price-refresh";

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
  return strategy(input); // variantConfig is already embedded in input.variantConfig
}

// ─── Gene Step: Risk ────────────────────────────────────

async function runRiskGene(
  db: D1Database,
  funds: FundConfig[],
  strategyKey = "baseline",
  variantConfig?: Record<string, unknown>,
): Promise<RiskOutput> {
  const strategy = getRiskStrategy(strategyKey);
  return strategy(db, funds, variantConfig);
}

// ─── Gene Step: Monitor (variant-aware) ─────────────────

async function runMonitorGene(
  db: D1Database,
  funds: FundConfig[],
  strategyKey = "baseline",
  variantConfig?: Record<string, unknown>,
): Promise<MonitorOutput> {
  const strategy = getMonitorStrategy(strategyKey);
  return strategy(db, funds, variantConfig);
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
  strategyKey = "baseline",
  variantConfig?: Record<string, unknown>,
  freshlyClosedThisRun?: ReadonlySet<string>,
): Promise<import("./trade").PaperTradeResult> {
  const strategy = getTraderStrategy(strategyKey);
  return strategy(db, signals, markets, funds, ts, variantConfig, freshlyClosedThisRun);
}

// ─── Gene Step: Micro-Evolver ───────────────────────────

async function runMicroEvolverGene(
  db: D1Database,
  funds: FundConfig[],
  strategyKey = "baseline",
  variantConfig?: Record<string, unknown>,
): Promise<MicroEvolverOutput> {
  const strategy = getMicroEvolverStrategy(strategyKey);
  const results = await strategy(db, funds, variantConfig);
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

  if (await isKillSwitchActive(env.DB)) {
    console.warn("[Genome] KILL_SWITCH active — pipeline halted");
    await storeHeartbeat(env.DB, {
      lastScanAt: ts,
      worker: workerHeartbeatContext(env, "genome"),
      totalFetched: 0,
      marketsFiltered: 0,
      signalsFound: 0,
      tradesOpened: 0,
      settlementsProcessed: 0,
      monitorActions: 0,
      riskStops: 0,
      riskExpired: 0,
      skipSummary: { KILL_SWITCH: 1 },
      pipelineRunning: false,
      priceRefresh: {
        totalOpen: 0,
        refreshed: 0,
        fetchFailed: 0,
        missingTokenId: 0,
        backfilledTokenIds: 0,
      },
    });
    return {
      scanner: { markets: [], filtered: [], signals: [], totalFetched: 0, avgEdge: 0 },
      risk: { stopped: [], expired: [] },
      monitor: { actions: [], highWaterMarkUpdates: [] },
      settler: { settlements: [] },
      trader: { trades: [] },
      microEvolver: { results: [] },
      events,
      timestamp: ts,
    };
  }

  // Eagerly write a partial heartbeat at pipeline start so /api/heartbeat always
  // reflects a live timestamp, even if the pipeline crashes mid-run.
  // This also acts as a diagnostic: if this timestamp never updates, the pipeline
  // itself is not being invoked (check Cloudflare Worker logs / cron trigger config).
  await storeHeartbeat(env.DB, {
    lastScanAt: ts,
    worker: workerHeartbeatContext(env, "genome"),
    totalFetched: 0,
    marketsFiltered: 0,
    signalsFound: 0,
    tradesOpened: 0,
    settlementsProcessed: 0,
    monitorActions: 0,
    riskStops: 0,
    riskExpired: 0,
    skipSummary: {},
    pipelineRunning: true,
  });

  function emit(type: AgentEventType, payload: Record<string, unknown>): void {
    events.push({ type, timestamp: ts, payload });
  }

  // Load active Gene variants for dispatch (all 5 evolvable genes).
  // gene_active_config is the exploitation winner; selectPipelineVariant adds a
  // bounded exploration lane so g1 challengers can earn paper/shadow samples.
  const minTradesForEval = Number(env.MIN_TRADES_FOR_EVAL) || 3;
  await Promise.all([
    "polymarket-scanner",
    "polymarket-monitor",
    "polymarket-risk",
    "polymarket-trader",
    "polymarket-micro-evolver",
  ].map(geneId => ensureSaneActiveVariant(env.DB, geneId, minTradesForEval).catch(() => null)));

  const [configuredScannerVariant, configuredMonitorVariant, configuredRiskVariant, configuredTraderVariant, configuredMicroEvolverVariant] =
    await Promise.all([
      getActiveVariant(env.DB, "polymarket-scanner").catch(() => null),
      getActiveVariant(env.DB, "polymarket-monitor").catch(() => null),
      getActiveVariant(env.DB, "polymarket-risk").catch(() => null),
      getActiveVariant(env.DB, "polymarket-trader").catch(() => null),
      getActiveVariant(env.DB, "polymarket-micro-evolver").catch(() => null),
    ]);
  const [scannerVariants, monitorVariants, riskVariants, traderVariants, microEvolverVariants] =
    await Promise.all([
      listVariants(env.DB, "polymarket-scanner").catch(() => []),
      listVariants(env.DB, "polymarket-monitor").catch(() => []),
      listVariants(env.DB, "polymarket-risk").catch(() => []),
      listVariants(env.DB, "polymarket-trader").catch(() => []),
      listVariants(env.DB, "polymarket-micro-evolver").catch(() => []),
    ]);
  const explorationInterval = Number(env.GENE_EXPLORATION_INTERVAL ?? 2);
  const scannerVariant = selectPipelineVariant(configuredScannerVariant, scannerVariants, ts, { interval: explorationInterval });
  const monitorVariant = selectPipelineVariant(configuredMonitorVariant, monitorVariants, ts, { interval: explorationInterval });
  const riskVariant = selectPipelineVariant(configuredRiskVariant, riskVariants, ts, { interval: explorationInterval });
  const traderVariant = selectPipelineVariant(configuredTraderVariant, traderVariants, ts, { interval: explorationInterval });
  const microEvolverVariant = selectPipelineVariant(configuredMicroEvolverVariant, microEvolverVariants, ts, { interval: explorationInterval });
  const scannerKey      = scannerVariant?.strategyKey      ?? "baseline";
  const monitorKey      = monitorVariant?.strategyKey      ?? "baseline";
  const riskKey         = riskVariant?.strategyKey         ?? "baseline";
  const traderKey       = traderVariant?.strategyKey       ?? "baseline";
  const microEvolverKey = microEvolverVariant?.strategyKey ?? "baseline";

  // ─── Phase A: D-Lite price refresh (ADR-273 path-A) ──────
  // Runs BEFORE risk/monitor/scan/trade so all downstream Genes read the freshest
  // mark-to-market price from D1.last_price (CLOB mid). Failures are non-fatal —
  // stale positions surface via staleCount, callers (monitor/risk) skip them.
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
    console.error("[Genome] Price refresh failed (non-fatal):", e);
    await storeError(env.DB, "price-refresh", e).catch(() => {});
  }

  // Step 1: Risk checks (stop-loss, expiry)
  const risk = await runRiskGene(env.DB, funds, riskKey, riskVariant?.config ?? undefined).catch(async (e): Promise<RiskOutput> => {
    console.error("[Genome] Risk gene failed:", e);
    await storeError(env.DB, "risk", e);
    return { stopped: [], expired: [] };
  });

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
      endDateWindowDays: Number(env.SCAN_END_DATE_WINDOW_DAYS) || 0,
      variantConfig: scannerVariant?.config ?? undefined,
    }, scannerKey);
  } catch (e) {
    console.error("[Genome] Scanner gene failed:", e);
    emit("ERROR", { stage: "scan", message: String(e) });
    await storeError(env.DB, "scanner", e);
    await storeHeartbeat(env.DB, {
      lastScanAt: ts, totalFetched: 0, marketsFiltered: 0, signalsFound: 0,
      worker: workerHeartbeatContext(env, "genome"),
      tradesOpened: 0, settlementsProcessed: 0, monitorActions: 0,
      riskStops: risk.stopped.length, riskExpired: risk.expired.length,
      skipSummary: {}, skipByFund: undefined, pipelineRunning: false,
      priceRefresh,
    });
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

  await recordScan(env.DB, crypto.randomUUID(), ts, scanner).catch(e => {
    console.error("[Genome] recordScan failed (non-critical):", e);
  });

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
  const settler = await runSettlerGene(env.DB, scanner.markets, funds).catch(async (e): Promise<SettlerOutput> => {
    console.error("[Genome] Settler gene failed:", e);
    await storeError(env.DB, "settler", e);
    return { settlements: [] };
  });
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

  // ─── KV cross-tick cooldown pre-fetch (M15: ADR-280 §D6) ──
  // Reads keys written by PREVIOUS pipeline ticks (TTL = 4 h, auto-expires).
  // Protects against the edge case where D1 read-replica lag > 5-min cron window,
  // causing a re-entry into a market that was just closed by a prior tick's monitor.
  // Non-fatal: if KV is unavailable, falls back to same-tick in-memory Set only.
  let kvCooldowns = new Set<string>();
  if (env.COOLDOWN_KV) {
    try {
      const kvList = await env.COOLDOWN_KV.list({ prefix: "cooldown:" });
      for (const k of kvList.keys) {
        kvCooldowns.add(k.name.slice("cooldown:".length)); // "fund_id:market_id"
      }
      if (kvCooldowns.size > 0) {
        console.log(`[Genome] KV cooldowns: ${kvCooldowns.size} cross-tick pair(s) active`);
      }
    } catch (e) {
      console.error("[Genome] KV cooldown pre-fetch failed (non-fatal):", e);
    }
  }

  // Step 4: Monitor (active selling)
  const monitorOut = await runMonitorGene(env.DB, funds, monitorKey, monitorVariant?.config ?? undefined).catch(async (e): Promise<MonitorOutput> => {
    console.error("[Genome] Monitor gene failed:", e);
    await storeError(env.DB, "monitor", e);
    return { actions: [], highWaterMarkUpdates: [] };
  });
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

  // Write this tick's closures to KV for next-tick protection (non-blocking).
  // expirationTtl = 14400 s = 4 h; KV auto-deletes expired keys.
  if (env.COOLDOWN_KV && monitorOut.actions.length > 0) {
    const COOLDOWN_TTL = 4 * 60 * 60;
    Promise.all(
      monitorOut.actions.map(a =>
        env.COOLDOWN_KV!.put(`cooldown:${a.fundId}:${a.marketId}`, "1", { expirationTtl: COOLDOWN_TTL }),
      ),
    ).catch(e => console.error("[Genome] KV cooldown write failed (non-fatal):", e));
  }

  // Build combined cooldown set: KV cross-tick pairs ∪ same-tick monitor closures.
  // Passed to the trader so it can skip these markets WITHOUT a D1 query —
  // D1 read replicas may not yet reflect monitor's UPDATE (M15: ADR-280 §D6).
  const freshlyClosedThisRun = new Set([
    ...kvCooldowns,
    ...monitorOut.actions.map(a => `${a.fundId}:${a.marketId}`),
  ]);

  // Step 5: Trader
  const traderResult = await runTraderGene(env.DB, scanner.signals, scanner.filtered, funds, ts, traderKey, traderVariant?.config ?? undefined, freshlyClosedThisRun).catch(async (e): Promise<import("./trade").PaperTradeResult> => {
    console.error("[Genome] Trader gene failed:", e);
    await storeError(env.DB, "trader", e);
    return { trades: [], skipReasons: [] };
  });
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
  const microEvolver = await runMicroEvolverGene(env.DB, funds, microEvolverKey, microEvolverVariant?.config ?? undefined).catch(async (e): Promise<MicroEvolverOutput> => {
    console.error("[Genome] Micro-evolver gene failed:", e);
    await storeError(env.DB, "micro-evolver", e);
    return { results: [] };
  });
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

  // Step 7: Attribute realized outcomes to the variants that executed this cycle.
  // Scanner keeps the historical settlement-only attribution. Risk/monitor close
  // actions also credit trader and micro-evolver as pipeline-level contributors
  // until per-trade Gene provenance is available.
  try {
    const riskOutcomes = [...risk.stopped, ...risk.expired].map(x => ({ pnl: x.pnl }));
    const settlementOutcomes = settler.settlements.map(x => ({ pnl: x.pnl }));
    const monitorOutcomes = monitorOut.actions.map(x => ({ pnl: x.pnl }));
    const closedOutcomes = [...riskOutcomes, ...settlementOutcomes, ...monitorOutcomes];

    await recordVariantOutcomes(env.DB, riskVariant, riskOutcomes);
    await recordVariantOutcomes(env.DB, scannerVariant, settlementOutcomes);
    await recordVariantOutcomes(env.DB, monitorVariant, monitorOutcomes);
    await recordVariantOutcomes(env.DB, traderVariant, closedOutcomes);
    await recordVariantOutcomes(env.DB, microEvolverVariant, closedOutcomes);
  } catch {
    // non-critical
  }

  // Step 8: Code Evolution
  let codeEvoResult;
  try {
    codeEvoResult = await checkAndRunCodeEvolution(env.DB, {
      epochTradeThreshold: Number(env.EPOCH_TRADE_THRESHOLD) || 10,
      minTradesForEval,
    }, env);
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

  // Store final heartbeat BEFORE broadcast so it's always written even if broadcast hangs.
  // Execution order: early partial write (PENDING) → pipeline stages → full write → broadcast → Telegram
  await storeHeartbeat(env.DB, {
    lastScanAt: ts,
    worker: workerHeartbeatContext(env, "genome"),
    totalFetched: scanner.totalFetched,
    marketsFiltered: scanner.filtered.length,
    signalsFound: scanner.signals.length,
    tradesOpened: trader.trades.length,
    settlementsProcessed: settler.settlements.length,
    monitorActions: monitorOut.actions.length,
    riskStops: risk.stopped.length,
    riskExpired: risk.expired.length,
    skipSummary: aggregateSkipReasonsLocal(traderSkipReasons),
    pipelineRunning: false,
    priceRefresh,
  });
  // Store per-fund skip breakdown in its own DB key so it is never overwritten
  // by the start-of-pipeline sentinel write (which used to cause stale/garbage data).
  await storeSkipByFund(env.DB, aggregateSkipReasonsByFundLocal(traderSkipReasons));

  // Broadcast all collected events (non-critical — slow DO calls must not block above)
  for (const event of events) {
    await broadcast(env, event);
  }

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
      { gene: "polymarket-micro-evolver", id: "micro", input: { mode: "micro" } },
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
  const avg = scanner.signals.length > 0
    ? Math.round((scanner.signals.reduce((s, x) => s + x.edge, 0) / scanner.signals.length) * 100) / 100
    : 0;
  await db.prepare(
    "INSERT INTO scans (id, scanned_at, total_fetched, markets_filtered, signals_found, avg_edge) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(scanId, ts, scanner.totalFetched, scanner.filtered.length, scanner.signals.length, avg).run();

  for (const sig of scanner.signals) {
    await db.prepare(
      "INSERT INTO signals (id, scan_id, signal_id, type, market_id, slug, question, description, edge, confidence, direction, prices, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      crypto.randomUUID(), scanId, sig.signalId, sig.type, sig.marketId, sig.slug,
      sig.question, sig.description, sig.edge, sig.confidence, sig.direction,
      JSON.stringify(sig.prices), sig.timestamp,
    ).run();
  }
}
