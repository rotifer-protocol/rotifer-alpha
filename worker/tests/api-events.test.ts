import test from "node:test";
import assert from "node:assert/strict";

import { handleApi } from "../src/api";

class FakeStatement {
  constructor(
    private readonly sql: string,
    private readonly rows: {
      scans: Record<string, unknown>[];
      trades: Record<string, unknown>[];
      signals: Record<string, unknown>[];
      evolution: Record<string, unknown>[];
    },
  ) {}

  bind(..._args: unknown[]) {
    return {
      all: async () => {
        if (this.sql.includes("FROM scans")) {
          return { results: this.rows.scans };
        }
        if (this.sql.includes("FROM paper_trades")) {
          return { results: this.rows.trades };
        }
        if (this.sql.includes("FROM signals")) {
          return { results: this.rows.signals };
        }
        if (this.sql.includes("FROM evolution_log")) {
          return { results: this.rows.evolution };
        }
        throw new Error(`Unexpected all() query: ${this.sql}`);
      },
      first: async () => {
        throw new Error(`Unexpected first() query: ${this.sql}`);
      },
      run: async () => {
        throw new Error(`Unexpected run() query: ${this.sql}`);
      },
    };
  }
}

class FakeDb {
  constructor(
    private readonly rows: {
      scans: Record<string, unknown>[];
      trades: Record<string, unknown>[];
      signals: Record<string, unknown>[];
      evolution: Record<string, unknown>[];
    },
  ) {}

  prepare(sql: string) {
    return new FakeStatement(sql, this.rows);
  }
}

test("api events expose detailed trade-opened and signal payloads", async () => {
  const db = new FakeDb({
    scans: [
      {
        scanned_at: "2026-04-04T15:30:16.173Z",
        total_fetched: 204,
        markets_filtered: 20,
        signals_found: 2,
        avg_edge: 70.18,
      },
    ],
    trades: [
      {
        fund_id: "shark",
        question: "What will happen before GTA VI?",
        direction: "SELL_YES",
        amount: 650,
        status: "OPEN",
        pnl: null,
        slug: "what-will-happen-before-gta-vi",
        opened_at: "2026-04-04T15:30:16.173Z",
        closed_at: null,
        entry_price: 0.4845,
        exit_price: null,
        monitor_reason: null,
      },
    ],
    signals: [
      {
        signal_id: "SIG-test-1",
        type: "MULTI_OUTCOME_ARB",
        market_id: "540844",
        slug: "what-will-happen-before-gta-vi",
        question: "What will happen before GTA VI?",
        description: "Synthetic arbitrage signal",
        edge: 99.95,
        confidence: 0.88,
        direction: "SELL_YES",
        prices: "{\"YES\":0.4845}",
        created_at: "2026-04-04T15:30:16.173Z",
      },
    ],
    evolution: [],
  });

  const response = await handleApi(
    "/api/events",
    new Request("http://localhost/api/events?limit=10"),
    { DB: db as unknown as D1Database } as never,
    [],
  );

  assert.ok(response);

  const body = await response!.json() as {
    events: Array<{ type: string; payload: Record<string, unknown> }>;
  };

  const opened = body.events.find((event) => event.type === "TRADE_OPENED");
  assert.ok(opened);
  assert.equal(opened!.payload.fundId, "shark");
  assert.equal(opened!.payload.price, 0.4845);
  assert.equal(opened!.payload.entryPrice, 0.4845);

  const signal = body.events.find((event) => event.type === "SIGNAL_FOUND");
  assert.ok(signal);
  assert.equal(signal!.payload.signalId, "SIG-test-1");
  assert.equal(signal!.payload.confidence, 0.88);
  assert.equal(signal!.payload.direction, "SELL_YES");
  assert.equal(signal!.payload.marketId, "540844");
});
