import test from "node:test";
import assert from "node:assert/strict";

import { executeMonitorActions, type MonitorResult } from "../src/monitor";

class FakeStatement {
  constructor(
    private readonly sql: string,
    private readonly calls: Array<{ sql: string; args: unknown[] }>,
  ) {}

  bind(...args: unknown[]) {
    return {
      run: async () => {
        this.calls.push({ sql: this.sql, args });
        return {};
      },
      /**
       * Stub `.first()` for read queries (e.g. circuit-breaker.loadCircuitBreakerState).
       * Returns null — simulates a fund with no prior circuit-breaker row. The
       * test intent here is to verify monitor-driven UPDATE statements; circuit-
       * breaker read just needs to not throw. Don't push to `calls` so we don't
       * pollute the assertion counter — calls is meant to track writes.
       */
      first: async <T>(): Promise<T | null> => null,
    };
  }
}

class FakeDb {
  public readonly calls: Array<{ sql: string; args: unknown[] }> = [];

  prepare(sql: string) {
    return new FakeStatement(sql, this.calls);
  }
}

test("executeMonitorActions persists exit price for closed monitor trades", async () => {
  const db = new FakeDb();
  const monitorResult: MonitorResult = {
    highWaterMarkUpdates: [],
    actions: [{
      tradeId: "trade-1",
      fundId: "cheetah",
      marketId: "123",
      slug: "some-market",
      question: "Will this resolve yes?",
      direction: "BUY_YES",
      shares: 100,
      newStatus: "PROFIT_TAKEN",
      pnl: 42.5,
      reason: "Take profit triggered at 31.0%",
      currentPrice: 0.62,
      entryPrice: 0.4,
    }],
  };

  await executeMonitorActions(db as unknown as D1Database, monitorResult);

  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /exit_price = \?/);
  assert.equal(db.calls[0].args[0], "PROFIT_TAKEN");
  assert.equal(db.calls[0].args[1], 0.62);
  assert.equal(db.calls[0].args[2], 42.5);
  assert.equal(db.calls[0].args[4], "Take profit triggered at 31.0%");
  assert.equal(db.calls[0].args[5], "trade-1");
});

test("high water mark updates are skipped for trades that are closing", async () => {
  const db = new FakeDb();
  const monitorResult: MonitorResult = {
    highWaterMarkUpdates: [
      { tradeId: "trade-1", hwm: 0.9 },
      { tradeId: "trade-2", hwm: 0.8 },
    ],
    actions: [{
      tradeId: "trade-1",
      fundId: "octopus",
      marketId: "456",
      slug: "another-market",
      question: "Will the trend reverse?",
      direction: "BUY_YES",
      shares: 50,
      newStatus: "REVERSED",
      pnl: -12,
      reason: "Probability reversed by 18.0pp",
      currentPrice: 0.31,
      entryPrice: 0.49,
    }],
  };

  await executeMonitorActions(db as unknown as D1Database, monitorResult);

  // Expected writes:
  //   [0] high_water_mark UPDATE for trade-2 (trade-1 skipped because closing)
  //   [1] exit_price UPDATE for trade-1 (REVERSED action persisted)
  //   [2] circuit_breaker_state UPDATE — REVERSED action has pnl=-12 (a loss),
  //       so recordCircuitBreakerLoss writes to epoch_loss_usdc. The follow-up
  //       loadCircuitBreakerState read returns null (no prior row), so no trip
  //       UPDATE happens; the breaker is not tripped in this single-loss scenario.
  assert.equal(db.calls.length, 3);
  assert.match(db.calls[0].sql, /high_water_mark/);
  assert.deepEqual(db.calls[0].args, [0.8, "trade-2"]);
  assert.equal(db.calls[1].args[5], "trade-1");
  assert.match(db.calls[2].sql, /circuit_breaker_state/);
});
