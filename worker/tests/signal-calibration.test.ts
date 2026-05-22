/**
 * signal-calibration.test.ts (2026-05-21)
 *
 * P9-C transitional calibration gate: 1.5× premium + absolute floors for
 * categories outside CALIBRATION_TRUSTED (sports, politics). Bridge until
 * v1.1 §5 Bayesian Platt scaling lands.
 *
 * Evidence motivating these tests (5/14-5/21 paper_trades scan):
 *   - crypto: 15 trades / 100% stop / -$4,777 (Layer 1 introduced 5/20)
 *   - ai:     33 trades / 18.2% stop / net -$3,508
 *   - sports: net positive across all 3 audit windows
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  categoryCalibrationGate,
  CALIBRATION_TRUSTED,
  UNTRUSTED_CATEGORY_MULTIPLIER,
  UNTRUSTED_MIN_EDGE_FLOOR,
  UNTRUSTED_MIN_CONFIDENCE_FLOOR,
} from "../src/signal-calibration.js";
import type { ArbSignal, FundConfig, SignalCategory } from "../src/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSig(overrides: Partial<ArbSignal> & { category: SignalCategory; edge: number; confidence: number }): ArbSignal {
  return {
    signalId: "SIG-test",
    type: "MISPRICING",
    marketId: "m1",
    slug: "test-slug",
    question: "Test market",
    description: "",
    edge: overrides.edge,
    confidence: overrides.confidence,
    direction: "BUY_BOTH",
    prices: {},
    category: overrides.category,
    timestamp: "2026-05-21T00:00:00Z",
    ...overrides,
  } as ArbSignal;
}

function makeFund(overrides: { id?: string; minEdge: number; minConfidence: number }): FundConfig {
  return {
    id: overrides.id ?? "test_fund",
    name: "Test",
    emoji: "🧪",
    motto: "",
    initialBalance: 10_000,
    monthlyTarget: 0.05,
    drawdownLimit: 0.20,
    drawdownSoftLimit: 0.10,
    allowedTypes: ["MISPRICING"],
    minEdge: overrides.minEdge,
    minConfidence: overrides.minConfidence,
    minVolume: 0,
    minLiquidity: 0,
    maxPerEvent: 1000,
    maxOpenPositions: 5,
    stopLossPercent: 0.10,
    maxHoldDays: 7,
    takeProfitPercent: 0.20,
    trailingStopPercent: 0.10,
    probReversalThreshold: 0.20,
    sizingMode: "fixed",
    sizingBase: 100,
    sizingScale: 0,
  } as FundConfig;
}

// ─── Trusted categories: always pass ─────────────────────────────────────────

test("sports category passes regardless of edge/confidence", () => {
  const fund = makeFund({ minEdge: 1.0, minConfidence: 0.5 });
  // Even sub-fund-DNA edge/conf — trusted gate just defers to upstream DNA checks
  const sig = makeSig({ category: "sports", edge: 0.0001, confidence: 0.0001 });
  assert.equal(categoryCalibrationGate(sig, fund).pass, true);
});

test("politics category passes regardless of edge/confidence", () => {
  const fund = makeFund({ minEdge: 1.0, minConfidence: 0.5 });
  const sig = makeSig({ category: "politics", edge: 0.0001, confidence: 0.0001 });
  assert.equal(categoryCalibrationGate(sig, fund).pass, true);
});

// ─── Untrusted: blocked when edge too low ────────────────────────────────────

test("crypto category blocked when edge below 1.5× fund.minEdge", () => {
  const fund = makeFund({ minEdge: 1.0, minConfidence: 0.2 });
  // 1.5× minEdge = 1.5, signal edge 1.4 < 1.5
  const sig = makeSig({ category: "crypto", edge: 1.4, confidence: 0.5 });
  const result = categoryCalibrationGate(sig, fund);
  assert.equal(result.pass, false);
  assert.equal(result.code, "UNCALIBRATED_EDGE_TOO_LOW");
});

test("ai category blocked when edge below floor (defends minEdge=0 funds)", () => {
  // octopus / honey_badger have minEdge=0. 1.5 × 0 = 0 would gate nothing,
  // so UNTRUSTED_MIN_EDGE_FLOOR (1.0) kicks in.
  const octopus = makeFund({ id: "octopus", minEdge: 0, minConfidence: 0 });
  const sig = makeSig({ category: "ai", edge: 0.5, confidence: 0.5 });
  const result = categoryCalibrationGate(sig, octopus);
  assert.equal(result.pass, false);
  assert.equal(result.code, "UNCALIBRATED_EDGE_TOO_LOW");
});

// ─── Untrusted: blocked when confidence too low ──────────────────────────────

test("crypto category blocked when confidence below 1.5× fund.minConfidence", () => {
  const cheetah = makeFund({ id: "cheetah", minEdge: 1.0, minConfidence: 0.2 });
  // edge passes (1.5 = 1.0×1.5), but conf 0.25 < 0.3 (1.5×0.2 = 0.3, also = floor)
  const sig = makeSig({ category: "crypto", edge: 1.5, confidence: 0.25 });
  const result = categoryCalibrationGate(sig, cheetah);
  assert.equal(result.pass, false);
  assert.equal(result.code, "UNCALIBRATED_CONFIDENCE_TOO_LOW");
});

test("crypto category blocked by confidence floor for minConfidence=0 funds", () => {
  // 1.5 × 0 = 0; UNTRUSTED_MIN_CONFIDENCE_FLOOR (0.3) takes over
  const honeyBadger = makeFund({ id: "honey_badger", minEdge: 0, minConfidence: 0 });
  const sig = makeSig({ category: "crypto", edge: 2.0, confidence: 0.2 });
  const result = categoryCalibrationGate(sig, honeyBadger);
  assert.equal(result.pass, false);
  assert.equal(result.code, "UNCALIBRATED_CONFIDENCE_TOO_LOW");
});

// ─── Untrusted: passes when both thresholds met ──────────────────────────────

test("crypto category passes at exactly the cheetah×1.5 boundary", () => {
  const cheetah = makeFund({ id: "cheetah", minEdge: 1.0, minConfidence: 0.2 });
  // edge = 1.5 (= 1.0×1.5), conf = 0.3 (= 0.2×1.5, also = floor)
  const sig = makeSig({ category: "crypto", edge: 1.5, confidence: 0.3 });
  assert.equal(categoryCalibrationGate(sig, cheetah).pass, true);
});

test("ai category passes at exactly the floors for minEdge=0/minConf=0 funds", () => {
  const honeyBadger = makeFund({ id: "honey_badger", minEdge: 0, minConfidence: 0 });
  const sig = makeSig({ category: "ai", edge: UNTRUSTED_MIN_EDGE_FLOOR, confidence: UNTRUSTED_MIN_CONFIDENCE_FLOOR });
  assert.equal(categoryCalibrationGate(sig, honeyBadger).pass, true);
});

// ─── Untrusted: turtle (strict DNA) completely blocks crypto ─────────────────

test("turtle DNA effectively blocks ALL crypto (1.5× minConf > 1.0)", () => {
  // turtle minConfidence = 0.7 → 1.5 × 0.7 = 1.05, but confidence is capped at 1.0
  // So no crypto/ai/other signal can ever meet the bar.
  const turtle = makeFund({ id: "turtle", minEdge: 0.8, minConfidence: 0.7 });
  // Try the max possible signal: edge 100%, confidence 1.0
  const sig = makeSig({ category: "crypto", edge: 100, confidence: 1.0 });
  const result = categoryCalibrationGate(sig, turtle);
  assert.equal(result.pass, false);
  assert.equal(result.code, "UNCALIBRATED_CONFIDENCE_TOO_LOW");
});

// ─── 'other' category treated as untrusted ───────────────────────────────────

test("'other' category gets the same untrusted treatment as crypto/ai", () => {
  const fund = makeFund({ minEdge: 0, minConfidence: 0 });
  // Below the floor
  const lowSig = makeSig({ category: "other", edge: 0.5, confidence: 0.5 });
  assert.equal(categoryCalibrationGate(lowSig, fund).pass, false);
  // At the floor
  const okSig = makeSig({ category: "other", edge: 1.0, confidence: 0.3 });
  assert.equal(categoryCalibrationGate(okSig, fund).pass, true);
});

// ─── Sanity: trusted set is exactly sports+politics ──────────────────────────

test("CALIBRATION_TRUSTED contains exactly sports + politics", () => {
  assert.equal(CALIBRATION_TRUSTED.size, 2);
  assert.ok(CALIBRATION_TRUSTED.has("sports"));
  assert.ok(CALIBRATION_TRUSTED.has("politics"));
  assert.ok(!CALIBRATION_TRUSTED.has("crypto"));
  assert.ok(!CALIBRATION_TRUSTED.has("ai"));
  assert.ok(!CALIBRATION_TRUSTED.has("other"));
});

test("multiplier and floors match documented values", () => {
  // Pinning the magic numbers; v1.1 §5 Platt scaling replaces these.
  assert.equal(UNTRUSTED_CATEGORY_MULTIPLIER, 1.5);
  assert.equal(UNTRUSTED_MIN_EDGE_FLOOR, 1.0);
  assert.equal(UNTRUSTED_MIN_CONFIDENCE_FLOOR, 0.3);
});

// ─── Regression: 5/20-5/21 crypto incident profile ───────────────────────────

test("regression: 5/20-5/21 crypto signal profile (high edge but low conf) blocked for low-DNA funds", () => {
  // Simulated profile of a crypto signal that slipped through pre-fix:
  // edge looked good (volume24hr-driven Market Impact Gate happy) but
  // confidence was modest. honey_badger DNA (minConf=0) wouldn't block it.
  const honeyBadger = makeFund({ id: "honey_badger", minEdge: 0, minConfidence: 0 });
  const sig = makeSig({ category: "crypto", edge: 3.5, confidence: 0.25 });
  const result = categoryCalibrationGate(sig, honeyBadger);
  assert.equal(result.pass, false, "post-fix: this crypto signal must be blocked");
  assert.equal(result.code, "UNCALIBRATED_CONFIDENCE_TOO_LOW");
});
