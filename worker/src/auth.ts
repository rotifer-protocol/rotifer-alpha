import type { Env } from "./types";

const rateLimit = new Map<string, number>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const last = rateLimit.get(ip);
  if (last && now - last < RATE_LIMIT_WINDOW_MS / RATE_LIMIT_MAX) return false;
  rateLimit.set(ip, now);
  if (rateLimit.size > 1000) {
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    for (const [k, v] of rateLimit) {
      if (v < cutoff) rateLimit.delete(k);
    }
  }
  return true;
}

export function requireAuth(req: Request, env: Env): Response | null {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!checkRateLimit(ip)) {
    return Response.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: corsHeaders() },
    );
  }

  const header = req.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return Response.json(
      { error: "Authentication required" },
      { status: 401, headers: corsHeaders() },
    );
  }

  const token = header.slice(7);
  if (!env.API_TOKEN || token !== env.API_TOKEN) {
    return Response.json(
      { error: "Invalid token" },
      { status: 403, headers: corsHeaders() },
    );
  }

  return null;
}

const ALLOWED_ORIGINS = [
  "https://rotifer.xyz",
  "https://www.rotifer.xyz",
  "http://localhost:5173",
  "http://localhost:3000",
];

export function corsHeaders(origin?: string | null): HeadersInit {
  const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
}

export function handleCors(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  const origin = req.headers.get("Origin");
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}
