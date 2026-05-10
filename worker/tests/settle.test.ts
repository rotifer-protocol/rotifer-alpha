/**
 * Settlement fallback tests.
 *
 * Regression context (2026-05-10): scanner only fetches active/closed=false
 * markets, so already-resolved markets can disappear from the in-memory market
 * list while their restored OPEN positions remain stale. The settler must fetch
 * Gamma by market_id and settle closed/resolved positions even when CLOB book is
 * unavailable.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { settle } from "../src/settle";
import type { FundConfig } from "../src/types";

interface TradeRow {
  id: string;
  fund_id: string;
  market_id: string;
  slug: string;
  question: string;
  direction: string;
  entry_price: number;
  shares: number;
  amount: number;
  status: string;
}

function makeDb(trades: TradeRow[]) {
  const rows = trades.map(row => ({ ...row }));
  const updates: { sql: string; args: unknown[] }[] = [];

  return {
    rows,
    updates,
    db: {
      prepare(sql: string) {
        let bound: unknown[] = [];
        return {
          bind(...args: unknown[]) {
            bound = args;
            return this;
          },
          async all() {
            if (sql.includes("SELECT * FROM paper_trades WHERE status = 'OPEN'")) {
              return { results: rows.filter(row => row.status === "OPEN") };
            }
            return { results: [] };
          },
          async first() {
            if (sql.includes("FROM system_config WHERE key = 'EXECUTION_MODE'")) {
              return { value: "paper" };
            }
            return null;
          },
          async run() {
            updates.push({ sql, args: bound });
            if (sql.includes("UPDATE paper_trades SET status = 'RESOLVED'")) {
              const [exitPrice, pnl, closedAt, monitorReason, id] = bound as [number, number, string, string, string];
              const row = rows.find(trade => trade.id === id);
              if (row) {
                row.status = "RESOLVED";
                Object.assign(row, { exit_price: exitPrice, pnl, closed_at: closedAt, monitor_reason: monitorReason });
              }
            }
            return {};
          },
        };
      },
    } as unknown as D1Database,
  };
}

function mockFetch(body: unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch;
  return () => { globalThis.fetch = original; };
}

const funds = [{ id: "gambler_l", emoji: "G" }] as FundConfig[];

test("settle: Gamma fallback resolves missing scanner market where NO won", async () => {
  const { db, rows } = makeDb([
    {
      id: "trade-1",
      fund_id: "gambler_l",
      market_id: "553843",
      slug: "flyers",
      question: "Will the Philadelphia Flyers win the 2026 NHL Stanley Cup?",
      direction: "SELL_YES",
      entry_price: 0.023,
      shares: 8695652.173913043,
      amount: 200000,
      status: "OPEN",
    },
  ]);
  const restore = mockFetch({
    id: "553843",
    question: "Will the Philadelphia Flyers win the 2026 NHL Stanley Cup?",
    slug: "will-the-philadelphia-flyers-win-the-2026-nhl-stanley-cup",
    outcomes: "[\"Yes\", \"No\"]",
    outcomePrices: "[\"0\", \"1\"]",
    active: true,
    closed: true,
  });

  try {
    const settlements = await settle(db, [], funds);

    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].status, "RESOLVED");
    assert.equal(settlements[0].exitPrice, 0);
    assert.equal(settlements[0].pnl, 200000);
    assert.equal(rows[0].status, "RESOLVED");
  } finally {
    restore();
  }
});

test("settle: Gamma fallback resolves BUY_YES loss when NO won", async () => {
  const { db, rows } = makeDb([
    {
      id: "trade-2",
      fund_id: "gambler_l",
      market_id: "553843",
      slug: "flyers",
      question: "Will the Philadelphia Flyers win the 2026 NHL Stanley Cup?",
      direction: "BUY_YES",
      entry_price: 0.2,
      shares: 1000,
      amount: 200,
      status: "OPEN",
    },
  ]);
  const restore = mockFetch({
    id: "553843",
    question: "Will the Philadelphia Flyers win the 2026 NHL Stanley Cup?",
    outcomes: "[\"Yes\", \"No\"]",
    outcomePrices: "[\"0\", \"1\"]",
    active: true,
    closed: true,
  });

  try {
    const settlements = await settle(db, [], funds);

    assert.equal(settlements.length, 1);
    assert.equal(settlements[0].exitPrice, 0);
    assert.equal(settlements[0].pnl, -200);
    assert.equal(rows[0].status, "RESOLVED");
  } finally {
    restore();
  }
});
