/**
 * micro-evolve-prob-reversal.test.ts (2026-05-23)
 *
 * v1.0.5 §2 follow-up fix: probReversalThreshold asymmetry bug.
 *
 * Original code had both branches pushing "down" — branch1 (reversedRate >
 * 25% → down) was backwards. monitor.ts:169 fires REVERSED when reversal >=
 * threshold; so:
 *   higher threshold = stricter = fewer REVERSED firings
 *   lower threshold = looser = more REVERSED firings
 *
 * branch1 fix: reversedRate > 25% → up (tighten, fewer REVERSED)
 * branch2 kept: reversedCount == 0 + stop_loss_rate > 30% → down (loosen, more
 *               REVERSED as early-exit)
 *
 * This file covers both branches + deadband + branch1 direction regression.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { analyzeAndAdjust } from "../src/micro-evolve.js";
import type { FundConfig } from "../src/types.js";

function makeFund(overrides: Partial<FundConfig> = {}): FundConfig {
  return {
    id: "test",
    name: "Test",
    emoji: "🧪",
    motto: "",
    initialBalance: 100_000,
    monthlyTarget: 0.08,
    drawdownLimit: 0.20,
    drawdownSoftLimit: 0.10,
    allowedTypes: ["MISPRICING"],
    minEdge: 1,
    minConfidence: 0.2,
    minVolume: 20_000,
    minLiquidity: 15_000,
    maxPerEvent: 8_000,
    maxOpenPositions: 10,
    stopLossPercent: 0.15,
    maxHoldDays: 14,
    takeProfitPercent: 0.30,
    trailingStopPercent: 0.12,
    probReversalThreshold: 0.20,
    sizingMode: "confidence",
    sizingBase: 1_000,
    sizingScale: 3_000,
    ...overrides,
  };
}

type ClosedTrade = { status: string; pnl: number; amount: number; entryPrice?: number; direction?: string };

function makeTrades(opts: { stopped?: number; reversed?: number; profitTaken?: number; trailing?: number; expired?: number }): ClosedTrade[] {
  const trades: ClosedTrade[] = [];
  const push = (status: string, pnl: number) => trades.push({ status, pnl, amount: 1000, entryPrice: 0.5, direction: "BUY_YES" });
  for (let i = 0; i < (opts.stopped ?? 0); i++) push("STOPPED", -100);
  for (let i = 0; i < (opts.reversed ?? 0); i++) push("REVERSED", -50);
  for (let i = 0; i < (opts.profitTaken ?? 0); i++) push("PROFIT_TAKEN", 600);
  for (let i = 0; i < (opts.trailing ?? 0); i++) push("TRAILING_STOPPED", 200);
  for (let i = 0; i < (opts.expired ?? 0); i++) push("EXPIRED", 50);
  return trades;
}

// ── branch1: reversal too frequent → tighten (up) ──────────────────────────

test("branch1: reversedRate > 25% triggers UP (tighten threshold)", () => {
  // 4 REVERSED / 10 total = 40% > 25% threshold → up
  const fund = makeFund();
  const trades = makeTrades({ reversed: 4, profitTaken: 3, stopped: 3 });
  const adjustments = analyzeAndAdjust(trades, fund, "small", 0.02);
  const prAdj = adjustments.find(a => a.param === "probReversalThreshold");
  assert.ok(prAdj, "probReversalThreshold adjustment should be present");
  assert.equal(prAdj!.direction, "up", "branch1 must push UP (was 'down' bug before 2026-05-23 fix)");
});

test("branch1 regression: high reversal rate must NOT push DOWN", () => {
  // This is the explicit regression guard for the 2026-05-23 fix.
  // Pre-fix: 40% reversed → down (wrong direction, makes reversals fire even more often).
  // Post-fix: 40% reversed → up.
  const fund = makeFund();
  const trades = makeTrades({ reversed: 5, profitTaken: 2, stopped: 3 });
  const adjustments = analyzeAndAdjust(trades, fund, "small", 0.02);
  const downAdj = adjustments.find(a => a.param === "probReversalThreshold" && a.direction === "down");
  assert.equal(downAdj, undefined, "REGRESSION: branch1 should not push down when reversedRate > 25%");
});

// ── branch2: no reversal + many stops → loosen (down) ─────────────────────

test("branch2: 0 reversed + stopLossRate > 30% triggers DOWN (loosen threshold)", () => {
  // 0 REVERSED + 4 STOPPED / 10 = 40% > 30% → down
  const fund = makeFund();
  const trades = makeTrades({ reversed: 0, stopped: 4, profitTaken: 6 });
  const adjustments = analyzeAndAdjust(trades, fund, "small", 0.02);
  const prAdj = adjustments.find(a => a.param === "probReversalThreshold");
  assert.ok(prAdj, "probReversalThreshold adjustment should be present");
  assert.equal(prAdj!.direction, "down", "branch2 must push DOWN");
});

// ── Deadband (no adjustment) ───────────────────────────────────────────────

test("deadband: 0 < reversedRate <= 25% AND no branch2 trigger → no adjustment", () => {
  // 2 reversed / 10 = 20% (not > 25%) + 2 stop_loss = 20% (not > 30%) → no adjustment
  const fund = makeFund();
  const trades = makeTrades({ reversed: 2, stopped: 2, profitTaken: 6 });
  const adjustments = analyzeAndAdjust(trades, fund, "small", 0.02);
  const prAdj = adjustments.find(a => a.param === "probReversalThreshold");
  assert.equal(prAdj, undefined, "deadband should produce no probReversalThreshold adjustment");
});

test("deadband: 0 reversed + stopLossRate <= 30% → no adjustment", () => {
  // 0 reversed + 2 stop / 10 = 20% (not > 30%) → no adjustment
  const fund = makeFund();
  const trades = makeTrades({ reversed: 0, stopped: 2, profitTaken: 8 });
  const adjustments = analyzeAndAdjust(trades, fund, "small", 0.02);
  const prAdj = adjustments.find(a => a.param === "probReversalThreshold");
  assert.equal(prAdj, undefined, "0 reversed + low stop rate should produce no adjustment");
});

// ── Boundary cases ─────────────────────────────────────────────────────────

test("boundary: reversedRate exactly 25% does NOT trigger up (strict > comparison)", () => {
  // Exactly 25% — branch1 uses `>` not `>=`, so this should NOT trigger
  const fund = makeFund();
  const trades = makeTrades({ reversed: 3, stopped: 3, profitTaken: 6 });  // 3/12 = 25%
  const adjustments = analyzeAndAdjust(trades, fund, "small", 0.02);
  const prAdj = adjustments.find(a => a.param === "probReversalThreshold");
  // 3/12 = 25% exactly. Using > 0.25 comparison: 0.25 > 0.25 is false → no up trigger.
  // branch2: reversedCount != 0 → no down trigger either.
  assert.equal(prAdj, undefined, "exactly 25% reversal rate must not trigger (strict > comparison)");
});

test("branch1 fires regardless of stop_loss rate", () => {
  // High reversal + high stop_loss — branch1 must fire (up) before branch2 considered
  const fund = makeFund();
  const trades = makeTrades({ reversed: 4, stopped: 5, profitTaken: 1 });
  const adjustments = analyzeAndAdjust(trades, fund, "small", 0.02);
  const prAdj = adjustments.find(a => a.param === "probReversalThreshold");
  assert.equal(prAdj!.direction, "up", "branch1 takes precedence over branch2 via if/else if");
});
