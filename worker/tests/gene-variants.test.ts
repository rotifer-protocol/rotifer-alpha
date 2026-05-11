import test from "node:test";
import assert from "node:assert/strict";

import {
  type GeneVariant,
  type EvolutionLogEntry,
} from "../src/gene-variants";

// ─── Fake D1 for variant management ─────────────────────

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
        row.id = args[0]; row.gene_id = args[1]; row.variant_name = args[2];
        row.description = args[3]; row.strategy_key = args[4]; row.config = args[5];
        row.parent_variant_id = args[6]; row.generation = args[7]; row.status = args[8] ?? "active";
        row.created_at = args[9] ?? args[8]; row.petri_score = 0; row.trades_evaluated = 0;
        row.win_count = 0; row.loss_count = 0; row.total_pnl = 0;
      } else if (table === "gene_lineage") {
        row.id = args[0]; row.parent_id = args[1]; row.child_id = args[2];
        row.mutation_type = args[3]; row.mutation_description = args[4]; row.created_at = args[5];
      } else if (table === "gene_evolution_log") {
        row.id = args[0]; row.epoch = args[1]; row.gene_id = args[2];
        row.action = args[3]; row.variant_id = args[4]; row.details = args[5];
        row.petri_score = args[6]; row.created_at = args[7];
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
      } else if (table === "gene_variants" && lc.includes("petri_score =")) {
        const id = args[1];
        const row = this.tables[table].find(r => r.id === id);
        if (row) row.petri_score = args[0];
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
    // Lineage JOIN query must be checked before gene_variants
    if (lc.includes("gene_lineage") && lc.includes("join")) {
      return this.tables.gene_lineage.filter(r =>
        this.tables.gene_variants.some(v => v.id === r.child_id && v.gene_id === args[0]),
      );
    }
    if (lc.includes("gene_lineage")) {
      return this.tables.gene_lineage;
    }
    if (lc.includes("gene_variants") && lc.includes("where gene_id")) {
      return this.tables.gene_variants.filter(r => r.gene_id === args[0]);
    }
    if (lc.includes("gene_variants")) {
      return this.tables.gene_variants;
    }
    if (lc.includes("gene_evolution_log")) {
      return this.tables.gene_evolution_log.slice(0, args[0] as number || 50);
    }
    if (lc.includes("gene_active_config")) {
      return this.tables.gene_active_config;
    }
    return [];
  }
}

// ─── Tests ──────────────────────────────────────────────

test("getActiveVariantId returns baseline when no config set", async () => {
  const {
    getActiveVariantId,
  } = await import("../src/gene-variants");
  const db = new FakeDb() as unknown as D1Database;
  const id = await getActiveVariantId(db, "polymarket-scanner");
  assert.equal(id, "polymarket-scanner:v1-baseline");
});

test("setActiveVariant + getActiveVariantId round-trip", async () => {
  const {
    setActiveVariant,
    getActiveVariantId,
  } = await import("../src/gene-variants");
  const db = new FakeDb() as unknown as D1Database;
  await setActiveVariant(db, "polymarket-scanner", "polymarket-scanner:v2-trend");
  const id = await getActiveVariantId(db, "polymarket-scanner");
  assert.equal(id, "polymarket-scanner:v2-trend");
});

test("createVariant stores variant and lineage", async () => {
  const {
    createVariant,
    listVariants,
    getLineage,
  } = await import("../src/gene-variants");
  const db = new FakeDb() as unknown as D1Database;

  await createVariant(
    db,
    "polymarket-scanner",
    "v2-trend",
    "trend-following",
    "Trend-following scanner variant",
    "polymarket-scanner:v1-baseline",
    1,
    {},
    "llm_generation",
    "LLM generated alternative with trend bias",
  );

  const variants = await listVariants(db, "polymarket-scanner");
  assert.equal(variants.length, 1);
  assert.equal(variants[0].strategyKey, "trend-following");
  assert.equal(variants[0].generation, 1);

  const lineage = await getLineage(db, "polymarket-scanner");
  assert.equal(lineage.length, 1);
  assert.equal(lineage[0].parentId, "polymarket-scanner:v1-baseline");
  assert.equal(lineage[0].childId, "polymarket-scanner:v2-trend");
  assert.equal(lineage[0].mutationType, "llm_generation");
});

test("recordTradeResult accumulates scores", async () => {
  const {
    createVariant,
    recordTradeResult,
    getVariant,
  } = await import("../src/gene-variants");
  const db = new FakeDb() as unknown as D1Database;

  await createVariant(db, "polymarket-scanner", "v1-baseline", "baseline", "Baseline", null, 0);
  await recordTradeResult(db, "polymarket-scanner:v1-baseline", 10, true);
  await recordTradeResult(db, "polymarket-scanner:v1-baseline", -5, false);
  await recordTradeResult(db, "polymarket-scanner:v1-baseline", 8, true);

  const v = await getVariant(db, "polymarket-scanner:v1-baseline");
  assert.ok(v);
  assert.equal(v.tradesEvaluated, 3);
  assert.equal(v.winCount, 2);
  assert.equal(v.lossCount, 1);
  assert.equal(v.totalPnl, 13);
});

test("computePetriScore calculates weighted score", async () => {
  const {
    createVariant,
    recordTradeResult,
    computePetriScore,
  } = await import("../src/gene-variants");
  const db = new FakeDb() as unknown as D1Database;

  await createVariant(db, "polymarket-scanner", "v1-test", "baseline", "Test", null, 0);
  await recordTradeResult(db, "polymarket-scanner:v1-test", 10, true);
  await recordTradeResult(db, "polymarket-scanner:v1-test", 20, true);
  await recordTradeResult(db, "polymarket-scanner:v1-test", -5, false);

  const score = await computePetriScore(db, "polymarket-scanner:v1-test");
  assert.ok(score > 0, `Score should be positive, got ${score}`);
});

test("eliminateVariant sets status and logs event", async () => {
  const {
    createVariant,
    eliminateVariant,
    getVariant,
    getEvolutionLog,
  } = await import("../src/gene-variants");
  const db = new FakeDb() as unknown as D1Database;

  await createVariant(db, "polymarket-scanner", "v1-bad", "baseline", "Bad variant", null, 0);
  await eliminateVariant(db, "polymarket-scanner:v1-bad", 1);

  const v = await getVariant(db, "polymarket-scanner:v1-bad");
  assert.ok(v);
  assert.equal(v.status, "eliminated");
  assert.ok(v.eliminatedAt);

  const log = await getEvolutionLog(db);
  assert.ok(log.some((e: EvolutionLogEntry) => e.action === "variant_eliminated"));
});

test("getAllActiveVariants returns map of gene→variant", async () => {
  const {
    setActiveVariant,
    getAllActiveVariants,
  } = await import("../src/gene-variants");
  const db = new FakeDb() as unknown as D1Database;

  await setActiveVariant(db, "polymarket-scanner", "polymarket-scanner:v1-baseline");
  await setActiveVariant(db, "polymarket-monitor", "polymarket-monitor:v2-adaptive");

  const map = await getAllActiveVariants(db);
  assert.equal(map.get("polymarket-scanner"), "polymarket-scanner:v1-baseline");
  assert.equal(map.get("polymarket-monitor"), "polymarket-monitor:v2-adaptive");
});

test("ensureStaticG1LineageBackfill inserts static challenger lineage rows", async () => {
  const {
    ensureStaticG1LineageBackfill,
    getLineage,
  } = await import("../src/gene-variants");
  const db = new FakeDb() as unknown as D1Database;

  await ensureStaticG1LineageBackfill(db);

  const lineage = await getLineage(db);
  assert.equal(lineage.length, 3);
  assert.ok(lineage.some(l => l.childId === "polymarket-risk:conservative g1"));
  assert.ok(lineage.some(l => l.childId === "polymarket-trader:high-edge g1"));
  assert.ok(lineage.some(l => l.childId === "polymarket-micro-evolver:aggressive g1"));
});
