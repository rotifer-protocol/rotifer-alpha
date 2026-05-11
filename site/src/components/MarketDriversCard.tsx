import { useState } from "react";
import { ChevronDown, TrendingUp, TrendingDown, ExternalLink } from "lucide-react";
import { useFetch } from "../hooks/useApi";
import { useI18n } from "../i18n/context";

/**
 * MarketDriversCard — explains intraday PnL changes by attributing realized
 * PnL to specific markets in a recent time window.
 *
 * Designed to answer "why did total return drop from X% to Y%?" without
 * forcing users to pull up the diagnostics page or D1 queries.
 *
 * Behavior:
 *   - Default collapsed. Saves vertical space; state persists across reloads.
 *   - User toggle is persisted to localStorage (key: petri-mdc-open).
 *   - Selected time window is also persisted (key: petri-mdc-hours).
 *   - Time window selector: 1h / 3h / 12h / 24h (default 3h).
 *
 * Limitation:
 *   - Only realized PnL is shown. Unrealized mark drift on long-held positions
 *     is intentionally omitted because we lack intra-day snapshot history to
 *     reliably attribute it to specific markets.
 */

interface MarketDriver {
  marketId: string;
  question: string | null;
  slug: string | null;
  netPnl: number;
  grossProfit: number;
  grossLoss: number;
  tradeCount: number;
  fundCount: number;
  lastClosedAt: string | null;
}

interface MarketDriversResp {
  windowHours: number;
  windowStart: string;
  windowEnd: string;
  totalNet: number;
  totalAbs: number;
  totalCount: number;
  drivers: MarketDriver[];
}

const WINDOWS = [1, 3, 12, 24] as const;
type Window = (typeof WINDOWS)[number];

const WINDOW_LABEL_KEY = {
  1: "driversWindow1h",
  3: "driversWindow3h",
  12: "driversWindow12h",
  24: "driversWindow24h",
} as const;

const STORAGE_OPEN  = "petri-mdc-open";
const STORAGE_HOURS = "petri-mdc-hours";

function readLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLS(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota / SSR */ }
}

interface Props {
  /** Total pool in USD; used for auto-expand threshold and pct framing. */
  totalPool: number;
}

function polymarketUrl(slug: string | null, question: string | null): string | null {
  if (slug) return `https://polymarket.com/event/${slug}`;
  if (question) return `https://polymarket.com/markets?_q=${encodeURIComponent(question)}`;
  return null;
}

function fmtUsdAbs(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1000) {
    return `${v >= 0 ? "+" : "-"}$${(abs / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}K`;
  }
  return `${v >= 0 ? "+" : "-"}$${abs.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function MarketDriversCard({ totalPool }: Props) {
  const { t } = useI18n();

  // Persistent state — reads localStorage on mount, defaults to collapsed / 3h
  const [hours, setHoursRaw] = useState<Window>(() => readLS<Window>(STORAGE_HOURS, 3));
  const [open, setOpenRaw]   = useState<boolean>(() => readLS<boolean>(STORAGE_OPEN, false));

  function setHours(w: Window) {
    setHoursRaw(w);
    writeLS(STORAGE_HOURS, w);
  }

  function toggleOpen() {
    setOpenRaw(prev => {
      const next = !prev;
      writeLS(STORAGE_OPEN, next);
      return next;
    });
  }

  const { data } = useFetch<MarketDriversResp>(`/api/market-drivers?hours=${hours}`, 60_000);

  // Don't render the card if we have no data yet — avoids a brief flash
  // of an empty card on initial load.
  if (!data) return null;

  const total = data.totalNet;
  const totalPctOfPool = totalPool > 0 ? (total / totalPool) * 100 : 0;
  const totalColor = total > 0
    ? "text-[var(--r-green)]"
    : total < 0
      ? "text-[var(--r-red)]"
      : "text-[var(--r-text-muted)]";

  return (
    <div className="glass-card mb-6 overflow-hidden">
      <button
        type="button"
        onClick={() => toggleOpen()}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-white/[0.02] transition-colors"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3 text-left min-w-0 flex-1">
          <span className="text-xs font-medium text-[var(--r-text-muted)] uppercase tracking-widest shrink-0">
            {t("driversTitle")}
          </span>
          <span className="text-xs flex items-baseline gap-1.5 min-w-0">
            <span className={`font-mono tabular-nums ${totalColor}`}>
              {fmtUsdAbs(total)}
              {totalPool > 0 && (
                <span className="opacity-80 ml-1">
                  ({totalPctOfPool >= 0 ? "+" : ""}{totalPctOfPool.toFixed(2)}%)
                </span>
              )}
            </span>
            <span className="text-[var(--r-text-faint)]">·</span>
            <span className="text-[var(--r-text-faint)] truncate">
              {data.totalCount} {t("driversTradesClosed")}
            </span>
          </span>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-[var(--r-text-faint)] shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="border-t border-[var(--r-border)] px-4 py-3">
          {/* Time window selector */}
          <div className="flex flex-wrap items-center gap-1 mb-3">
            {WINDOWS.map(w => (
              <button
                key={w}
                type="button"
                onClick={() => setHours(w)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  hours === w
                    ? "bg-[var(--r-accent)] text-white"
                    : "text-[var(--r-text-muted)] hover:text-[var(--r-text)] hover:bg-white/[0.05]"
                }`}
                aria-pressed={hours === w}
              >
                {t(WINDOW_LABEL_KEY[w])}
              </button>
            ))}
          </div>

          {data.drivers.length === 0 ? (
            <p className="text-xs text-[var(--r-text-faint)] py-2">{t("driversEmpty")}</p>
          ) : (
            <ul className="space-y-1">
              {data.drivers.slice(0, 5).map(d => {
                const positive = d.netPnl > 0;
                const Icon = positive ? TrendingUp : TrendingDown;
                const color = positive ? "text-[var(--r-green)]" : "text-[var(--r-red)]";
                const url = polymarketUrl(d.slug, d.question);
                const inner = (
                  <div className="flex items-center gap-2 sm:gap-3 px-2 py-2 rounded-md hover:bg-white/[0.03] transition-colors min-w-0">
                    <Icon className={`w-3.5 h-3.5 shrink-0 ${color}`} />
                    <span className="flex-1 truncate text-xs text-[var(--r-text)]">
                      {d.question || d.marketId}
                    </span>
                    <span className={`text-xs font-mono tabular-nums shrink-0 ${color}`}>
                      {fmtUsdAbs(d.netPnl)}
                    </span>
                    <span className="text-[10px] text-[var(--r-text-faint)] shrink-0 tabular-nums whitespace-nowrap">
                      {d.tradeCount}{t("driversTradeUnit")} · {d.fundCount}{t("driversFundUnit")}
                    </span>
                    {url && <ExternalLink className="w-3 h-3 shrink-0 text-[var(--r-text-faint)] opacity-60" />}
                  </div>
                );
                return (
                  <li key={d.marketId}>
                    {url ? (
                      <a href={url} target="_blank" rel="noopener noreferrer" className="block no-underline">
                        {inner}
                      </a>
                    ) : (
                      inner
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <p className="text-[10px] text-[var(--r-text-faint)] mt-3 italic leading-relaxed">
            {t("driversNote")}
          </p>
        </div>
      )}
    </div>
  );
}
