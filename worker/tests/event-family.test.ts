import test from "node:test";
import assert from "node:assert/strict";

import { eventFamilyKey } from "../src/event-family";

test("eventFamilyKey groups James Bond actor variants", () => {
  assert.equal(
    eventFamilyKey("next-james-bond-actor-635", "Next James Bond actor?"),
    eventFamilyKey("james-norton-announced-as-next-james-bond", "James Norton announced as next James Bond?"),
  );
});

test("eventFamilyKey groups binary child questions with their competition event", () => {
  assert.equal(
    eventFamilyKey("nba-playoffs-eastern-conference-champion", "NBA Playoffs: Eastern Conference Champion"),
    eventFamilyKey("will-detroit-pistons-win-the-nba-eastern-conference-finals", "Will Detroit Pistons win the NBA Eastern Conference Finals?"),
  );
});

test("eventFamilyKey keeps adjacent competitions separate", () => {
  assert.notEqual(
    eventFamilyKey("nba-playoffs-eastern-conference-champion", "NBA Playoffs: Eastern Conference Champion"),
    eventFamilyKey("nba-playoffs-western-conference-champion", "NBA Playoffs: Western Conference Champion"),
  );
});

test("eventFamilyKey strips Polymarket numeric suffixes", () => {
  assert.equal(
    eventFamilyKey("next-james-bond-actor-635"),
    eventFamilyKey("next-james-bond-actor"),
  );
});
