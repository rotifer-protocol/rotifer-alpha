import { useState, useEffect, useCallback, useRef } from "react";

const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? "https://api.rotifer.xyz" : "");

// ─── Cache layers ──────────────────────────────────────────────────────────────
//
// SWR (stale-while-revalidate) pattern: cached data is shown instantly to
// avoid loading flashes, and a background fetch fires on every mount past
// the dedup window to make sure the user sees the latest data within a
// network round-trip (~200-500ms) of opening the site.
//
// Layer 1 — memCache (in-memory, module-level)
//   Survives component re-renders and SPA route changes within a tab.
//   Cleared on page reload.
//
// Layer 2 — localStorage (persisted across sessions)
//   Survives page reloads and new tabs. On mount the entire LS is replayed
//   into memCache so the first paint is instant.
//
// Layer 3 — inFlight (deduplication)
//   If multiple components request the same path concurrently, only one
//   network request fires. All callers share the same promise.

const memCache = new Map<string, { data: unknown; ts: number }>();
const inFlight  = new Map<string, Promise<unknown>>();

// Dedup window: skip the network if we just fetched this path within the
// last DEDUP_WINDOW_MS. Anything older triggers a background revalidate
// even when cached data is already on screen.
const DEDUP_WINDOW_MS = 20_000;
const LS_PREFIX = "petri_apicache_v1_"; // Bump suffix to wipe stale schema on next deploy

// ─── localStorage helpers ──────────────────────────────────────────────────────

function readLs(path: string): { data: unknown; ts: number } | null {
  try {
    const raw = localStorage.getItem(LS_PREFIX + path);
    if (!raw) return null;
    const hit = JSON.parse(raw) as { data: unknown; ts: number };
    return hit?.data !== undefined && hit?.ts ? hit : null;
  } catch {
    return null;
  }
}

function writeLs(path: string, data: unknown): void {
  try {
    localStorage.setItem(LS_PREFIX + path, JSON.stringify({ data, ts: Date.now() }));
  } catch {
    // Quota exceeded — silently skip; LS is best-effort, not critical
  }
}

// Seed memCache from localStorage synchronously at module load time so the very
// first useFetch call in any component can skip the "is cache warm?" check.
// We iterate existing LS keys and promote them to memCache.
(function seedMemCacheFromLs() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(LS_PREFIX)) continue;
      const path = key.slice(LS_PREFIX.length);
      const hit = readLs(path);
      if (hit) memCache.set(path, hit);
    }
  } catch {
    // localStorage unavailable (e.g. private-browsing with strict settings)
  }
})();

// For first-time visitors (empty LS), kick off the most critical fetch immediately —
// before React mounts any component. By the time ArenaPage calls useFetch('/api/funds'),
// the in-flight promise is already running (or done), cutting ~100-200ms from perceived load.
(function earlyPrefetch() {
  if (typeof window === "undefined") return;
  const CRITICAL = ["/api/funds"];
  for (const path of CRITICAL) {
    if (memCache.has(path)) continue; // already seeded from LS — no network needed
    const p = fetch(`${API_BASE}${path}`)
      .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .then(json => { memCache.set(path, { data: json, ts: Date.now() }); writeLs(path, json); return json; })
      .catch(() => null)
      .finally(() => inFlight.delete(path));
    inFlight.set(path, p);
  }
})();

// ─── Hook ──────────────────────────────────────────────────────────────────────

interface UseFetchReturn<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useFetch<T>(path: string, intervalMs?: number): UseFetchReturn<T> {
  // memCache is already seeded from LS at module load — one unified read path.
  const cached = memCache.get(path);

  // Show cached data immediately: no loading flash on route change OR page reload.
  const [data, setData]       = useState<T | null>(cached ? (cached.data as T) : null);
  const [loading, setLoading] = useState(!cached);
  const [error, setError]     = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const fetchData = useCallback(async (forceRevalidate = false) => {
    const now = Date.now();
    const hit = memCache.get(path);

    // Show cached data immediately regardless of age (no loading flash).
    if (hit && mountedRef.current) {
      setData(hit.data as T);
      setLoading(false);
    }

    // SWR: always revalidate on mount unless a sibling caller just fetched
    // the same path within the dedup window. Without this the user can sit
    // on an LS-cached snapshot for minutes before the polling interval
    // fires the next forced refresh.
    if (!forceRevalidate && hit && (now - hit.ts) < DEDUP_WINDOW_MS) return;

    // Deduplicate concurrent requests for the same path
    try {
      let p = inFlight.get(path);
      if (!p) {
        p = fetch(`${API_BASE}${path}`)
          .then(res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
          })
          .finally(() => inFlight.delete(path));
        inFlight.set(path, p);
      }

      const json = await p;
      const entry = { data: json, ts: Date.now() };
      memCache.set(path, entry);   // Layer 1
      writeLs(path, json);         // Layer 2 — write-through to localStorage

      if (mountedRef.current) {
        setData(json as T);
        setError(null);
        setLoading(false);
      }
    } catch (e) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : "Unknown error");
        if (!hit) setLoading(false); // Only enter error state if no cached data to show
      }
    }
  }, [path]);

  useEffect(() => {
    fetchData();
    if (intervalMs && intervalMs > 0) {
      // Interval polling always force-revalidates (bypasses dedup window)
      const timer = setInterval(() => fetchData(true), intervalMs);
      return () => clearInterval(timer);
    }
  }, [fetchData, intervalMs]);

  const refetch = useCallback(() => fetchData(true), [fetchData]);

  return { data, loading, error, refetch };
}
