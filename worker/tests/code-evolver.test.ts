/**
 * code-evolver.test.ts
 *
 * Tests for the Gene implementation-level evolution loop (Phase 3.5).
 * Covers: epoch boundary detection, variant promotion, and elimination.
 *
 * Note on Alpha Score vs F(g):
 *   These tests verify Alpha Score (local PBT metric, formerly "Petri Score" /
 *   "PBT Rank Score" — renamed 2026-05-20) which is STRICTLY independent of
 *   the Rotifer Protocol F(g) (protocol-level fitness).
 *   ADR-273 D5 / ADR-117 three-dimension independence discipline applies:
 *   Alpha Score ≠ F(g) — they must never directly feed each other.
 */

import test from "node:test";
import assert from "node:assert/strict";

// ─── Fake D1 (re-uses same structure as gene-variants.test.ts) ──────────────

type Row = Record<string, unknown>;

class FakeDb {
  public tables: Record<string, Row[]> = {
    gene_variants: [],
    gene_lineage: [],
    gene_evolution_log: [],
    gene_active_config: [],
  };
  public calls: Array<{ sql: string; args: unknown[] }> = [];

  prepare(sql: string) {
    const db = this;
    return {
      bind(...args: unknown[]) {
        return {
          async run() {
            db.calls.push({ sql, args });
            db._execute(sql, args);
            return {};
          },
          async first<T = Row>(): Promise<T | null> {
            db.calls.push({ sql, args });
            return db._first(sql, args) as T | null;
          },
          async all() {
            db.calls.push({ sql, args });
            return { results: db._all(sql, args) };
          },
        };
      },
      async first<T = Row>(): Promise<T | null> {
        db.calls.push({ sql, args: [] });
        return db._first(sql, []) as T | null;
      },
      async all() {
        db.calls.push({ sql, args: [] });
        return { results: db._all(sql, []) };
      },
    };
  }

  _execute(sql: string, args: unknown[]): void {
    const lc = sql.toLowerCase().trim();
    if (lc.startsWith("insert")) {
      const tableMatch = lc.match(/into\s+(\w+)/);
      if (!tableMatch) return;
      const table = tableMatch[1];
      if (!this.tables[table]) this.tables[table] = [];
      const row: Row = {};
      if (table === "gene_variants") {
        // INSERT SQL: (id, gene_id, variant_name, description, strategy_key, config,
        //              parent_variant_id, generation, status='active', created_at)
        // Note: status is a literal 'active' in the SQL — NOT a ? param.
        // args[0..7] = id,gene_id,variant_name,description,strategy_key,config,parent_variant_id,generation
        // args[8] = created_at
        row.id = args[0]; row.gene_id = args[1]; row.variant_name = args[2];
        row.description = args[3]; row.strategy_key = args[4]; row.config = args[5];
        row.parent_variant_id = args[6]; row.generation = args[7];
        row.status = "active";
        row.created_at = args[8];
        row.alpha_score = 0; row.trades_evaluated = 0;
        row.win_count = 0; row.loss_count = 0; row.total_pnl = 0;
      } else if (table === "gene_evolution_log") {
        row.id = args[0]; row.epoch = args[1]; row.gene_id = args[2];
        row.action = args[3]; row.variant_id = args[4]; row.details = args[5];
        row.alpha_score = args[6]; row.created_at = args[7];
      } else if (table === "gene_active_config") {
        const existing = this.tables[table].findIndex(r => r.gene_id === args[0]);
        if (existing >= 0) this.tables[table].splice(existing, 1);
        row.gene_id = args[0]; row.active_variant_id = args[1]; row.updated_at = args[2];
      }
      this.tables[table].push(row);
    } else if (lc.startsWith("update")) {
      const tableMatch = lc.match(/update\s+(\w+)/);
      if (!tableMatch) return;
      const table = tableMatch[1];
      if (table === "gene_variants" && lc.includes("status = 'eliminated'")) {
        const id = args[1];
        const row = this.tables[table].find(r => r.id === id);
        if (row) { row.status = "eliminated"; row.eliminated_at = args[0]; }
      } else if (table === "gene_variants" && lc.includes("trades_evaluated")) {
        const id = args[3];
        const row = this.tables[table].find(r => r.id === id);
        if (row) {
          (row.trades_evaluated as number) += 1;
          (row.total_pnl as number) += args[0] as number;
          (row.win_count as number) += args[1] as number;
          (row.loss_count as number) += args[2] as number;
        }
      } else if (table === "gene_variants" && lc.includes("alpha_score =")) {
        const id = args[1];
        const row = this.tables[table].find(r => r.id === id);
        if (row) row.alpha_score = args[0];
      }
    }
  }

  _first(sql: string, args: unknown[]): Row | null {
    const lc = sql.toLowerCase();
    if (lc.includes("gene_active_config")) {
      return this.tables.gene_active_config.find(r => r.gene_id === args[0]) ?? null;
    }
    if (lc.includes("gene_variants") && lc.includes("where id")) {
      return this.tables.gene_variants.find(r => r.id === args[0]) ?? null;
    }
    if (lc.includes("max(epoch)")) {
      const maxEpoch = this.tables.gene_evolution_log.reduce(
        (max, r) => Math.max(max, r.epoch as number), 0,
      );
      return { epoch: maxEpoch || 0 };
    }
    if (lc.includes("gene_evolution_log") && lc.includes("epoch_completed")) {
      const match = this.tables.gene_evolution_log.find(
        r => r.epoch === args[0] && r.action === "epoch_completed",
      );
      return match ?? null;
    }
    if (lc.includes("sum(trades_evaluated)")) {
      const total = this.tables.gene_variants
        .filter(r => r.status === "active")
        .reduce((s, r) => s + (r.trades_evaluated as number), 0);
      return { total };
    }
    return null;
  }

  _all(sql: string, args: unknown[]): Row[] {
    const lc = sql.toLowerCase();
    if (lc.includes("gene_lineage") && lc.includes("join")) {
      return [];
    }
    if (lc.includes("gene_variants") && lc.includes("where gene_id")) {
      return this.tables.gene_variants.filter(r => r.gene_id === args[0]);
    }
    if (lc.includes("gene_variants")) {
      return this.tables.gene_variants;
    }
    if (lc.includes("gene_evolution_log")) {
      return this.tables.gene_evolution_log.slice(0, (args[0] as number) || 50);
    }
    if (lc.includes("gene_active_config")) {
      return this.tables.gene_active_config;
    }
    return [];
  }

  /** Helper: bulk-set trades_evaluated on a variant row */
  setTrades(variantId: string, count: number, winRate: number, avgPnl: number): void {
    const row = this.tables.gene_variants.find(r => r.id === variantId);
    if (!row) throw new Error(`Variant ${variantId} not in FakeDb`);
    row.trades_evaluated = count;
    row.win_count = Math.round(count * winRate);
    row.loss_count = count - (row.win_count as number);
    row.total_pnl = Math.round(count * avgPnl * 100) / 100;
  }
}

// ─── Helper: seed a baseline variant without enough trades to pass threshold ─

async function seedBaseline(db: FakeDb, geneId: string): Promise<string> {
  const { createVariant } = await import("../src/gene-variants");
  const id = `${geneId}:v1-baseline`;
  await createVariant(
    db as unknown as D1Database,
    geneId, "v1-baseline", "baseline", "Baseline variant", null, 0,
  );
  return id;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test("checkAndRunCodeEvolution: does NOT trigger when below epoch threshold", async () => {
  const { checkAndRunCodeEvolution } = await import("../src/code-evolver");
  const db = new FakeDb();

  // Single scanner variant with only 10 trades (< 50 threshold)
  await seedBaseline(db, "polymarket-scanner");
  db.setTrades("polymarket-scanner:v1-baseline", 10, 0.6, 2.5);

  const result = await checkAndRunCodeEvolution(db as unknown as D1Database);

  assert.equal(result.triggered, false, "Should not trigger below epoch threshold");
  assert.equal(result.evaluations.length, 0);
  assert.equal(result.promotions.length, 0);
  assert.equal(result.eliminations.length, 0);
});

test("checkAndRunCodeEvolution: triggers epoch when ≥50 trades accumulated", async () => {
  const { checkAndRunCodeEvolution } = await import("../src/code-evolver");
  const { createVariant } = await import("../src/gene-variants");
  const db = new FakeDb();

  // Seed ONE scanner variant with enough trades to cross threshold
  await seedBaseline(db, "polymarket-scanner");
  db.setTrades("polymarket-scanner:v1-baseline", 55, 0.7, 3.0);

  const result = await checkAndRunCodeEvolution(db as unknown as D1Database);

  assert.equal(result.triggered, true, "Should trigger epoch when threshold crossed");
  assert.ok(result.epoch > 0, "Epoch should be incremented");

  // epoch_started and epoch_completed logs must exist
  const log = db.tables.gene_evolution_log;
  assert.ok(
    log.some(r => r.action === "epoch_started"),
    "epoch_started log should be written",
  );
  assert.ok(
    log.some(r => r.action === "epoch_completed"),
    "epoch_completed log should be written",
  );
});

test("checkAndRunCodeEvolution: promotes best variant when 2 exist with enough trades", async () => {
  const { checkAndRunCodeEvolution } = await import("../src/code-evolver");
  const { createVariant, getActiveVariantId } = await import("../src/gene-variants");
  const db = new FakeDb();

  // v1-baseline: mediocre score
  await createVariant(db as unknown as D1Database, "polymarket-scanner", "v1-baseline", "baseline", "Baseline", null, 0);
  db.setTrades("polymarket-scanner:v1-baseline", 30, 0.5, 1.0);

  // v2-trend: better score (higher win rate + higher PnL)
  await createVariant(db as unknown as D1Database, "polymarket-scanner", "v2-trend", "trend-following", "Trend variant", "polymarket-scanner:v1-baseline", 1);
  db.setTrades("polymarket-scanner:v2-trend", 30, 0.8, 5.0);

  // Total trades = 60, crosses 50-trade threshold
  const result = await checkAndRunCodeEvolution(db as unknown as D1Database);

  assert.equal(result.triggered, true);
  assert.ok(result.promotions.length > 0, "At least one promotion should occur");

  const scannerPromotion = result.promotions.find(p => p.geneId === "polymarket-scanner");
  assert.ok(scannerPromotion, "polymarket-scanner should have a promotion");
  assert.equal(
    scannerPromotion.variantId, "polymarket-scanner:v2-trend",
    "Better variant (v2-trend) should be promoted",
  );
});

test("checkAndRunCodeEvolution: eliminates worst variant when ≥3 exist", async () => {
  const { checkAndRunCodeEvolution } = await import("../src/code-evolver");
  const { createVariant, getVariant } = await import("../src/gene-variants");
  const db = new FakeDb();

  // 3 variants for polymarket-scanner with different performance levels
  await createVariant(db as unknown as D1Database, "polymarket-scanner", "v1-baseline", "baseline", "Baseline", null, 0);
  db.setTrades("polymarket-scanner:v1-baseline", 20, 0.55, 1.5);

  await createVariant(db as unknown as D1Database, "polymarket-scanner", "v2-good", "trend-following", "Good", "polymarket-scanner:v1-baseline", 1);
  db.setTrades("polymarket-scanner:v2-good", 20, 0.80, 6.0);

  await createVariant(db as unknown as D1Database, "polymarket-scanner", "v3-bad", "contrarian", "Bad", "polymarket-scanner:v1-baseline", 1);
  db.setTrades("polymarket-scanner:v3-bad", 20, 0.20, -3.0);

  // Total = 60 trades — triggers epoch
  const result = await checkAndRunCodeEvolution(db as unknown as D1Database);

  assert.equal(result.triggered, true);
  assert.ok(result.eliminations.length > 0, "Worst variant should be eliminated when ≥3 exist");

  const scannerElim = result.eliminations.find(e => e.geneId === "polymarket-scanner");
  assert.ok(scannerElim, "polymarket-scanner elimination should be recorded");
  assert.equal(
    scannerElim.variantId, "polymarket-scanner:v3-bad",
    "Worst performer (v3-bad) should be eliminated",
  );

  // Confirm DB row is marked eliminated
  const v3 = await getVariant(db as unknown as D1Database, "polymarket-scanner:v3-bad");
  assert.ok(v3);
  assert.equal(v3.status, "eliminated", "v3-bad status should be 'eliminated' in DB");
});

test("checkAndRunCodeEvolution: does NOT eliminate when only 1 variant exists (preserve last)", async () => {
  // 2026-05-05 update: elimination threshold lowered from ≥3 to ≥2 (Phase 3.5 §F3)
  // to keep competition continuous. Only the lone-survivor case (1 variant) is preserved.
  const { checkAndRunCodeEvolution } = await import("../src/code-evolver");
  const { createVariant } = await import("../src/gene-variants");
  const db = new FakeDb();

  // Single variant with enough trades to cross epoch threshold (default 50)
  await createVariant(db as unknown as D1Database, "polymarket-scanner", "v1-baseline", "baseline", "Baseline", null, 0);
  db.setTrades("polymarket-scanner:v1-baseline", 60, 0.6, 2.0);

  const result = await checkAndRunCodeEvolution(db as unknown as D1Database);

  assert.equal(result.triggered, true);
  const scannerElim = result.eliminations.filter(e => e.geneId === "polymarket-scanner");
  assert.equal(scannerElim.length, 0, "Should NOT eliminate when only 1 variant exists (would leave gene empty)");
});

test("checkAndRunCodeEvolution: DOES eliminate when ≥2 variants exist (post 2026-05-05 §F3)", async () => {
  const { checkAndRunCodeEvolution } = await import("../src/code-evolver");
  const { createVariant } = await import("../src/gene-variants");
  const db = new FakeDb();

  await createVariant(db as unknown as D1Database, "polymarket-scanner", "v1-baseline", "baseline", "Baseline", null, 0);
  db.setTrades("polymarket-scanner:v1-baseline", 30, 0.6, 2.0);

  await createVariant(db as unknown as D1Database, "polymarket-scanner", "v2-alt", "alternative", "Alt", "polymarket-scanner:v1-baseline", 1);
  db.setTrades("polymarket-scanner:v2-alt", 30, 0.4, -1.0);

  const result = await checkAndRunCodeEvolution(db as unknown as D1Database);

  assert.equal(result.triggered, true);
  const scannerElim = result.eliminations.filter(e => e.geneId === "polymarket-scanner");
  assert.equal(scannerElim.length, 1, "Should eliminate the worst when ≥2 variants exist");
  assert.equal(scannerElim[0].variantId, "polymarket-scanner:v2-alt", "v2-alt has worse score, should be eliminated");
});

test("checkAndRunCodeEvolution: does NOT promote variants with zero Alpha Score", async () => {
  const { checkAndRunCodeEvolution } = await import("../src/code-evolver");
  const { createVariant, getActiveVariantId } = await import("../src/gene-variants");
  const db = new FakeDb();

  await createVariant(db as unknown as D1Database, "polymarket-risk", "v1-baseline", "baseline", "Baseline", null, 0);
  db.setTrades("polymarket-risk:v1-baseline", 1, 1.0, 10.0);

  await createVariant(db as unknown as D1Database, "polymarket-risk", "conservative g1", "conservative", "Conservative", "polymarket-risk:v1-baseline", 1);
  db.setTrades("polymarket-risk:conservative g1", 8, 0.25, -900.0);

  const result = await checkAndRunCodeEvolution(db as unknown as D1Database, {
    epochTradeThreshold: 5,
    minTradesForEval: 3,
  });

  assert.equal(result.triggered, true);
  assert.equal(
    result.promotions.some(p => p.geneId === "polymarket-risk"),
    false,
    "Zero-score risk challenger should not be promoted",
  );
  assert.equal(
    await getActiveVariantId(db as unknown as D1Database, "polymarket-risk"),
    "polymarket-risk:v1-baseline",
    "Configured baseline should remain active until a positive-score variant exists",
  );
});
