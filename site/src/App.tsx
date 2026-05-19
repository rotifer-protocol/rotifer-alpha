import { useEffect, useState, useRef, useMemo, lazy, Suspense } from "react";
import { Routes, Route, NavLink, Outlet, useOutletContext } from "react-router-dom";
import { Languages, ExternalLink, Info, Share2, BarChart2 } from "lucide-react";

// Inline GitHub SVG octicon (lucide-react version used doesn't export Github)
const GithubIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
  </svg>
);
import { useWebSocket, type AgentEvent } from "./hooks/useWebSocket";
import { useFetch } from "./hooks/useApi";
import { FundRanking } from "./components/FundRanking";
import { EventFeed } from "./components/EventFeed";
import { StatusBar } from "./components/StatusBar";
import { MarketDriversCard } from "./components/MarketDriversCard";
import { ShareModal } from "./components/ShareModal";

// Heavy page panels — lazy-loaded per route so the initial bundle stays lean.
// Each import() creates a separate chunk; React.Suspense shows a skeleton while it loads.
const EvolutionPanel = lazy(() =>
  import("./components/EvolutionPanel").then(m => ({ default: m.EvolutionPanel }))
);
const FundDetail = lazy(() =>
  import("./components/FundDetail").then(m => ({ default: m.FundDetail }))
);
const ShadowPanel = lazy(() =>
  import("./components/ShadowPanel").then(m => ({ default: m.ShadowPanel }))
);
const GeneEvolutionPanel = lazy(() =>
  import("./components/GeneEvolutionPanel").then(m => ({ default: m.GeneEvolutionPanel }))
);
const LazyDiagnosticsPage = lazy(() =>
  import("./components/DiagnosticsPage").then(m => ({ default: m.DiagnosticsPage }))
);
const LazyDocsPage = lazy(() =>
  import("./components/DocsPage").then(m => ({ default: m.DocsPage }))
);
const LazyAnalysisPage = lazy(() =>
  import("./components/AnalysisPage").then(m => ({ default: m.AnalysisPage }))
)
const LazyArenaPage = lazy(() =>
  import("./components/ArenaPage").then(m => ({ default: m.ArenaPageContent }))
);
const LazyLivePanel = lazy(() =>
  import("./components/LivePanel").then(m => ({ default: m.LivePanel }))
);

// Prefetch on hover — kick off the chunk download before the user clicks the nav link
const prefetch = {
  evolution:   () => import("./components/EvolutionPanel"),
  shadow:      () => import("./components/ShadowPanel"),
  gene:        () => import("./components/GeneEvolutionPanel"),
  diagnostics: () => import("./components/DiagnosticsPage"),
  arena:       () => import("./components/ArenaPage"),
  live:        () => import("./components/LivePanel"),
};
import { useI18n } from "./i18n/context";
import type { TranslationKey } from "./i18n/translations";
import { fundDisplayName, fmtUSD } from "./lib/fundMeta";

const WS_URL = import.meta.env.VITE_WS_URL || (import.meta.env.PROD ? "wss://api.rotifer.xyz/ws" : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);

// ─── Skeleton ─────────────────────────────────────────────────────────────────
// Rules: never use dynamic Tailwind class interpolation (e.g. h-${n}, w-${n}).
// Tailwind v4 static scanner won't detect them; use inline styles for dynamic values.

/** A single muted bar with explicit pixel/percent dimensions. Safe with Tailwind scanner. */
function SkeletonBlock({ widthPct = 100, heightPx = 10, className = "" }: { widthPct?: number; heightPx?: number; className?: string }) {
  return (
    <div
      className={`bg-[var(--r-border)] rounded opacity-60 ${className}`}
      style={{ width: `${widthPct}%`, height: `${heightPx}px` }}
    />
  );
}

/** Mimics an actual fund ranking card so users understand what's loading. */
function FundCardSkeleton({ delay = 0 }: { delay?: number }) {
  return (
    <div className="glass-card p-4 animate-pulse" style={{ animationDelay: `${delay}s` }}>
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-[var(--r-border)] opacity-60 shrink-0" />
        <div className="flex-1 min-w-0 space-y-1.5">
          <SkeletonBlock widthPct={38} heightPx={12} />
          <SkeletonBlock widthPct={55} heightPx={9} />
        </div>
        <div className="w-20 shrink-0 space-y-1.5">
          <SkeletonBlock widthPct={100} heightPx={14} />
          <SkeletonBlock widthPct={70} heightPx={9} />
        </div>
        <div className="w-14 shrink-0 space-y-1.5">
          <SkeletonBlock widthPct={100} heightPx={12} />
          <SkeletonBlock widthPct={80} heightPx={9} />
        </div>
      </div>
    </div>
  );
}

/** Suspense fallback for the Evolution page — mirrors KPI strip + chart + epoch cards layout. */
function EvolutionSkeleton() {
  return (
    <div className="space-y-5">
      <div className="h-3 bg-[var(--r-border)] rounded opacity-60 w-40" />
      {/* KPI chips */}
      <div className="flex gap-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="glass-card px-4 py-3 animate-pulse flex-1 space-y-1.5">
            <SkeletonBlock widthPct={55} heightPx={9} />
            <SkeletonBlock widthPct={80} heightPx={20} />
          </div>
        ))}
      </div>
      {/* Fitness chart */}
      <div className="glass-card p-5 animate-pulse space-y-3">
        <SkeletonBlock widthPct={22} heightPx={12} />
        <div className="bg-[var(--r-border)] rounded opacity-40" style={{ height: "196px" }} />
      </div>
      {/* Epoch cards */}
      <div className="flex gap-2.5">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="glass-card p-3 animate-pulse space-y-1.5" style={{ minWidth: "96px" }}>
            <SkeletonBlock widthPct={60} heightPx={9} />
            <SkeletonBlock widthPct={80} heightPx={16} />
          </div>
        ))}
      </div>
      {/* Lower panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {[0, 1].map(i => (
          <div key={i} className="glass-card p-5 animate-pulse space-y-2.5">
            <SkeletonBlock widthPct={28} heightPx={12} />
            <div className="bg-[var(--r-border)] rounded opacity-40" style={{ height: "148px" }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Generic Suspense fallback for Shadow, Gene Evolution, Diagnostics pages. */
function PageSkeleton() {
  return (
    <div className="space-y-5">
      <div className="h-3 bg-[var(--r-border)] rounded opacity-60 w-36" />
      <div className="glass-card p-5 animate-pulse space-y-3">
        <SkeletonBlock widthPct={22} heightPx={12} />
        <div className="bg-[var(--r-border)] rounded opacity-40" style={{ height: "196px" }} />
        <div className="flex gap-3 pt-1">
          {[...Array(4)].map((_, i) => <SkeletonBlock key={i} widthPct={25} heightPx={30} />)}
        </div>
      </div>
      <div className="glass-card p-5 animate-pulse space-y-2.5">
        <SkeletonBlock widthPct={18} heightPx={12} />
        {[...Array(5)].map((_, i) => <SkeletonBlock key={i} widthPct={100} heightPx={38} />)}
      </div>
    </div>
  );
}

/** Suspense fallback for /fund/:id — mirrors real page shape so the jump feels smooth. */
function FundPageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-4 bg-[var(--r-border)] rounded opacity-50 animate-pulse" style={{ width: "80px" }} />
      <div className="glass-card p-6 animate-pulse">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-lg bg-[var(--r-border)] opacity-60 shrink-0" />
          <div className="flex-1 min-w-0 space-y-2">
            <SkeletonBlock widthPct={42} heightPx={24} />
            <SkeletonBlock widthPct={62} heightPx={12} />
          </div>
          <div className="shrink-0 space-y-1.5" style={{ width: "104px" }}>
            <SkeletonBlock widthPct={100} heightPx={32} />
            <SkeletonBlock widthPct={70} heightPx={16} />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="glass-card p-4 animate-pulse space-y-2">
            <SkeletonBlock widthPct={50} heightPx={10} />
            <SkeletonBlock widthPct={68} heightPx={24} />
            <SkeletonBlock widthPct={58} heightPx={8} />
          </div>
        ))}
      </div>
      <div className="glass-card p-5 animate-pulse space-y-3">
        <div className="flex items-center justify-between">
          <SkeletonBlock widthPct={20} heightPx={12} />
          <div style={{ width: "120px" }}><SkeletonBlock widthPct={100} heightPx={28} /></div>
        </div>
        <div className="bg-[var(--r-border)] rounded opacity-35" style={{ height: "180px" }} />
      </div>
    </div>
  );
}

function RotiferLogo({ className = "w-6 h-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className}>
      <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="2" />
      <path d="M9 10C14 6 23 9 23 16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M23 22C18 26 9 23 9 16" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function InfoPopover() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="relative inline-flex" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="p-2.5 -m-2.5 text-[var(--r-text-faint)] hover:text-[var(--r-text-muted)] transition-colors ml-1"
        aria-label="Info"
      >
        <Info className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-2 z-50 w-64 glass-card p-3 text-xs text-[var(--r-text-muted)] space-y-1.5 shadow-lg animate-fade-in">
          <p>{t("infoLine1")}</p>
          <p>{t("infoLine2")}</p>
          <p>{t("infoLine3")}</p>
        </div>
      )}
    </div>
  );
}


export interface FundData {
  id: string;
  name: string;
  emoji: string;
  motto: string;
  initialBalance: number;
  totalValue: number;
  returnPct: number;
  winRate: number;
  winCount: number;
  lossCount: number;
  realizedPnl: number;
  unrealizedPnl: number;
  openPositions: number;
  /** D-Lite (2026-05-10): positions whose last_price is NULL or older than the
   *  stale threshold (10 min). The fund's unrealized PnL excludes these to
   *  avoid jitter on intermittent CLOB outages — the UI surfaces the count so
   *  users know when numbers are partial. */
  staleCount?: number;
  monthlyTarget: number;
  frozen: boolean;
}

interface FundsResponse {
  funds: FundData[];
}

export interface LayoutContext {
  events: AgentEvent[];
  connected: boolean;
  connectionCount: number;
  funds: FundData[];
  fundsLoading: boolean;
}

export function useLayoutContext() {
  return useOutletContext<LayoutContext>();
}

function Layout() {
  const { events, connected, connectionCount } = useWebSocket(WS_URL);
  const { data: fundsData, loading, refetch } = useFetch<FundsResponse>("/api/funds", 60_000);
  const { t, toggle, locale } = useI18n();

  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[0];
    if (
      latest.type === "SNAPSHOT_UPDATED" ||
      latest.type === "TRADE_OPENED" ||
      latest.type === "TRADE_SETTLED" ||
      latest.type === "TRADE_STOPPED" ||
      latest.type === "TRADE_EXPIRED" ||
      latest.type === "TRADE_INVALIDATED" ||
      latest.type === "TRADE_PROFIT_TAKEN" ||
      latest.type === "TRADE_TRAILING_STOPPED" ||
      latest.type === "TRADE_REVERSED" ||
      latest.type === "MICRO_EVOLUTION" ||
      latest.type === "EVOLUTION_COMPLETED"
    ) {
      refetch();
    }
  }, [events, refetch]);

  const ctx: LayoutContext = {
    events,
    connected,
    connectionCount,
    funds: fundsData?.funds ?? [],
    fundsLoading: loading,
  };

  const navClass = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
      isActive
        ? "bg-[var(--r-accent)] text-white"
        : "text-[var(--r-text-muted)] hover:text-[var(--r-text)]"
    }`;

  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--r-border)] bg-[var(--r-surface)]/80 backdrop-blur-lg sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <NavLink to="/" className="flex items-center gap-3 no-underline">
            <RotiferLogo className="w-6 h-6 text-[var(--r-accent)]" />
        <div>
              <h1 className="font-bold text-lg leading-tight">
                rotifer.xyz <span className="text-[var(--r-text-muted)] font-normal text-sm">/ Petri</span>
              </h1>
              <p className="text-xs text-[var(--r-text-muted)]">{t("subtitle")}</p>
            </div>
          </NavLink>

          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-1 bg-[var(--r-surface)] border border-[var(--r-border)] rounded-lg p-1">
              <NavLink to="/" className={navClass} end>{t("arena")}</NavLink>
              <NavLink to="/arena" className={navClass} onMouseEnter={prefetch.arena}>{t("navArena")}</NavLink>
              <NavLink to="/evolution" className={navClass} onMouseEnter={prefetch.evolution}>{t("evolution")}</NavLink>
              <NavLink to="/shadow" className={navClass} onMouseEnter={prefetch.shadow}>{t("shadow")}</NavLink>
              <NavLink to="/gene-evolution" className={navClass} onMouseEnter={prefetch.gene}>{t("navGeneEvolution")}</NavLink>
              <NavLink to="/diagnostics" className={navClass} onMouseEnter={prefetch.diagnostics}>{t("diagnostics")}</NavLink>
              <NavLink to="/live" className={navClass} onMouseEnter={prefetch.live}>Live</NavLink>
              <NavLink to="/docs" className={navClass}>
                {t("navDocs")}
              </NavLink>
        </div>

        <button
              onClick={toggle}
              className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs text-[var(--r-text-muted)] hover:text-[var(--r-text)] border border-[var(--r-border)] hover:border-[var(--r-border-hover)] transition-all"
              aria-label={locale === "en" ? t("langSwitchTooltipAlt") : t("langSwitchTooltip")}
              title={locale === "en" ? t("langSwitchTooltipAlt") : t("langSwitchTooltip")}
        >
              <Languages className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{locale === "en" ? "中文" : "EN"}</span>
        </button>

            {/* GitHub icon link */}
            <a
              href="https://github.com/rotifer-protocol/rotifer-petri"
              target="_blank"
              rel="noopener noreferrer"
              title="GitHub"
              className="p-1.5 text-[var(--r-text-faint)] hover:text-[var(--r-text)] transition-colors"
            >
              <GithubIcon className="w-4 h-4" />
            </a>

            <StatusBar connected={connected} connectionCount={connectionCount} />
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        <div className="sm:hidden flex items-center gap-1 bg-[var(--r-surface)] border border-[var(--r-border)] rounded-lg p-1 mb-6 overflow-x-auto">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `flex-1 px-2 py-2 rounded-md text-sm font-medium text-center whitespace-nowrap transition-all ${
                isActive ? "bg-[var(--r-accent)] text-white" : "text-[var(--r-text-muted)]"
              }`
            }
          >
            {t("arena")}
          </NavLink>
          <NavLink
            to="/arena"
            className={({ isActive }) =>
              `flex-1 px-2 py-2 rounded-md text-sm font-medium text-center whitespace-nowrap transition-all ${
                isActive ? "bg-[var(--r-accent)] text-white" : "text-[var(--r-text-muted)]"
              }`
            }
          >
            {t("navArena")}
          </NavLink>
          <NavLink
            to="/evolution"
            className={({ isActive }) =>
              `flex-1 px-2 py-2 rounded-md text-sm font-medium text-center whitespace-nowrap transition-all ${
                isActive ? "bg-[var(--r-accent)] text-white" : "text-[var(--r-text-muted)]"
              }`
            }
          >
            {t("evolution")}
          </NavLink>
          <NavLink
            to="/shadow"
            className={({ isActive }) =>
              `flex-1 px-2 py-2 rounded-md text-sm font-medium text-center whitespace-nowrap transition-all ${
                isActive ? "bg-[var(--r-accent)] text-white" : "text-[var(--r-text-muted)]"
              }`
            }
          >
            {t("shadow")}
          </NavLink>
          <NavLink
            to="/gene-evolution"
            className={({ isActive }) =>
              `flex-1 px-2 py-2 rounded-md text-sm font-medium text-center whitespace-nowrap transition-all ${
                isActive ? "bg-[var(--r-accent)] text-white" : "text-[var(--r-text-muted)]"
              }`
            }
            >
            {t("navGeneEvolution")}
          </NavLink>
          <NavLink
            to="/diagnostics"
            className={({ isActive }) =>
              `flex-1 px-2 py-2 rounded-md text-sm font-medium text-center whitespace-nowrap transition-all ${
                isActive ? "bg-[var(--r-accent)] text-white" : "text-[var(--r-text-muted)]"
              }`
            }
          >
            {t("diagnostics")}
          </NavLink>
          <NavLink
            to="/live"
            className={({ isActive }) =>
              `flex-1 px-2 py-2 rounded-md text-sm font-medium text-center whitespace-nowrap transition-all ${
                isActive ? "bg-[var(--r-accent)] text-white" : "text-[var(--r-text-muted)]"
              }`
            }
            onMouseEnter={prefetch.live}
          >
            Live
          </NavLink>
          <NavLink
            to="/docs"
            className={({ isActive }) =>
              `flex-1 px-2 py-2 rounded-md text-sm font-medium text-center whitespace-nowrap transition-all ${
                isActive ? "bg-[var(--r-accent)] text-white" : "text-[var(--r-text-muted)]"
              }`
            }
          >
            {t("navDocs")}
          </NavLink>
        </div>

        <Outlet context={ctx} />

        <div className="mt-20" />
      </main>

      <footer className="border-t border-[var(--r-border)] bg-[var(--r-surface)]/50">
        <div className="max-w-6xl mx-auto px-4 py-10">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-8">
            {/* Branding */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <RotiferLogo className="w-5 h-5 text-[var(--r-accent)]" />
                <span className="font-semibold text-sm">rotifer.xyz <span className="text-[var(--r-text-muted)] font-normal">/ Petri</span></span>
              </div>
              <p className="text-xs text-[var(--r-text-faint)]">{t("footerBrandSub")}</p>
              <p className="text-[11px] text-[var(--r-text-faint)] opacity-60">{t("disclaimerShort")}</p>
            </div>

            {/* Links */}
            <div className="flex flex-wrap gap-10 text-xs">
              <div className="space-y-2.5">
                <p className="font-medium text-[var(--r-text-muted)] uppercase tracking-widest text-[10px]">{t("footerProtocol")}</p>
                <a href="https://rotifer.dev" target="_blank" rel="noopener noreferrer" className="block text-[var(--r-text-faint)] hover:text-[var(--r-text)] transition-colors">rotifer.dev</a>
                <a href="https://rotifer.ai" target="_blank" rel="noopener noreferrer" className="block text-[var(--r-text-faint)] hover:text-[var(--r-text)] transition-colors">rotifer.ai</a>
              </div>
              <div className="space-y-2.5">
                <p className="font-medium text-[var(--r-text-muted)] uppercase tracking-widest text-[10px]">{t("footerOpenSource")}</p>
                <a href="https://github.com/rotifer-protocol/rotifer-petri" target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-[var(--r-text-faint)] hover:text-[var(--r-text)] transition-colors">
                  <GithubIcon className="w-3 h-3" />petri
                </a>
                <a href="https://github.com/rotifer-protocol/rotifer-spec" target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-[var(--r-text-faint)] hover:text-[var(--r-text)] transition-colors">
                  <GithubIcon className="w-3 h-3" />spec
                </a>
              </div>
              <div className="space-y-2.5">
                <p className="font-medium text-[var(--r-text-muted)] uppercase tracking-widest text-[10px]">{t("footerDocs")}</p>
                <NavLink to="/docs" className="block text-[var(--r-text-faint)] hover:text-[var(--r-text)] transition-colors no-underline">
                  {t("navDocs")} →
                </NavLink>
                <a href="https://polymarket.com" target="_blank" rel="noopener noreferrer" className="block text-[var(--r-text-faint)] hover:text-[var(--r-text)] transition-colors">Polymarket</a>
              </div>
            </div>
          </div>

        </div>
      </footer>
    </div>
  );
}

interface SnapshotData {
  fund_id: string;
  date: string;
  total_value: number;
}

function polymarketUrl(slug: unknown, question: unknown): string | null {
  const s = String(slug || "");
  if (s) return `https://polymarket.com/event/${s}`;
  const q = String(question || "");
  if (q) return `https://polymarket.com/markets?_q=${encodeURIComponent(q)}`;
  return null;
}

function useHighlight(events: AgentEvent[]) {
  const { t } = useI18n();
  const tFund = (raw: unknown) => fundDisplayName(String(raw).toLowerCase(), t);

  for (const e of events) {
    const p = e.payload;
    if (e.type === "TRADE_SETTLED" && Math.abs(Number(p.pnl)) > 5) {
      const pnl = Number(p.pnl);
      const name = tFund(p.fundName || p.fundId || "");
      const sign = pnl >= 0 ? "+" : "-";
      return { text: `${name} ${t("heroHighlightSettled")} "${String(p.question).slice(0, 40)}" (${sign}$${Math.abs(pnl).toFixed(2)})`, positive: pnl >= 0, url: polymarketUrl(p.slug, p.question) };
    }
    if (e.type === "SIGNAL_FOUND" && Number(p.edge) > 15) {
      const edgeVal = Number(p.edge);
      const warn = edgeVal > 50 ? "⚠️ " : "";
      return { text: `${warn}${t("heroHighlightSignal")} ${edgeVal.toFixed(1)}% ${t("heroHighlightEdge")} — ${String(p.question).slice(0, 40)}`, positive: true, url: polymarketUrl(p.slug, p.question) };
    }
    if (e.type === "TRADE_OPENED") {
      return { text: `${tFund(p.fundName)} ${t("eventOpened")} · ${fmtUSD(Number(p.amount))} · ${String(p.question).slice(0, 40)}`, positive: true, url: polymarketUrl(p.slug, p.question) };
    }
    if (e.type === "EVOLUTION_COMPLETED") {
      return { text: `${t("eventEvolved")} — ${t("epoch")} ${String(p.epoch)}`, positive: true, url: null };
    }
  }
  return { text: t("heroScanningMarkets"), positive: true, url: null };
}

interface HeartbeatData {
  lastScanAt: string;
  totalFetched: number;
  marketsFiltered: number;
  signalsFound: number;
  tradesOpened: number;
  settlementsProcessed: number;
  monitorActions: number;
  riskStops: number;
  riskExpired: number;
  skipSummary: Record<string, number>;
  skipByFund?: Record<string, Record<string, number>>;
}

function formatTimeAgo(iso: string, t: (k: TranslationKey) => string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t("timeJustNow");
  if (mins < 60) return `${mins}${t("timeMinAgo")}`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}${t("timeHourAgo")}`;
}

function HeartbeatBar({ heartbeat }: { heartbeat: HeartbeatData | null }) {
  const { t } = useI18n();

  if (!heartbeat) {
    return (
      <div className="flex items-center gap-2 text-[10px] text-[var(--r-text-faint)] mt-2">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--r-text-faint)] opacity-40" />
        <span>{t("heartbeatNeverRun")}</span>
      </div>
    );
  }

  const ago = formatTimeAgo(heartbeat.lastScanAt, t);
  const skip = heartbeat.skipSummary ?? {};
  const maxPos = skip.MAX_POSITIONS ?? 0;
  const dup = skip.DUPLICATE_MARKET ?? 0;
  const lowEdge = (skip.EDGE_TOO_LOW ?? 0) + (skip.CONFIDENCE_TOO_LOW ?? 0);
  const noSignals = heartbeat.signalsFound === 0;

  const parts: string[] = [];
  parts.push(`${heartbeat.marketsFiltered} ${t("heartbeatMarkets")}`);
  parts.push(`${heartbeat.signalsFound} ${t("heartbeatSignals")}`);
  parts.push(`${heartbeat.tradesOpened} ${t("heartbeatTrades")}`);

  const skipParts: string[] = [];
  if (noSignals) skipParts.push(t("heartbeatNoSignals"));
  if (maxPos > 0) skipParts.push(`${maxPos} ${t("heartbeatSkipMaxPos")}`);
  if (dup > 0) skipParts.push(`${dup} ${t("heartbeatSkipDuplicate")}`);
  if (lowEdge > 0) skipParts.push(`${lowEdge} ${t("heartbeatSkipEdge")}`);

  const isRecent = Date.now() - new Date(heartbeat.lastScanAt).getTime() < 45 * 60000;
  const totalActions = heartbeat.tradesOpened + heartbeat.settlementsProcessed + heartbeat.monitorActions;
  const totalSkips = Object.values(skip).reduce((s: number, n) => s + (n as number), 0);

  // 5-block pipeline health: one block per criterion
  const healthBlocks = [
    isRecent,
    heartbeat.marketsFiltered > 0,
    heartbeat.signalsFound > 0,
    totalActions > 0,
    totalActions > 0 || totalSkips < 5,   // some activity OR very few skips
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-[var(--r-text-faint)] mt-2">
      {/* Health blocks */}
      <div className="flex items-center gap-[3px] mr-0.5" title={t("heartbeatLastScan")}>
        {healthBlocks.map((ok, i) => (
          <div
            key={i}
            className={`w-3.5 h-1.5 rounded-sm transition-colors ${ok ? "bg-[var(--r-green)]" : "bg-[var(--r-text-faint)]/20"}`}
          />
        ))}
      </div>
      <span className="font-medium">{t("heartbeatLastScan")}: {ago}</span>
      <span className="opacity-50">·</span>
      <span>{parts.join(" → ")}</span>
      {skipParts.length > 0 && (
        <>
          <span className="opacity-50">·</span>
          <span className="text-[var(--r-text-faint)]">{skipParts.join(", ")}</span>
        </>
      )}
    </div>
  );
}

function HeroOverview({ funds, events }: { funds: FundData[]; events: AgentEvent[] }) {
  const { t } = useI18n();
  const { data: hbResp } = useFetch<{ heartbeat: HeartbeatData | null }>("/api/heartbeat", 60_000);
  // P3: today's change — pull recent snapshots (60 = 4 days × 15 funds upper bound)
  const { data: snapResp } = useFetch<{ snapshots: SnapshotData[]; startDate?: string | null }>("/api/snapshots?limit=60", 300_000);

  const [showShare, setShowShare] = useState(false);

  const totalPool = funds.reduce((s, f) => s + f.totalValue, 0);
  const initialCapital = funds.reduce((s, f) => s + f.initialBalance, 0);

  // Days running: use the API-provided startDate (MIN(date) from DB) so the count
  // always reflects the true launch date, not the sliding snapshot-window cutoff.
  const daysRunning = (() => {
    const anchor = snapResp?.startDate ?? (snapResp?.snapshots?.length
      ? snapResp.snapshots.reduce((min, s) => s.date < min ? s.date : min, snapResp.snapshots[0].date)
      : null);
    if (!anchor) return null;
    return Math.max(1, Math.floor((Date.now() - new Date(anchor).getTime()) / 86400000) + 1);
  })();
  const SEASON_DAYS = 90;
  const arcRadius = 15;
  const arcCirc = 2 * Math.PI * arcRadius;
  const arcLen = daysRunning ? Math.min(daysRunning / SEASON_DAYS, 1) * arcCirc : 0;
  const totalPnl = totalPool - initialCapital;
  const totalReturnPct = initialCapital > 0 ? ((totalPool - initialCapital) / initialCapital) * 100 : 0;

  // P3: today's change — compare current totalPool to most-recent snapshot per fund.
  // Snapshots are written daily at UTC 00:00; we only count funds that have at least one snapshot
  // (and only the matching subset on the live side) so the two pools always align.
  let todayChangePct: number | null = null;
  if (snapResp?.snapshots && snapResp.snapshots.length > 0) {
    const latestByFund = new Map<string, SnapshotData>();
    for (const s of snapResp.snapshots) {
      const cur = latestByFund.get(s.fund_id);
      if (!cur || new Date(s.date) > new Date(cur.date)) latestByFund.set(s.fund_id, s);
    }
    let yesterdayPool = 0;
    let todayPoolMatched = 0;
    for (const f of funds) {
      const snap = latestByFund.get(f.id);
      if (snap) {
        yesterdayPool += snap.total_value;
        todayPoolMatched += f.totalValue;
      }
    }
    if (yesterdayPool > 0) {
      todayChangePct = ((todayPoolMatched - yesterdayPool) / yesterdayPool) * 100;
    }
  }
  const totalOpen = funds.reduce((s, f) => s + f.openPositions, 0);
  const totalWins = funds.reduce((s, f) => s + (f.winCount ?? 0), 0);
  const totalLosses = funds.reduce((s, f) => s + (f.lossCount ?? 0), 0);
  const totalClosed = totalWins + totalLosses;
  const avgWR = totalClosed > 0 ? totalWins / totalClosed : 0;
  const wrSufficient = totalClosed >= 3;

  // P0: realized vs unrealized split (industry standard B2 — IBKR/Coinbase/Polymarket all show this)
  const totalRealized = funds.reduce((s, f) => s + (f.realizedPnl ?? 0), 0);
  const totalUnrealized = funds.reduce((s, f) => s + (f.unrealizedPnl ?? 0), 0);
  const realizedPct = initialCapital > 0 ? (totalRealized / initialCapital) * 100 : 0;
  const unrealizedPct = initialCapital > 0 ? (totalUnrealized / initialCapital) * 100 : 0;

  // P1: unrealized share warning (Coinbase B4 — flag when unrealized dominates declared profit)
  // Trigger only when there's a meaningful positive total profit and >70% is paper
  const unrealizedShare = totalPnl > 0 && totalUnrealized > 0
    ? totalUnrealized / totalPnl
    : 0;
  const showUnrealizedWarning = totalPnl > 0 && unrealizedShare > 0.7;

  // D-Lite (2026-05-10): aggregate stale-position count across all funds.
  // When >0, render an amber stale-price banner so users know the displayed
  // unrealized PnL excludes some positions whose CLOB mid-price is unavailable.
  const totalStale = funds.reduce((s, f) => s + (f.staleCount ?? 0), 0);
  const showStaleWarning = totalStale > 0;

  const pnlColor = totalPnl > 0 ? "text-[var(--r-green)]" : totalPnl < 0 ? "text-[var(--r-red)]" : "";
  const returnColor = totalReturnPct > 0 ? "text-[var(--r-green)]" : totalReturnPct < 0 ? "text-[var(--r-red)]" : "";
  const pnlPrefix = totalPnl > 0 ? "+" : totalPnl < 0 ? "-" : "";
  const returnPrefix = totalReturnPct > 0 ? "+" : "";

  const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  // Mobile compact format: $6.08M / $5.55M / +$528.48K — prevents 3-column KPI overlap on narrow viewports.
  const fmtCompact = (v: number) => v.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 2 });
  const realizedColor = totalRealized > 0 ? "text-[var(--r-green)]" : totalRealized < 0 ? "text-[var(--r-red)]" : "text-[var(--r-text-faint)]";
  const unrealizedColor = totalUnrealized > 0 ? "text-[var(--r-green)]" : totalUnrealized < 0 ? "text-[var(--r-red)]" : "text-[var(--r-text-faint)]";
  const todayColor = todayChangePct == null
    ? "text-[var(--r-text-faint)]"
    : todayChangePct > 0 ? "text-[var(--r-green)]"
    : todayChangePct < 0 ? "text-[var(--r-red)]"
    : "text-[var(--r-text-faint)]";

  const highlight = useHighlight(events);

  return (
    <>
    <div className="glass-card p-5 mb-6 relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-r from-[var(--r-accent)]/5 to-transparent pointer-events-none" />
      <div className="relative">
        {/* Share button + days-running arc — top-right of hero */}
        <div className="absolute top-0 right-0 flex items-center gap-2">
          {/* P2-①: Days running arc ring */}
          {daysRunning !== null && (
            <div className="relative w-9 h-9 shrink-0" title={`${t("dayRunning")} ${daysRunning}`}>
              <svg width="36" height="36" className="-rotate-90">
                <circle cx="18" cy="18" r={arcRadius} fill="none" stroke="var(--r-border)" strokeWidth="2" />
                <circle
                  cx="18" cy="18" r={arcRadius} fill="none"
                  stroke="var(--r-accent)" strokeWidth="2" strokeLinecap="round"
                  strokeDasharray={`${arcLen} ${arcCirc}`}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-[9px] font-bold tabular-nums text-[var(--r-accent)] leading-none">{daysRunning}</span>
                <span className="text-[6px] text-[var(--r-text-faint)] leading-none mt-px">{t("dayRunning")}</span>
              </div>
            </div>
          )}
          <button
            onClick={() => setShowShare(true)}
            title={t("shareTitle")}
            className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium text-[var(--r-text-faint)] hover:text-[var(--r-accent)] rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--r-accent)]"
          >
            <Share2 className="w-3 h-3 shrink-0" />
            <span className="hidden sm:inline">{t("shareTitle")}</span>
          </button>
        </div>

        {/* P2-③: Disconnected banner — removed to avoid false-alarm on page load */}
        {/* ── Hero dominant: 总收益率 ── */}
        <div className="text-center mb-4 pt-1">
          <p className="text-[10px] uppercase tracking-widest text-[var(--r-text-faint)] mb-1.5 font-medium">{t("heroTotalReturn")}</p>
          <p className={`text-4xl sm:text-5xl font-bold font-mono tabular-nums tracking-tight ${returnColor}`}>
            {returnPrefix}{totalReturnPct.toFixed(2)}%
          </p>
          <p className="text-[10px] font-mono tabular-nums mt-2">
            <span className={realizedColor}>{t("heroRealized")} {fmtPct(realizedPct)}</span>
            <span className="mx-1.5 text-[var(--r-border)]">·</span>
            <span className={unrealizedColor}>
              {t("heroUnrealized")} {fmtPct(unrealizedPct)}
              {showUnrealizedWarning && (
                <span className="ml-1 text-amber-500/70 font-normal" title={t("heroUnrealizedWarning")}>
                  ({Math.round(unrealizedShare * 100)}%{t("heroUnrealizedPaperLabel")})
                </span>
              )}
            </span>
          </p>
        </div>

        {/* D-Lite stale-price banner */}
        {showStaleWarning && (
          <div className="flex items-center gap-2 px-3 py-2 mb-3 rounded-md bg-amber-500/5 border border-amber-500/20 text-[11px]">
            <span className="text-amber-400 font-bold tabular-nums shrink-0">{totalStale}</span>
            <span className="text-amber-200/80">{t("heroStaleWarning")}</span>
          </div>
        )}

        {/* ── Secondary metrics row  (4 cards: PnL · Today · Open Positions · Analysis) ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 mb-3">
          <div className="text-center min-w-0 rounded-lg py-2.5 px-1 bg-white/[0.025]">
            <p className="text-[10px] text-[var(--r-text-faint)] mb-1">{t("heroTotalPnl")}</p>
            <p className={`text-base sm:text-lg font-bold font-mono tabular-nums whitespace-nowrap ${pnlColor}`}>
              <span className="sm:hidden">{pnlPrefix}${fmtCompact(Math.abs(totalPnl))}</span>
              <span className="hidden sm:inline">{pnlPrefix}${Math.abs(totalPnl).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </p>
          </div>
          <div className="text-center min-w-0 rounded-lg py-2.5 px-1 bg-white/[0.025]">
            <p className="text-[10px] text-[var(--r-text-faint)] mb-1">
              {todayChangePct != null ? t("heroToday") : t("heroTotalPool")}
            </p>
            <p className={`text-base sm:text-lg font-bold font-mono tabular-nums whitespace-nowrap ${todayChangePct != null ? todayColor : ""}`}>
              {todayChangePct != null
                ? fmtPct(todayChangePct)
                : <><span className="sm:hidden">${fmtCompact(totalPool)}</span><span className="hidden sm:inline">${totalPool.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span></>
              }
            </p>
          </div>
          <div className="text-center min-w-0 rounded-lg py-2.5 px-1 bg-white/[0.025]">
            <p className="text-[10px] text-[var(--r-text-faint)] mb-1">{t("heroActivePositions")}</p>
            <p className="text-base sm:text-lg font-bold font-mono tabular-nums whitespace-nowrap">{totalOpen}</p>
          </div>
          {/* 4th card: history analysis entry */}
          <NavLink
            to="/analysis"
            className="text-center min-w-0 rounded-lg py-2.5 px-1 bg-white/[0.025] border border-transparent hover:border-[var(--r-accent)]/40 hover:bg-[var(--r-accent)]/5 transition-all no-underline group cursor-pointer"
          >
            <p className="text-[10px] text-[var(--r-text-faint)] mb-1.5 group-hover:text-[var(--r-accent)] transition-colors">
              {t("analysisPageTitle")}
            </p>
            <div className="flex items-center justify-center">
              <BarChart2 className="w-5 h-5 text-[var(--r-text-muted)] group-hover:text-[var(--r-accent)] transition-colors" />
            </div>
          </NavLink>
        </div>

        {/* ── Footnote: auxiliary context ── */}
        <p className="text-center text-[10px] text-[var(--r-text-faint)] font-mono mb-4 leading-relaxed">
          {t("heroInitialCapital")} <span className="tabular-nums">${fmtCompact(initialCapital)}</span>
          <span className="mx-1.5 opacity-40">·</span>
          {t("heroTotalPool")} <span className="tabular-nums">${fmtCompact(totalPool)}</span>
          <span className="mx-1.5 opacity-40">·</span>
          {t("heroSystemWR")} <span className="tabular-nums">{wrSufficient ? `${Math.round(avgWR * 100)}%` : t("heroWRInsufficient")}</span>
        </p>
        {/* P2-⑤: Hero aux link — docs */}
        <div className="flex items-center justify-center mt-2">
          <NavLink to="/docs" className="text-[10px] text-[var(--r-text-faint)] hover:text-[var(--r-accent)] transition-colors no-underline">
            {t("heroLearnMoreLink")}
          </NavLink>
        </div>

        {/* Highlight ticker */}
        {highlight.url ? (
          <a
            href={highlight.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-xs border-t border-[var(--r-border)] pt-3 group cursor-pointer"
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${highlight.positive ? "bg-[var(--r-green)]" : "bg-[var(--r-red)]"} animate-pulse`} />
            <span className="text-[var(--r-text-muted)] truncate group-hover:text-[var(--r-accent)] transition-colors">{highlight.text}</span>
            <ExternalLink className="w-3 h-3 shrink-0 text-[var(--r-text-faint)] group-hover:text-[var(--r-accent)] transition-colors" />
          </a>
        ) : (
          <div className="flex items-center gap-2 text-xs border-t border-[var(--r-border)] pt-3">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${highlight.positive ? "bg-[var(--r-green)]" : "bg-[var(--r-red)]"} animate-pulse`} />
            <span className="text-[var(--r-text-muted)] truncate">{highlight.text}</span>
          </div>
        )}

        {/* Heartbeat bar */}
        <HeartbeatBar heartbeat={hbResp?.heartbeat ?? null} />
      </div>
    </div>
    <ShareModal
      isOpen={showShare}
      onClose={() => setShowShare(false)}
      funds={funds}
      snapshots={snapResp?.snapshots ?? []}
      startDate={snapResp?.startDate}
      totalPool={totalPool}
      initialCapital={initialCapital}
      totalPnl={totalPnl}
      totalReturnPct={totalReturnPct}
      todayChangePct={todayChangePct}
    />
    </>
  );
}

function ArenaPage() {
  const { events, funds, fundsLoading, connected } = useLayoutContext();
  const { t } = useI18n();
  const { data: snapshotsResp } = useFetch<{ snapshots: SnapshotData[] }>("/api/snapshots?limit=60", 120_000);

  // Mobile tab state — persisted in sessionStorage
  const [mobileTab, setMobileTab] = useState<"rankings" | "events">(() => {
    try { return (sessionStorage.getItem("arena-tab") as "rankings" | "events") || "rankings"; } catch { return "rankings"; }
  });
  const [unreadEvents, setUnreadEvents] = useState(0);
  const prevEventsLenRef = useRef(events.length);

  useEffect(() => {
    const diff = events.length - prevEventsLenRef.current;
    if (diff > 0 && mobileTab === "rankings") {
      setUnreadEvents(c => Math.min(c + diff, 99));
    }
    prevEventsLenRef.current = events.length;
  }, [events.length, mobileTab]);

  const switchTab = (tab: "rankings" | "events") => {
    setMobileTab(tab);
    if (tab === "events") setUnreadEvents(0);
    try { sessionStorage.setItem("arena-tab", tab); } catch {}
  };

  // P1-①: Hero visibility → sticky command bar
  const heroSentinelRef = useRef<HTMLDivElement>(null);
  const [heroVisible, setHeroVisible] = useState(true);
  useEffect(() => {
    const el = heroSentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => setHeroVisible(entry.isIntersecting),
      { threshold: 0, rootMargin: "-64px 0px 0px 0px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // P1-②: Fund activity map (last event timestamp per fund_id)
  const fundLastActivity = useMemo(() => {
    const map: Record<string, number> = {};
    for (const event of events) {
      const fid = (event.payload as Record<string, unknown>)?.fund_id as string | undefined;
      if (!fid) continue;
      const ts = new Date(event.timestamp).getTime();
      if (!map[fid] || ts > map[fid]) map[fid] = ts;
    }
    return map;
  }, [events]);

  // P1-⑤: Today's activity summary
  const todaySummary = useMemo(() => {
    const todayStr = new Date().toISOString().split("T")[0];
    let scans = 0, tradesOpened = 0, evolutions = 0, tradePnl = 0;
    for (const event of events) {
      if (new Date(event.timestamp).toISOString().split("T")[0] !== todayStr) continue;
      if (event.type === "SCAN_COMPLETE") scans++;
      else if (event.type === "TRADE_OPENED") tradesOpened++;
      else if (event.type === "EVOLUTION_COMPLETED" || event.type === "MICRO_EVOLUTION") evolutions++;
      else if (["TRADE_SETTLED", "TRADE_STOPPED", "TRADE_EXPIRED", "TRADE_PROFIT_TAKEN", "TRADE_TRAILING_STOPPED"].includes(event.type)) {
        const d = event.payload as Record<string, unknown>;
        tradePnl += (d?.pnl as number) ?? (d?.amount as number) ?? 0;
      }
    }
    return { scans, tradesOpened, evolutions, tradePnl };
  }, [events]);

  const sparklineData: Record<string, number[]> = {};
  if (snapshotsResp?.snapshots) {
    const byFund: Record<string, SnapshotData[]> = {};
    for (const s of snapshotsResp.snapshots) {
      (byFund[s.fund_id] ??= []).push(s);
    }
    for (const [fid, snaps] of Object.entries(byFund)) {
      sparklineData[fid] = snaps.slice(0, 7).reverse().map(s => s.total_value);
    }
  }

  const totalPool    = funds.reduce((s, f) => s + f.totalValue, 0);
  const initCap      = funds.reduce((s, f) => s + f.initialBalance, 0);
  const totalPnl     = totalPool - initCap;
  const totalRetPct  = initCap > 0 ? ((totalPool - initCap) / initCap) * 100 : 0;
  const retColor     = totalRetPct > 0 ? "text-[var(--r-green)]" : totalRetPct < 0 ? "text-[var(--r-red)]" : "";
  const pnlColor     = totalPnl  > 0 ? "text-[var(--r-green)]" : totalPnl  < 0 ? "text-[var(--r-red)]" : "";
  const fmtC = (v: number) => v.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 2 });

  const hasTodaySummary = todaySummary.scans > 0 || todaySummary.tradesOpened > 0 || todaySummary.evolutions > 0;

  return (
    <div>
        {funds.length > 0 && <HeroOverview funds={funds} events={events} />}
      {/* Sentinel: IntersectionObserver watches this to show/hide command bar */}
      <div ref={heroSentinelRef} className="pointer-events-none h-0" aria-hidden />

      {/* P1-①: Sticky command bar — slides in when hero scrolls above fold */}
      <div
        className={`fixed left-0 right-0 z-40 border-b border-[var(--r-border)] bg-[var(--r-surface)]/95 backdrop-blur-md transition-all duration-300 ${
          heroVisible || funds.length === 0 ? "-top-12 opacity-0 pointer-events-none" : "top-[60px] opacity-100"
        }`}
      >
        <div className="max-w-6xl mx-auto px-4 h-10 flex items-center gap-2.5 pt-0.5">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse shrink-0" />
          <span className="text-[10px] text-[var(--r-text-faint)] font-medium uppercase tracking-widest shrink-0">
            {t("cmdBarLive")}
          </span>
          <span className="w-px h-3 bg-[var(--r-border)] shrink-0" />
          <span className={`font-mono text-xs font-bold tabular-nums whitespace-nowrap ${retColor}`}>
            {totalRetPct >= 0 ? "+" : ""}{totalRetPct.toFixed(2)}%
          </span>
          <span className="text-[var(--r-text-faint)] text-xs opacity-50 hidden sm:inline">·</span>
          <span className={`font-mono text-xs font-medium tabular-nums whitespace-nowrap hidden sm:inline ${pnlColor}`}>
            {totalPnl >= 0 ? "+" : "−"}${fmtC(Math.abs(totalPnl))}
          </span>
          <div className="flex-1" />
          <NavLink
            to="/analysis"
            className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] border border-[var(--r-border)] text-[var(--r-text-faint)] hover:border-[var(--r-accent)] hover:text-[var(--r-accent)] transition-colors no-underline shrink-0"
          >
            <BarChart2 className="w-2.5 h-2.5 shrink-0" />
            <span className="hidden sm:inline">{t("analysisEntryBtn")}</span>
          </NavLink>
        </div>
      </div>

      {/* Mobile tab switcher */}
      <div className="lg:hidden flex p-1 rounded-xl bg-[var(--r-surface)] border border-[var(--r-border)] mb-4">
        <button
          onClick={() => switchTab("rankings")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium transition-all ${
            mobileTab === "rankings"
              ? "bg-[var(--r-bg)] shadow text-[var(--r-text)]"
              : "text-[var(--r-text-muted)] hover:text-[var(--r-text)]"
          }`}
        >
          🏆 {t("fundArenaRankings")}
        </button>
        <button
          onClick={() => switchTab("events")}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium transition-all relative ${
            mobileTab === "events"
              ? "bg-[var(--r-bg)] shadow text-[var(--r-text)]"
              : "text-[var(--r-text-muted)] hover:text-[var(--r-text)]"
          }`}
        >
          ⚡ {t("liveEventFeed")}
          {unreadEvents > 0 && (
            <span className="absolute -top-0.5 right-2 min-w-[16px] h-4 px-1 rounded-full bg-[var(--r-accent)] text-white text-[9px] flex items-center justify-center font-bold leading-none">
              {unreadEvents > 9 ? "9+" : unreadEvents}
            </span>
          )}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Left: Fund rankings */}
        <div className={`lg:col-span-3 ${mobileTab !== "rankings" ? "hidden lg:block" : ""}`}>
          <h2 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-3 flex items-center">
            {t("fundArenaRankings")}
            <a href="https://rotifer.dev" target="_blank" rel="noopener noreferrer" className="normal-case tracking-normal font-normal text-[10px] text-[var(--r-text-faint)] hover:text-[var(--r-accent)] transition-colors ml-1.5">
              ({t("agentTagline1")})
            </a>
            <InfoPopover />
          </h2>
          <div className="flex items-center gap-1.5 mb-4">
            <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-[var(--r-accent)] text-white whitespace-nowrap">
              {t("marketPrediction")}
            </span>
            <span className="px-2.5 py-1 rounded-full text-xs font-medium border border-dashed border-[var(--r-border)] text-[var(--r-text-faint)] whitespace-nowrap cursor-not-allowed opacity-50" title={t("marketSoon")}>
              {t("marketDefi")}
            </span>
            <span className="px-2.5 py-1 rounded-full text-xs font-medium border border-dashed border-[var(--r-border)] text-[var(--r-text-faint)] whitespace-nowrap cursor-not-allowed opacity-50" title={t("marketSoon")}>
              {t("marketSports")}
            </span>
          </div>
          {fundsLoading ? (
            <div className="space-y-2.5">
              {[...Array(5)].map((_, i) => (
                <FundCardSkeleton key={i} delay={i * 0.07} />
              ))}
            </div>
          ) : funds.length > 0 ? (
            <>
              <FundRanking funds={funds} sparklines={sparklineData} lastActivity={fundLastActivity} />
              {/* Secondary CTA — natural discovery after reading rankings */}
              <NavLink
                to="/analysis"
                className="mt-3 flex items-center justify-center gap-2 w-full py-2.5 rounded-xl border border-[var(--r-border)] text-[11px] text-[var(--r-text-muted)] hover:border-[var(--r-accent)] hover:text-[var(--r-accent)] transition-colors no-underline"
              >
                <BarChart2 className="w-3.5 h-3.5 shrink-0" />
                {t("analysisFullHistoryBtn")}
              </NavLink>
            </>
          ) : (
            <div className="glass-card p-8 text-center text-[var(--r-text-muted)]">{t("noFundData")}</div>
          )}
        </div>

        {/* Right: Market drivers + today summary + event feed (sticky on desktop) */}
        <div className={`lg:col-span-2 lg:sticky lg:top-4 lg:self-start ${mobileTab !== "events" ? "hidden lg:block" : ""}`}>
          {/* P1-③: MarketDriversCard lives here — semantic coherence with event feed */}
          {funds.length > 0 && <MarketDriversCard totalPool={totalPool} />}

          {/* P1-⑤: Today's activity summary strip */}
          {hasTodaySummary && (
            <div className="flex items-center gap-1.5 flex-wrap text-[10px] text-[var(--r-text-faint)] mb-3 px-0.5">
              <span className="font-medium text-[var(--r-text-muted)] shrink-0">{t("todaySummaryLabel")}</span>
              {todaySummary.scans > 0 && (
                <span className="whitespace-nowrap">{todaySummary.scans} {t("todaySummaryScans")}</span>
              )}
              {todaySummary.tradesOpened > 0 && (
                <span className="whitespace-nowrap">· {todaySummary.tradesOpened} {t("todaySummaryTrades")}</span>
              )}
              {todaySummary.evolutions > 0 && (
                <span className="whitespace-nowrap">· {todaySummary.evolutions} {t("todaySummaryEvolutions")}</span>
              )}
              {todaySummary.tradePnl !== 0 && (
                <span className={`font-mono tabular-nums whitespace-nowrap ${todaySummary.tradePnl > 0 ? "text-[var(--r-green)]" : "text-[var(--r-red)]"}`}>
                  · {todaySummary.tradePnl >= 0 ? "+" : ""}${fmtC(Math.abs(todaySummary.tradePnl))}
                </span>
              )}
            </div>
          )}

          <h2 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-4">
            {t("liveEventFeed")}
          </h2>
          <EventFeed events={events} connected={connected} fillViewport />
        </div>
      </div>
    </div>
  );
}

function EvolutionPage() {
  const { t } = useI18n();

  return (
    <div>
      <h2 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-4">
        {t("evolutionHistory")}
      </h2>
      <EvolutionPanel />
    </div>
  );
}

function GeneEvolutionPage() {
  const { t } = useI18n();
  return (
    <div>
      <h2 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-1">
        {t("geneEvolution")}
      </h2>
      <p className="text-xs text-[var(--r-text-faint)] mb-4">{t("geneEvolutionDesc")}</p>
      <GeneEvolutionPanel />
    </div>
  );
}

function ArenaCompetitionPage() {
  const { t } = useI18n();
  return (
    <div>
      <div className="mb-6">
        <h2 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-1">
          {t("arenaTitle")}
        </h2>
        <p className="text-xs text-[var(--r-text-faint)]">{t("arenaSubtitle")}</p>
      </div>
      <LazyArenaPage />
    </div>
  );
}

function ShadowPage() {
  const { t } = useI18n();

  return (
    <div>
      <h2 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-1">
        {t("shadowTitle")}
      </h2>
      <p className="text-xs text-[var(--r-text-faint)] mb-4">{t("shadowDesc")}</p>
      <ShadowPanel />
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<ArenaPage />} />
        <Route path="evolution" element={
          <Suspense fallback={<EvolutionSkeleton />}><EvolutionPage /></Suspense>
        } />
        <Route path="shadow" element={
          <Suspense fallback={<PageSkeleton />}><ShadowPage /></Suspense>
        } />
        <Route path="arena" element={
          <Suspense fallback={<PageSkeleton />}><ArenaCompetitionPage /></Suspense>
        } />
        <Route path="gene-evolution" element={
          <Suspense fallback={<PageSkeleton />}><GeneEvolutionPage /></Suspense>
        } />
        <Route path="diagnostics" element={
          <Suspense fallback={<PageSkeleton />}><LazyDiagnosticsPage /></Suspense>
        } />
        <Route path="live" element={
          <Suspense fallback={<PageSkeleton />}><LazyLivePanel /></Suspense>
        } />
        <Route path="docs" element={
          <Suspense fallback={<PageSkeleton />}><LazyDocsPage /></Suspense>
        } />
        <Route path="analysis" element={
          <Suspense fallback={<PageSkeleton />}><LazyAnalysisPage /></Suspense>
        } />
        <Route path="fund/:fundId" element={
          <Suspense fallback={<FundPageSkeleton />}><FundDetail /></Suspense>
        } />
      </Route>
    </Routes>
  );
}
