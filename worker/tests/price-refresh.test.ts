/**
 * Pyramid mid layer: integration tests for refreshOpenPrices().
 *
 * Mocks:
 *   - global fetch (Gamma + CLOB)
 *   - D1Database (in-memory implementation)
 *
 * Verifies the full D-Lite refresh cycle:
 *   load OPEN trades → backfill missing token_ids → batch CLOB mid →
 *   write last_price + last_price_updated_at → return telemetry.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { refreshOpenPrices } from "../src/price-refresh";

interface Row {
  id: string;
  market_id: string;
  token_id: string | null;
  last_price: number | null;
  last_price_updated_at: string | null;
}

/**
 * Tiny in-memory D1 mock — only implements what refreshOpenPrices touches.
 * Captures all UPDATE statements so tests can assert what got written.
 *
 * Mirrors the D1 prepared-statement chain shape used by the source:
 *   db.prepare(sql).all<T>()                             // SELECT directly
 *   db.prepare(sql).bind(...args).run()                  // UPDATE
 *   db.batch([db.prepare(...).bind(...)])                // batch UPDATE
 *
 * Each statement object carries both the unbound chain (.all/.bind) AND
 * the bound chain (.run after .bind), so the same shim works for both.
 */
function makeDb(initialRows: Row[]) {
  const rows = initialRows.map(r => ({ ...r }));
  const updates: { sql: string; args: unknown[] }[] = [];

  function makeStmt(sql: string, boundArgs: unknown[] | null) {
    return {
      bind: (...args: unknown[]) => makeStmt(sql, args),
      all: async <T>() => {
        if (sql.includes("SELECT id, market_id, token_id FROM paper_trades")) {
          return { results: rows.map(r => ({ id: r.id, market_id: r.market_id, token_id: r.token_id })) as unknown as T[] };
        }
        return { results: [] as T[] };
      },
      run: async () => {
        const args = boundArgs ?? [];
        updates.push({ sql, args });
        applyUpdate(sql, args, rows);
        return {};
      },
    };
  }

  const db = {
    prepare: (sql: string) => makeStmt(sql, null),
    batch: async (stmts: any[]) => {
      for (const s of stmts) await s.run();
      return [];
    },
  } as any;

  return { db, rows, updates };
}

function applyUpdate(sql: string, args: unknown[], rows: Row[]): void {
  if (sql.includes("UPDATE paper_trades SET token_id = ? WHERE id = ?")) {
    const [tokenId, id] = args as [string, string];
    const row = rows.find(r => r.id === id);
    if (row) row.token_id = tokenId;
  } else if (sql.includes("UPDATE paper_trades SET last_price = ?, last_price_updated_at = ? WHERE id = ?")) {
    const [price, ts, id] = args as [number, string, string];
    const row = rows.find(r => r.id === id);
    if (row) {
      row.last_price = price;
      row.last_price_updated_at = ts;
    }
  }
}

/** Mock global.fetch with route-based responses. */
function mockFetch(routes: Record<string, () => unknown>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    for (const pattern of Object.keys(routes)) {
      if (u.includes(pattern)) {
        const body = routes[pattern]();
        if (body === null) {
          return { ok: false, status: 500, json: async () => ({}) } as Response;
        }
        return { ok: true, status: 200, json: async () => body } as Response;
      }
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
  return () => { globalThis.fetch = original; };
}

// ─── Tests ───────────────────────────────────────────────

test("refreshOpenPrices: empty OPEN set returns zero counts", async () => {
  const { db } = makeDb([]);
  const restore = mockFetch({});
  try {
    const r = await refreshOpenPrices(db);
    assert.equal(r.totalOpen, 0);
    assert.equal(r.refreshed, 0);
    assert.equal(r.fetchFailed, 0);
    assert.equal(r.missingTokenId, 0);
    assert.equal(r.backfilledTokenIds, 0);
  } finally {
    restore();
  }
});

test("refreshOpenPrices: fully-backfilled rows refresh last_price via CLOB", async () => {
  const { db, rows } = makeDb([
    { id: "t1", market_id: "m1", token_id: "tok-1", last_price: 0.5, last_price_updated_at: "2026-01-01T00:00:00Z" },
    { id: "t2", market_id: "m2", token_id: "tok-2", last_price: 0.3, last_price_updated_at: "2026-01-01T00:00:00Z" },
  ]);
  const restore = mockFetch({
    "clob.polymarket.com/book?token_id=tok-1": () => ({
      // Spread 0.10 = at the CLOB_MAX_SPREAD boundary; mid = 0.6 (accepted).
      bids: [{ price: "0.55", size: "100" }],
      asks: [{ price: "0.65", size: "100" }],
    }),
    "clob.polymarket.com/book?token_id=tok-2": () => ({
      bids: [{ price: "0.35", size: "100" }],
      asks: [{ price: "0.45", size: "100" }],
    }),
  });
  try {
    const r = await refreshOpenPrices(db);
    assert.equal(r.totalOpen, 2);
    assert.equal(r.refreshed, 2);
    assert.equal(r.fetchFailed, 0);
    assert.equal(r.missingTokenId, 0);
    // Approx compare for IEEE-754 (0.55+0.65)/2 = 0.6000000000000001 etc.
    assert.ok(rows[0].last_price !== null && Math.abs(rows[0].last_price - 0.6) < 1e-9);
    assert.ok(rows[1].last_price !== null && Math.abs(rows[1].last_price - 0.4) < 1e-9);
    assert.notEqual(rows[0].last_price_updated_at, "2026-01-01T00:00:00Z");
  } finally {
    restore();
  }
});

test("refreshOpenPrices: NULL token_id triggers Gamma backfill, then CLOB refresh", async () => {
  const { db, rows } = makeDb([
    { id: "t1", market_id: "m1", token_id: null, last_price: null, last_price_updated_at: null },
  ]);
  const restore = mockFetch({
    "gamma-api.polymarket.com/markets/m1": () => ({
      clobTokenIds: ["new-tok-1", "new-tok-1-no"],
    }),
    "clob.polymarket.com/book?token_id=new-tok-1": () => ({
      bids: [{ price: "0.45", size: "100" }],
      asks: [{ price: "0.55", size: "100" }],
    }),
  });
  try {
    const r = await refreshOpenPrices(db);
    assert.equal(r.missingTokenId, 1);
    assert.equal(r.backfilledTokenIds, 1);
    assert.equal(r.refreshed, 1);
    assert.equal(rows[0].token_id, "new-tok-1");
    assert.equal(rows[0].last_price, 0.5);
  } finally {
    restore();
  }
});

test("refreshOpenPrices: Gamma backfill failure → row stays NULL, fetchFailed++", async () => {
  const { db, rows } = makeDb([
    { id: "t1", market_id: "m1", token_id: null, last_price: null, last_price_updated_at: null },
  ]);
  const restore = mockFetch({
    "gamma-api.polymarket.com/markets/m1": () => null, // simulate 500
  });
  try {
    const r = await refreshOpenPrices(db);
    assert.equal(r.missingTokenId, 1);
    assert.equal(r.backfilledTokenIds, 0);
    assert.equal(r.refreshed, 0);
    assert.equal(r.fetchFailed, 1);
    assert.equal(rows[0].token_id, null);
    assert.equal(rows[0].last_price, null);  // never written
  } finally {
    restore();
  }
});

test("refreshOpenPrices: CLOB failure → last_price retained, fetchFailed++", async () => {
  const oldTs = "2026-04-01T00:00:00Z";
  const { db, rows } = makeDb([
    { id: "t1", market_id: "m1", token_id: "tok-1", last_price: 0.4, last_price_updated_at: oldTs },
  ]);
  const restore = mockFetch({
    "clob.polymarket.com/book": () => null, // simulate 500
  });
  try {
    const r = await refreshOpenPrices(db);
    assert.equal(r.totalOpen, 1);
    assert.equal(r.refreshed, 0);
    assert.equal(r.fetchFailed, 1);
    // Old last_price + ts retained — caller's isStale() will detect.
    assert.equal(rows[0].last_price, 0.4);
    assert.equal(rows[0].last_price_updated_at, oldTs);
  } finally {
    restore();
  }
});

test("refreshOpenPrices: same market_id deduped to one Gamma fetch", async () => {
  // Two trades on the same market — only one Gamma call should happen.
  let gammaCalls = 0;
  const { db, rows } = makeDb([
    { id: "t1", market_id: "m1", token_id: null, last_price: null, last_price_updated_at: null },
    { id: "t2", market_id: "m1", token_id: null, last_price: null, last_price_updated_at: null },
  ]);
  const restore = mockFetch({
    "gamma-api.polymarket.com/markets/m1": () => {
      gammaCalls++;
      return { clobTokenIds: ["shared-tok"] };
    },
    "clob.polymarket.com/book?token_id=shared-tok": () => ({
      // Spread 0.10 (at boundary, accepted) — mid = 0.5.
      bids: [{ price: "0.45", size: "100" }],
      asks: [{ price: "0.55", size: "100" }],
    }),
  });
  try {
    const r = await refreshOpenPrices(db);
    assert.equal(gammaCalls, 1);
    assert.equal(r.backfilledTokenIds, 2); // both rows share the discovered tok
    assert.equal(rows[0].token_id, "shared-tok");
    assert.equal(rows[1].token_id, "shared-tok");
  } finally {
    restore();
  }
});

test("refreshOpenPrices: thin CLOB book (0.01/0.99) treated as fetchFailed (round-2 fix)", async () => {
  // Regression for the 2026-05-10 incident: D-Lite v1 wrote last_price=0.5
  // for any market whose CLOB book had min-tick floor + max-tick ceiling.
  // After spread-filter fix: clobMidPrice → null → row keeps prior last_price
  // and increments fetchFailed (caller's isStale gate handles the dashboard).
  const oldTs = "2026-04-01T00:00:00Z";
  const { db, rows } = makeDb([
    { id: "thin", market_id: "m-thin", token_id: "tok-thin", last_price: 0.4, last_price_updated_at: oldTs },
  ]);
  const restore = mockFetch({
    "clob.polymarket.com/book?token_id=tok-thin": () => ({
      bids: [{ price: "0.01", size: "1" }],
      asks: [{ price: "0.99", size: "1" }],
    }),
  });
  try {
    const r = await refreshOpenPrices(db);
    assert.equal(r.totalOpen, 1);
    assert.equal(r.refreshed, 0);
    assert.equal(r.fetchFailed, 1);
    // Critical: last_price NOT overwritten with 0.5 placeholder.
    assert.equal(rows[0].last_price, 0.4);
    assert.equal(rows[0].last_price_updated_at, oldTs);
  } finally {
    restore();
  }
});

test("refreshOpenPrices: mixed fresh + missing + failed — partial success isolated", async () => {
  const { db, rows } = makeDb([
    { id: "ok",   market_id: "m-ok",   token_id: "tok-ok",   last_price: 0.4, last_price_updated_at: "2026-01-01T00:00:00Z" },
    { id: "miss", market_id: "m-miss", token_id: null,       last_price: null, last_price_updated_at: null },
    { id: "fail", market_id: "m-fail", token_id: "tok-fail", last_price: 0.7, last_price_updated_at: "2026-01-01T00:00:00Z" },
  ]);
  const restore = mockFetch({
    "gamma-api.polymarket.com/markets/m-miss": () => ({ clobTokenIds: ["tok-miss"] }),
    "clob.polymarket.com/book?token_id=tok-ok": () => ({
      bids: [{ price: "0.5", size: "1" }],
      asks: [{ price: "0.5", size: "1" }],
    }),
    "clob.polymarket.com/book?token_id=tok-miss": () => ({
      bids: [{ price: "0.3", size: "1" }],
      asks: [{ price: "0.3", size: "1" }],
    }),
    "clob.polymarket.com/book?token_id=tok-fail": () => null,
  });
  try {
    const r = await refreshOpenPrices(db);
    assert.equal(r.totalOpen, 3);
    assert.equal(r.missingTokenId, 1);
    assert.equal(r.backfilledTokenIds, 1);
    assert.equal(r.refreshed, 2);
    assert.equal(r.fetchFailed, 1);
    assert.equal(rows[0].last_price, 0.5);
    assert.equal(rows[1].token_id, "tok-miss");
    assert.equal(rows[1].last_price, 0.3);
    // failed row keeps old price + ts
    assert.equal(rows[2].last_price, 0.7);
  } finally {
    restore();
  }
});
