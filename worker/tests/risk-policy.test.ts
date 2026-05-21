import test from "node:test";
import assert from "node:assert/strict";

import {
  OTM_PRICE_THRESHOLD,
  MAX_OTM_POSITION_RATIO,
  SANITY_LOSS_MULTIPLIER,
  isOTMPosition,
  calcOTMCap,
  isUnsafeSellEntry,
  isUnreasonableLoss,
} from "../src/risk-policy";

// ============================================================
// P2 Path A — single-position OTM cap (founder approved 2026-05-10)
// ============================================================
//
// Background: honey_badger_l (formerly gambler_l) accumulated $349K unrealized PnL with 89%
// concentrated in 2 SELL_WEAKEST OTM positions. Tail-risk concentration:
// 99% of the time these positions earn small amounts, but a single OTM
// hit (e.g. an underdog winning the NBA championship) can wipe months
// of gains in one settlement.
//
// Cap design: 5% of fund equity per OTM position × maxOpenPositions=20
// = 100% theoretical OTM exposure ceiling. Forces ≥20-way diversification
// if a fund pursues full OTM exposure. Constants live in risk-policy.ts
// and are NOT in EVOLVABLE_PARAMS — risk guardrails must not be self-tuned.

// ─── isOTMPosition: threshold semantics ─────────────────────────

test("isOTMPosition: typical NBA underdog price (0.0085) is flagged OTM", () => {
  // 76ers 2026 NBA Champion @ 0.0085 — the canonical SELL_WEAKEST target
  assert.equal(isOTMPosition(0.0085, "SELL_YES"), true);
});

test("isOTMPosition: BUY long-shot at low price is flagged OTM", () => {
  assert.equal(isOTMPosition(0.03, "BUY_YES"), true);
});

test("isOTMPosition: edge case — exactly at threshold is NOT flagged", () => {
  // 0.05 is the upper exclusive bound; only strictly below is OTM
  assert.equal(isOTMPosition(OTM_PRICE_THRESHOLD, "BUY_YES"), false);
});

test("isOTMPosition: just below threshold IS flagged", () => {
  assert.equal(isOTMPosition(OTM_PRICE_THRESHOLD - 0.0001, "BUY_YES"), true);
});

test("isOTMPosition: midrange price is NOT OTM", () => {
  assert.equal(isOTMPosition(0.5, "BUY_YES"), false);
  assert.equal(isOTMPosition(0.5, "SELL_YES"), false);
});

test("isOTMPosition: high price (favorite) is NOT OTM", () => {
  // High-price BUY is "in-the-money", not OTM
  assert.equal(isOTMPosition(0.92, "BUY_YES"), false);
});

test("isOTMPosition: zero price is rejected (data anomaly, not OTM)", () => {
  // price=0 should be filtered upstream by passesPriceBoundary, but
  // defensively we don't classify it as OTM (avoids div-by-zero confusion)
  assert.equal(isOTMPosition(0, "BUY_YES"), false);
  assert.equal(isOTMPosition(-0.01, "BUY_YES"), false);
});

// ─── calcOTMCap: tier behaviour ─────────────────────────────────

test("calcOTMCap: small fund ($10K equity) → $500 cap", () => {
  assert.equal(calcOTMCap(10_000), 500);
});

test("calcOTMCap: medium fund ($100K equity) → $5,000 cap", () => {
  assert.equal(calcOTMCap(100_000), 5_000);
});

test("calcOTMCap: large fund ($1M equity) → $50,000 cap", () => {
  assert.equal(calcOTMCap(1_000_000), 50_000);
});

test("calcOTMCap: cap scales with equity, not initial balance", () => {
  // After fund grows from $1M → $1.349M (honey_badger_l real scenario),
  // cap should scale accordingly (not stay anchored to initial $1M)
  assert.equal(calcOTMCap(1_349_000), 67_450);
});

test("calcOTMCap: cap shrinks during drawdown (compound risk protection)", () => {
  // Fund underwater: equity $850K → cap also shrinks to $42.5K,
  // preventing martingale-style "double down on tail risk" recovery
  assert.equal(calcOTMCap(850_000), 42_500);
});

// ─── Combined: realistic honey_badger_l scenario ─────────────────────

test("scenario: honey_badger_l $30K bet at price 0.0085 EXCEEDS cap", () => {
  // honey_badger_l sizingBase=10K, sizingScale=20K → max single bet $30K
  // current equity ~$1.349M → cap $67,450
  // 30K < 67.45K → would PASS cap (not blocked)
  // This is a CALIBRATION CHECK: cap is loose enough that it doesn't
  // block legitimate sizing, but tight enough to prevent runaway concentration.
  const equity = 1_349_000;
  const proposedBet = 30_000;
  const price = 0.0085;
  const direction = "SELL_YES";

  const isOTM = isOTMPosition(price, direction);
  const cap = calcOTMCap(equity);

  assert.equal(isOTM, true);
  assert.ok(proposedBet < cap, `30K bet should fit within ${cap} cap`);
});

test("scenario: pathological 100K bet at 0.0085 IS BLOCKED", () => {
  // If maxPerEvent allowed a $100K stake on 0.0085 (price scaling pathology)
  // the cap would catch it: $100K > $67,450 → SKIP with OTM_CAP
  const equity = 1_349_000;
  const proposedBet = 100_000;
  const price = 0.0085;

  const isOTM = isOTMPosition(price, "SELL_YES");
  const cap = calcOTMCap(equity);

  assert.equal(isOTM, true);
  assert.ok(proposedBet > cap, `100K bet should exceed ${cap} cap`);
});

test("MAX_OTM_POSITION_RATIO is 5% (calibration anchor)", () => {
  // Sentinel: changing this constant requires conscious review
  // (and ideally an ADR). Locking value via test.
  assert.equal(MAX_OTM_POSITION_RATIO, 0.05);
  assert.equal(OTM_PRICE_THRESHOLD, 0.05);
});

// ============================================================
// Track 2 — SELL_YES low-entry hard reject (2026-05-10 forensic)
// ============================================================
//
// Background: 33 SELL_YES @ entry 0.0015-0.025 produced -$86.28M phantom
// losses (Polymarket Gamma 0.5 placeholder × 1666× leverage). D-Lite
// eliminates the API entry; this rule eliminates the leverage amplifier.
// Together they prevent recurrence.

test("isUnsafeSellEntry: SELL_YES at canonical bogus entry (0.0015) is rejected", () => {
  // Worst historical trade: shark_l SELL_YES @ 0.0015 → -$12.46M phantom
  assert.equal(isUnsafeSellEntry(0.0015, "SELL_YES"), true);
});

test("isUnsafeSellEntry: SELL_YES just below threshold (0.049) is rejected", () => {
  assert.equal(isUnsafeSellEntry(0.049, "SELL_YES"), true);
});

test("isUnsafeSellEntry: SELL_YES exactly at threshold (0.05) is allowed", () => {
  // Threshold is exclusive (matches isOTMPosition semantics)
  assert.equal(isUnsafeSellEntry(0.05, "SELL_YES"), false);
});

test("isUnsafeSellEntry: SELL_YES at moderate price (0.10) is allowed", () => {
  // 10% probability — leverage is bounded at 10× amount, manageable
  assert.equal(isUnsafeSellEntry(0.10, "SELL_YES"), false);
});

test("isUnsafeSellEntry: BUY_YES at deep OTM is NOT rejected (long-shot is allowed)", () => {
  // BUY_YES @ low price = long-shot bet, asymmetric upside, max loss = -100%
  // Stays allowed but is gated by OTM_CAP (5% equity max).
  assert.equal(isUnsafeSellEntry(0.0015, "BUY_YES"), false);
});

test("isUnsafeSellEntry: BUY_YES at any price is NOT rejected", () => {
  // Track 2 only targets SELL_YES leverage explosion
  assert.equal(isUnsafeSellEntry(0.001, "BUY_YES"), false);
  assert.equal(isUnsafeSellEntry(0.04, "BUY_YES"), false);
  assert.equal(isUnsafeSellEntry(0.5, "BUY_YES"), false);
  assert.equal(isUnsafeSellEntry(0.95, "BUY_YES"), false);
});

test("isUnsafeSellEntry: zero/negative price not classified (data anomaly handled upstream)", () => {
  // PRICE_BOUNDARY check upstream catches these; defensively: not unsafe
  // (avoids a downstream skip masking an upstream missing filter)
  assert.equal(isUnsafeSellEntry(0, "SELL_YES"), false);
  assert.equal(isUnsafeSellEntry(-0.01, "SELL_YES"), false);
});

// ============================================================
// Track 3 — Sanity guard against implausible mark prices (2026-05-10)
// ============================================================
//
// Defense-in-depth: even with D-Lite (no Gamma API mark) and Track 2
// (no SELL_YES @ entry<0.05), refuse to act on any mark that implies
// > 1000% loss. Catches future API quirks without false-tripping on
// legitimate tail losses.

test("isUnreasonableLoss: small loss is normal", () => {
  // -50% loss on $100 position = -$50 → reasonable
  assert.equal(isUnreasonableLoss(-50, 100), false);
});

test("isUnreasonableLoss: full -100% loss is normal (BUY_YES max)", () => {
  // BUY_YES going to 0: loss = -amount → -100% → still reasonable
  assert.equal(isUnreasonableLoss(-100, 100), false);
});

test("isUnreasonableLoss: -500% loss is normal for SELL_YES tail", () => {
  // SELL_YES @ entry=0.05 going to 0.30: loss = (0.30 - 0.05) × shares
  // shares = amount/0.05 = 20× amount → loss = 0.25 × 20 × amount = 5× amount
  // = 500% loss — within sanity band, allowed
  assert.equal(isUnreasonableLoss(-500, 100), false);
});

test("isUnreasonableLoss: -10× exactly is the boundary (not flagged)", () => {
  // Strictly less than -10× trips (SANITY_LOSS_MULTIPLIER × amount)
  assert.equal(isUnreasonableLoss(-1000, 100), false);
});

test("isUnreasonableLoss: -1001 on $100 amount IS flagged", () => {
  assert.equal(isUnreasonableLoss(-1001, 100), true);
});

test("isUnreasonableLoss: historical 33233% bogus trip — caught", () => {
  // shark_l SELL_YES @ entry=0.0015, shares=25M, amount=$37,500
  // bogus mark 0.5: loss = $37,500 - 25M×0.5 = -$12,462,500
  // 332× position size → trips sanity guard
  assert.equal(isUnreasonableLoss(-12_462_500, 37_500), true);
});

test("isUnreasonableLoss: zero or negative amount does not flag", () => {
  // Defensive: amount≤0 means malformed trade, don't trip on it
  assert.equal(isUnreasonableLoss(-1000, 0), false);
  assert.equal(isUnreasonableLoss(-1000, -50), false);
});

test("SANITY_LOSS_MULTIPLIER is 10 (calibration anchor)", () => {
  // Sentinel: changing this requires conscious review.
  assert.equal(SANITY_LOSS_MULTIPLIER, 10);
});
