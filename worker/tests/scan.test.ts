import test from "node:test";
import assert from "node:assert/strict";

import { analyze } from "../src/scan";
import type { MarketSnapshot } from "../src/types";

function market(overrides: Partial<MarketSnapshot>): MarketSnapshot {
  return {
    id: "m",
    question: "Candidate announced?",
    slug: "candidate-market",
    outcomes: ["Yes", "No"],
    outcomePrices: [0.33, 0.67],
    bestBid: 0.32,
    bestAsk: 0.34,
    spread: 0.01,
    volume24hr: 100_000,
    liquidity: 50_000,
    endDate: "2026-06-01T00:00:00Z",
    eventSlug: "event",
    eventTitle: "Event",
    groupItemTitle: "",
    active: true,
    closed: false,
    ...overrides,
  };
}

test("multi-outcome arb skips incomplete event subsets with extreme low yes-sum", () => {
  const ts = "2026-05-18T09:25:00.000Z";
  const signals = analyze([
    market({
      id: "bond-james-norton",
      question: "James Norton announced as next James Bond?",
      eventSlug: "next-james-bond-actor-635",
      eventTitle: "Next James Bond actor?",
      outcomePrices: [0.0115, 0.9885],
    }),
    market({
      id: "bond-harris-dickinson",
      question: "Harris Dickinson announced as next James Bond?",
      eventSlug: "next-james-bond-actor-635",
      eventTitle: "Next James Bond actor?",
      outcomePrices: [0.06, 0.94],
    }),
  ], ts);

  assert.equal(
    signals.some(s => s.type === "MULTI_OUTCOME_ARB" && s.slug === "next-james-bond-actor-635"),
    false,
    "A partial candidate subset (yes_sum=0.0715) must not be treated as complete-event arbitrage",
  );
});

test("multi-outcome arb still emits when event coverage is plausibly complete", () => {
  const ts = "2026-05-18T12:00:00.000Z";
  const signals = analyze([
    market({ id: "a", question: "A wins?", outcomePrices: [0.42, 0.58] }),
    market({ id: "b", question: "B wins?", outcomePrices: [0.31, 0.69] }),
    market({ id: "c", question: "C wins?", outcomePrices: [0.24, 0.76] }),
  ], ts);

  const arb = signals.find(s => s.type === "MULTI_OUTCOME_ARB" && s.slug === "event");
  assert.ok(arb, "A three-candidate event with yes_sum=0.97 should still produce an arb signal");
  assert.equal(arb.direction, "BUY_STRONGEST");
});
