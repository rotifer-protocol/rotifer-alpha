/**
 * Polymarket API credential lifecycle — ALPHA-001 Phase 2 · P2.5
 *
 * Manages the two-level authentication required by CLOB V2 trading endpoints:
 *
 *   L1 — EIP-712 sign ClobAuthDomain → derive API credentials (one-time, cached in D1)
 *   L2 — HMAC-SHA256 per-request headers using the stored credentials
 *
 * Credentials are idempotent: the same nonce=0 always returns the same
 * {apiKey, secret, passphrase} for a given wallet. Re-derivation is safe to
 * call at any time; D1 caching avoids unnecessary network round-trips.
 *
 * Required Worker secret (set via `wrangler secret put OWNER_PRIVATE_KEY`):
 *   OWNER_PRIVATE_KEY — Owner EOA private key for the Polymarket wallet
 *
 * References:
 *   https://docs.polymarket.com/api-reference/authentication
 *   https://github.com/Polymarket/clob-client-v2/src/signing/hmac.ts
 */

import { buildHmacSig, signClobAuth } from "./polymarket-signer.js";

const CLOB_API = "https://clob.polymarket.com";
const CREDS_D1_KEY = "POLYMARKET_API_CREDS";
/** Re-derive credentials after 72 hours (they're long-lived; 72h is conservative). */
const CREDS_TTL_MS = 72 * 3_600_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PolyApiCreds {
  apiKey:     string;
  secret:     string;   // base64url encoded
  passphrase: string;
  /** ISO timestamp of when these credentials were last derived. */
  derivedAt:  string;
}

// ─── L1 Auth: derive / load API credentials ───────────────────────────────────

/**
 * Load API credentials from D1 cache, or derive fresh credentials via L1 auth.
 *
 * Derivation uses EIP-712 ClobAuth signature + GET /auth/derive-api-key.
 * Using nonce=0 ensures idempotency — re-derives the same credentials each time.
 * Fresh credentials are stored in D1 `system_config` for the next call.
 *
 * @param db            D1 database binding
 * @param privateKey    Owner EOA private key (hex)
 * @param walletAddress Checksummed Polygon address (derive via privateKeyToWalletAddress)
 */
export async function loadOrDeriveApiCreds(
  db: D1Database,
  privateKey: string,
  walletAddress: string,
): Promise<PolyApiCreds> {
  // ── 1. Try D1 cache ────────────────────────────────────────────────────────
  const cached = await db
    .prepare("SELECT value FROM system_config WHERE key = ?")
    .bind(CREDS_D1_KEY)
    .first<{ value: string }>();

  if (cached?.value) {
    try {
      const creds = JSON.parse(cached.value) as PolyApiCreds;
      const ageMs = Date.now() - new Date(creds.derivedAt).getTime();
      if (ageMs < CREDS_TTL_MS && creds.apiKey && creds.secret && creds.passphrase) {
        return creds;
      }
    } catch {
      // Malformed cache entry — fall through to re-derive
    }
  }

  // ── 2. Fetch server time (improves signature validity window) ──────────────
  let ts: number;
  try {
    const timeRes = await fetch(`${CLOB_API}/time`, { method: "GET" });
    if (timeRes.ok) {
      const body = await timeRes.json() as { time: number };
      ts = Math.floor(body.time);
    } else {
      ts = Math.floor(Date.now() / 1000);
    }
  } catch {
    ts = Math.floor(Date.now() / 1000);
  }

  // ── 3. L1 EIP-712 sign ClobAuth ────────────────────────────────────────────
  const sig = await signClobAuth(privateKey, ts, /* nonce= */ 0);

  // ── 4. Derive API credentials ──────────────────────────────────────────────
  const res = await fetch(`${CLOB_API}/auth/derive-api-key`, {
    method: "GET",
    headers: {
      "POLY_ADDRESS":   walletAddress,
      "POLY_SIGNATURE": sig,
      "POLY_TIMESTAMP": String(ts),
      "POLY_NONCE":     "0",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`derive-api-key failed ${res.status}: ${body.slice(0, 200)}`);
  }

  const body = (await res.json()) as { apiKey: string; secret: string; passphrase: string };

  const creds: PolyApiCreds = {
    apiKey:     body.apiKey,
    secret:     body.secret,
    passphrase: body.passphrase,
    derivedAt:  new Date().toISOString(),
  };

  // ── 5. Persist to D1 ──────────────────────────────────────────────────────
  await db
    .prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)")
    .bind(CREDS_D1_KEY, JSON.stringify(creds))
    .run();

  return creds;
}

// ─── L2 Auth: build per-request POLY_* headers ───────────────────────────────

/**
 * Build the 5 POLY_* L2 HTTP headers for a CLOB trading endpoint.
 *
 * All trading endpoints (POST /order, DELETE /order, POST /heartbeat, etc.)
 * require these headers in addition to the signed order payload.
 *
 * @param walletAddress  Checksummed Polygon EOA address
 * @param creds          API credentials from loadOrDeriveApiCreds()
 * @param method         HTTP method ("GET", "POST", "DELETE")
 * @param requestPath    URL path, e.g. "/order" or "/cancel-orders"
 * @param body           JSON string body for POST/PUT; omit for GET/DELETE
 */
export async function buildL2Headers(
  walletAddress: string,
  creds: PolyApiCreds,
  method: string,
  requestPath: string,
  body?: string,
): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000);
  const sig = await buildHmacSig(creds.secret, ts, method, requestPath, body);
  return {
    "Content-Type":    "application/json",
    "POLY_ADDRESS":    walletAddress,
    "POLY_SIGNATURE":  sig,
    "POLY_TIMESTAMP":  String(ts),
    "POLY_API_KEY":    creds.apiKey,
    "POLY_PASSPHRASE": creds.passphrase,
  };
}
