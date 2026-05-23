#!/usr/bin/env -S node --import tsx
/**
 * backfill-paper-trades-signals-category.ts (v1.0 follow-up, 2026-05-23)
 *
 * Schema 037 backfill: populates `paper_trades.category` + `signals.category`
 * for historical rows that currently default to 'other' (schema 037 default).
 *
 * ── Strategy ──────────────────────────────────────────────────────────────
 *
 * Data flow (no direct D1 driver — wraps wrangler CLI):
 *   1. SELECT rows from D1 via `wrangler d1 execute --json` in batches of 1000.
 *   2. Run inferCategory(slug, question) locally to derive category.
 *   3. Write UPDATE SQL statements to an output file (one per row that resolves
 *      to a non-'other' category).
 *   4. User runs: wrangler d1 execute polymarket-signals --remote --file <output.sql>
 *
 * Why two-phase (generate SQL → user runs):
 *   - Keeps the script free of D1 write credentials
 *   - Lets user inspect the SQL before applying (audit trail)
 *   - Idempotent: re-run safely (only updates rows where category = 'other')
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *
 *   # Dry-run: print first 5 sample UPDATE statements + per-category stats
 *   tsx worker/scripts/backfill-paper-trades-signals-category.ts --dry-run
 *
 *   # Generate full UPDATE SQL files (paper-trades + signals)
 *   tsx worker/scripts/backfill-paper-trades-signals-category.ts \
 *     --out-dir worker/data/backfill-037
 *
 *   # Then user applies (NOT this script):
 *   wrangler d1 execute polymarket-signals --remote --file \
 *     worker/data/backfill-037/paper_trades-updates.sql
 *
 * ── Safety ────────────────────────────────────────────────────────────────
 *
 *   - ID escaping: WHERE id = '<id>' uses doubled single-quote escape
 *   - Skip 'other' results: only writes UPDATE for category != 'other' (no-op
 *     UPDATEs would waste rows; default already covers 'other' case)
 *   - Batch size 1000 / max 100 batches per table (100k row safety ceiling)
 *
 * Refs: internal v1.0 plan C1.3 follow-up · schema 037 spec
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { inferCategory } from "../src/scan";

const BATCH_SIZE = 1000;
const MAX_BATCHES = 100; // safety: 100 × 1000 = 100k rows ceiling
const TABLES = ["paper_trades", "signals"] as const;

interface CliArgs {
  dryRun: boolean;
  outDir: string;
  database: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dryRun: false,
    outDir: "worker/data/backfill-037",
    database: "polymarket-signals",
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--out-dir") args.outDir = argv[++i] ?? args.outDir;
    else if (argv[i] === "--db") args.database = argv[++i] ?? args.database;
  }
  return args;
}

interface Row {
  id: string;
  slug: string | null;
  question: string | null;
}

function fetchBatch(table: string, database: string, offset: number): Row[] {
  // Read rows where category is still default ('other'). LIMIT + OFFSET pagination.
  // Note: ORDER BY id is critical for stable pagination across batches.
  const query =
    `SELECT id, slug, question FROM ${table} ` +
    `WHERE category = 'other' ` +
    `ORDER BY id LIMIT ${BATCH_SIZE} OFFSET ${offset}`;

  const cmd = `npx wrangler d1 execute ${database} --remote --json --command "${query}"`;
  const stdout = execSync(cmd, { encoding: "utf-8" });
  const parsed = JSON.parse(stdout);
  // wrangler d1 execute --json returns array; first element has .results
  return (parsed[0]?.results ?? []) as Row[];
}

function escapeId(id: string): string {
  // SQLite uses doubled single-quote for escaping within string literals
  return id.replace(/'/g, "''");
}

interface BatchResult {
  fetched: number;
  toUpdate: number;
  byCategory: Record<string, number>;
  sqlStatements: string[];
}

function processBatch(table: string, rows: Row[]): BatchResult {
  const byCategory: Record<string, number> = { sports: 0, politics: 0, crypto: 0, ai: 0, other: 0 };
  const sqlStatements: string[] = [];

  for (const row of rows) {
    const slug = row.slug ?? "";
    const question = row.question ?? "";
    const category = inferCategory(slug, question);
    byCategory[category] = (byCategory[category] ?? 0) + 1;

    // Skip 'other' — it's the default; no-op UPDATE is wasteful
    if (category === "other") continue;

    sqlStatements.push(
      `UPDATE ${table} SET category = '${category}' WHERE id = '${escapeId(row.id)}';`,
    );
  }

  return {
    fetched: rows.length,
    toUpdate: sqlStatements.length,
    byCategory,
    sqlStatements,
  };
}

function backfillTable(table: string, args: CliArgs): { totalFetched: number; totalToUpdate: number; combinedByCategory: Record<string, number>; outFile?: string } {
  console.log(`\n━━━━ Backfilling ${table} ━━━━`);

  const allSql: string[] = [`-- Schema 037 backfill for ${table} — generated ${new Date().toISOString()}`];
  const combinedByCategory: Record<string, number> = { sports: 0, politics: 0, crypto: 0, ai: 0, other: 0 };
  let totalFetched = 0;
  let totalToUpdate = 0;
  let batchNum = 1;
  let offset = 0;

  while (batchNum <= MAX_BATCHES) {
    const rows = fetchBatch(table, args.database, offset);
    if (rows.length === 0) {
      console.log(`  Batch ${batchNum}: 0 rows — done`);
      break;
    }

    const result = processBatch(table, rows);
    totalFetched += result.fetched;
    totalToUpdate += result.toUpdate;
    for (const [k, v] of Object.entries(result.byCategory)) {
      combinedByCategory[k] = (combinedByCategory[k] ?? 0) + v;
    }
    allSql.push(...result.sqlStatements);

    console.log(
      `  Batch ${batchNum}: ${result.fetched} fetched / ${result.toUpdate} UPDATE — ` +
      `sports ${result.byCategory.sports} / politics ${result.byCategory.politics} / ` +
      `crypto ${result.byCategory.crypto} / ai ${result.byCategory.ai} / other ${result.byCategory.other}`,
    );

    // Dry-run stops after first batch (sample is enough to validate logic)
    if (args.dryRun) {
      console.log("  (DRY-RUN) Stopping after first batch. First 5 sample UPDATE statements:");
      for (const s of result.sqlStatements.slice(0, 5)) console.log(`    ${s}`);
      break;
    }

    // Since we filter by `category = 'other'` and then UPDATE to non-'other',
    // subsequent SELECTs with same WHERE will not return previously processed rows.
    // OFFSET stays 0 (always grab next 1000 unprocessed); if we used OFFSET += BATCH
    // we'd skip rows that DIDN'T change (category resolved to 'other') on next pass.
    offset = 0;
    batchNum++;

    // Safety break if no rows would have been UPDATEd this batch
    if (result.toUpdate === 0) {
      console.log(`  Batch ${batchNum - 1}: 0 UPDATE generated — remaining 'other' rows are genuine 'other' category. Done.`);
      break;
    }
  }

  console.log(`\nSummary for ${table}:`);
  console.log(`  Total fetched (across batches): ${totalFetched}`);
  console.log(`  Total UPDATE statements generated: ${totalToUpdate}`);
  console.log(`  By inferred category: ${JSON.stringify(combinedByCategory)}`);

  // Write SQL to output file (unless dry-run)
  if (!args.dryRun && totalToUpdate > 0) {
    const outFile = `${args.outDir}/${table}-updates.sql`;
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, allSql.join("\n") + "\n", "utf-8");
    console.log(`  ✅ Wrote ${totalToUpdate} UPDATE statements to ${outFile}`);
    console.log(`  Apply with: npx wrangler d1 execute ${args.database} --remote --file ${outFile}`);
    return { totalFetched, totalToUpdate, combinedByCategory, outFile };
  }

  return { totalFetched, totalToUpdate, combinedByCategory };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Schema 037 backfill — mode: ${args.dryRun ? "DRY-RUN" : "GENERATE-SQL"}`);
  console.log(`  Database: ${args.database}`);
  console.log(`  Output dir: ${args.outDir}`);

  for (const table of TABLES) {
    backfillTable(table, args);
  }

  console.log("\n━━━━ DONE ━━━━");
  if (args.dryRun) {
    console.log("Re-run without --dry-run to generate full SQL files.");
  } else {
    console.log("Apply the generated *.sql files via `wrangler d1 execute ... --file <path>`.");
  }
}

main();
