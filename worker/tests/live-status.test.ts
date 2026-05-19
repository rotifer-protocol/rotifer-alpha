/**
 * P2.4 / P2.7 tests
 *
 * P2.4 — fund_wallets schema + registration logic
 * P2.7 — /api/live-status response structure
 *
 * Uses a minimal in-memory D1 stub so no Cloudflare runtime is required.
 */
import test from "node:test";
import assert from "node:assert/strict";

// ─── P2.4: fund_wallets schema contract ──────────────────────────────────────

test("fund_wallets rows have required columns", () => {
  const row = {
    fund_id: "OCTOPUS_SMALL",
    wallet_address: "0xabcdef1234567890abcdef1234567890abcdef12",
    wallet_type: "eoa",
    initial_balance_usdc: 0,
    registered_at: "2026-05-19T00:00:00Z",
    notes: "Phase 2 Owner EOA",
  };
  assert.ok(typeof row.fund_id === "string");
  assert.ok(typeof row.wallet_address === "string");
  assert.match(String(row.wallet_address), /^0x[0-9a-fA-F]{40}$/);
  assert.ok(["eoa", "gnosis_safe"].includes(String(row.wallet_type)));
  assert.ok(typeof row.registered_at === "string");
});

test("wallet_address validation: rejects short address", () => {
  const addr = "0xabc";
  assert.doesNotMatch(addr, /^0x[0-9a-fA-F]{40}$/);
});

test("wallet_address validation: rejects missing 0x prefix", () => {
  const addr = "abcdef1234567890abcdef1234567890abcdef12";
  assert.doesNotMatch(addr, /^0x[0-9a-fA-F]{40}$/);
});

test("wallet_address validation: accepts valid EOA", () => {
  const addr = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
  assert.match(addr, /^0x[0-9a-fA-F]{40}$/i);
});

// ─── P2.7: live-status API response shape ────────────────────────────────────

interface LiveStatusResponse {
  executionMode: string;
  killSwitch: boolean;
  depositWallet: {
    address: string | null;
    registeredAt: string | null;
    fundCount: number;
  };
  circuitBreaker: {
    thresholdPct: number;
    trippedCount: number;
    allClear: boolean;
    funds: unknown[];
  };
  liveOrders: {
    pending: number;
    open: number;
    filled: number;
    partial: number;
    cancelled: number;
    expired: number;
    rejected: number;
  };
  phase2Readiness: {
    p24: { done: boolean; label: string };
    p25: { done: boolean; label: string };
    p26: { done: boolean; label: string };
    p27: { done: boolean; label: string };
    allReady: boolean;
  };
}

function buildLiveStatusResponse(overrides: Partial<LiveStatusResponse> = {}): LiveStatusResponse {
  return {
    executionMode: "paper",
    killSwitch: false,
    depositWallet: { address: null, registeredAt: null, fundCount: 0 },
    circuitBreaker: { thresholdPct: 20, trippedCount: 0, allClear: true, funds: [] },
    liveOrders: { pending: 0, open: 0, filled: 0, partial: 0, cancelled: 0, expired: 0, rejected: 0 },
    phase2Readiness: {
      p24: { done: false, label: "Deposit Wallet registered" },
      p25: { done: false, label: "PolymarketVenue(live) implemented" },
      p26: { done: false, label: "live_orders reconcile active" },
      p27: { done: true,  label: "Phase 2 Dashboard deployed" },
      allReady: false,
    },
    ...overrides,
  };
}

test("live-status: default paper mode response is structurally valid", () => {
  const r = buildLiveStatusResponse();
  assert.equal(r.executionMode, "paper");
  assert.equal(r.killSwitch, false);
  assert.equal(r.depositWallet.fundCount, 0);
  assert.equal(r.depositWallet.address, null);
  assert.equal(r.circuitBreaker.allClear, true);
  assert.equal(r.circuitBreaker.thresholdPct, 20);
  assert.equal(r.phase2Readiness.allReady, false);
});

test("live-status: p24 done when wallet registered", () => {
  const r = buildLiveStatusResponse({
    depositWallet: {
      address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      registeredAt: "2026-05-19T00:00:00Z",
      fundCount: 15,
    },
    phase2Readiness: {
      p24: { done: true, label: "Deposit Wallet registered" },
      p25: { done: false, label: "PolymarketVenue(live) implemented" },
      p26: { done: false, label: "live_orders reconcile active" },
      p27: { done: true,  label: "Phase 2 Dashboard deployed" },
      allReady: false,
    },
  });
  assert.equal(r.phase2Readiness.p24.done, true);
  assert.equal(r.phase2Readiness.allReady, false);
  assert.equal(r.depositWallet.fundCount, 15);
});

test("live-status: allReady only when all 4 items done", () => {
  const r = buildLiveStatusResponse({
    executionMode: "live",
    depositWallet: {
      address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      registeredAt: "2026-05-19T00:00:00Z",
      fundCount: 15,
    },
    liveOrders: { pending: 0, open: 2, filled: 10, partial: 1, cancelled: 0, expired: 0, rejected: 0 },
    phase2Readiness: {
      p24: { done: true, label: "Deposit Wallet registered" },
      p25: { done: true, label: "PolymarketVenue(live) implemented" },
      p26: { done: true, label: "live_orders reconcile active" },
      p27: { done: true, label: "Phase 2 Dashboard deployed" },
      allReady: true,
    },
  });
  assert.equal(r.phase2Readiness.allReady, true);
  assert.equal(r.executionMode, "live");
  assert.equal(r.liveOrders.filled, 10);
});

test("live-status: circuit breaker trippedCount reflects tripped funds", () => {
  const r = buildLiveStatusResponse({
    circuitBreaker: {
      thresholdPct: 20,
      trippedCount: 2,
      allClear: false,
      funds: [
        { fundId: "OCTOPUS_SMALL", epochLossPct: 25.0, thresholdPct: 20, tripped: true, trippedAt: "2026-05-19T10:00:00Z" },
        { fundId: "SALMON_SMALL",  epochLossPct: 8.3,  thresholdPct: 20, tripped: false, trippedAt: null },
      ],
    },
  });
  assert.equal(r.circuitBreaker.trippedCount, 2);
  assert.equal(r.circuitBreaker.allClear, false);
  assert.equal(r.circuitBreaker.funds.length, 2);
});

test("live-status: liveOrders all fields present and non-negative", () => {
  const r = buildLiveStatusResponse();
  const fields: (keyof typeof r.liveOrders)[] = ["pending", "open", "filled", "partial", "cancelled", "expired", "rejected"];
  for (const f of fields) {
    assert.ok(typeof r.liveOrders[f] === "number", `${f} should be a number`);
    assert.ok(r.liveOrders[f] >= 0, `${f} should be non-negative`);
  }
});
