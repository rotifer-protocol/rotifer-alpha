/**
 * Polymarket CLOB V2 signing primitives — Cloudflare Workers compatible
 * ALPHA-001 Phase 2 · P2.5
 *
 * Three signing operations:
 *   signClobAuth()        L1 auth: EIP-712 ClobAuthDomain (nonce-based, derive credentials)
 *   buildHmacSig()        L2 auth: HMAC-SHA256 per-request signature (Web Crypto)
 *   buildSignedOrderV2()  Order:   EIP-712 V2 Order struct (EOA, signatureType=0)
 *
 * Plus pure helpers:
 *   buildOrderAmounts()       Compute makerAmount / takerAmount for BUY or SELL
 *   privateKeyToWalletAddress Derive checksummed Polygon address from raw private key
 *
 * All secrets are passed as parameters; no global state.
 * Uses viem/accounts for secp256k1 (Workers-compatible via @noble/curves).
 *
 * References:
 *   https://docs.polymarket.com/api-reference/authentication
 *   https://docs.polymarket.com/v2-migration
 *   https://github.com/Polymarket/clob-client-v2/src/signing/
 */

import { privateKeyToAccount } from "viem/accounts";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Polygon mainnet chain ID */
export const POLYGON_CHAIN_ID = 137;

/**
 * CTF Exchange V2 contract — Polygon mainnet (live since 2026-04-28).
 * Binary yes/no markets use this address in the EIP-712 domain.
 */
export const CTF_EXCHANGE_V2 =
  "0xE111180000d2663C0091e4f400237545B87B996B" as const;

/**
 * Neg Risk CTF Exchange V2 — Polygon mainnet.
 * Multi-outcome (3+ outcome) markets use this address instead.
 */
export const NEG_RISK_EXCHANGE_V2 =
  "0xe2222d279d744050d28e00520010520000310F59" as const;

/** bytes32 zero literal used for metadata / builder fields. */
export const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/** pUSD and CTF conditional token precision: 1e6 (same as USDC on Polygon). */
export const TOKEN_DECIMALS = 1_000_000;

// ─── EIP-712 type structs (canonical, from clob-client-v2) ───────────────────

const CTF_ORDER_STRUCT = [
  { name: "salt",          type: "uint256" },
  { name: "maker",         type: "address" },
  { name: "signer",        type: "address" },
  { name: "tokenId",       type: "uint256" },
  { name: "makerAmount",   type: "uint256" },
  { name: "takerAmount",   type: "uint256" },
  { name: "side",          type: "uint8"   },
  { name: "signatureType", type: "uint8"   },
  { name: "timestamp",     type: "uint256" },
  { name: "metadata",      type: "bytes32" },
  { name: "builder",       type: "bytes32" },
] as const;

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** Normalize a raw private key to `0x${string}` for viem. */
export function normalizeKey(key: string): `0x${string}` {
  return (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
}

/** Derive the checksummed Polygon address from a raw private key (hex). */
export function privateKeyToWalletAddress(privateKey: string): string {
  return privateKeyToAccount(normalizeKey(privateKey)).address;
}

// ─── Order amount calculation (pure, testable) ────────────────────────────────

export interface OrderAmounts {
  /** 0 = BUY, 1 = SELL — the uint8 side value in the signed struct. */
  clobSide: 0 | 1;
  /** Maker amount as BigInt string in 1e6 units. BUY → pUSD; SELL → CTF shares. */
  makerAmount: string;
  /** Taker amount as BigInt string in 1e6 units. BUY → CTF shares; SELL → pUSD. */
  takerAmount: string;
  /** Shares in human units (for D1 record + logging). */
  sharesHuman: number;
}

/**
 * Compute CLOB V2 makerAmount / takerAmount from an OrderIntent's notional.
 *
 * Semantics:
 *   YES / BUY  (clobSide=0): spend sizeUsdc pUSD → receive sizeUsdc/price YES shares
 *   NO  / SELL (clobSide=1): sell sizeUsdc/price YES shares → receive sizeUsdc pUSD
 *
 * Amounts use floor() to avoid over-spending (conservative for the maker).
 * Shares are rounded to 2 decimal places matching Polymarket's 0.01 tick.
 *
 * @param intentSide  "YES" maps to BUY (clobSide=0); "NO" maps to SELL (clobSide=1)
 * @param sizeUsdc    Notional USDC to spend (BUY) or receive (SELL)
 * @param priceCents  Price in integer cents 0–100 (e.g. 60 = $0.60 = 60% probability)
 */
export function buildOrderAmounts(
  intentSide: "YES" | "NO",
  sizeUsdc: number,
  priceCents: number,
): OrderAmounts {
  const price = priceCents / 100; // convert to 0–1 float
  if (price <= 0 || price >= 1 || sizeUsdc <= 0) {
    throw new Error(
      `buildOrderAmounts: invalid inputs — price=${price} sizeUsdc=${sizeUsdc}`,
    );
  }

  // Shares: floor to 2 decimal places (Polymarket minimum tick = 0.01 shares)
  const sharesHuman = Math.floor((sizeUsdc / price) * 100) / 100;

  // 1e6 integer amounts (floor = conservative, avoids rounding up beyond balance)
  const usdcRaw  = Math.floor(sizeUsdc * TOKEN_DECIMALS);
  const sharesRaw = Math.floor(sharesHuman * TOKEN_DECIMALS);

  const clobSide: 0 | 1 = intentSide === "YES" ? 0 : 1;

  if (clobSide === 0) {
    // BUY: maker gives pUSD, receives YES shares
    return { clobSide, makerAmount: String(usdcRaw), takerAmount: String(sharesRaw), sharesHuman };
  } else {
    // SELL: maker gives YES shares, receives pUSD
    return { clobSide, makerAmount: String(sharesRaw), takerAmount: String(usdcRaw), sharesHuman };
  }
}

// ─── L1 Auth: ClobAuth EIP-712 signature ─────────────────────────────────────

/**
 * Sign the ClobAuth EIP-712 message for L1 API key derivation.
 *
 * Using nonce=0 consistently means GET /auth/derive-api-key always returns
 * the same credentials — idempotent and safe to retry.
 *
 * @param privateKey  EOA private key (hex, with or without 0x prefix)
 * @param timestamp   Unix seconds — use server time from GET /time when possible
 * @param nonce       0 for initial creation; same nonce to re-derive existing creds
 * @param chainId     137 for Polygon mainnet
 */
export async function signClobAuth(
  privateKey: string,
  timestamp: number,
  nonce = 0,
  chainId = POLYGON_CHAIN_ID,
): Promise<string> {
  const account = privateKeyToAccount(normalizeKey(privateKey));
  return account.signTypedData({
    domain: {
      name:    "ClobAuthDomain",
      version: "1",
      chainId,
    },
    types: {
      ClobAuth: [
        { name: "address",   type: "address" },
        { name: "timestamp", type: "string"  },
        { name: "nonce",     type: "uint256" },
        { name: "message",   type: "string"  },
      ],
    },
    primaryType: "ClobAuth",
    message: {
      address:   account.address,
      timestamp: String(timestamp),
      nonce,
      message:   "This message attests that I control the given wallet",
    },
  });
}

// ─── L2 Auth: HMAC-SHA256 per-request signature ───────────────────────────────

/**
 * Build the HMAC-SHA256 L2 auth signature for a CLOB API request.
 *
 * message = timestamp (unix seconds) + method.toUpperCase() + requestPath [+ body]
 * Key is base64url-decoded from `secret`.
 * Output is URL-safe base64 (+ → -, / → _), with "=" padding preserved.
 *
 * Uses Web Crypto API (available natively in Cloudflare Workers and Node ≥20).
 *
 * @param secret      API secret (base64url encoded) from L1 credential derivation
 * @param timestamp   Unix seconds (must match POLY_TIMESTAMP header)
 * @param method      HTTP method, e.g. "POST" or "GET"
 * @param requestPath URL path + query, e.g. "/order"
 * @param body        JSON body string for POST/PUT; omit for GET/DELETE
 */
export async function buildHmacSig(
  secret: string,
  timestamp: number,
  method: string,
  requestPath: string,
  body?: string,
): Promise<string> {
  // Decode base64url secret to raw bytes
  const normalized = secret.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const rawBinary = atob(padded);
  const keyBytes = new Uint8Array(rawBinary.length);
  for (let i = 0; i < rawBinary.length; i++) keyBytes[i] = rawBinary.charCodeAt(i);

  // Build message: timestamp + METHOD + path [+ body]
  let msg = `${timestamp}${method.toUpperCase()}${requestPath}`;
  if (body !== undefined) msg += body;

  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await globalThis.crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(msg),
  );

  // Convert to URL-safe base64
  const sigBytes = new Uint8Array(sigBuf);
  let binary = "";
  for (let i = 0; i < sigBytes.length; i++) binary += String.fromCharCode(sigBytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
}

// ─── Order signing: EIP-712 V2 Order struct ───────────────────────────────────

/** Wire body for POST /order (matches CLOB V2 API). */
export interface V2OrderWireBody {
  salt:          string;   // random uint256 string
  maker:         string;   // checksummed EOA address
  signer:        string;   // same as maker for EOA (signatureType=0)
  tokenId:       string;   // YES token ID (from market metadata)
  makerAmount:   string;   // 1e6 units
  takerAmount:   string;   // 1e6 units
  side:          string;   // "BUY" | "SELL" (wire string, not uint8)
  signatureType: number;   // 0 = EOA
  timestamp:     string;   // milliseconds (V2 replaces nonce)
  metadata:      string;   // bytes32 zero
  builder:       string;   // bytes32 zero (no builder code)
  expiration:    string;   // "0" for GTC/FOK; unix seconds for GTD
  signature:     string;   // EIP-712 65-byte hex signature
}

/**
 * Build and EIP-712 sign a CLOB V2 order with EOA signing (signatureType=0).
 *
 * For Phase 2 Small:
 *   - EOA signs directly (no POLY_1271 deposit wallet, no Gnosis Safe)
 *   - signatureType = 0 (EOA)
 *   - maker = signer = EOA wallet address
 *   - expiration = "0" (no time limit; order type in POST body controls lifetime)
 *
 * @param privateKey  Owner EOA private key
 * @param tokenId     YES token ID from Polymarket market metadata
 * @param amounts     Output of buildOrderAmounts()
 * @param exchange    CTF_EXCHANGE_V2 or NEG_RISK_EXCHANGE_V2
 * @param chainId     137 for Polygon mainnet
 */
export async function buildSignedOrderV2(
  privateKey: string,
  tokenId: string,
  amounts: OrderAmounts,
  exchange: string = CTF_EXCHANGE_V2,
  chainId = POLYGON_CHAIN_ID,
): Promise<V2OrderWireBody> {
  const account = privateKeyToAccount(normalizeKey(privateKey));
  const maker = account.address;

  // Salt: random 32-byte value encoded as a decimal string (V2 format)
  const saltBytes = crypto.getRandomValues(new Uint8Array(32));
  const saltBigInt = saltBytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
  const salt = saltBigInt.toString();

  // Timestamp in milliseconds (V2 uses ms instead of nonce for uniqueness)
  const timestamp = String(Date.now());

  // Sign the EIP-712 V2 Order struct
  const signature = await account.signTypedData({
    domain: {
      name:              "Polymarket CTF Exchange",
      version:           "2",
      chainId,
      verifyingContract: exchange as `0x${string}`,
    },
    types: { Order: CTF_ORDER_STRUCT },
    primaryType: "Order",
    message: {
      salt,
      maker,
      signer:        maker,
      tokenId,
      makerAmount:   amounts.makerAmount,
      takerAmount:   amounts.takerAmount,
      side:          amounts.clobSide,
      signatureType: 0,
      timestamp,
      metadata:      ZERO_BYTES32,
      builder:       ZERO_BYTES32,
    },
  });

  return {
    salt,
    maker,
    signer:        maker,
    tokenId,
    makerAmount:   amounts.makerAmount,
    takerAmount:   amounts.takerAmount,
    side:          amounts.clobSide === 0 ? "BUY" : "SELL",
    signatureType: 0,
    timestamp,
    metadata:      ZERO_BYTES32,
    builder:       ZERO_BYTES32,
    expiration:    "0",
    signature,
  };
}
