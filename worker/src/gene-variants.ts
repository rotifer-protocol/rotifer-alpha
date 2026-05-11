/**
 * Gene Variant Management
 *
 * Manages alternative Gene implementations — CRUD, scoring, lineage tracking,
 * and runtime variant selection for the Genome orchestrator.
 */

// ─── Types ──────────────────────────────────────────────

export interface GeneVariant {
  id: string;
  geneId: string;
  variantName: string;
  description: string | null;
  descriptionZh: string | null;
  strategyKey: string;
  config: Record<string, unknown>;
  parentVariantId: string | null;
  generation: number;
  status: "active" | "eliminated" | "retired";
  petriScore: number;
  tradesEvaluated: number;
  winCount: number;
  lossCount: number;
  totalPnl: number;
  createdAt: string;
  eliminatedAt: string | null;
}

export interface LineageEntry {
  id: string;
  parentId: string;
  childId: string;
  mutationType: string;
  mutationDescription: string | null;
  createdAt: string;
}

export interface EvolutionLogEntry {
  id: string;
  epoch: number;
  geneId: string;
  action: string;
  variantId: string | null;
  details: string | null;
  petriScore: number | null;
  createdAt: string;
}

const STATIC_G1_LINEAGE_BACKFILL = [
  {
    id: "lineage-risk-v1-to-conservative-g1",
    parentId: "polymarket-risk:v1-baseline",
    childId: "polymarket-risk:conservative g1",
    mutationType: "threshold_tightening",
    mutationDescription: "Tightened stop-loss and max-hold thresholds to cut losses faster.",
  },
  {
    id: "lineage-trader-v1-to-high-edge-g1",
    parentId: "polymarket-trader:v1-baseline",
    childId: "polymarket-trader:high-edge g1",
    mutationType: "signal_filter",
    mutationDescription: "Raised entry bar to edge >= 2x fund minEdge for fewer, higher-conviction trades.",
  },
  {
    id: "lineage-micro-evolver-v1-to-aggressive-g1",
    parentId: "polymarket-micro-evolver:v1-baseline",
    childId: "polymarket-micro-evolver:aggressive g1",
    mutationType: "adaptation_rate",
    mutationDescription: "Increased parameter nudge ratio and lowered trade threshold so fund params adapt faster.",
  },
] as const;

// ─── Active Variant Lookup ──────────────────────────────

export async function getActiveVariantId(db: D1Database, geneId: string): Promise<string> {
  const row = await db.prepare(
    "SELECT active_variant_id FROM gene_active_config WHERE gene_id = ?",
  ).bind(geneId).first<{ active_variant_id: string }>();
  return row?.active_variant_id ?? `${geneId}:v1-baseline`;
}

export async function getActiveVariant(db: D1Database, geneId: string): Promise<GeneVariant | null> {
  const variantId = await getActiveVariantId(db, geneId);
  return await getVariant(db, variantId);
}

export async function setActiveVariant(db: D1Database, geneId: string, variantId: string): Promise<void> {
  await db.prepare(
    "INSERT OR REPLACE INTO gene_active_config (gene_id, active_variant_id, updated_at) VALUES (?, ?, ?)",
  ).bind(geneId, variantId, new Date().toISOString()).run();
}

export async function getAllActiveVariants(db: D1Database): Promise<Map<string, string>> {
  const rows = await db.prepare("SELECT gene_id, active_variant_id FROM gene_active_config").all();
  const map = new Map<string, string>();
  for (const r of (rows.results ?? []) as any[]) {
    map.set(r.gene_id, r.active_variant_id);
  }
  return map;
}

export function selectSaneActiveVariant(
  configured: GeneVariant | null,
  variants: GeneVariant[],
  minTradesForEval = 3,
): GeneVariant | null {
  const active = variants.filter(v => v.status === "active");
  if (active.length === 0) return configured;

  const configuredActive = configured
    ? active.find(v => v.id === configured.id) ?? null
    : null;

  const hasSufficientBadSample = configuredActive
    ? configuredActive.petriScore <= 0 && configuredActive.tradesEvaluated >= minTradesForEval
    : false;

  if (configuredActive && !hasSufficientBadSample) return configuredActive;

  const candidates = active.filter(v => v.id !== configuredActive?.id);
  if (candidates.length === 0) return configuredActive ?? active[0];

  return candidates.sort((a, b) =>
    (b.petriScore - a.petriScore) ||
    (b.totalPnl - a.totalPnl) ||
    (a.tradesEvaluated - b.tradesEvaluated) ||
    (b.generation - a.generation) ||
    a.id.localeCompare(b.id),
  )[0];
}

export async function ensureSaneActiveVariant(
  db: D1Database,
  geneId: string,
  minTradesForEval = 3,
): Promise<GeneVariant | null> {
  const configuredId = await getActiveVariantId(db, geneId);
  const variants = await listVariants(db, geneId);
  const configured = variants.find(v => v.id === configuredId) ?? await getVariant(db, configuredId);
  const selected = selectSaneActiveVariant(configured, variants, minTradesForEval);
  if (selected && selected.id !== configuredId) {
    await setActiveVariant(db, geneId, selected.id);
  }
  return selected;
}

// ─── Variant CRUD ───────────────────────────────────────

export async function getVariant(db: D1Database, variantId: string): Promise<GeneVariant | null> {
  const row = await db.prepare("SELECT * FROM gene_variants WHERE id = ?").bind(variantId).first();
  return row ? mapVariantRow(row) : null;
}

export async function listVariants(db: D1Database, geneId?: string): Promise<GeneVariant[]> {
  const sql = geneId
    ? "SELECT * FROM gene_variants WHERE gene_id = ? ORDER BY generation DESC, created_at DESC"
    : "SELECT * FROM gene_variants ORDER BY gene_id, generation DESC, created_at DESC";
  const rows = geneId
    ? await db.prepare(sql).bind(geneId).all()
    : await db.prepare(sql).all();
  return (rows.results ?? []).map(mapVariantRow);
}

export async function createVariant(
  db: D1Database,
  geneId: string,
  variantName: string,
  strategyKey: string,
  description: string,
  parentVariantId: string | null,
  generation: number,
  config: Record<string, unknown> = {},
  mutationType?: string,
  mutationDescription?: string,
): Promise<GeneVariant> {
  const id = `${geneId}:${variantName}`;
  const now = new Date().toISOString();

  await db.prepare(
    `INSERT INTO gene_variants (id, gene_id, variant_name, description, strategy_key, config, parent_variant_id, generation, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).bind(id, geneId, variantName, description, strategyKey, JSON.stringify(config), parentVariantId, generation, now).run();

  if (parentVariantId && mutationType) {
    await db.prepare(
      "INSERT INTO gene_lineage (id, parent_id, child_id, mutation_type, mutation_description, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), parentVariantId, id, mutationType, mutationDescription ?? null, now).run();
  }

  return (await getVariant(db, id))!;
}

export async function eliminateVariant(db: D1Database, variantId: string, epoch: number): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(
    "UPDATE gene_variants SET status = 'eliminated', eliminated_at = ? WHERE id = ?",
  ).bind(now, variantId).run();

  const variant = await getVariant(db, variantId);
  if (variant) {
    await logEvolution(db, epoch, variant.geneId, "variant_eliminated", variantId,
      JSON.stringify({ reason: "Lowest Petri Score in epoch", score: variant.petriScore }),
      variant.petriScore);
  }
}

// ─── Scoring ────────────────────────────────────────────

export async function recordTradeResult(
  db: D1Database,
  variantId: string,
  pnl: number,
  won: boolean,
): Promise<void> {
  await db.prepare(
    `UPDATE gene_variants SET
       trades_evaluated = trades_evaluated + 1,
       total_pnl = total_pnl + ?,
       win_count = win_count + ?,
       loss_count = loss_count + ?
     WHERE id = ?`,
  ).bind(pnl, won ? 1 : 0, won ? 0 : 1, variantId).run();
}

export async function computePetriScore(db: D1Database, variantId: string): Promise<number> {
  const v = await getVariant(db, variantId);
  if (!v || v.tradesEvaluated === 0) return 0;

  const winRate = v.tradesEvaluated > 0 ? v.winCount / v.tradesEvaluated : 0;
  const avgPnl = v.totalPnl / v.tradesEvaluated;
  const rawScore = (winRate * 0.4 + Math.tanh(avgPnl / 100) * 0.6) * 100;
  const score = Math.max(0, Math.min(100, rawScore));

  await db.prepare("UPDATE gene_variants SET petri_score = ? WHERE id = ?").bind(score, variantId).run();
  return score;
}

// ─── Lineage ────────────────────────────────────────────

export async function getLineage(db: D1Database, geneId?: string): Promise<LineageEntry[]> {
  if (geneId) {
    const rows = await db.prepare(
      `SELECT l.* FROM gene_lineage l
       JOIN gene_variants v ON l.child_id = v.id
       WHERE v.gene_id = ?
       ORDER BY l.created_at DESC`,
    ).bind(geneId).all();
    return (rows.results ?? []).map(mapLineageRow);
  }
  const rows = await db.prepare("SELECT * FROM gene_lineage ORDER BY created_at DESC").all();
  return (rows.results ?? []).map(mapLineageRow);
}

/**
 * Runtime idempotent backfill for static g1 challengers.
 *
 * The SQL migration remains the durable schema path, but production D1 API
 * access can be unavailable to the deploy token. Running the same INSERT OR
 * IGNORE through the Worker DB binding keeps the public lineage view complete
 * without requiring broader Cloudflare account permissions.
 */
export async function ensureStaticG1LineageBackfill(db: D1Database): Promise<void> {
  const now = new Date().toISOString();
  for (const row of STATIC_G1_LINEAGE_BACKFILL) {
    await db.prepare(
      "INSERT OR IGNORE INTO gene_lineage (id, parent_id, child_id, mutation_type, mutation_description, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      row.id,
      row.parentId,
      row.childId,
      row.mutationType,
      row.mutationDescription,
      now,
    ).run();
  }
}

export async function ensureNonNegativePetriScores(db: D1Database): Promise<void> {
  await db.prepare("UPDATE gene_variants SET petri_score = 0 WHERE petri_score < 0").bind().run();
  await db.prepare("UPDATE gene_evolution_log SET petri_score = 0 WHERE petri_score < 0").bind().run();
}

// ─── Evolution Log ──────────────────────────────────────

export async function logEvolution(
  db: D1Database,
  epoch: number,
  geneId: string,
  action: string,
  variantId: string | null,
  details: string | null,
  petriScore: number | null,
): Promise<void> {
  await db.prepare(
    "INSERT INTO gene_evolution_log (id, epoch, gene_id, action, variant_id, details, petri_score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), epoch, geneId, action, variantId, details, petriScore, new Date().toISOString()).run();
}

export async function getEvolutionLog(db: D1Database, limit = 50): Promise<EvolutionLogEntry[]> {
  const rows = await db.prepare(
    "SELECT * FROM gene_evolution_log ORDER BY created_at DESC LIMIT ?",
  ).bind(limit).all();
  return (rows.results ?? []).map(mapLogRow);
}

export async function getCurrentEpoch(db: D1Database): Promise<number> {
  const row = await db.prepare(
    "SELECT MAX(epoch) as epoch FROM gene_evolution_log",
  ).first<{ epoch: number | null }>();
  return row?.epoch ?? 0;
}

// ─── Row Mappers ────────────────────────────────────────

function mapVariantRow(row: any): GeneVariant {
  return {
    id: row.id,
    geneId: row.gene_id,
    variantName: row.variant_name,
    description: row.description,
    descriptionZh: row.description_zh ?? null,
    strategyKey: row.strategy_key,
    config: JSON.parse(row.config || "{}"),
    parentVariantId: row.parent_variant_id,
    generation: row.generation,
    status: row.status,
    petriScore: row.petri_score ?? 0,
    tradesEvaluated: row.trades_evaluated ?? 0,
    winCount: row.win_count ?? 0,
    lossCount: row.loss_count ?? 0,
    totalPnl: row.total_pnl ?? 0,
    createdAt: row.created_at,
    eliminatedAt: row.eliminated_at,
  };
}

function mapLineageRow(row: any): LineageEntry {
  return {
    id: row.id,
    parentId: row.parent_id,
    childId: row.child_id,
    mutationType: row.mutation_type,
    mutationDescription: row.mutation_description,
    createdAt: row.created_at,
  };
}

function mapLogRow(row: any): EvolutionLogEntry {
  return {
    id: row.id,
    epoch: row.epoch,
    geneId: row.gene_id,
    action: row.action,
    variantId: row.variant_id,
    details: row.details,
    petriScore: row.petri_score != null ? Math.max(0, row.petri_score) : null,
    createdAt: row.created_at,
  };
}
