import { useEffect, useState, useRef } from "react";
import { Routes, Route, NavLink, Outlet, useOutletContext } from "react-router-dom";
import { Languages, ExternalLink, Info } from "lucide-react";
import { useWebSocket, type AgentEvent } from "./hooks/useWebSocket";
import { useFetch } from "./hooks/useApi";
import { FundRanking } from "./components/FundRanking";
import { EventFeed } from "./components/EventFeed";
import { StatusBar } from "./components/StatusBar";
import { EvolutionPanel } from "./components/EvolutionPanel";
import { FundDetail } from "./components/FundDetail";
import { ShadowPanel } from "./components/ShadowPanel";
import { GeneEvolutionPanel } from "./components/GeneEvolutionPanel";
import { useI18n } from "./i18n/context";
import type { TranslationKey } from "./i18n/translations";
import { fundDisplayName } from "./lib/fundMeta";

const WS_URL = import.meta.env.VITE_WS_URL || (import.meta.env.PROD ? "wss://api.rotifer.xyz/ws" : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);

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
        className="text-[var(--r-text-faint)] hover:text-[var(--r-text-muted)] transition-colors ml-1"
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
              <NavLink to="/evolution" className={navClass}>{t("evolution")}</NavLink>
              <NavLink to="/shadow" className={navClass}>{t("shadow")}</NavLink>
              <NavLink to="/gene-evolution" className={navClass}>{t("geneEvolution")}</NavLink>
        </div>

        <button
              onClick={toggle}
              className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs text-[var(--r-text-muted)] hover:text-[var(--r-text)] border border-[var(--r-border)] hover:border-[var(--r-border-hover)] transition-all"
              title={locale === "en" ? t("langSwitchTooltipAlt") : t("langSwitchTooltip")}
        >
              <Languages className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{locale === "en" ? "中文" : "EN"}</span>
        </button>

            <StatusBar connected={connected} connectionCount={connectionCount} />
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        <div className="sm:hidden flex items-center gap-1 bg-[var(--r-surface)] border border-[var(--r-border)] rounded-lg p-1 mb-6">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `flex-1 px-3 py-2 rounded-md text-sm font-medium text-center transition-all ${
                isActive ? "bg-[var(--r-accent)] text-white" : "text-[var(--r-text-muted)]"
              }`
            }
          >
            {t("arena")}
          </NavLink>
          <NavLink
            to="/evolution"
            className={({ isActive }) =>
              `flex-1 px-3 py-2 rounded-md text-sm font-medium text-center transition-all ${
                isActive ? "bg-[var(--r-accent)] text-white" : "text-[var(--r-text-muted)]"
              }`
            }
          >
            {t("evolution")}
          </NavLink>
          <NavLink
            to="/shadow"
            className={({ isActive }) =>
              `flex-1 px-3 py-2 rounded-md text-sm font-medium text-center transition-all ${
                isActive ? "bg-[var(--r-accent)] text-white" : "text-[var(--r-text-muted)]"
              }`
            }
          >
            {t("shadow")}
          </NavLink>
          <NavLink
            to="/gene-evolution"
            className={({ isActive }) =>
              `flex-1 px-3 py-2 rounded-md text-sm font-medium text-center transition-all ${
                isActive ? "bg-[var(--r-accent)] text-white" : "text-[var(--r-text-muted)]"
              }`
            }
          >
            {t("geneEvolution")}
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
            <div className="flex gap-12 text-xs">
              <div className="space-y-2.5">
                <p className="font-medium text-[var(--r-text-muted)] uppercase tracking-widest text-[10px]">{t("footerProtocol")}</p>
                <a href="https://rotifer.dev" target="_blank" rel="noopener noreferrer" className="block text-[var(--r-text-faint)] hover:text-[var(--r-text)] transition-colors">rotifer.dev</a>
                <a href="https://rotifer.ai" target="_blank" rel="noopener noreferrer" className="block text-[var(--r-text-faint)] hover:text-[var(--r-text)] transition-colors">rotifer.ai</a>
                <a href="https://github.com/rotifer-protocol" target="_blank" rel="noopener noreferrer" className="block text-[var(--r-text-faint)] hover:text-[var(--r-text)] transition-colors">GitHub</a>
              </div>
              <div className="space-y-2.5">
                <p className="font-medium text-[var(--r-text-muted)] uppercase tracking-widest text-[10px]">{t("footerData")}</p>
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
      return { text: `${tFund(p.fundName)} ${t("eventOpened")} · $${String(p.amount)} · ${String(p.question).slice(0, 40)}`, positive: true, url: polymarketUrl(p.slug, p.question) };
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

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-[var(--r-text-faint)] mt-2">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isRecent ? "bg-[var(--r-green)]" : "bg-[var(--r-text-faint)] opacity-40"}`} />
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

  const totalPool = funds.reduce((s, f) => s + f.totalValue, 0);
  const initialCapital = funds.reduce((s, f) => s + f.initialBalance, 0);
  const totalPnl = totalPool - initialCapital;
  const totalReturnPct = initialCapital > 0 ? ((totalPool - initialCapital) / initialCapital) * 100 : 0;
  const totalOpen = funds.reduce((s, f) => s + f.openPositions, 0);
  const totalWins = funds.reduce((s, f) => s + (f.winCount ?? 0), 0);
  const totalLosses = funds.reduce((s, f) => s + (f.lossCount ?? 0), 0);
  const totalClosed = totalWins + totalLosses;
  const avgWR = totalClosed > 0 ? totalWins / totalClosed : 0;
  const wrSufficient = totalClosed >= 3;

  const pnlColor = totalPnl > 0 ? "text-[var(--r-green)]" : totalPnl < 0 ? "text-[var(--r-red)]" : "";
  const returnColor = totalReturnPct > 0 ? "text-[var(--r-green)]" : totalReturnPct < 0 ? "text-[var(--r-red)]" : "";
  const pnlPrefix = totalPnl > 0 ? "+" : totalPnl < 0 ? "-" : "";
  const returnPrefix = totalReturnPct > 0 ? "+" : "";

  const highlight = useHighlight(events);

  return (
    <div className="glass-card p-5 mb-6 relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-r from-[var(--r-accent)]/5 to-transparent pointer-events-none" />
      <div className="relative">
        {/* Primary row: 3 large metrics */}
        <div className="grid grid-cols-3 gap-4 mb-3">
          <div className="text-center">
            <p className="text-xs text-[var(--r-text-muted)] mb-1">{t("heroTotalPool")}</p>
            <p className="text-xl font-bold font-mono tabular-nums">${totalPool.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-[var(--r-text-muted)] mb-1">{t("heroTotalReturn")}</p>
            <p className={`text-xl font-bold font-mono tabular-nums ${returnColor}`}>{returnPrefix}{totalReturnPct.toFixed(2)}%</p>
          </div>
          <div className="text-center">
            <p className="text-xs text-[var(--r-text-muted)] mb-1">{t("heroActivePositions")}</p>
            <p className="text-xl font-bold font-mono tabular-nums">{totalOpen}</p>
          </div>
        </div>

        {/* Secondary row: 3 supplementary metrics */}
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="text-center">
            <p className="text-[10px] text-[var(--r-text-faint)] mb-0.5">{t("heroInitialCapital")}</p>
            <p className="text-sm font-mono tabular-nums text-[var(--r-text-muted)]">${initialCapital.toLocaleString()}</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-[var(--r-text-faint)] mb-0.5">{t("heroTotalPnl")}</p>
            <p className={`text-sm font-mono tabular-nums ${pnlColor}`}>{pnlPrefix}${Math.abs(totalPnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-[var(--r-text-faint)] mb-0.5">{t("heroSystemWR")}</p>
            <p className="text-sm font-mono tabular-nums text-[var(--r-text-muted)]">
              {wrSufficient ? `${Math.round(avgWR * 100)}%` : t("heroWRInsufficient")}
            </p>
          </div>
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
  );
}

function ArenaPage() {
  const { events, funds, fundsLoading } = useLayoutContext();
  const { t } = useI18n();
  const { data: snapshotsResp } = useFetch<{ snapshots: SnapshotData[] }>("/api/snapshots?limit=60", 120_000);

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

  return (
    <div>
      {funds.length > 0 && <HeroOverview funds={funds} events={events} />}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-3">
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
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="glass-card p-5 h-20 animate-pulse" />
              ))}
            </div>
          ) : funds.length > 0 ? (
            <FundRanking funds={funds} sparklines={sparklineData} />
          ) : (
            <div className="glass-card p-8 text-center text-[var(--r-text-muted)]">{t("noFundData")}</div>
          )}
        </div>
        <div className="lg:col-span-2">
          <h2 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-4">
            {t("liveEventFeed")}
          </h2>
          <EventFeed events={events} />
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
        <Route path="evolution" element={<EvolutionPage />} />
        <Route path="shadow" element={<ShadowPage />} />
        <Route path="gene-evolution" element={<GeneEvolutionPage />} />
        <Route path="fund/:fundId" element={<FundDetail />} />
      </Route>
    </Routes>
  );
}
