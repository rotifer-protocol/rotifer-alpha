/**
 * micro-evolve-take-profit.test.ts (2026-05-20)
 *
 * Regression tests for the take-profit single-direction-drift bug fix.
 *
 * Bug history (v1, prior):
 *   - Up-trigger judge `avgTakeReturn > fund.takeProfitPercent * 0.8` was permanently
 *     true whenever any PROFIT_TAKEN trade existed, because PROFIT_TAKEN-state trades
 *     by definition satisfy `pnl/amount ≥ takeProfitPercent` (typically + slippage).
 *   - Result: all 15 production funds drifted from default 0.25 to 0.45-1.16 by
 *     2026-05-20, none ever decreased.  PROFIT_TAKEN became extremely rare
 *     (136 vs 315 STOPPED over 14 days).
 *
 * Fix (v2, this commit):
 *   - Down-trigger: profitTakenRate < 0.10 AND stopLossRate > 0.30
 *   - Up-trigger:   profitTakenRate > 0.20 AND avgTakeReturn > 1.5 × takeProfitPercent
 *   - Deadband (0.10 ≤ profitTakenRate ≤ 0.20): no take-profit adjustment
 */

import test from "node:test";
import assert from "node:assert/strict";
import { analyzeAndAdjust } from "../src/micro-evolve.js";
import type { FundConfig } from "../src/types.js";

function makeFund(overrides: Partial<FundConfig> = {}): FundConfig {
  return {
    id: "test", name: "Test", emoji: "T", motto: "test",
    initialBalance: 10000, monthlyTarget: 0.10,
    drawdownLimit: 0.30, drawdownSoftLimit: 0.15,
    allowedTypes: ["MISPRICING"],
    minEdge: 1.0, minConfidence: 0.2, minVolume: 1000, minLiquidity: 500,
    maxPerEvent: 500, maxOpenPositions: 10,
    stopLossPercent: 0.20, maxHoldDays: 14,
    takeProfitPercent: 0.25,
    trailingStopPercent: 0.10, probReversalThreshold: 0.15,
    sizingMode: "fixed", sizingBase: 100, sizingScale: 0,
    ...overrides,
  };
}

interface TradeStub {
  pnl: number;
  status: string;
  monitor_reason: string | null;
  closed_at: string;
  amount: number;
  entry_price: number;
  direction: string;
}

function makeTrade(status: string, pnlOverAmount: number, amount = 1000): TradeStub {
  return {
    pnl: pnlOverAmount * amount,
    status,
    monitor_reason: null,
    closed_at: "2026-05-20T00:00:00Z",
    amount,
    entry_price: 0.5,
    direction: "BUY",
  };
}

function findTakeProfitAdjustment(adjustments: ReturnType<typeof analyzeAndAdjust>) {
  return adjustments.find((a) => a.param === "takeProfitPercent");
}

// ─── Bug regression: prior single-direction-drift trigger ────────────────────

test("v1 bug regression: 1 PROFIT_TAKEN with pnl/amount = takeProfitPercent should NOT trigger up-adjust", () => {
  // This was the canonical bug input.  In v1, this would push take-profit higher
  // forever; in v2, it must NOT (profitTakenRate is only 1/30 = 3.3%, well below 20%).
  const fund = makeFund({ takeProfitPercent: 0.25 });
  const trades: TradeStub[] = [
    makeTrade("PROFIT_TAKEN", 0.27),
    ...Array.from({ length: 15 }, () => makeTrade("EXPIRED", 0)),
    ...Array.from({ length: 14 }, () => makeTrade("STOPPED", -0.20)),
  ];
  const result = analyzeAndAdjust(trades as any, fund, "small", 0.02);
  const tp = findTakeProfitAdjustment(result);
  // With profitTakenRate=3.3% and stopLossRate=46.7%, this hits the DOWN trigger
  // (< 10% AND > 30%), which is the correct fix behavior.
  assert.ok(tp, "take-profit should be adjusted (down direction)");
  assert.strictEqual(tp!.direction, "down", "must be down, not up (regression)");
});

// ─── New down-trigger ───────────────────────────────────────────────────────

test("down-trigger: profit-taken < 10% AND stop-loss > 30% → DOWN", () => {
  const fund = makeFund({ takeProfitPercent: 0.50 });
  const trades: TradeStub[] = [
    ...Array.from({ length: 1 }, () => makeTrade("PROFIT_TAKEN", 0.55)),
    ...Array.from({ length: 8 }, () => makeTrade("STOPPED", -0.20)),
    ...Array.from({ length: 11 }, () => makeTrade("EXPIRED", 0)),
  ];
  // profitTakenRate = 1/20 = 5%, stopLossRate = 8/20 = 40%
  const result = analyzeAndAdjust(trades as any, fund, "small", 0.02);
  const tp = findTakeProfitAdjustment(result);
  assert.ok(tp, "take-profit must be adjusted");
  assert.strictEqual(tp!.direction, "down");
  assert.ok(tp!.after < tp!.before, "value must decrease");
});

// ─── New up-trigger (tightened threshold) ───────────────────────────────────

test("up-trigger: profit-taken > 20% AND avgTakeReturn > 1.5× threshold → UP", () => {
  const fund = makeFund({ takeProfitPercent: 0.20 });
  const trades: TradeStub[] = [
    // 6 profits with returns ~0.35 (= 1.75× threshold of 0.20)
    ...Array.from({ length: 6 }, () => makeTrade("PROFIT_TAKEN", 0.35)),
    ...Array.from({ length: 14 }, () => makeTrade("EXPIRED", 0)),
  ];
  // profitTakenRate = 6/20 = 30%, avgTakeReturn = 0.35 = 1.75× takeProfitPercent
  const result = analyzeAndAdjust(trades as any, fund, "small", 0.02);
  const tp = findTakeProfitAdjustment(result);
  assert.ok(tp, "take-profit must be adjusted");
  assert.strictEqual(tp!.direction, "up");
  assert.ok(tp!.after > tp!.before, "value must increase");
});

test("up-trigger blocked when avgTakeReturn is only 1.2× threshold (deadband)", () => {
  const fund = makeFund({ takeProfitPercent: 0.20 });
  const trades: TradeStub[] = [
    // 5 profits with returns 0.24 (= 1.2× threshold, just barely over but not > 1.5×)
    ...Array.from({ length: 5 }, () => makeTrade("PROFIT_TAKEN", 0.24)),
    ...Array.from({ length: 15 }, () => makeTrade("EXPIRED", 0)),
  ];
  // profitTakenRate = 5/20 = 25% (passes first guard), but 1.2× < 1.5×
  const result = analyzeAndAdjust(trades as any, fund, "small", 0.02);
  const tp = findTakeProfitAdjustment(result);
  assert.strictEqual(tp, undefined, "must NOT adjust — overshoot insufficient");
});

// ─── Deadband ────────────────────────────────────────────────────────────────

test("deadband: 10% ≤ profit-taken-rate ≤ 20% → no adjustment", () => {
  const fund = makeFund({ takeProfitPercent: 0.30 });
  const trades: TradeStub[] = [
    ...Array.from({ length: 3 }, () => makeTrade("PROFIT_TAKEN", 0.35)),  // 15%
    ...Array.from({ length: 5 }, () => makeTrade("STOPPED", -0.20)),       // 25%
    ...Array.from({ length: 12 }, () => makeTrade("EXPIRED", 0)),          // 60%
  ];
  // profitTakenRate = 15% (deadband), stopLossRate = 25% (below 30%)
  const result = analyzeAndAdjust(trades as any, fund, "small", 0.02);
  const tp = findTakeProfitAdjustment(result);
  assert.strictEqual(tp, undefined, "deadband: must NOT adjust");
});

// ─── Edge case: zero profit-taken trades ─────────────────────────────────────

test("zero PROFIT_TAKEN, high stop-loss → still triggers DOWN (rate is 0% < 10%)", () => {
  const fund = makeFund({ takeProfitPercent: 0.40 });
  const trades: TradeStub[] = [
    ...Array.from({ length: 8 }, () => makeTrade("STOPPED", -0.20)),
    ...Array.from({ length: 12 }, () => makeTrade("EXPIRED", 0)),
  ];
  // profitTakenRate = 0% < 10%, stopLossRate = 40% > 30%
  const result = analyzeAndAdjust(trades as any, fund, "small", 0.02);
  const tp = findTakeProfitAdjustment(result);
  assert.ok(tp, "take-profit should be adjusted");
  assert.strictEqual(tp!.direction, "down");
});

test("zero PROFIT_TAKEN, low stop-loss → no adjustment", () => {
  const fund = makeFund({ takeProfitPercent: 0.30 });
  const trades: TradeStub[] = [
    ...Array.from({ length: 4 }, () => makeTrade("STOPPED", -0.20)),  // 20%, < 30%
    ...Array.from({ length: 16 }, () => makeTrade("EXPIRED", 0)),
  ];
  const result = analyzeAndAdjust(trades as any, fund, "small", 0.02);
  const tp = findTakeProfitAdjustment(result);
  assert.strictEqual(tp, undefined, "no take-profit adjustment expected");
});
