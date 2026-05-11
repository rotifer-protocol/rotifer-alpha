import test from "node:test";
import assert from "node:assert/strict";

import { handleApi } from "../src/api";

interface DriverRow {
  market_id: string;
  question: string;
  slug: string | null;
  net_pnl: number;
  gross_profit: number;
  gross_loss: number;
  trade_count: number;
  fund_count: number;
  last_closed_at: string | null;
}

interface TotalsRow {
  total_net: number;
  total_abs: number;
  total_count: number;
}

class DriverStmt {
  constructor(
    private readonly sql: string,
    private readonly drivers: DriverRow[],
    private readonly totals: TotalsRow,
    private readonly cutoffSink: { value: string | null },
  ) {}

  bind(...args: unknown[]) {
    if (args.length > 0) this.cutoffSink.value = String(args[0]);
    const sql = this.sql;
    const drivers = this.drivers;
    const totals = this.totals;
    return {
      all: async () => {
        if (sql.includes("GROUP BY market_id")) {
          return { results: drivers as unknown as Record<string, unknown>[] };
        }
        throw new Error(`Unexpected all() query: ${sql}`);
      },
      first: async () => {
        if (sql.includes("SUM(ABS(COALESCE(pnl, 0)))")) {
          return totals as unknown as Record<string, unknown>;
        }
        throw new Error(`Unexpected first() query: ${sql}`);
      },
      run: async () => {
        throw new Error(`Unexpected run() query: ${sql}`);
      },
    };
  }
}

class DriverDb {
  cutoff: { value: string | null } = { value: null };
  constructor(
    private readonly drivers: DriverRow[],
    private readonly totals: TotalsRow,
  ) {}
  prepare(sql: string) {
    return new DriverStmt(sql, this.drivers, this.totals, this.cutoff);
  }
}

const sampleDrivers: DriverRow[] = [
  {
    market_id: "M-NBA",
    question: "2026 NBA Champion",
    slug: "nba-champ",
    net_pnl: 28800,
    gross_profit: 28800,
    gross_loss: 0,
    trade_count: 3,
    fund_count: 3,
    last_closed_at: "2026-05-11T00:10:00Z",
  },
  {
    market_id: "M-WC",
    question: "NBA Western Conf Champion",
    slug: "nba-wc",
    net_pnl: -13000,
    gross_profit: 700,
    gross_loss: -13700,
    trade_count: 7,
    fund_count: 4,
    last_closed_at: "2026-05-11T01:20:00Z",
  },
  {
    market_id: "M-NHL",
    question: "NHL Stanley Cup",
    slug: null,
    net_pnl: -5934,
    gross_profit: 0,
    gross_loss: -5934,
    trade_count: 1,
    fund_count: 1,
    last_closed_at: "2026-05-11T01:10:00Z",
  },
];

const sampleTotals: TotalsRow = {
  total_net: 14571,
  total_abs: 47634,
  total_count: 33,
};

async function callDrivers(hoursParam: string | null): Promise<{ db: DriverDb; body: any }> {
  const db = new DriverDb(sampleDrivers, sampleTotals);
  const url = hoursParam == null
    ? "http://localhost/api/market-drivers"
    : `http://localhost/api/market-drivers?hours=${hoursParam}`;
  const res = await handleApi(
    "/api/market-drivers",
    new Request(url),
    { DB: db as unknown as D1Database } as never,
    [],
  );
  assert.ok(res);
  const body = await res!.json();
  return { db, body };
}

test("market-drivers default window is 3 hours", async () => {
  const { db, body } = await callDrivers(null);
  assert.equal(body.windowHours, 3);
  const cutoff = db.cutoff.value;
  assert.ok(cutoff, "cutoff should be bound");
  const cutoffMs = new Date(cutoff!).getTime();
  const expectedMs = Date.now() - 3 * 60 * 60 * 1000;
  // Allow 5s skew between request and Date.now() in test.
  assert.ok(Math.abs(cutoffMs - expectedMs) < 5000, `cutoff ${cutoff} too far from expected`);
});

test("market-drivers honors valid hours param and rounds totals", async () => {
  const { db, body } = await callDrivers("12");
  assert.equal(body.windowHours, 12);
  const cutoffMs = new Date(db.cutoff.value!).getTime();
  const expectedMs = Date.now() - 12 * 60 * 60 * 1000;
  assert.ok(Math.abs(cutoffMs - expectedMs) < 5000);

  assert.equal(body.totalNet, 14571);
  assert.equal(body.totalAbs, 47634);
  assert.equal(body.totalCount, 33);
});

test("market-drivers rejects invalid hours and falls back to 3", async () => {
  const cases = ["999", "abc", "0", "-1", "5"];
  for (const c of cases) {
    const { body } = await callDrivers(c);
    assert.equal(body.windowHours, 3, `hours=${c} should fall back to 3`);
  }
});

test("market-drivers shapes drivers payload (fields + types)", async () => {
  const { body } = await callDrivers("3");
  assert.equal(body.drivers.length, 3);
  const first = body.drivers[0];
  assert.equal(first.marketId, "M-NBA");
  assert.equal(first.question, "2026 NBA Champion");
  assert.equal(first.slug, "nba-champ");
  assert.equal(first.netPnl, 28800);
  assert.equal(first.grossProfit, 28800);
  assert.equal(first.grossLoss, 0);
  assert.equal(first.tradeCount, 3);
  assert.equal(first.fundCount, 3);
  assert.equal(first.lastClosedAt, "2026-05-11T00:10:00Z");

  const nullSlug = body.drivers[2];
  assert.equal(nullSlug.slug, null, "null slug should be preserved as null");
});
