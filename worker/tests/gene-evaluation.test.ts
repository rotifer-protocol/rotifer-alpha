import test from "node:test";
import assert from "node:assert/strict";

import type { GeneVariant } from "../src/gene-variants";
import { selectPipelineVariant } from "../src/gene-evaluation";

function variant(
  id: string,
  generation: number,
  tradesEvaluated: number,
  status: GeneVariant["status"] = "active",
): GeneVariant {
  const [geneId, variantName] = id.split(":");
  return {
    id,
    geneId,
    variantName,
    description: null,
    descriptionZh: null,
    strategyKey: variantName.includes("g1") ? "challenger" : "baseline",
    config: {},
    parentVariantId: generation > 0 ? `${geneId}:v1-baseline` : null,
    generation,
    status,
    alphaScore: 0,
    tradesEvaluated,
    winCount: 0,
    lossCount: 0,
    totalPnl: 0,
    createdAt: "2026-05-11T00:00:00.000Z",
    eliminatedAt: null,
  };
}

test("selectPipelineVariant returns configured winner outside exploration bucket", () => {
  const baseline = variant("polymarket-monitor:v1-baseline", 0, 100);
  const challenger = variant("polymarket-monitor:adaptive g1", 1, 0);

  const selected = selectPipelineVariant(
    baseline,
    [baseline, challenger],
    "1970-01-01T00:05:00.000Z",
    { interval: 2 },
  );

  assert.equal(selected?.id, baseline.id);
});

test("selectPipelineVariant samples least-evaluated challenger during exploration bucket", () => {
  const baseline = variant("polymarket-monitor:v1-baseline", 0, 100);
  const challengerA = variant("polymarket-monitor:adaptive g1", 1, 5);
  const challengerB = variant("polymarket-monitor:llm-config g2", 2, 0);

  const selected = selectPipelineVariant(
    baseline,
    [baseline, challengerA, challengerB],
    "1970-01-01T00:00:00.000Z",
    { interval: 2 },
  );

  assert.equal(selected?.id, challengerB.id);
});

test("selectPipelineVariant ignores eliminated challengers", () => {
  const baseline = variant("polymarket-risk:v1-baseline", 0, 10);
  const eliminated = variant("polymarket-risk:conservative g1", 1, 0, "eliminated");

  const selected = selectPipelineVariant(
    baseline,
    [baseline, eliminated],
    "1970-01-01T00:00:00.000Z",
    { interval: 2 },
  );

  assert.equal(selected?.id, baseline.id);
});

test("selectPipelineVariant falls back when configured variant is no longer active", () => {
  const eliminatedBaseline = variant("polymarket-risk:v1-baseline", 0, 10, "eliminated");
  const challenger = variant("polymarket-risk:conservative g1", 1, 0);

  const selected = selectPipelineVariant(
    eliminatedBaseline,
    [eliminatedBaseline, challenger],
    "1970-01-01T00:05:00.000Z",
    { interval: 2 },
  );

  assert.equal(selected?.id, challenger.id);
});
