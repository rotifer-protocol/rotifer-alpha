import test from "node:test";
import assert from "node:assert/strict";

import {
  checkPortfolioConcentration,
  getPortfolioEventExposureMap,
  PORTFOLIO_MAX_EVENT_USDC,
} from "../src/portfolio-coordinator";

// ---------------------------------------------------------------------------
// checkPortfolioConcentration — pure function tests
// ---------------------------------------------------------------------------

test("checkPortfolioConcentration: allows entry when below limit", () => {
  const result = checkPortfolioConcentration(0, 100, 200);
  assert.equal(result.allowed, true);
  assert.equal(result.portfolioExposure, 0);
  assert.equal(result.wouldBeExposure, 100);
  assert.equal(result.limit, 200);
});

test("checkPortfolioConcentration: allows entry exactly at limit", () => {
  const result = checkPortfolioConcentration(100, 100, 200);
  assert.equal(result.allowed, true);
  assert.equal(result.wouldBeExposure, 200);
});

test("checkPortfolioConcentration: blocks entry that would exceed limit", () => {
  const result = checkPortfolioConcentration(150, 100, 200);
  assert.equal(result.allowed, false);
  assert.equal(result.wouldBeExposure, 250);
  assert.equal(result.limit, 200);
});

test("checkPortfolioConcentration: blocks when existing exposure already at limit", () => {
  const result = checkPortfolioConcentration(200, 50, 200);
  assert.equal(result.allowed, false);
});

test("checkPortfolioConcentration: uses PORTFOLIO_MAX_EVENT_USDC as default limit", () => {
  const result = checkPortfolioConcentration(0, PORTFOLIO_MAX_EVENT_USDC);
  assert.equal(result.allowed, true);
  assert.equal(result.limit, PORTFOLIO_MAX_EVENT_USDC);
});

test("checkPortfolioConcentration: blocks with default limit exceeded", () => {
  const result = checkPortfolioConcentration(PORTFOLIO_MAX_EVENT_USDC, 1);
  assert.equal(result.allowed, false);
});

// ---------------------------------------------------------------------------
// getPortfolioEventExposureMap — DB aggregation tests (mock D1)
// ---------------------------------------------------------------------------

function makeDb(rows: Array<{ slug: string | null; question: string | null; amount: number }>) {
  return {
    prepare: (_sql: string) => ({
      all: async () => ({ results: rows }),
    }),
  } as unknown as D1Database;
}

test("getPortfolioEventExposureMap: sums amounts across all funds for same event family", async () => {
  const db = makeDb([
    { slug: "next-james-bond-actor-635", question: "Next James Bond actor?", amount: 100 },
    { slug: "james-norton-announced-as-next-james-bond", question: "James Norton announced as next James Bond?", amount: 80 },
  ]);
  const map = await getPortfolioEventExposureMap(db);
  // Both rows should canonicalize to the same event family key
  assert.equal(map.size, 1);
  const [key] = [...map.keys()];
  assert.equal(map.get(key), 180);
});

test("getPortfolioEventExposureMap: keeps separate event families separate", async () => {
  const db = makeDb([
    { slug: "next-james-bond-actor", question: "Next James Bond actor?", amount: 100 },
    { slug: "next-us-president", question: "Who will be the next US President?", amount: 200 },
  ]);
  const map = await getPortfolioEventExposureMap(db);
  assert.equal(map.size, 2);
  const total = [...map.values()].reduce((s, v) => s + v, 0);
  assert.equal(total, 300);
});

test("getPortfolioEventExposureMap: returns empty map when no open positions", async () => {
  const db = makeDb([]);
  const map = await getPortfolioEventExposureMap(db);
  assert.equal(map.size, 0);
});

test("getPortfolioEventExposureMap: handles null slug and question gracefully", async () => {
  const db = makeDb([
    { slug: null, question: null, amount: 50 },
  ]);
  const map = await getPortfolioEventExposureMap(db);
  // null/null canonicalizes to "unknown-event"
  assert.equal(map.size, 1);
  assert.equal(map.get("unknown-event"), 50);
});

// ---------------------------------------------------------------------------
// Integration: concentration check using realistic multi-fund scenario
// ---------------------------------------------------------------------------

test("portfolio gate blocks second fund from piling into same James Bond event", async () => {
  // Fund A already has $150 in the James Bond event family
  const db = makeDb([
    { slug: "next-james-bond-actor-635", question: "Next James Bond actor?", amount: 150 },
  ]);
  const map = await getPortfolioEventExposureMap(db);

  // Fund B tries to add $75 — total would be $225 > $200 limit
  const [key] = [...map.keys()];
  const result = checkPortfolioConcentration(map.get(key) ?? 0, 75, PORTFOLIO_MAX_EVENT_USDC);
  assert.equal(result.allowed, false);
  assert.equal(result.wouldBeExposure, 225);
});

test("portfolio gate allows second fund when total stays within limit", async () => {
  // Fund A has $100 in James Bond
  const db = makeDb([
    { slug: "next-james-bond-actor", question: "Next James Bond actor?", amount: 100 },
  ]);
  const map = await getPortfolioEventExposureMap(db);

  // Fund B tries to add $80 — total would be $180 ≤ $200 limit
  const [key] = [...map.keys()];
  const result = checkPortfolioConcentration(map.get(key) ?? 0, 80, PORTFOLIO_MAX_EVENT_USDC);
  assert.equal(result.allowed, true);
  assert.equal(result.wouldBeExposure, 180);
});
