/**
 * risk-effective-sizing.test.ts (2026-05-22)
 *
 * v1.0.5 §1 P8-B dual-semantic drawdown protection regression tests for
 * effectiveSizing(). Validates both new dual-DD semantics and the legacy
 * fallback path (pre-schema-035 funds without peakDrawdown* / lossVsInitial*).
 *
 * Background (P8-B, ALPHA-003 D2 + ALPHA-PRD-003 C-HARDEN1.1):
 *
 *   - P8 方案 A (2026-05-21) shifted accounting.calculateDrawdownPct's
 *     reference from initialBalance → peak equity, restoring sizing
 *     protection for already-profitable funds.
 *
 *   - But it silently destroyed the "absolute loss vs initial capital"
 *     semantic. A fund that **never climbed** + bleeds below initialBalance
 *     would have peakDD≈0 → no protection from peakDrawdown alone.
 *
 *   - v1.0.5 §1 P8-B introduces dual semantics:
 *       peakDD       (业界标准 drawdown, 常态保护)
 *       lossVsInit   (vs initial capital, 绝对兜底)
 *     Either DD reaching its limit triggers protection — the more
 *     restrictive guardrail wins.
 *
 * Test coverage:
 *   1. New dual-DD path (peak* + lossVsInitial* fields populated)
 *   2. Legacy fallback path (only drawdown* fields, pre-schema-035 funds)
 *   3. Edge cases: both at limit / one at limit / neither / new high
 */

import test from "node:test";
import assert from "node:assert/strict";
import { effectiveSizing } from "../src/risk.js";
import type { FundConfig } from "../src/types.js";

function makeFund(overrides: Partial<FundConfig> = {}): FundConfig {
  // Mirror cheetah_m defaults — middle-of-the-road archetype.
  return {
    id: "test_fund",
    name: "Test Fund",
    emoji: "🧪",
    motto: "",
    initialBalance: 100_000,
    monthlyTarget: 0.08,
    drawdownLimit: 0.20,
    drawdownSoftLimit: 0.10,
    // v1.0.5 §1 P8-B dual-semantic fields (defaults from schema 035 backfill
    // for cheetah family: peakDD same as legacy, lossVsInit slightly wider).
    peakDrawdownLimit:        0.20,
    peakDrawdownSoftLimit:    0.10,
    lossVsInitialLimit:       0.25,
    lossVsInitialSoftLimit:   0.15,
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

// ── Dual-DD happy path ──────────────────────────────────────────────────────

test("returns rawSize when both DDs below soft limits", () => {
  const fund = makeFund();
  // peakDD 5% < 10% softLimit, lossInit 8% < 15% softLimit
  const size = effectiveSizing(1000, 0.05, 0.08, fund);
  assert.equal(size, 1000);
});

test("halves sizing when peakDD crosses soft limit", () => {
  const fund = makeFund();
  // peakDD 12% > 10% softLimit, lossInit 5% < 15% softLimit
  const size = effectiveSizing(1000, 0.12, 0.05, fund);
  assert.equal(size, 500);
});

test("halves sizing when lossVsInitialDD crosses soft limit", () => {
  const fund = makeFund();
  // peakDD 5% < 10% softLimit, lossInit 18% > 15% softLimit
  const size = effectiveSizing(1000, 0.05, 0.18, fund);
  assert.equal(size, 500);
});

test("hard stops when peakDD crosses hard limit", () => {
  const fund = makeFund();
  // peakDD 22% > 20% hardLimit → 0 regardless of lossInit
  const size = effectiveSizing(1000, 0.22, 0.10, fund);
  assert.equal(size, 0);
});

test("hard stops when lossVsInitialDD crosses hard limit", () => {
  const fund = makeFund();
  // peakDD 5% < softLimit, lossInit 26% > 25% hardLimit → 0
  const size = effectiveSizing(1000, 0.05, 0.26, fund);
  assert.equal(size, 0);
});

test("more restrictive DD wins — hard stop trumps soft halve", () => {
  const fund = makeFund();
  // peakDD 12% > 10% softLimit (→ halve)
  // lossInit 26% > 25% hardLimit (→ 0)
  // hard stop wins
  const size = effectiveSizing(1000, 0.12, 0.26, fund);
  assert.equal(size, 0);
});

// ── New-high / zero DD ─────────────────────────────────────────────────────

test("new high — both DDs at 0 returns full rawSize", () => {
  const fund = makeFund();
  const size = effectiveSizing(1000, 0, 0, fund);
  assert.equal(size, 1000);
});

test("both DDs exactly at soft limit triggers halve (≥ boundary)", () => {
  const fund = makeFund();
  // 10% == softLimit (peakDrawdownSoftLimit), 15% == softLimit (lossVsInitialSoftLimit)
  const size = effectiveSizing(1000, 0.10, 0.15, fund);
  assert.equal(size, 500);
});

test("both DDs exactly at hard limit triggers hard stop (≥ boundary)", () => {
  const fund = makeFund();
  const size = effectiveSizing(1000, 0.20, 0.25, fund);
  assert.equal(size, 0);
});

// ── Legacy fallback path (pre-schema-035 funds) ────────────────────────────

test("legacy fund without peakDrawdown* / lossVsInitial* falls back to drawdown*", () => {
  // Simulate a pre-schema-035 fund: only legacy drawdown_* fields present.
  const legacyFund = makeFund({
    peakDrawdownLimit:      undefined,
    peakDrawdownSoftLimit:  undefined,
    lossVsInitialLimit:     undefined,
    lossVsInitialSoftLimit: undefined,
  });
  // Both DDs > drawdownSoftLimit (10%) → halve
  const size = effectiveSizing(1000, 0.12, 0.12, legacyFund);
  assert.equal(size, 500);
});

test("legacy fund hard stop uses drawdownLimit fallback", () => {
  const legacyFund = makeFund({
    peakDrawdownLimit:      undefined,
    peakDrawdownSoftLimit:  undefined,
    lossVsInitialLimit:     undefined,
    lossVsInitialSoftLimit: undefined,
  });
  // peakDD 22% > drawdownLimit (20%) → 0
  const size = effectiveSizing(1000, 0.22, 0.05, legacyFund);
  assert.equal(size, 0);
});

test("partial fallback — some new fields present, others fall back", () => {
  // E.g. fund got peak* during partial migration but lossVsInit* still missing.
  const partialFund = makeFund({
    peakDrawdownLimit:      0.25,    // narrower than legacy (25% not 20%)
    peakDrawdownSoftLimit:  0.12,
    lossVsInitialLimit:     undefined, // fallback → 0.20
    lossVsInitialSoftLimit: undefined, // fallback → 0.10
  });
  // peakDD 13% > 12% peakSoft → halve
  // lossInit 8% < 10% legacy fallback → ok
  const size = effectiveSizing(1000, 0.13, 0.08, partialFund);
  assert.equal(size, 500);
});

// ── lossVsInitial caught the gap peakDD missed (P8-B raison d'etre) ────────

test("never-climbed fund: peakDD~0 but lossVsInit triggers protection", () => {
  // Scenario: fund deployed at $100k, immediately drifted down to $85k
  // without ever climbing. peak_equity ≈ initialBalance → peakDD ≈ 0.
  // Pre-P8-B: no protection. Post-P8-B: lossVsInit catches it.
  const fund = makeFund();
  // peakDD ~0 (fund never climbed) + lossInit 15% (at soft limit) → halve
  const size = effectiveSizing(1000, 0.001, 0.15, fund);
  assert.equal(size, 500);
});

test("never-climbed fund: lossVsInit at hard limit → hard stop", () => {
  const fund = makeFund();
  // peakDD ~0 + lossInit 25% (at hard limit) → 0
  const size = effectiveSizing(1000, 0.001, 0.25, fund);
  assert.equal(size, 0);
});
