import test from "node:test";
import assert from "node:assert/strict";

import { handleApi } from "../src/api";

interface ExecutedQuery {
  sql: string;
  bindings: unknown[];
}

class FakeStatement {
  constructor(
    private readonly sql: string,
    private readonly db: FakeDb,
  ) {}

  bind(...args: unknown[]) {
    this.db.lastQuery = { sql: this.sql, bindings: args };
    return {
      all: async () => ({ results: this.db.rows }),
      first: async () => null,
      run: async () => {},
    };
  }
}

class FakeDb {
  public lastQuery: ExecutedQuery | null = null;
  public rows: Record<string, unknown>[] = [];

  prepare(sql: string) {
    return new FakeStatement(sql, this);
  }
}

function callTrades(url: string, db: FakeDb) {
  return handleApi(
    "/api/trades",
    new Request(url),
    { DB: db as unknown as D1Database } as never,
    [],
  );
}

test("apiTrades without time filter still honors explicit limit up to 1000", async () => {
  const db = new FakeDb();
  await callTrades("http://localhost/api/trades?limit=500", db);

  assert.ok(db.lastQuery, "query must run");
  const limit = db.lastQuery!.bindings[db.lastQuery!.bindings.length - 1];
  assert.equal(limit, 500, "explicit ?limit=500 should pass through even without a time filter");
  assert.doesNotMatch(db.lastQuery!.sql, /COALESCE\(closed_at, opened_at\)\s*>=/);
  assert.doesNotMatch(db.lastQuery!.sql, /COALESCE\(closed_at, opened_at\)\s*<=/);
});

test("apiTrades without time filter uses default 50 when limit not provided", async () => {
  const db = new FakeDb();
  await callTrades("http://localhost/api/trades", db);

  assert.equal(
    db.lastQuery!.bindings[db.lastQuery!.bindings.length - 1],
    50,
    "no limit param + no time filter → conservative 50 default",
  );
});

test("apiTrades since adds >= filter and lifts default limit to 500", async () => {
  const db = new FakeDb();
  await callTrades("http://localhost/api/trades?since=2026-05-20", db);

  assert.match(db.lastQuery!.sql, /COALESCE\(closed_at, opened_at\) >= \?/);
  assert.equal(db.lastQuery!.bindings[0], "2026-05-20T00:00:00.000Z");
  assert.equal(
    db.lastQuery!.bindings[db.lastQuery!.bindings.length - 1],
    500,
    "default limit should jump to 500 when a time filter is active",
  );
});

test("apiTrades until adds <= filter with ISO normalization", async () => {
  const db = new FakeDb();
  await callTrades(
    "http://localhost/api/trades?until=2026-05-22T23:59:59.999Z",
    db,
  );

  assert.match(db.lastQuery!.sql, /COALESCE\(closed_at, opened_at\) <= \?/);
  assert.equal(db.lastQuery!.bindings[0], "2026-05-22T23:59:59.999Z");
});

test("apiTrades since + until combine in WHERE", async () => {
  const db = new FakeDb();
  await callTrades(
    "http://localhost/api/trades?since=2026-05-20&until=2026-05-22",
    db,
  );

  assert.match(db.lastQuery!.sql, />= \?/);
  assert.match(db.lastQuery!.sql, /<= \?/);
  assert.equal(db.lastQuery!.bindings[0], "2026-05-20T00:00:00.000Z");
  assert.equal(db.lastQuery!.bindings[1], "2026-05-22T00:00:00.000Z");
});

test("apiTrades silently ignores an unparseable since", async () => {
  const db = new FakeDb();
  await callTrades("http://localhost/api/trades?since=not-a-date", db);

  assert.doesNotMatch(db.lastQuery!.sql, /COALESCE\(closed_at, opened_at\) >=/);
  assert.equal(
    db.lastQuery!.bindings[db.lastQuery!.bindings.length - 1],
    50,
    "invalid time filter must not trigger the higher default limit",
  );
});

test("apiTrades with time filter caps limit at 1000", async () => {
  const db = new FakeDb();
  await callTrades(
    "http://localhost/api/trades?since=2026-05-20&limit=5000",
    db,
  );

  assert.equal(db.lastQuery!.bindings[db.lastQuery!.bindings.length - 1], 1000);
});

test("apiTrades combines status, fund, and time filters in binding order", async () => {
  const db = new FakeDb();
  await callTrades(
    "http://localhost/api/trades?status=STOPPED&fund=shark&since=2026-05-20",
    db,
  );

  assert.deepEqual(db.lastQuery!.bindings, [
    "STOPPED",
    "shark",
    "2026-05-20T00:00:00.000Z",
    500,
  ]);
  assert.match(
    db.lastQuery!.sql,
    /status = \? AND fund_id = \? AND COALESCE\(closed_at, opened_at\) >= \?/,
  );
});
