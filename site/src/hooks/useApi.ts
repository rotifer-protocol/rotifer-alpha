import { useState, useEffect, useCallback, useRef } from "react";

const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? "https://api.rotifer.xyz" : "");

// ─── Cache layers ──────────────────────────────────────────────────────────────
//
// Layer 1 — memCache (in-memory, module-level)
//   Survives component re-renders and SPA route changes within a tab.
//   Zero loading flash when navigating between pages.
//   Cleared on page reload.
//
// Layer 2 — localStorage (persisted across sessions)
//   Survives page reloads and new tabs.
//   On mount: if LS has fresh-enough data, show it immediately (no loading flash on refresh).
//   On network response: write-through to keep LS up to date.
//
// Layer 3 — inFlight (deduplication)
//   If multiple components request the same path concurrently, only one network
//   request fires. All callers share the same promise.

const memCache = new Map<string, { data: unknown; ts: number }>();
const inFlight  = new Map<string, Promise<unknown>>();

const MEM_TTL_MS = 20_000;   // Re-validate after 20s (background, user sees cached data)
const LS_TTL_MS  = 5 * 60_000; // Show LS data without loading flash if < 5 min old
const LS_PREFIX  = "petri_apicache_v1_"; // Bump suffix to wipe stale schema on next deploy

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

    // Show cached data immediately regardless of age
    if (hit && mountedRef.current) {
      setData(hit.data as T);
      setLoading(false);

      // Determine which TTL governs whether we skip the network round-trip:
      // — LS-promoted entries (seeded at module load) use the longer LS_TTL_MS
      //   so a fresh page reload doesn't hammer the API if data is < 5 min old.
      // — Within-session entries use the shorter MEM_TTL_MS (20 s).
      const age = now - hit.ts;
      const ttl = age < LS_TTL_MS ? LS_TTL_MS : MEM_TTL_MS;
      if (!forceRevalidate && age < ttl) return;
    }

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
      // Interval polling always force-revalidates (bypasses TTL check)
      const timer = setInterval(() => fetchData(true), intervalMs);
      return () => clearInterval(timer);
    }
  }, [fetchData, intervalMs]);

  const refetch = useCallback(() => fetchData(true), [fetchData]);

  return { data, loading, error, refetch };
}
