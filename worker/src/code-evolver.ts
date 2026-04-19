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
  computePetriScore,
  eliminateVariant,
  setActiveVariant,
  logEvolution,
  getCurrentEpoch,
  type GeneVariant,
} from "./gene-variants";
import { GENE_REGISTRY } from "./gene-interface";

const EPOCH_TRADE_THRESHOLD = 50;
const MIN_TRADES_FOR_EVAL = 5;

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

export async function checkAndRunCodeEvolution(db: D1Database): Promise<EpochResult> {
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
        await computePetriScore(db, v.id);
      }
    }

    const refreshed = await listVariants(db, gene.id);
    const activeRefreshed = refreshed.filter(v => v.status === "active");
    const evaluated = activeRefreshed.filter(v => v.tradesEvaluated >= MIN_TRADES_FOR_EVAL);

    const sorted = [...evaluated].sort((a, b) => b.petriScore - a.petriScore);
    const best = sorted[0];
    const worst = sorted.length >= 2 ? sorted[sorted.length - 1] : null;

    const eval_: GeneEvaluation = {
      geneId: gene.id,
      variants: activeRefreshed.map(v => ({
        variantId: v.id,
        score: v.petriScore,
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
        JSON.stringify({ score: best.petriScore, trades: best.tradesEvaluated }), best.petriScore);
      promotions.push({ geneId: gene.id, variantId: best.id, score: best.petriScore });
    }

    if (worst && activeRefreshed.length >= 3) {
      await eliminateVariant(db, worst.id, nextEpoch);
      eliminations.push({ geneId: gene.id, variantId: worst.id, score: worst.petriScore });
    }
  }

  await logEvolution(db, nextEpoch, "*", "epoch_completed", null,
    JSON.stringify({ totalTrades: totalTrades?.total ?? 0, evaluations: evaluations.length, promotions: promotions.length, eliminations: eliminations.length }),
    null);

  return { epoch: nextEpoch, evaluations, promotions, eliminations, triggered: true };
}
