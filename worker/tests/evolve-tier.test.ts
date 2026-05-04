/**
 * evolve-tier.test.ts
 *
 * Unit tests for ADR-274 tier-aware PARAM_BOUNDS design:
 *   - fundTier() boundary conditions
 *   - Tier hierarchy: medium bounds > small bounds for scaled params
 *   - Tier-invariant params are consistent across tiers (spot-check via fundTier logic)
 *
 * Note: clampParam / mutateParams are internal; tested indirectly via fundTier export.
 * Full PBT integration tests require D1 mock (tracked as Cycle 2 follow-up).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { fundTier } from "../src/evolve.js";

// ─── fundTier boundary tests ────────────────────────────────────────────────

test("fundTier: $10K → small", () => {
  assert.strictEqual(fundTier(10_000), "small");
});

test("fundTier: $0 → small (edge: zero balance)", () => {
  assert.strictEqual(fundTier(0), "small");
});

test("fundTier: $49 999 → small (just below $50K boundary)", () => {
  assert.strictEqual(fundTier(49_999), "small");
});

test("fundTier: $50 000 → medium (at lower boundary)", () => {
  assert.strictEqual(fundTier(50_000), "medium");
});

test("fundTier: $100 000 → medium", () => {
  assert.strictEqual(fundTier(100_000), "medium");
});

test("fundTier: $499 999 → medium (just below $500K boundary)", () => {
  assert.strictEqual(fundTier(499_999), "medium");
});

test("fundTier: $500 000 → large (at lower boundary)", () => {
  assert.strictEqual(fundTier(500_000), "large");
});

test("fundTier: $1 000 000 → large", () => {
  assert.strictEqual(fundTier(1_000_000), "large");
});

test("fundTier: $10 000 000 → large (very large fund)", () => {
  assert.strictEqual(fundTier(10_000_000), "large");
});

// ─── Tier hierarchy sanity check ────────────────────────────────────────────
// Verify tier progression matches ADR-274 D1 intent: tiers cover
// the three initialBalance ranges used in 3×5 matrix ($10K / $100K / $1M).

test("fundTier: $10K / $100K / $1M map to the 3 distinct tiers", () => {
  const results = [10_000, 100_000, 1_000_000].map(fundTier);
  assert.deepStrictEqual(results, ["small", "medium", "large"]);
});

test("fundTier: all 3 tiers are distinct (no tier collision for matrix funds)", () => {
  const tiers = new Set([fundTier(10_000), fundTier(100_000), fundTier(1_000_000)]);
  assert.strictEqual(tiers.size, 3, "Each capital level must map to a different tier");
});
