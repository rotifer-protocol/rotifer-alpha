/**
 * Code Evolver
 *
 * Controls the Gene implementation-level evolution loop:
 *   1. Detect epoch boundary (enough trades evaluated)
 *   2. Score all active variants per Gene
 *   3. Eliminate worst performer if ≥2 active variants exist
 *   4. Promote best performer
 *   5. Log evolution decisions
 *
 * Epoch boundary = every EPOCH_TRADE_THRESHOLD trades across all funds.
 * In production this roughly maps to ~3 weeks of pipeline execution.
 */

import {
  listVariants,
  computeAlphaScore,
  eliminateVariant,
  setActiveVariant,
  logEvolution,
  getCurrentEpoch,
  createVariant,
  type GeneVariant,
} from "./gene-variants";
import { GENE_REGISTRY } from "./gene-interface";
import { generateLLMVariantConfig, isLLMSupportedGene, type LLMVariantStats } from "./gene-llm-evolver";
import type { Env } from "./types";

const EPOCH_TRADE_THRESHOLD_DEFAULT = 50;
const MIN_TRADES_FOR_EVAL_DEFAULT = 5;

export interface EpochResult {
  epoch: number;
  evaluations: GeneEvaluation[];
  promotions: Array<{ geneId: string; variantId: string; score: number }>;
  eliminations: Array<{ geneId: string; variantId: string; score: number }>;
  triggered: boolean;
}

export interface GeneEvaluation {
  geneId: string;
  variants: Array<{ variantId: string; score: number; trades: number; status: string }>;
  bestVariant: string;
  worstVariant: string | null;
}

export interface CodeEvoOptions {
  epochTradeThreshold?: number;
  minTradesForEval?: number;
}

export async function checkAndRunCodeEvolution(
  db: D1Database,
  opts: CodeEvoOptions = {},
  env?: Env,
): Promise<EpochResult> {
  const EPOCH_TRADE_THRESHOLD = opts.epochTradeThreshold ?? EPOCH_TRADE_THRESHOLD_DEFAULT;
  const MIN_TRADES_FOR_EVAL = opts.minTradesForEval ?? MIN_TRADES_FOR_EVAL_DEFAULT;

  const currentEpoch = await getCurrentEpoch(db);

  const totalTrades = await db.prepare(
    "SELECT SUM(trades_evaluated) as total FROM gene_variants WHERE status = 'active'",
  ).first<{ total: number | null }>();

  const lastEpochTrades = await db.prepare(
    "SELECT details FROM gene_evolution_log WHERE epoch = ? AND action = 'epoch_completed' ORDER BY created_at DESC LIMIT 1",
  ).bind(currentEpoch).first<{ details: string | null }>();

  const prevTotal = lastEpochTrades?.details
    ? JSON.parse(lastEpochTrades.details).totalTrades ?? 0
    : 0;

  const tradesSinceLastEpoch = (totalTrades?.total ?? 0) - prevTotal;

  if (tradesSinceLastEpoch < EPOCH_TRADE_THRESHOLD) {
    return { epoch: currentEpoch, evaluations: [], promotions: [], eliminations: [], triggered: false };
  }

  const nextEpoch = currentEpoch + 1;
  await logEvolution(db, nextEpoch, "*", "epoch_started", null,
    JSON.stringify({ tradesSinceLastEpoch, threshold: EPOCH_TRADE_THRESHOLD }), null);

  const evaluations: GeneEvaluation[] = [];
  const promotions: EpochResult["promotions"] = [];
  const eliminations: EpochResult["eliminations"] = [];

  for (const gene of GENE_REGISTRY) {
    const variants = await listVariants(db, gene.id);
    const active = variants.filter(v => v.status === "active");

    if (active.length === 0) continue;

    for (const v of active) {
      if (v.tradesEvaluated >= MIN_TRADES_FOR_EVAL) {
        await computeAlphaScore(db, v.id);
      }
    }

    const refreshed = await listVariants(db, gene.id);
    const activeRefreshed = refreshed.filter(v => v.status === "active");
    const evaluated = activeRefreshed.filter(v => v.tradesEvaluated >= MIN_TRADES_FOR_EVAL);

    const sorted = [...evaluated].sort((a, b) => b.alphaScore - a.alphaScore);
    const promotable = sorted.filter(v => v.alphaScore > 0);
    const best = promotable[0] ?? null;
    const worst = best && sorted.length >= 2 ? sorted[sorted.length - 1] : null;

    const eval_: GeneEvaluation = {
      geneId: gene.id,
      variants: activeRefreshed.map(v => ({
        variantId: v.id,
        score: v.alphaScore,
        trades: v.tradesEvaluated,
        status: v.status,
      })),
      bestVariant: best?.id ?? activeRefreshed[0]?.id ?? "",
      worstVariant: worst?.id ?? null,
    };
    evaluations.push(eval_);

    if (best) {
      await setActiveVariant(db, gene.id, best.id);
      await logEvolution(db, nextEpoch, gene.id, "variant_promoted", best.id,
        JSON.stringify({ score: best.alphaScore, trades: best.tradesEvaluated }), best.alphaScore);
      promotions.push({ geneId: gene.id, variantId: best.id, score: best.alphaScore });
    }

    if (worst && activeRefreshed.length >= 2) {
      await eliminateVariant(db, worst.id, nextEpoch);
      eliminations.push({ geneId: gene.id, variantId: worst.id, score: worst.alphaScore });

      // After elimination, spawn a fresh challenger so competition can continue.
      // Phase 3.5: try LLM config generation first (scanner/monitor only).
      // Fallback: respawn the eliminated variant's strategyKey with zeroed stats.
      const willHaveOneActive = activeRefreshed.length - 1 < 2;
      if (willHaveOneActive) {
        const survivor = activeRefreshed.find(v => v.id !== worst.id);
        let spawned = false;

        if (env?.AI && isLLMSupportedGene(gene.id) && survivor) {
          const stats: LLMVariantStats = {
            tradesEvaluated: survivor.tradesEvaluated,
            winRate: survivor.tradesEvaluated > 0 ? survivor.winCount / survivor.tradesEvaluated : 0,
            avgPnl: survivor.tradesEvaluated > 0 ? survivor.totalPnl / survivor.tradesEvaluated : 0,
            alphaScore: survivor.alphaScore,
          };
          const llmConfig = await generateLLMVariantConfig(env.AI, gene.id, stats);
          if (llmConfig) {
            const gen = survivor.generation + 1;
            const name = `llm-config g${gen}`;
            await createVariant(
              db, gene.id, name, "llm-config",
              (llmConfig.hypothesis as string | undefined) ?? "LLM-generated challenger",
              survivor.id, gen, llmConfig,
              "llm-generated",
              `LLM challenger: ${(llmConfig.hypothesis as string | undefined)?.slice(0, 100) ?? "AI-suggested config"}`,
            );
            await logEvolution(db, nextEpoch, gene.id, "variant_llm_generated", survivor.id,
              JSON.stringify({ config: llmConfig, newVariant: name }), null);
            spawned = true;
          }
        }

        if (!spawned) {
          const gen = worst.generation + 1;
          const name = `${worst.strategyKey} g${gen}`;
          await createVariant(
            db, gene.id, name, worst.strategyKey,
            worst.description ?? "",
            worst.id, gen, worst.config ?? {},
            "respawn",
            `Fresh challenger respawned from ${worst.id} after epoch ${nextEpoch}`,
          );
          await logEvolution(db, nextEpoch, gene.id, "variant_respawned", worst.id,
            JSON.stringify({ strategyKey: worst.strategyKey, parentScore: worst.alphaScore, newVariant: name }), null);
        }
      }
    }
  }

  await logEvolution(db, nextEpoch, "*", "epoch_completed", null,
    JSON.stringify({ totalTrades: totalTrades?.total ?? 0, evaluations: evaluations.length, promotions: promotions.length, eliminations: eliminations.length }),
    null);

  return { epoch: nextEpoch, evaluations, promotions, eliminations, triggered: true };
}
