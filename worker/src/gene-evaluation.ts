import type { GeneVariant } from "./gene-variants";
import { recordTradeResult } from "./gene-variants";

const DEFAULT_BUCKET_MS = 5 * 60 * 1000;

export interface VariantOutcome {
  pnl: number;
}

export interface ExplorationOptions {
  /**
   * Run a non-configured active challenger once every N time buckets.
   * 0 disables exploration. Default bucket is the 5-minute cron cadence.
   */
  interval?: number;
  bucketMs?: number;
}

/**
 * Selects the variant that should execute this pipeline cycle.
 *
 * `gene_active_config` remains the exploitation winner. This selector adds a
 * bounded exploration lane so challengers can earn real paper/shadow samples
 * instead of staying at zero forever.
 */
export function selectPipelineVariant(
  configured: GeneVariant | null,
  variants: GeneVariant[],
  timestamp: string,
  opts: ExplorationOptions = {},
): GeneVariant | null {
  const active = variants
    .filter(v => v.status === "active")
    .sort((a, b) => a.id.localeCompare(b.id));
  if (active.length === 0) return configured;
  if (!configured) return active[0];

  const configuredActive = active.find(v => v.id === configured.id);
  if (!configuredActive) return active[0];
  const interval = opts.interval ?? 2;
  if (interval <= 0 || active.length <= 1) return configuredActive;

  const bucketMs = opts.bucketMs ?? DEFAULT_BUCKET_MS;
  const ts = Date.parse(timestamp);
  const bucket = Number.isFinite(ts) ? Math.floor(ts / bucketMs) : 0;
  if (bucket % interval !== 0) return configuredActive;

  const challengers = active
    .filter(v => v.id !== configuredActive.id)
    .sort((a, b) =>
      (a.tradesEvaluated - b.tradesEvaluated) ||
      (b.generation - a.generation) ||
      a.id.localeCompare(b.id),
    );

  return challengers[0] ?? configuredActive;
}

export async function recordVariantOutcomes(
  db: D1Database,
  variant: GeneVariant | null,
  outcomes: VariantOutcome[],
): Promise<void> {
  if (!variant || outcomes.length === 0) return;
  for (const outcome of outcomes) {
    await recordTradeResult(db, variant.id, outcome.pnl, outcome.pnl > 0);
  }
}
