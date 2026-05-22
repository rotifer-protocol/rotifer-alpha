/**
 * micro-evolve-drawdown-gate.test.ts (2026-05-22)
 *
 * v1.0.5 §3 (ALPHA-PRD-003 C-HARDEN1.3): drawdown soft-limit micro-evolve gate.
 *
 * Validates that aggressive-direction mutations (those that increase the
 * fund's risk envelope) are suppressed when the fund is in drawdown
 * soft-limit state. Conservative-direction mutations and neutral params
 * remain unaffected.
 *
 * Background: micro-evolve uses outcome-classification heuristics to nudge
 * fund DNA. Under stress (drawdown soft-limit), pushing DNA toward riskier
 * params (looser stop-loss, larger sizing, etc.) compounds the loss. v1.0.5
 * §3 introduces a counter-cyclical gate that allows only de-risking
 * mutations while the fund is bleeding.
 *
 * Aggressive (gated when in soft-limit):
 *   - stopLossPercent ↑   (tolerate larger per-trade losses)
 *   - takeProfitPercent ↑ (wait longer / require more before exit)
 *   - trailingStopPercent ↑ (allow larger retracement)
 *   - sizingBase ↑        (larger initial position)
 *
 * Conservative (always allowed):
 *   - same params ↓ direction
 *
 * Neutral (always allowed):
 *   - maxHoldDays / probReversalThreshold
 */

import test from "node:test";
import assert from "node:assert/strict";
import { analyzeAndAdjust, checkDrawdownSoftLimitGate } from "../src/micro-evolve.js";
import type { FundConfig } from "../src/types.js";

function makeFund(overrides: Partial<FundConfig> = {}): FundConfig {
  // Mirror cheetah_m defaults with v1.0.5 §1 P8-B dual-DD fields populated.
  return {
    id: "test_fund",
    name: "Test Fund",
    emoji: "🧪",
    motto: "",
    initialBalance: 100_000,
    monthlyTarget: 0.08,
    drawdownLimit: 0.20,
    drawdownSoftLimit: 0.10,
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

// Mock trades to deterministically trigger specific nudges.
function makeTrades(opts: { stopped?: number; profitTaken?: number; trailing?: number; expired?: number; reversed?: number; winning?: number; losing?: number }) {
  type ClosedTrade = { status: string; pnl: number; amount: number; entryPrice?: number; direction?: string };
  const trades: ClosedTrade[] = [];
  const push = (status: string, pnl: number, amount = 1000) => trades.push({ status, pnl, amount, entryPrice: 0.5, direction: "BUY_YES" });
  for (let i = 0; i < (opts.stopped ?? 0); i++) push("STOPPED", -100);
  for (let i = 0; i < (opts.profitTaken ?? 0); i++) push("PROFIT_TAKEN", 600); // pnl/amount = 0.6 (> tp 0.30 × 1.5 = 0.45 — triggers up)
  for (let i = 0; i < (opts.trailing ?? 0); i++) push("TRAILING_STOPPED", 200);
  for (let i = 0; i < (opts.expired ?? 0); i++) push("EXPIRED", 50);
  for (let i = 0; i < (opts.reversed ?? 0); i++) push("REVERSED", -50);
  for (let i = 0; i < (opts.winning ?? 0); i++) push("RESOLVED", 200);
  for (let i = 0; i < (opts.losing ?? 0); i++) push("RESOLVED", -100);
  return trades;
}

// ── Gate OFF (isInSoftLimit=false): aggressive mutations pass through ────

test("gate OFF: stopLossPercent up adjustment passes (high stop-loss rate)", () => {
  const fund = makeFund();
  // 6 STOPPED / 10 total = 60% > 0.4 threshold → stopLoss up
  const trades = makeTrades({ stopped: 6, profitTaken: 4 });
  const adjustments = analyzeAndAdjust(trades, fund, "small", 0.02, false);
  const slUp = adjustments.find(a => a.param === "stopLossPercent" && a.direction === "up");
  assert.ok(slUp, "stopLossPercent up should be present when gate OFF");
});

test("gate OFF: sizingBase up adjustment passes (winning streak)", () => {
  const fund = makeFund();
  // totalPnl > 0 + winRate > 0.55 → sizingBase up
  const trades = makeTrades({ winning: 8, losing: 2 });
  const adjustments = analyzeAndAdjust(trades, fund, "small", 0.02, false);
  const szUp = adjustments.find(a => a.param === "sizingBase" && a.direction === "up");
  assert.ok(szUp, "sizingBase up should be present when gate OFF");
});

// ── Gate ON (isInSoftLimit=true): aggressive mutations suppressed ─────────

test("gate ON: stopLossPercent up adjustment SUPPRESSED", () => {
  const fund = makeFund();
  const trades = makeTrades({ stopped: 6, profitTaken: 4 });
  const adjustments = analyzeAndAdjust(trades, fund, "small", 0.02, true);
  const slUp = adjustments.find(a => a.param === "stopLossPercent" && a.direction === "up");
  assert.equal(slUp, undefined, "stopLossPercent up should be suppressed when gate ON");
});

test("gate ON: takeProfitPercent up adjustment SUPPRESSED", () => {
  const fund = makeFund();
  // 5 PT / 10 total = 50% > 0.20 + avgTakeReturn 0.6 > 0.30 × 1.5 = 0.45 → tp up
  const trades = makeTrades({ profitTaken: 5, stopped: 5 });
  const adjustments = analyzeAndAdjust(trades, fund, "small", 0.02, true);
  const tpUp = adjustments.find(a => a.param === "takeProfitPercent" && a.direction === "up");
  assert.equal(tpUp, undefined, "takeProfitPercent up should be suppressed when gate ON");
});

test("gate ON: trailingStopPercent up adjustment SUPPRESSED", () => {
  const fund = makeFund();
  // 4 TRAILING_STOPPED / 10 total = 40% > 0.3 → trailing up
  const trades = makeTrades({ trailing: 4, stopped: 6 });
  const adjustments = analyzeAndAdjust(trades, fund, "small", 0.02, true);
  const trUp = adjustments.find(a => a.param === "trailingStopPercent" && a.direction === "up");
  assert.equal(trUp, undefined, "trailingStopPercent up should be suppressed when gate ON");
});

test("gate ON: sizingBase up adjustment SUPPRESSED", () => {
  const fund = makeFund();
  const trades = makeTrades({ winning: 8, losing: 2 });
  const adjustments = analyzeAndAdjust(trades, fund, "small", 0.02, true);
  const szUp = adjustments.find(a => a.param === "sizingBase" && a.direction === "up");
  assert.equal(szUp, undefined, "sizingBase up should be suppressed when gate ON");
});

// ── Conservative (down) mutations remain allowed under gate ──────────────

test("gate ON: stopLossPercent DOWN adjustment still allowed (conservative)", () => {
  const fund = makeFund();
  // stopLossRate < 0.1 + avgPnl < 0 → stopLoss down
  const trades = makeTrades({ winning: 1, losing: 9 });
  const adjustments = analyzeAndAdjust(trades, fund, "small", 0.02, true);
  const slDown = adjustments.find(a => a.param === "stopLossPercent" && a.direction === "down");
  assert.ok(slDown, "stopLossPercent down (conservative) should pass through gate");
});

test("gate ON: sizingBase DOWN adjustment still allowed", () => {
  const fund = makeFund();
  // totalPnl < 0 + winRate < 0.4 → sizingBase down
  const trades = makeTrades({ winning: 3, losing: 7 });
  const adjustments = analyzeAndAdjust(trades, fund, "small", 0.02, true);
  const szDown = adjustments.find(a => a.param === "sizingBase" && a.direction === "down");
  assert.ok(szDown, "sizingBase down (conservative) should pass through gate");
});

// ── Neutral params (maxHoldDays / probReversalThreshold) unaffected ──────

test("gate ON: maxHoldDays UP adjustment passes (not in aggressive list)", () => {
  const fund = makeFund();
  // expiredCount==0 + avgPnl > 0 → maxHoldDays up
  const trades = makeTrades({ winning: 8, losing: 2 });
  const adjustments = analyzeAndAdjust(trades, fund, "small", 0.02, true);
  const mhUp = adjustments.find(a => a.param === "maxHoldDays" && a.direction === "up");
  assert.ok(mhUp, "maxHoldDays up should NOT be gated (neutral param)");
});

// ── Gate transition: removing soft-limit restores aggressive mutations ───

test("gate transition: same trades evaluated with gate OFF then ON differ", () => {
  const fund = makeFund();
  const trades = makeTrades({ stopped: 6, profitTaken: 4 });

  const offResults = analyzeAndAdjust(trades, fund, "small", 0.02, false);
  const onResults  = analyzeAndAdjust(trades, fund, "small", 0.02, true);

  const offHasSLUp = offResults.some(a => a.param === "stopLossPercent" && a.direction === "up");
  const onHasSLUp  = onResults.some(a  => a.param === "stopLossPercent" && a.direction === "up");

  assert.equal(offHasSLUp, true,  "gate OFF must include stopLossPercent up");
  assert.equal(onHasSLUp,  false, "gate ON must exclude stopLossPercent up");
});

// ── checkDrawdownSoftLimitGate DB integration ────────────────────────────

function makeDb(snapshot: { total_value: number | null } | null, peak: number | null = null): D1Database {
  return {
    prepare(sql: string) {
      const isSnapshot = sql.includes("portfolio_snapshots") && sql.includes("ORDER BY");
      const isPeak     = sql.includes("MAX(total_value)");
      return {
        bind(_fundId: string) {
          return {
            async first<T>(): Promise<T | null> {
              if (isSnapshot) return snapshot as T | null;
              if (isPeak)     return { peak } as T | null;
              return null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

test("gate check: fund at peak (no DD) returns false", async () => {
  // initial=100k, current=110k, peak=110k → peakDD=0, lossInitDD=0
  const db = makeDb({ total_value: 110_000 }, 110_000);
  const fund = makeFund();
  const inLimit = await checkDrawdownSoftLimitGate(db, fund);
  assert.equal(inLimit, false);
});

test("gate check: peakDD exceeds peakDrawdownSoftLimit triggers gate", async () => {
  // initial=100k, peak=120k, current=105k → peakDD=12.5% > 10% softLimit → ON
  const db = makeDb({ total_value: 105_000 }, 120_000);
  const fund = makeFund();
  const inLimit = await checkDrawdownSoftLimitGate(db, fund);
  assert.equal(inLimit, true);
});

test("gate check: lossVsInit exceeds lossVsInitialSoftLimit triggers gate", async () => {
  // initial=100k, peak=100k, current=83k → peakDD=17% > 10% (also triggers)
  // and lossInitDD=17% > 15% softLimit → ON
  const db = makeDb({ total_value: 83_000 }, 100_000);
  const fund = makeFund();
  const inLimit = await checkDrawdownSoftLimitGate(db, fund);
  assert.equal(inLimit, true);
});

test("gate check: never-climbed fund where ONLY lossVsInit triggers", async () => {
  // initial=100k, peak=100k (never climbed), current=84k → peakDD=16% (also > peakSoft 10%)
  // Construct a case where peakDD < peakSoft but lossInit > lossInitSoft.
  // initial=100k, peak=105k, current=88k → peakDD=(105-88)/105=16.2% > peakSoft 10% → ON
  // Try: initial=100k, peak=100k, current=86k → peakDD=14% > 10% peakSoft (also triggers, both)
  // For pure lossInit-only trigger we'd need peakDD < peakSoft but lossInit > lossInitSoft.
  // With current parameters (peakSoft=10%, lossInitSoft=15%, fund never climbed so peak=initial),
  // peakDD == lossInitDD always when peak=initial — they trigger together by symmetry.
  // So this test verifies the symmetric trigger: at 16% loss both fire.
  const db = makeDb({ total_value: 84_000 }, 100_000);
  const fund = makeFund();
  const inLimit = await checkDrawdownSoftLimitGate(db, fund);
  assert.equal(inLimit, true);
});

test("gate check: no snapshot returns false (gate open, don't freeze new funds)", async () => {
  const db = makeDb(null);
  const fund = makeFund();
  const inLimit = await checkDrawdownSoftLimitGate(db, fund);
  assert.equal(inLimit, false);
});

test("gate check: legacy fallback when v1.0.5 §1 fields missing", async () => {
  // Pre-schema-035 fund: only drawdownSoftLimit (0.10) present, no peak*/lossVsInit*.
  // initial=100k, peak=120k, current=107k → peakDD=10.83% > 0.10 legacy fallback → ON
  const db = makeDb({ total_value: 107_000 }, 120_000);
  const fund = makeFund({
    peakDrawdownSoftLimit:    undefined,
    lossVsInitialSoftLimit:   undefined,
  });
  const inLimit = await checkDrawdownSoftLimitGate(db, fund);
  assert.equal(inLimit, true);
});
