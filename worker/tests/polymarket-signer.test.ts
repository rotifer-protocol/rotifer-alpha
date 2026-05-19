/**
 * polymarket-signer.test.ts
 * ALPHA-001 Phase 2 · P2.5
 *
 * Tests for the pure / nearly-pure functions in polymarket-signer.ts:
 *   - buildOrderAmounts()          pure math, no I/O
 *   - buildHmacSig()               Web Crypto (available in Node ≥20)
 *   - privateKeyToWalletAddress()  deterministic key derivation
 *   - buildSignedOrderV2()         EIP-712 signing with a known test key
 *
 * Uses node:test (same framework as the rest of the worker test suite).
 * No real network calls; no real money.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOrderAmounts,
  buildHmacSig,
  privateKeyToWalletAddress,
  buildSignedOrderV2,
  CTF_EXCHANGE_V2,
  TOKEN_DECIMALS,
  ZERO_BYTES32,
} from "../src/polymarket-signer.js";

// ─── Known test private key (Ethereum test vector, never holds real funds) ────
// This is a well-known dev/test private key used in Ethereum documentation.
// Source: https://github.com/ethereum/tests (do NOT use for anything real)
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // checksummed

// ─── buildOrderAmounts ────────────────────────────────────────────────────────

test("buildOrderAmounts: BUY YES at price 0.60, size $10 USDC", () => {
  const r = buildOrderAmounts("YES", 10, 60);
  // clobSide = 0 (BUY)
  assert.equal(r.clobSide, 0);
  // shares = floor(10 / 0.60 * 100) / 100 = floor(16.666...) / 1 = 16.66
  assert.equal(r.sharesHuman, 16.66);
  // makerAmount = floor(10 * 1e6) = 10_000_000 (USDC)
  assert.equal(r.makerAmount, String(10 * TOKEN_DECIMALS));
  // takerAmount = floor(16.66 * 1e6) = 16_660_000 (shares)
  assert.equal(r.takerAmount, String(Math.floor(16.66 * TOKEN_DECIMALS)));
});

test("buildOrderAmounts: SELL YES at price 0.40, size $20 USDC", () => {
  const r = buildOrderAmounts("NO", 20, 40);
  // clobSide = 1 (SELL)
  assert.equal(r.clobSide, 1);
  // shares = floor(20 / 0.40 * 100) / 100 = 50.00
  assert.equal(r.sharesHuman, 50.0);
  // makerAmount = floor(50 * 1e6) = 50_000_000 (shares)
  assert.equal(r.makerAmount, String(50 * TOKEN_DECIMALS));
  // takerAmount = floor(20 * 1e6) = 20_000_000 (USDC)
  assert.equal(r.takerAmount, String(20 * TOKEN_DECIMALS));
});

test("buildOrderAmounts: shares floor correctly at fractional share count", () => {
  const r = buildOrderAmounts("YES", 5, 33); // price = 0.33
  // shares = floor(5 / 0.33 * 100) / 100 = floor(15.15...) / 1 = 15.15
  assert.ok(r.sharesHuman >= 15.15 && r.sharesHuman <= 15.16);
  // makerAmount must not exceed sizeUsdc * 1e6
  assert.ok(Number(r.makerAmount) <= 5 * TOKEN_DECIMALS);
  assert.equal(r.clobSide, 0); // YES = BUY
});

test("buildOrderAmounts: rejects price <= 0", () => {
  assert.throws(
    () => buildOrderAmounts("YES", 10, 0),
    /invalid inputs/,
  );
});

test("buildOrderAmounts: rejects price >= 100 (= 1.0)", () => {
  assert.throws(
    () => buildOrderAmounts("YES", 10, 100),
    /invalid inputs/,
  );
});

test("buildOrderAmounts: rejects sizeUsdc <= 0", () => {
  assert.throws(
    () => buildOrderAmounts("YES", 0, 50),
    /invalid inputs/,
  );
});

test("buildOrderAmounts: makerAmount and takerAmount are string-encoded non-negative integers", () => {
  const r = buildOrderAmounts("YES", 25, 75);
  assert.ok(/^\d+$/.test(r.makerAmount), "makerAmount must be non-negative integer string");
  assert.ok(/^\d+$/.test(r.takerAmount), "takerAmount must be non-negative integer string");
  assert.ok(Number(r.makerAmount) > 0);
  assert.ok(Number(r.takerAmount) > 0);
});

// ─── privateKeyToWalletAddress ────────────────────────────────────────────────

test("privateKeyToWalletAddress: derives correct checksummed address", () => {
  const addr = privateKeyToWalletAddress(TEST_PRIVATE_KEY);
  assert.equal(addr, TEST_ADDRESS);
});

test("privateKeyToWalletAddress: handles key without 0x prefix", () => {
  const addr = privateKeyToWalletAddress(TEST_PRIVATE_KEY.slice(2));
  assert.equal(addr, TEST_ADDRESS);
});

// ─── buildHmacSig ─────────────────────────────────────────────────────────────
// HMAC test uses Web Crypto (available in Node ≥20 with `--experimental-global-webcrypto`
// or Node ≥22 where it is available by default).

test("buildHmacSig: produces URL-safe base64 output", async () => {
  // A base64url-encoded 32-byte secret (test vector, not real credentials)
  const testSecret = "c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0MDA";
  const sig = await buildHmacSig(testSecret, 1716000000, "POST", "/order", '{"test":true}');
  // Must not contain + or /; may contain -, _, =
  assert.doesNotMatch(sig, /[+/]/);
  assert.ok(sig.length > 0);
  assert.ok(typeof sig === "string");
});

test("buildHmacSig: same inputs produce same signature (deterministic)", async () => {
  const testSecret = "c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0MDA";
  const ts = 1716000001;
  const a = await buildHmacSig(testSecret, ts, "GET", "/auth/derive-api-key");
  const b = await buildHmacSig(testSecret, ts, "GET", "/auth/derive-api-key");
  assert.equal(a, b);
});

test("buildHmacSig: different body produces different signature", async () => {
  const testSecret = "c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0MDA";
  const ts = 1716000002;
  const a = await buildHmacSig(testSecret, ts, "POST", "/order", '{"orderType":"FOK"}');
  const b = await buildHmacSig(testSecret, ts, "POST", "/order", '{"orderType":"GTC"}');
  assert.notEqual(a, b);
});

test("buildHmacSig: body=undefined and body='' produce the same signature (empty string appends nothing)", async () => {
  // This matches upstream clob-client-v2 behavior: msg += body where body=""
  // is identical to not calling msg += body at all.
  const testSecret = "c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0MDA";
  const ts = 1716000003;
  const withoutBody = await buildHmacSig(testSecret, ts, "GET", "/order");
  const withEmptyBody = await buildHmacSig(testSecret, ts, "GET", "/order", "");
  assert.equal(withoutBody, withEmptyBody);
});

test("buildHmacSig: non-empty body produces different signature than no body", async () => {
  const testSecret = "c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0MDA";
  const ts = 1716000004;
  const withoutBody = await buildHmacSig(testSecret, ts, "POST", "/order");
  const withBody = await buildHmacSig(testSecret, ts, "POST", "/order", '{"orderType":"FOK"}');
  assert.notEqual(withoutBody, withBody);
});

// ─── buildSignedOrderV2 ───────────────────────────────────────────────────────

test("buildSignedOrderV2: wire body has all required fields", async () => {
  const tokenId = "12345678901234567890123456789012345678901234567890"; // synthetic
  const amounts = buildOrderAmounts("YES", 10, 60);
  const order = await buildSignedOrderV2(TEST_PRIVATE_KEY, tokenId, amounts, CTF_EXCHANGE_V2);

  // Required fields in POST /order wire body
  assert.ok(order.salt,          "salt must be present");
  assert.ok(order.maker,         "maker must be present");
  assert.ok(order.signer,        "signer must be present");
  assert.ok(order.tokenId,       "tokenId must be present");
  assert.ok(order.makerAmount,   "makerAmount must be present");
  assert.ok(order.takerAmount,   "takerAmount must be present");
  assert.ok(order.side,          "side must be present");
  assert.ok(order.timestamp,     "timestamp must be present");
  assert.ok(order.signature,     "signature must be present");
  assert.equal(order.signatureType, 0, "signatureType must be 0 (EOA)");
  assert.equal(order.metadata, ZERO_BYTES32);
  assert.equal(order.builder,  ZERO_BYTES32);
  assert.equal(order.expiration, "0");
});

test("buildSignedOrderV2: maker and signer are the EOA address", async () => {
  const tokenId = "99999";
  const amounts = buildOrderAmounts("YES", 5, 50);
  const order = await buildSignedOrderV2(TEST_PRIVATE_KEY, tokenId, amounts);
  assert.equal(order.maker,  TEST_ADDRESS);
  assert.equal(order.signer, TEST_ADDRESS);
});

test("buildSignedOrderV2: side is BUY for YES intent", async () => {
  const amounts = buildOrderAmounts("YES", 10, 60);
  const order = await buildSignedOrderV2(TEST_PRIVATE_KEY, "1", amounts);
  assert.equal(order.side, "BUY");
});

test("buildSignedOrderV2: side is SELL for NO intent", async () => {
  const amounts = buildOrderAmounts("NO", 10, 40);
  const order = await buildSignedOrderV2(TEST_PRIVATE_KEY, "1", amounts);
  assert.equal(order.side, "SELL");
});

test("buildSignedOrderV2: signature is a valid hex string (0x + 130 hex chars = 65 bytes)", async () => {
  const amounts = buildOrderAmounts("YES", 10, 60);
  const order = await buildSignedOrderV2(TEST_PRIVATE_KEY, "42", amounts);
  // EIP-712 signature: 65 bytes = 130 hex chars + "0x" prefix
  assert.match(order.signature, /^0x[0-9a-fA-F]{130}$/);
});

test("buildSignedOrderV2: salt is a unique decimal string per call", async () => {
  const amounts = buildOrderAmounts("YES", 10, 60);
  const a = await buildSignedOrderV2(TEST_PRIVATE_KEY, "1", amounts);
  const b = await buildSignedOrderV2(TEST_PRIVATE_KEY, "1", amounts);
  // Salt should be different (random) each call
  assert.notEqual(a.salt, b.salt);
});

test("buildSignedOrderV2: amounts match input", async () => {
  const amounts = buildOrderAmounts("YES", 10, 60);
  const order = await buildSignedOrderV2(TEST_PRIVATE_KEY, "888", amounts);
  assert.equal(order.makerAmount, amounts.makerAmount);
  assert.equal(order.takerAmount, amounts.takerAmount);
  assert.equal(order.tokenId, "888");
});
