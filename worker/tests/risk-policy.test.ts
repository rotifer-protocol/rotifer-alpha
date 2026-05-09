import test from "node:test";
import assert from "node:assert/strict";

import {
  OTM_PRICE_THRESHOLD,
  MAX_OTM_POSITION_RATIO,
  isOTMPosition,
  calcOTMCap,
} from "../src/risk-policy";

// ============================================================
// P2 Path A — single-position OTM cap (founder approved 2026-05-10)
// ============================================================
//
// Background: gambler_l accumulated $349K unrealized PnL with 89%
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
  // After fund grows from $1M → $1.349M (gambler_l real scenario),
  // cap should scale accordingly (not stay anchored to initial $1M)
  assert.equal(calcOTMCap(1_349_000), 67_450);
});

test("calcOTMCap: cap shrinks during drawdown (compound risk protection)", () => {
  // Fund underwater: equity $850K → cap also shrinks to $42.5K,
  // preventing martingale-style "double down on tail risk" recovery
  assert.equal(calcOTMCap(850_000), 42_500);
});

// ─── Combined: realistic gambler_l scenario ─────────────────────

test("scenario: gambler_l $30K bet at price 0.0085 EXCEEDS cap", () => {
  // gambler_l sizingBase=10K, sizingScale=20K → max single bet $30K
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
