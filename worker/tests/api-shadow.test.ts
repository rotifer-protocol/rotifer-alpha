import test from "node:test";
import assert from "node:assert/strict";

import { handleApi } from "../src/api";

class FakeShadowStatement {
  constructor(
    private readonly sql: string,
    private readonly db: FakeShadowDb,
  ) {}

  bind(..._args: unknown[]) {
    return this;
  }

  async all() {
    if (this.sql.includes("SELECT so.*") && this.sql.includes("FROM shadow_orders")) {
      this.db.orderSql = this.sql;
      return {
        results: [
          {
            id: "shadow-clean",
            paper_trade_id: "paper-clean",
            fund_id: "shark",
            market_id: "market-clean",
            slug: "clean-market",
            question: "Clean market?",
            status: "WOULD_FILL",
            paper_pnl: 12,
            shadow_pnl: 10,
            created_at: "2026-05-19T00:00:00.000Z",
          },
        ],
      };
    }
    throw new Error(`Unexpected all() query: ${this.sql}`);
  }

  async first() {
    if (this.sql.includes("COUNT(*) AS count") && this.sql.includes("FROM shadow_orders")) {
      this.db.summarySql = this.sql;
      return {
        count: 1,
        paper_pnl: -10,
        shadow_pnl: -11,
      };
    }
    throw new Error(`Unexpected first() query: ${this.sql}`);
  }

  async run() {
    throw new Error(`Unexpected run() query: ${this.sql}`);
  }
}

class FakeShadowDb {
  public orderSql = "";
  public summarySql = "";

  prepare(sql: string) {
    return new FakeShadowStatement(sql, this);
  }
}

test("api shadow excludes migrated and James Bond rows by default", async () => {
  const db = new FakeShadowDb();
  const response = await handleApi(
    "/api/shadow",
    new Request("http://localhost/api/shadow?limit=10"),
    { DB: db as unknown as D1Database } as never,
    [],
  );

  const body = await response!.json() as {
    orders: unknown[];
    excludedSummary: { count: number };
  };

  assert.equal(body.orders.length, 1);
  assert.equal(body.excludedSummary.count, 1);
  assert.match(db.orderSql, /monitor_reason NOT LIKE 'MIGRATED:%'/);
  assert.match(db.orderSql, /james bond/);
  assert.match(db.orderSql, /james-bond/);
});

test("api shadow can include invalidated rows for explicit audit views", async () => {
  const db = new FakeShadowDb();
  await handleApi(
    "/api/shadow",
    new Request("http://localhost/api/shadow?limit=10&includeInvalidated=1"),
    { DB: db as unknown as D1Database } as never,
    [],
  );

  assert.doesNotMatch(db.orderSql, /monitor_reason NOT LIKE 'MIGRATED:%'/);
});
