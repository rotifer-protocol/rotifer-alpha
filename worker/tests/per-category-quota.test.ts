/**
 * per-category-quota.test.ts (2026-05-22)
 *
 * v1.0.5 §4.2 per-category quota tests (ALPHA-PRD-003 C-HARDEN1.6).
 *
 * Validates applyCategoryBudget()'s new dual-mode behavior:
 *   1. Legacy number mode: single fraction applied to every category
 *      (backward-compatible with all callers before §4.2).
 *   2. Per-category mode: Partial<Record<SignalCategory, number>> looking up
 *      per category, with legacyFraction or 0.40 fallback for missing entries.
 *
 * Cap math: maxPerCategoryCount = max(1, ceil(signals.length × fraction)).
 * Signals must be passed already-sorted by edge descending (caller's
 * responsibility); the function only filters excess by traversal order.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { applyCategoryBudget } from "../src/scan.js";
import type { ArbSignal, SignalCategory } from "../src/types.js";

function makeSignal(category: SignalCategory, edge: number = 1): ArbSignal {
  return {
    signalId: `sig-${category}-${edge}-${Math.random()}`,
    type: "MISPRICING",
    marketId: "m",
    slug: "s",
    question: "?",
    description: "",
    edge,
    confidence: 0.5,
    direction: "BUY_YES",
    prices: {},
    timestamp: new Date().toISOString(),
    category,
  };
}

function repeat<T>(item: () => T, n: number): T[] {
  return Array.from({ length: n }, () => item());
}

// ── Legacy single-fraction mode (backward compat) ────────────────────────

test("legacy mode: 10 signals all sports + 0.40 fraction → 4 kept (ceil(10×0.40))", () => {
  const sigs = repeat(() => makeSignal("sports"), 10);
  const result = applyCategoryBudget(sigs, 0.40);
  assert.equal(result.length, 4);
  assert.ok(result.every(s => s.category === "sports"));
});

test("legacy mode: 100 mixed signals → each category capped at 0.20 = 20", () => {
  // 60 sports + 20 politics + 20 crypto = 100 total
  const sigs = [
    ...repeat(() => makeSignal("sports"), 60),
    ...repeat(() => makeSignal("politics"), 20),
    ...repeat(() => makeSignal("crypto"), 20),
  ];
  const result = applyCategoryBudget(sigs, 0.20);
  const counts = new Map<SignalCategory, number>();
  for (const s of result) counts.set(s.category!, (counts.get(s.category!) ?? 0) + 1);
  assert.equal(counts.get("sports"), 20);   // capped
  assert.equal(counts.get("politics"), 20); // already at cap
  assert.equal(counts.get("crypto"), 20);   // already at cap
});

test("legacy mode: fraction >= 1 returns all signals unchanged", () => {
  const sigs = repeat(() => makeSignal("crypto"), 50);
  const result = applyCategoryBudget(sigs, 1.0);
  assert.equal(result.length, 50);
});

test("legacy mode: empty input returns empty output", () => {
  const result = applyCategoryBudget([], 0.40);
  assert.equal(result.length, 0);
});

// ── Per-category lookup mode (v1.0.5 §4.2 new) ──────────────────────────

test("per-cat mode: honey_badger archetype defaults — full lookup", () => {
  // Simulate 100 signals: 30 sports, 20 politics, 20 crypto, 20 ai, 10 other
  const sigs = [
    ...repeat(() => makeSignal("sports"), 30),
    ...repeat(() => makeSignal("politics"), 20),
    ...repeat(() => makeSignal("crypto"), 20),
    ...repeat(() => makeSignal("ai"), 20),
    ...repeat(() => makeSignal("other"), 10),
  ];
  const honeyBadgerBudget: Partial<Record<SignalCategory, number>> = {
    sports: 0.50, politics: 0.30, crypto: 0.20, ai: 0.20, other: 0.20,
  };
  const result = applyCategoryBudget(sigs, honeyBadgerBudget);
  const counts = new Map<SignalCategory, number>();
  for (const s of result) counts.set(s.category!, (counts.get(s.category!) ?? 0) + 1);
  // 100 × {0.50, 0.30, 0.20, 0.20, 0.20} = {50, 30, 20, 20, 20}
  // Actual incoming counts are lower than caps for some categories.
  assert.equal(counts.get("sports"), 30);   // 30 ≤ cap 50, all kept
  assert.equal(counts.get("politics"), 20); // 20 ≤ cap 30, all kept
  assert.equal(counts.get("crypto"), 20);   // 20 == cap 20, all kept
  assert.equal(counts.get("ai"), 20);       // 20 == cap 20, all kept
  assert.equal(counts.get("other"), 10);    // 10 ≤ cap 20, all kept
});

test("per-cat mode: turtle archetype caps crypto/ai at 10%", () => {
  // Simulate 100 signals: 40 sports, 30 politics, 15 crypto, 10 ai, 5 other
  const sigs = [
    ...repeat(() => makeSignal("sports"), 40),
    ...repeat(() => makeSignal("politics"), 30),
    ...repeat(() => makeSignal("crypto"), 15),
    ...repeat(() => makeSignal("ai"), 10),
    ...repeat(() => makeSignal("other"), 5),
  ];
  const turtleBudget: Partial<Record<SignalCategory, number>> = {
    sports: 0.40, politics: 0.30, crypto: 0.10, ai: 0.10, other: 0.10,
  };
  const result = applyCategoryBudget(sigs, turtleBudget);
  const counts = new Map<SignalCategory, number>();
  for (const s of result) counts.set(s.category!, (counts.get(s.category!) ?? 0) + 1);
  // 100 × {0.40, 0.30, 0.10, 0.10, 0.10} = caps {40, 30, 10, 10, 10}
  assert.equal(counts.get("sports"), 40);    // 40 == cap 40
  assert.equal(counts.get("politics"), 30);  // 30 == cap 30
  assert.equal(counts.get("crypto"), 10);    // 15 > cap 10 → 5 dropped
  assert.equal(counts.get("ai"), 10);        // 10 == cap 10
  assert.equal(counts.get("other"), 5);      // 5 < cap 10
});

test("per-cat mode: missing category falls back to legacyFraction", () => {
  const sigs = repeat(() => makeSignal("ai"), 20);
  // budget object missing "ai" entry → fall back to legacyFraction 0.25
  const result = applyCategoryBudget(sigs, { sports: 0.50 } as Partial<Record<SignalCategory, number>>, 0.25);
  // 20 × 0.25 = 5
  assert.equal(result.length, 5);
});

test("per-cat mode: missing category + no legacyFraction → 0.40 default", () => {
  const sigs = repeat(() => makeSignal("crypto"), 20);
  // budget missing crypto + no legacyFraction passed → 0.40 default
  const result = applyCategoryBudget(sigs, { sports: 0.50 } as Partial<Record<SignalCategory, number>>);
  // 20 × 0.40 = 8
  assert.equal(result.length, 8);
});

test("per-cat mode: one category uncapped (fraction = 1.0)", () => {
  const sigs = [
    ...repeat(() => makeSignal("sports"), 50),
    ...repeat(() => makeSignal("crypto"), 10),
  ];
  const budget: Partial<Record<SignalCategory, number>> = {
    sports: 1.0,    // uncapped
    crypto: 0.05,  // 60 × 0.05 = 3
  };
  const result = applyCategoryBudget(sigs, budget);
  const counts = new Map<SignalCategory, number>();
  for (const s of result) counts.set(s.category!, (counts.get(s.category!) ?? 0) + 1);
  assert.equal(counts.get("sports"), 50);  // uncapped, all kept
  assert.equal(counts.get("crypto"), 3);   // capped at 3
});

// ── Order preservation (edge-descending semantics) ───────────────────────

test("legacy mode: drops lowest-edge excess of dominant category", () => {
  // signals sorted by edge desc: sports(10) sports(9) sports(8) crypto(7) sports(6) sports(5)
  // With cap 0.40 (6 × 0.40 = 2.4 → ceil to 3), sports cap = 3 → first 3 sports kept.
  const sigs: ArbSignal[] = [
    makeSignal("sports", 10),
    makeSignal("sports", 9),
    makeSignal("sports", 8),
    makeSignal("crypto", 7),
    makeSignal("sports", 6),
    makeSignal("sports", 5),
  ];
  const result = applyCategoryBudget(sigs, 0.40);
  const sportsEdges = result.filter(s => s.category === "sports").map(s => s.edge).sort((a, b) => b - a);
  // First-3-encountered sports kept (10, 9, 8) — sports 6 and 5 dropped.
  assert.deepEqual(sportsEdges, [10, 9, 8]);
  // crypto kept (under its cap)
  assert.ok(result.find(s => s.category === "crypto" && s.edge === 7));
});

// ── Defensive ────────────────────────────────────────────────────────────

test("legacy mode: signal with missing category treated as 'other'", () => {
  const sigs: ArbSignal[] = [
    makeSignal("sports"),
    { ...makeSignal("sports"), category: undefined } as ArbSignal,
  ];
  const result = applyCategoryBudget(sigs, 0.50);
  // 2 signals × 0.50 = 1 each. "other" gets 1 slot, sports gets 1 slot.
  // Both kept (each is alone in its category).
  assert.equal(result.length, 2);
});
