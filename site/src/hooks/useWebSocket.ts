import { useEffect, useRef, useState, useCallback } from "react";

export interface AgentEvent {
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

interface UseWebSocketReturn {
  events: AgentEvent[];
  connected: boolean;
  connectionCount: number;
}

const MAX_EVENTS = 200;
// Versioned key — bump suffix to wipe stale data on schema changes
const STORAGE_KEY = "petri_events_v1";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? "https://api.rotifer.xyz" : "");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadFromStorage(): AgentEvent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AgentEvent[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Compute a stable deduplication key for an event.
 * - Evolution events are epoch-scoped: WS and REST reconstruct the same logical
 *   event but at slightly different wall-clock timestamps, so we key on epoch
 *   number instead of timestamp to avoid ghost duplicates.
 * - All other events use type + timestamp.
 */
function dedupeKey(e: AgentEvent): string {
  if (e.type === "EVOLUTION_COMPLETED" || e.type === "EVOLUTION_STARTED") {
    return `${e.type}\x00epoch:${e.payload?.epoch ?? e.timestamp}`;
  }
  return `${e.type}\x00${e.timestamp}`;
}

/** Deduplicate + sort newest-first + cap at MAX_EVENTS. */
function mergeEvents(a: AgentEvent[], b: AgentEvent[]): AgentEvent[] {
  const seen = new Set<string>();
  const result: AgentEvent[] = [];
  for (const e of [...a, ...b]) {
    const key = dedupeKey(e);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(e);
    }
  }
  result.sort((x, y) => new Date(y.timestamp).getTime() - new Date(x.timestamp).getTime());
  return result.slice(0, MAX_EVENTS);
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useWebSocket(url: string): UseWebSocketReturn {
  // Initialise synchronously from localStorage — zero flicker on refresh
  const [events, setEvents] = useState<AgentEvent[]>(() => loadFromStorage());
  const [connected, setConnected] = useState(false);
  const [connectionCount, setConnectionCount] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const historyLoaded = useRef(false);
  const persistTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // ── Persist to localStorage (debounced 500 ms) ───────────────────────────
  useEffect(() => {
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
      } catch {
        // Quota exceeded — silently skip; existing data is still readable
      }
    }, 500);
  }, [events]);

  // ── REST history hydration on mount ──────────────────────────────────────
  useEffect(() => {
    if (historyLoaded.current) return;
    historyLoaded.current = true;

    fetch(`${API_BASE}/api/events?limit=100`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { events: AgentEvent[] } | null) => {
        if (!data?.events?.length) return;
        const fresh = data.events.filter(e => e.type !== "CONNECTED");
        setEvents(prev => mergeEvents(prev, fresh));
      })
      .catch(() => {});
  }, []);

  // ── WebSocket connection ──────────────────────────────────────────────────
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      retryRef.current = 0;
    };

    ws.onmessage = (e) => {
      try {
        const event: AgentEvent = JSON.parse(e.data);
        if (event.payload?.connections !== undefined) {
          setConnectionCount(event.payload.connections as number);
        }
        if (event.type === "CONNECTED") return;
        setEvents(prev => mergeEvents([event], prev));
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      const delay = Math.min(
        RECONNECT_BASE_MS * Math.pow(2, retryRef.current),
        RECONNECT_MAX_MS,
      );
      retryRef.current++;
      timerRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => ws.close();
  }, [url]);

  useEffect(() => {
    connect();
    return () => {
      timerRef.current && clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { events, connected, connectionCount };
}
