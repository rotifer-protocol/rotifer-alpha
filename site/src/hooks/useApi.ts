import { useState, useEffect, useCallback, useRef } from "react";

const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? "https://api.rotifer.xyz" : "");

// Module-level caches — survive component re-renders and route changes within a session.
// memCache provides stale-while-revalidate: show cached data instantly, refresh in background.
// inFlight deduplicates concurrent requests for the same path.
const memCache = new Map<string, { data: unknown; ts: number }>();
const inFlight = new Map<string, Promise<unknown>>();

const DEFAULT_TTL_MS = 20_000; // Cache considered fresh for 20s; after that, silently revalidate [v2]

interface UseFetchReturn<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useFetch<T>(path: string, intervalMs?: number, ttlMs = DEFAULT_TTL_MS): UseFetchReturn<T> {
  // Initialise synchronously from cache — zero loading flash when navigating between routes
  const cached = memCache.get(path);
  const [data, setData] = useState<T | null>(cached ? (cached.data as T) : null);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const fetchData = useCallback(async (forceRevalidate = false) => {
    const now = Date.now();
    const hit = memCache.get(path);

    // Show cached data immediately regardless of freshness
    if (hit && mountedRef.current) {
      setData(hit.data as T);
      setLoading(false);
      // Skip network round-trip if cache is still fresh
      if (!forceRevalidate && now - hit.ts < ttlMs) return;
    }

    // Deduplicate: if a request for this path is already in-flight, piggyback on it
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
      memCache.set(path, { data: json, ts: Date.now() });
      if (mountedRef.current) {
        setData(json as T);
        setError(null);
        setLoading(false);
      }
    } catch (e) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : "Unknown error");
        // Only surface error state if there's no cached data to keep showing
        if (!hit) setLoading(false);
      }
    }
  }, [path, ttlMs]);

  useEffect(() => {
    fetchData();
    if (intervalMs && intervalMs > 0) {
      // Periodic intervals always revalidate regardless of TTL
      const timer = setInterval(() => fetchData(true), intervalMs);
      return () => clearInterval(timer);
    }
  }, [fetchData, intervalMs]);

  const refetch = useCallback(() => fetchData(true), [fetchData]);

  return { data, loading, error, refetch };
}
