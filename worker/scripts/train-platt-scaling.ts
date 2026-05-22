#!/usr/bin/env -S node --import tsx
/**
 * train-platt-scaling.ts (v1.0.5 §4.1 skeleton, 2026-05-22)
 *
 * Trains per-category Platt scaling coefficients (a, b) for ArbSignal raw
 * probability calibration. Output goes to worker/data/platt-models.json which
 * the worker reads at cold start.
 *
 * ── Status: SKELETON ──────────────────────────────────────────────────────
 *
 * This file is the v1.0.5 §4.1 entry point but is **not yet wired to produce
 * usable models** — that requires P-HARDEN1.2 (5 categories × ≥100 settled
 * paper_trades). Estimated data-ready date: 2026-06-12 to 2026-06-25 (per
 * v1.0.5 plan §6 W3-W5).
 *
 * Until then, calibrateProbability() defaults to IDENTITY_PLATT_MODEL
 * (a=1, b=0 per category) so calibratedProb == rawProb. Running this script
 * before data is ready writes an identity model with a console warning.
 *
 * ── Algorithm (when ready) ────────────────────────────────────────────────
 *
 * For each SignalCategory:
 *   1. Collect (rawProb, actual_outcome) pairs from paper_trades + live_orders
 *      where status ∈ {RESOLVED, STOPPED, PROFIT_TAKEN, TRAILING_STOPPED, EXPIRED}
 *      and the signal's raw probability is recorded (signal_log table or
 *      derived from entry_price + edge).
 *   2. actual_outcome is binary: 1 if the trade settled with positive PnL,
 *      0 otherwise.
 *   3. Fit logistic regression min over (a, b) of negative log-likelihood:
 *        L(a, b) = -Σ [outcome × log(σ(a×rawProb + b)) +
 *                      (1-outcome) × log(1 - σ(a×rawProb + b))]
 *      Use simple gradient descent (no Bayesian — Platt is point estimate).
 *   4. Sanity check: |a| < 10, |b| < 5 — outside this range usually indicates
 *      training data corruption.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *
 *   # Skeleton mode (writes identity model with warning):
 *   tsx worker/scripts/train-platt-scaling.ts --dry-run
 *
 *   # Full training (requires data, not yet implemented):
 *   tsx worker/scripts/train-platt-scaling.ts \
 *     --db worker/data/training.sqlite \
 *     --out worker/data/platt-models.json
 *
 * ── Refs ──────────────────────────────────────────────────────────────────
 *   internal ALPHA-PRD-003 C-HARDEN1.4
 *   v1.0.5 plan §4.1
 *   signal-calibration.ts {calibrateProbability, IDENTITY_PLATT_MODEL}
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { IDENTITY_PLATT_MODEL, type PlattModelStore } from "../src/signal-calibration.js";

const OUTPUT_PATH_DEFAULT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "data",
  "platt-models.json",
);

interface CliArgs {
  dryRun: boolean;
  outPath: string;
  dbPath?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, outPath: OUTPUT_PATH_DEFAULT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--out") args.outPath = argv[++i] ?? OUTPUT_PATH_DEFAULT;
    else if (argv[i] === "--db")  args.dbPath  = argv[++i];
  }
  return args;
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeModel(outPath: string, model: PlattModelStore): void {
  ensureDir(outPath);
  fs.writeFileSync(outPath, JSON.stringify(model, null, 2) + "\n", "utf8");
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun || !args.dbPath) {
    console.warn(
      "[train-platt-scaling] DRY-RUN / no --db arg: writing IDENTITY model.\n" +
      "  This is the v1.0.5 §4.1 skeleton output and is expected behavior\n" +
      "  until P-HARDEN1.2 (5 categories × ≥100 settled trades) is satisfied.\n" +
      "  See worker/scripts/train-platt-scaling.ts header for details.",
    );
    const stamped: PlattModelStore = Object.fromEntries(
      Object.entries(IDENTITY_PLATT_MODEL).map(([cat, params]) => [
        cat,
        { ...params, trainedAt: new Date().toISOString(), trainedSampleCount: 0 },
      ]),
    ) as PlattModelStore;
    writeModel(args.outPath, stamped);
    console.log(`[train-platt-scaling] Wrote IDENTITY model to ${args.outPath}`);
    return;
  }

  // Full training path — TODO (v1.0.5 §4.1 implementation, gated by P-HARDEN1.2)
  console.error(
    "[train-platt-scaling] Full training NOT IMPLEMENTED yet.\n" +
    "  Use --dry-run for the identity skeleton.\n" +
    "  Training implementation lands when P-HARDEN1.2 data is ready.",
  );
  process.exit(2);
}

main();
