import { useState, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ArrowLeft, TrendingUp, Activity, Target,
  Shield, ChevronDown, ChevronUp, Fingerprint, ExternalLink,
  Zap, RefreshCw, GitBranch,
} from "lucide-react";
import { ComposedChart, Area, Line, LineChart, BarChart, Bar, Cell, ReferenceLine, RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { useFetch } from "../hooks/useApi";
import { FUND_ICONS } from "./icons/FundIcons";
import { FUND_COLORS } from "./FundRanking";
import { useI18n } from "../i18n/context";
import { formatFundGeneration, type TranslationKey } from "../i18n/translations";
import { FUND_NAME_KEYS, FUND_MOTTO_KEYS, fundDisplayName, fundTierLabel, fmtUSD } from "../lib/fundMeta";
import { InfoPopover } from "./InfoPopover";

const REASON_I18N: Record<string, TranslationKey> = {
  STANDARD_PBT: "actionPbt", PBT_INHERIT_MUTATE: "actionInherit",
  GLOBAL_RESET: "actionReset", SKIP_INSUFFICIENT: "actionSkipInsufficient",
  SKIP_ALL_GOOD: "actionSkipGood", UNCHANGED: "actionUnchanged",
  MICRO_EVOLUTION: "microEvolutionLabel",
};

interface FundDetailData {
  id: string; name: string; emoji: string; motto: string;
  initialBalance: number; totalValue: number; returnPct: number;
  winRate: number; openPositions: number; monthlyTarget: number;
  frozen: boolean; winCount: number; lossCount: number; realizedPnl: number; unrealizedPnl?: number;
  config: {
    allowedTypes: string[]; monthlyTarget: number; minEdge: number; minConfidence: number;
    minVolume: number; minLiquidity: number; maxPerEvent: number;
    maxOpenPositions: number; stopLossPercent: number; maxHoldDays: number;
    takeProfitPercent?: number; trailingStopPercent?: number; probReversalThreshold?: number;
    sizingMode: string; sizingBase: number; sizingScale: number;
    drawdownLimit: number; drawdownSoftLimit: number;
    generation: number; parentId: string | null;
  };
}

interface Trade {
  id: string; fund_id: string; question: string; direction: string;
  entry_price: number; exit_price: number | null; amount: number;
  pnl: number | null; status: string; opened_at: string; closed_at: string | null;
  signal_id: string; market_id: string; slug: string; shares: number;
  current_price?: number | null; current_value?: number | null;
  unrealized_pnl?: number | null; live_return_pct?: number | null;
  raw_status?: string;
  close_reason?: string | null;
  close_reason_code?: string | null;
  counts_toward_performance?: boolean;
  is_system_closed?: boolean;
}

function polymarketUrl(slug: string, marketId: string, question: string): string {
  const s = slug || (marketId && !marketId.startsWith("0x") && marketId.includes("-") ? marketId : "");
  if (s) return `https://polymarket.com/event/${s}`;
  return `https://polymarket.com/markets?_q=${encodeURIComponent(question)}`;
}

const STATUS_KEYS: Record<string, TranslationKey> = {
  OPEN: "tradeStatusOpen",
  RESOLVED: "tradeStatusResolved",
  STOPPED: "tradeStatusStopped",
  EXPIRED: "tradeStatusExpired",
  INVALIDATED: "tradeStatusInvalidated",
  PROFIT_TAKEN: "eventProfitTaken",
  TRAILING_STOPPED: "eventTrailingStopped",
  REVERSED: "eventReversed",
};

const CLOSE_REASON_KEYS: Record<string, TranslationKey> = {
  MARKET_RESOLVED: "closeReasonResolved",
  STOP_LOSS_TRIGGERED: "closeReasonStopLoss",
  MAX_HOLD_REACHED: "closeReasonExpired",
  TAKE_PROFIT_TRIGGERED: "closeReasonTakeProfit",
  TRAILING_STOP_TRIGGERED: "closeReasonTrailingStop",
  PROBABILITY_REVERSED: "closeReasonReversed",
  SYSTEM_INVALIDATED: "closeReasonInvalidated",
};

const DIRECTION_KEYS: Record<string, TranslationKey> = {
  BUY_YES: "directionBuyYes",
  SELL_YES: "directionSellYes",
  BUY_BOTH: "directionBuyBoth",
  SELL_BOTH: "directionSellBoth",
  BUY_STRONGEST: "directionBuyStrongest",
  SELL_WEAKEST: "directionSellWeakest",
  PROVIDE_LIQUIDITY: "directionProvideLiquidity",
};

const SIGNAL_TYPE_KEYS: Record<string, TranslationKey> = {
  MISPRICING: "signalMispricing",
  MULTI_OUTCOME_ARB: "signalMultiOutcomeArb",
  SPREAD: "signalSpread",
};

const SIZING_MODE_KEYS: Record<string, TranslationKey> = {
  fixed: "sizingFixed",
  confidence: "sizingConfidence",
  edge: "sizingEdge",
  edge_confidence: "sizingEdgeConfidence",
};

interface Snapshot {
  fund_id: string; date: string; total_value: number; win_rate: number;
  open_positions: number; realized_pnl: number; cash_balance: number;
}

interface EvolutionLog {
  id: string; epoch: number; executed_at: string; action: string;
  fund_id: string; params_before: string; params_after: string;
  fitness_before: number | null; fitness_after: number | null; reason: string;
}

function daysHeld(openedAt: string, closedAt: string | null): number {
  const end = closedAt ? new Date(closedAt) : new Date();
  return Math.max(0, Math.floor((end.getTime() - new Date(openedAt).getTime()) / 86_400_000));
}

function TradeRow({ trade, maxHoldDays, maxAbsPnl }: { trade: Trade; maxHoldDays?: number; maxAbsPnl?: number }) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const pnl = trade.pnl ?? 0;
  const isOpen = trade.status === "OPEN";
  const isInvalidated = trade.status === "INVALIDATED";
  const countsTowardPerformance = trade.counts_toward_performance ?? (!isOpen && !isInvalidated);
  const livePnl = trade.unrealized_pnl ?? 0;
  const statusKey = STATUS_KEYS[trade.status];
  const dirKey = DIRECTION_KEYS[trade.direction];
  const closeReasonKey = trade.close_reason_code ? CLOSE_REASON_KEYS[trade.close_reason_code] : undefined;
  const closeReasonSummary = closeReasonKey
    ? t(closeReasonKey)
    : (trade.close_reason ?? null);
  const closeReasonDetail = trade.close_reason && (
    trade.close_reason_code === "SYSTEM_INVALIDATED" ||
    trade.close_reason_code === "STOP_LOSS_TRIGGERED" ||
    trade.close_reason_code === "TAKE_PROFIT_TRIGGERED" ||
    trade.close_reason_code === "TRAILING_STOP_TRIGGERED" ||
    trade.close_reason_code === "PROBABILITY_REVERSED"
  )
    ? trade.close_reason
    : null;
  const days = daysHeld(trade.opened_at, trade.closed_at);
  const remaining = isOpen && maxHoldDays ? Math.max(0, maxHoldDays - days) : null;
  const holdPct   = isOpen && maxHoldDays ? Math.min(1, days / maxHoldDays) : null;
  const holdColor = holdPct == null ? "" : holdPct >= 0.8 ? "var(--r-red)" : holdPct >= 0.5 ? "#eab308" : "var(--r-green)";

  return (
    <div className="glass-card overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full px-4 py-3 flex items-center gap-3 text-sm text-left hover:bg-[var(--r-overlay-3)] transition-colors"
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${
          isOpen
            ? "bg-yellow-400"
            : isInvalidated
              ? "bg-slate-400"
              : pnl >= 0
                ? "bg-[var(--r-green)]"
                : "bg-[var(--r-red)]"
        }`} />
        <div className="flex-1 min-w-0">
          <a
            href={polymarketUrl(trade.slug, trade.market_id, trade.question)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="truncate inline-flex items-center gap-1 hover:text-[var(--r-accent)] transition-colors max-w-full"
            title={t("viewOnPolymarket")}
          >
            <span className="truncate">{trade.question}</span>
            <ExternalLink className="w-3 h-3 shrink-0 opacity-40" />
          </a>
        </div>
        <span className="text-xs font-mono text-[var(--r-text-muted)] shrink-0">{dirKey ? t(dirKey) : trade.direction}</span>
                <span className="text-xs font-mono shrink-0">{fmtUSD(trade.amount)}</span>
        {isOpen && trade.unrealized_pnl != null && (
          <span className={`text-xs font-mono font-medium shrink-0 ${livePnl >= 0 ? "pnl-positive" : "pnl-negative"}`}>
            {livePnl >= 0 ? "+" : ""}{livePnl.toFixed(2)}
          </span>
        )}
        {!isOpen && (
          <span className={`text-xs font-mono font-medium shrink-0 ${
            countsTowardPerformance
              ? (pnl >= 0 ? "pnl-positive" : "pnl-negative")
              : "text-[var(--r-text-muted)]"
          }`}>
            {countsTowardPerformance ? `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}` : t("notApplicable")}
          </span>
        )}
        {/* PnL mini-bar — proportional to maxAbsPnl in current view */}
        {!isOpen && maxAbsPnl != null && maxAbsPnl > 0 && countsTowardPerformance && (
          <div
            className="hidden sm:flex w-10 h-2 bg-[var(--r-border)] rounded-full overflow-hidden shrink-0"
            title={`${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, (Math.abs(pnl) / maxAbsPnl) * 100)}%`,
                background: pnl >= 0 ? "var(--r-green)" : "var(--r-red)",
              }}
            />
          </div>
        )}
        <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
          isOpen ? "bg-yellow-500/20 text-yellow-400" :
          trade.status === "INVALIDATED" ? "bg-slate-500/20 text-slate-300" :
          trade.status === "RESOLVED" || trade.status === "PROFIT_TAKEN" ? "bg-green-500/20 text-green-400" :
          trade.status === "STOPPED" || trade.status === "TRAILING_STOPPED" ? "bg-red-500/20 text-red-400" :
          trade.status === "REVERSED" ? "bg-rose-500/20 text-rose-400" :
          "bg-orange-500/20 text-orange-400"
        }`}>
          {statusKey ? t(statusKey) : trade.status}
        </span>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-[var(--r-text-muted)] shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-[var(--r-text-muted)] shrink-0" />}
      </button>

      {/* Hold-duration progress strip — only for OPEN trades */}
      {holdPct != null && (
        <div className="h-0.5 bg-[var(--r-border)]">
          <div
            className="h-full transition-all duration-500"
            style={{ width: `${holdPct * 100}%`, background: holdColor }}
          />
        </div>
      )}

      {open && (
        <div className="px-4 pb-3 pt-1 border-t border-[var(--r-border)] text-xs animate-in">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <span className="text-[var(--r-text-muted)]">{t("entryPrice")}</span>
              <p className="font-mono font-medium">${trade.entry_price?.toFixed(3) ?? "—"}</p>
            </div>
            <div>
              <span className="text-[var(--r-text-muted)]">{isOpen ? t("currentPrice") : t("exitPrice")}</span>
              <p className="font-mono font-medium">
                {isOpen
                  ? trade.current_price != null ? `$${trade.current_price.toFixed(3)}` : "—"
                  : trade.exit_price != null ? `$${trade.exit_price.toFixed(3)}` : isInvalidated ? t("notApplicable") : "—"}
              </p>
            </div>
            <div>
              <span className="text-[var(--r-text-muted)]">{t("direction")}</span>
              <p className="font-medium">{dirKey ? t(dirKey) : trade.direction}</p>
            </div>
            <div>
              <span className="text-[var(--r-text-muted)]">{t("openedAt")}</span>
              <p className="font-mono">
                {new Date(trade.opened_at).toLocaleDateString()}
                {remaining != null && <span className="text-[var(--r-text-faint)] ml-1.5">· {t("daysRemaining")}{remaining}{t("daysUnit")}</span>}
              </p>
            </div>
            {trade.closed_at && (
              <div>
                <span className="text-[var(--r-text-muted)]">{t("closedAt")}</span>
                <p className="font-mono">
                  {new Date(trade.closed_at).toLocaleDateString()}
                  <span className="text-[var(--r-text-faint)] ml-1.5">· {t("daysHeld")}{days}{t("daysUnit")}</span>
                </p>
              </div>
            )}
            {!isOpen && (
              <div>
                <span className="text-[var(--r-text-muted)]">{t("pnl")}</span>
                <p className={`font-mono font-bold ${
                  countsTowardPerformance
                    ? (pnl >= 0 ? "pnl-positive" : "pnl-negative")
                    : "text-[var(--r-text-muted)]"
                }`}>
                  {countsTowardPerformance ? `${pnl >= 0 ? "+$" : "-$"}${Math.abs(pnl).toFixed(2)}` : t("notApplicable")}
                </p>
              </div>
            )}
            {!isOpen && closeReasonSummary && (
              <div>
                <span className="text-[var(--r-text-muted)]">{t("closeReason")}</span>
                <p className="font-medium">{closeReasonSummary}</p>
              </div>
            )}
            {isOpen && (
              <>
                <div>
                  <span className="text-[var(--r-text-muted)]">{t("currentValue")}</span>
                  <p className="font-mono font-medium">
                    {trade.current_value != null ? `$${trade.current_value.toFixed(2)}` : "—"}
                  </p>
                </div>
                <div>
                  <span className="text-[var(--r-text-muted)]">{t("unrealizedPnl")}</span>
                  <p className={`font-mono font-bold ${livePnl >= 0 ? "pnl-positive" : "pnl-negative"}`}>
                    {trade.unrealized_pnl != null ? `${livePnl >= 0 ? "+$" : "-$"}${Math.abs(livePnl).toFixed(2)}` : "—"}
                  </p>
                </div>
                <div>
                  <span className="text-[var(--r-text-muted)]">{t("liveReturnPct")}</span>
                  <p className={`font-mono font-medium ${(trade.live_return_pct ?? 0) >= 0 ? "pnl-positive" : "pnl-negative"}`}>
                    {trade.live_return_pct != null ? `${trade.live_return_pct >= 0 ? "+" : ""}${trade.live_return_pct.toFixed(2)}%` : "—"}
                  </p>
                </div>
              </>
            )}
          </div>
          {!isOpen && closeReasonDetail && (
            <div className="mt-3">
              <p className="text-[var(--r-text-faint)] italic">{closeReasonDetail}</p>
              {(trade.close_reason_code === "STOP_LOSS_TRIGGERED" || trade.close_reason_code === "TRAILING_STOP_TRIGGERED") && (
                <p className="text-[var(--r-text-faint)] text-xs mt-1 opacity-60">{t("stopLossNote")}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ParamGroup {
  titleKey: TranslationKey;
  params: { key: string; labelKey: TranslationKey }[];
}

const GENE_GROUPS: ParamGroup[] = [
  {
    titleKey: "geneGroupSignal",
    params: [
      { key: "allowedTypes", labelKey: "paramAllowedTypes" },
      { key: "minEdge", labelKey: "paramMinEdge" },
      { key: "minConfidence", labelKey: "paramMinConfidence" },
      { key: "minVolume", labelKey: "paramMinVolume" },
      { key: "minLiquidity", labelKey: "paramMinLiquidity" },
    ],
  },
  {
    titleKey: "geneGroupPosition",
    params: [
      { key: "maxPerEvent", labelKey: "paramMaxPerEvent" },
      { key: "maxOpenPositions", labelKey: "paramMaxPositions" },
      { key: "sizingMode", labelKey: "paramSizingMode" },
      { key: "sizingBase", labelKey: "paramSizingBase" },
      { key: "sizingScale", labelKey: "paramSizingScale" },
    ],
  },
  {
    titleKey: "geneGroupRisk",
    params: [
      { key: "stopLossPercent", labelKey: "paramStopLoss" },
      { key: "takeProfitPercent", labelKey: "takeProfitLabel" },
      { key: "trailingStopPercent", labelKey: "trailingStopLabel" },
      { key: "probReversalThreshold", labelKey: "probReversalLabel" },
      { key: "maxHoldDays", labelKey: "paramMaxHold" },
      { key: "drawdownLimit", labelKey: "paramDrawdownLimit" },
      { key: "drawdownSoftLimit", labelKey: "paramDrawdownSoft" },
      { key: "monthlyTarget", labelKey: "paramMonthlyTarget" },
    ],
  },
];

const PARAM_LABELS: Record<string, TranslationKey> = {};
for (const g of GENE_GROUPS) for (const p of g.params) PARAM_LABELS[p.key] = p.labelKey;

export function FundDetail() {
  const { fundId } = useParams<{ fundId: string }>();
  const { t, locale } = useI18n();
  const { data: fundResp, loading: fundLoading, error: fundError } = useFetch<{ fund: FundDetailData }>(`/api/funds/${fundId}`, 30_000);
  const { data: closedTradesResp } = useFetch<{ trades: Trade[] }>(`/api/trades?fund=${fundId}&status=CLOSED&limit=50`, 30_000);
  const { data: openTradesResp } = useFetch<{ trades: Trade[] }>(`/api/trades?fund=${fundId}&status=OPEN&limit=20`, 30_000);
  const { data: snapshotsResp } = useFetch<{ snapshots: Snapshot[] }>(`/api/snapshots?fund=${fundId}&limit=92`);
  const { data: evoResp } = useFetch<{ logs: EvolutionLog[] }>("/api/evolution");

  // Equity curve view toggle — persisted across reloads
  type EquityView = "equity" | "daily";
  const [equityView, setEquityViewRaw] = useState<EquityView>(() => readLS<EquityView>(EQUITY_VIEW_KEY, "equity"));
  function setEquityView(v: EquityView) { setEquityViewRaw(v); writeLS(EQUITY_VIEW_KEY, v); }

  // Strategy gene view toggle
  const [geneView, setGeneViewRaw] = useState<GeneView>(() => readLS<GeneView>(GENE_VIEW_KEY, "params"));
  function setGeneView(v: GeneView) { setGeneViewRaw(v); writeLS(GENE_VIEW_KEY, v); }

  if (fundLoading) {
    return (
      <div className="space-y-4">
        <div className="glass-card p-8 h-24 animate-pulse" />
        <div className="glass-card p-8 h-48 animate-pulse" />
      </div>
    );
  }

  const fund = fundResp?.fund;
  if (!fund) {
    return (
      <div className="glass-card p-8 text-center">
        <p className={fundError ? "text-[var(--r-red)]" : "text-[var(--r-text-muted)]"}>
          {fundError ?? t("fundNotFound")}
        </p>
        <Link to="/" className="text-[var(--r-accent)] text-sm mt-2 inline-block">{t("backToArena")}</Link>
      </div>
    );
  }

  const Icon = FUND_ICONS[fund.id];
  const color = FUND_COLORS[fund.id] || "text-[var(--r-text-muted)]";
  const nameKey = FUND_NAME_KEYS[fund.id];
  const mottoKey = FUND_MOTTO_KEYS[fund.id];
  const tierBadge = fundTierLabel(fund.id);

  const today = new Date().toISOString().slice(0, 10);
  const initialBalance = fund.initialBalance;
  const snapshotPoints = (snapshotsResp?.snapshots ?? [])
    .slice()
    .reverse()
    .map(s => ({ date: s.date, value: s.total_value }));
  const lastDate = snapshotPoints[snapshotPoints.length - 1]?.date;
  const rawPoints = lastDate === today
    ? snapshotPoints.map(p => p.date === today ? { ...p, value: fund.totalValue } : p)
    : [...snapshotPoints, { date: today, value: fund.totalValue }];
  const chartData = rawPoints.map(p => ({
    ...p,
    pct: initialBalance > 0 ? ((p.value - initialBalance) / initialBalance) * 100 : 0,
  }));

  // Daily returns — consecutive snapshot deltas (% change day-over-day)
  const dailyReturns = rawPoints.slice(1).map((p, i) => {
    const prev = rawPoints[i];
    const delta    = p.value - prev.value;
    const deltaPct = prev.value > 0 ? (delta / prev.value) * 100 : 0;
    return { date: p.date, delta, deltaPct };
  });

  const openTrades = openTradesResp?.trades ?? [];
  const closedTrades = closedTradesResp?.trades ?? [];

  const fundEvoLogs = evoResp?.logs?.filter((l: EvolutionLog) => l.fund_id === fundId && l.action !== "UNCHANGED") ?? [];

  const pnlClass = fund.returnPct >= 0 ? "pnl-positive" : "pnl-negative";
  const sign = fund.returnPct >= 0 ? "+" : "";

  const cfg = fund.config;

  // 6-axis radar — each parameter normalized to its expected [min, max] range
  const radarData = [
    { dim: t("paramMinEdge"),       value: normParam(cfg.minEdge,          0.01, 0.25) },
    { dim: t("paramMinConfidence"), value: normParam(cfg.minConfidence,     0.50, 0.92) },
    { dim: t("paramStopLoss"),      value: normParam(cfg.stopLossPercent,   0.05, 0.30) },
    { dim: t("paramSizingScale"),   value: normParam(cfg.sizingScale,       0.50, 3.00) },
    { dim: t("paramMonthlyTarget"), value: normParam(cfg.monthlyTarget,     0.02, 0.18) },
    { dim: t("paramMaxHold"),       value: normParam(cfg.maxHoldDays,       3,    21  ) },
  ];

  return (
    <div className="space-y-6 animate-in">
      {/* Back + Header */}
      <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-[var(--r-text-muted)] hover:text-[var(--r-accent)] transition-colors">
        <ArrowLeft className="w-4 h-4" /> {t("backToArena")}
      </Link>

      <div className="glass-card p-6">
        <div className="flex items-center gap-4">
          {Icon && <span className={`${color} shrink-0`}><Icon size={48} /></span>}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-baseline gap-1.5 flex-wrap min-w-0">
                <h2 className="text-2xl font-bold whitespace-nowrap">{nameKey ? fundDisplayName(fund.id, t) : fund.name}</h2>
                <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-[var(--r-surface)] text-[var(--r-text-muted)] border border-[var(--r-border)] shrink-0">{tierBadge}</span>
                <span
                  className="text-[10px] text-[var(--r-text-faint)] font-normal tracking-wide opacity-70 shrink-0 hidden sm:inline"
                  title={t("evolvableStrategyBody")}
                >
                  · {t("evolvableStrategyBody")}
                </span>
              </div>
              <span
                className="text-xs px-2 py-0.5 rounded-full bg-[var(--r-accent-dim)] text-[var(--r-accent)] border border-[var(--r-accent)]/30 cursor-help shrink-0"
                title={t("generationBadgeTooltip")}
              >
                {formatFundGeneration(locale, cfg.generation)}
              </span>
              {fund.frozen && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30">{t("frozen")}</span>
              )}
            </div>
            <p className="text-sm text-[var(--r-text-muted)] mt-1 truncate">{mottoKey ? t(mottoKey as any) : fund.motto}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-xl sm:text-3xl font-bold font-mono whitespace-nowrap">{fmtUSD(fund.totalValue)}</p>
            <p className={`text-sm sm:text-lg font-mono font-medium whitespace-nowrap ${pnlClass}`}>{sign}{fund.returnPct.toFixed(2)}%</p>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard icon={TrendingUp} label={t("winRate")} value={`${Math.round(fund.winRate * 100)}%`} sub={`${fund.winCount}${t("wins")} / ${fund.lossCount}${t("losses")}`} />
        <StatCard icon={Activity} label={t("openPositions")} value={String(fund.openPositions)} sub={`${t("max")} ${cfg.maxOpenPositions}`} />
        <StatCard icon={Target} label={t("monthlyTarget")} value={`+${(fund.monthlyTarget * 100).toFixed(0)}%`} sub={`${fmtUSD(fund.initialBalance, 0)} ${t("initial")}`} />
        <StatCard icon={Shield} label={t("drawdown")} value={`${(cfg.drawdownLimit * 100).toFixed(0)}%`} sub={`${t("soft")} ${(cfg.drawdownSoftLimit * 100).toFixed(0)}%`} />
      </div>

      {/* Equity Curve */}
      <div className="glass-card p-5">
        <div className="flex items-center gap-2 mb-4">
          <h3 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest">{t("equityCurve")}</h3>
          {/* View toggle */}
          <div className="flex items-center gap-1 ml-auto">
            {(["equity", "daily"] as const).map(v => (
              <button
                key={v}
                type="button"
                onClick={() => setEquityView(v)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  equityView === v
                    ? "bg-[var(--r-accent)] text-white"
                    : "text-[var(--r-text-muted)] hover:text-[var(--r-text)] hover:bg-white/[0.05]"
                }`}
              >
                {v === "equity" ? t("equityCurveViewEquity") : t("equityCurveViewDaily")}
              </button>
            ))}
          </div>
        </div>

        {equityView === "equity" ? (
          chartData.length > 1 ? (
            <ResponsiveContainer width="100%" height={240}>
              <ComposedChart data={chartData}>
                <defs>
                  <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--r-accent)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="var(--r-accent)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--r-border)" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--r-text-muted)" }} tickLine={false} axisLine={false} />
                <YAxis
                  yAxisId="left"
                  tick={{ fontSize: 10, fill: "var(--r-text-muted)" }}
                  tickLine={false} axisLine={false}
                  domain={["dataMin - 100", "dataMax + 100"]}
                  tickFormatter={(v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                  width={70}
                />
                <YAxis
                  yAxisId="right" orientation="right"
                  tick={{ fontSize: 10, fill: "#60a5fa" }}
                  tickLine={false} axisLine={false}
                  tickFormatter={(v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`}
                  width={52}
                />
                <Tooltip
                  contentStyle={{ background: "var(--r-surface)", border: "1px solid var(--r-border)", borderRadius: 8, fontSize: 12 }}
                  formatter={(value: unknown, name: unknown) => {
                    if (name === "value") return [fmtUSD(Number(value)), t("totalValue")];
                    if (name === "pct") { const n = Number(value); return [`${n >= 0 ? "+" : ""}${n.toFixed(2)}%`, t("equityCurveReturn")]; }
                    return [String(value), String(name)];
                  }}
                />
                <Area yAxisId="left" type="monotone" dataKey="value" stroke="var(--r-accent)" fill="url(#equityGrad)" strokeWidth={2} dot={false} />
                <Line yAxisId="right" type="monotone" dataKey="pct" stroke="#60a5fa" strokeWidth={1.5} dot={false} strokeDasharray="5 3" />
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-center text-[var(--r-text-muted)] text-sm py-8">{t("equityCurveEmpty")}</p>
          )
        ) : (
          dailyReturns.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={dailyReturns} barCategoryGap="20%">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--r-border)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--r-text-muted)" }} tickLine={false} axisLine={false} />
                <YAxis
                  tick={{ fontSize: 10, fill: "var(--r-text-muted)" }}
                  tickLine={false} axisLine={false}
                  tickFormatter={(v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`}
                  width={52}
                />
                <Tooltip
                  cursor={{ fill: "rgba(255,255,255,0.04)", strokeWidth: 0 }}
                  contentStyle={{ background: "var(--r-surface)", border: "1px solid var(--r-border)", borderRadius: 8, fontSize: 12 }}
                  itemStyle={{ color: "var(--r-text)" }}
                  labelStyle={{ color: "var(--r-text-muted)", marginBottom: 4 }}
                  formatter={(value: unknown) => {
                    const n = Number(value);
                    return [`${n >= 0 ? "+" : ""}${n.toFixed(2)}%`, t("equityCurveViewDaily")];
                  }}
                  labelFormatter={(label: unknown) => String(label)}
                />
                <ReferenceLine y={0} stroke="var(--r-border)" strokeWidth={1.5} />
                <Bar dataKey="deltaPct" radius={[3, 3, 0, 0]} maxBarSize={10}>
                  {dailyReturns.map((entry, idx) => (
                    <Cell key={idx} fill={entry.deltaPct >= 0 ? "var(--r-green)" : "var(--r-red)"} fillOpacity={0.85} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-center text-[var(--r-text-muted)] text-sm py-8">{t("equityCurveEmpty")}</p>
          )
        )}
      </div>

      {/* Strategy Gene */}
      <div className="glass-card p-5">
        <div className="flex items-center gap-2 mb-4">
          <h3 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest">
            <Fingerprint className="w-4 h-4 inline-block mr-1.5 -mt-0.5" />{t("strategyGene")}
          </h3>
          <div className="flex items-center gap-1 ml-auto">
            {(["params", "radar"] as const).map(v => (
              <button
                key={v}
                type="button"
                onClick={() => setGeneView(v)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                  geneView === v
                    ? "bg-[var(--r-accent)] text-white"
                    : "text-[var(--r-text-muted)] hover:text-[var(--r-text)] hover:bg-white/[0.05]"
                }`}
              >
                {v === "params" ? t("geneViewParams") : t("geneViewRadar")}
              </button>
            ))}
          </div>
        </div>

        {geneView === "params" ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {GENE_GROUPS.map(group => (
              <div key={group.titleKey}>
                <h4 className="text-xs font-medium text-[var(--r-accent)] uppercase tracking-wider mb-2">{t(group.titleKey)}</h4>
                <div className="space-y-0">
                  {group.params.map(({ key, labelKey }) => {
                    const isRisk = group.titleKey === "geneGroupRisk" && (key === "stopLossPercent" || key === "drawdownLimit" || key === "takeProfitPercent" || key === "trailingStopPercent" || key === "probReversalThreshold");
                    return (
                      <div key={key} className="flex justify-between py-1.5 border-b border-[var(--r-border)]/50 text-sm">
                        <span className="text-[var(--r-text-muted)]">{t(labelKey)}</span>
                        <span className={`font-mono font-medium ${isRisk ? "text-[var(--r-red)]" : ""}`}>
                          {formatConfigValue(key, cfg[key as keyof typeof cfg], t)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <RadarChart data={radarData} cx="50%" cy="50%" outerRadius="65%">
              <PolarGrid stroke="var(--r-border)" />
              <PolarAngleAxis
                dataKey="dim"
                tick={{ fontSize: 10, fill: "var(--r-text-muted)" }}
              />
              <PolarRadiusAxis
                domain={[0, 1]}
                tick={false}
                axisLine={false}
              />
              <Radar
                dataKey="value"
                stroke="var(--r-accent)"
                fill="var(--r-accent)"
                fillOpacity={0.25}
                strokeWidth={1.5}
              />
              <Tooltip
                contentStyle={{ background: "var(--r-surface)", border: "1px solid var(--r-border)", borderRadius: 8, fontSize: 12 }}
                formatter={(value: unknown) => [(Number(value) * 100).toFixed(0) + "%", ""]}
              />
            </RadarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Open Positions */}
      {openTrades.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-3">
            <Activity className="w-4 h-4 inline-block mr-1.5 -mt-0.5 text-yellow-400" />{t("openPositions")} ({openTrades.length})
          </h3>
          {/* Exposure bar */}
          {fund.initialBalance > 0 && (() => {
            const deployed = openTrades.reduce((s, tr) => s + tr.amount, 0);
            const pct = Math.min(100, (deployed / fund.initialBalance) * 100);
            return (
              <div className="glass-card px-4 py-3 mb-3">
                <div className="flex justify-between text-xs text-[var(--r-text-muted)] mb-1.5">
                  <span>{t("deployedCapital")}</span>
                  <span className="font-mono">{fmtUSD(deployed)} / {fmtUSD(fund.initialBalance, 0)}</span>
                </div>
                <div className="h-1.5 rounded-full bg-[var(--r-border)] overflow-hidden">
                  <div className="h-full rounded-full bg-[var(--r-accent)] transition-all" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })()}
          <div className="space-y-1.5">
            {openTrades.map(trade => <TradeRow key={trade.id} trade={trade} maxHoldDays={cfg.maxHoldDays} />)}
          </div>
        </div>
      )}

      {/* Trade History */}
      <TradeHistorySection
        trades={closedTrades}
        maxHoldDays={cfg.maxHoldDays}
        fundRealizedPnl={fund.realizedPnl}
        fundWinCount={fund.winCount}
        fundLossCount={fund.lossCount}
        fundWinRate={fund.winRate}
        snapshots={snapshotsResp?.snapshots}
      />

      {/* Evolution Log */}
      {fundEvoLogs.length > 0 && <EvoLogSection logs={fundEvoLogs} />}
    </div>
  );
}

// ─── Calendar heatmap ────────────────────────────────────────────────────────
function CalendarHeatmap({
  trades, fundRealizedPnl, snapshots,
}: {
  trades: Trade[];
  fundRealizedPnl?: number;
  snapshots?: Snapshot[];
}) {
  const { t, locale } = useI18n();

  // Build pnlByDate: prefer snapshot-delta path (complete history, no LIMIT),
  // fall back to trades aggregation only when snapshots are unavailable.
  const pnlByDate: Record<string, number> = {};
  if (snapshots && snapshots.length > 0) {
    // API returns DESC; sort ASC for delta computation
    const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
    // First snapshot: its realized_pnl is the delta from fund inception (base = 0)
    pnlByDate[sorted[0].date] = sorted[0].realized_pnl;
    // Subsequent snapshots: delta over the previous day
    for (let i = 1; i < sorted.length; i++) {
      const delta = sorted[i].realized_pnl - sorted[i - 1].realized_pnl;
      if (delta !== 0) pnlByDate[sorted[i].date] = delta;
    }
  } else {
    for (const tr of trades) {
      if (!tr.closed_at || tr.pnl == null || tr.counts_toward_performance === false) continue;
      const d = tr.closed_at.slice(0, 10);
      pnlByDate[d] = (pnlByDate[d] ?? 0) + tr.pnl;
    }
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 91 cells: day[0] = 90 days ago, day[90] = today
  const cells = Array.from({ length: 91 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() - (90 - i));
    const key = d.toISOString().slice(0, 10);
    return { date: key, pnl: pnlByDate[key] ?? null };
  });

  // Split into weeks (columns of 7)
  const weeks: (typeof cells)[] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  // Only count days within the 91-day window for stats
  const windowStart = cells[0].date;
  const windowVals  = Object.entries(pnlByDate)
    .filter(([d]) => d >= windowStart)
    .map(([, v]) => v);

  const maxAbs    = windowVals.length > 0 ? Math.max(...windowVals.map(Math.abs)) : 1;
  const hasData   = windowVals.length > 0;
  const periodPnl = windowVals.reduce((s, v) => s + v, 0);
  const winDays   = windowVals.filter(v => v >= 0).length;
  const bestDay   = windowVals.length > 0 ? Math.max(...windowVals) : null;
  const worstDay  = windowVals.length > 0 ? Math.min(...windowVals) : null;

  function bg(pnl: number | null): string {
    if (pnl == null) return "rgba(255,255,255,0.06)";
    const a = (0.2 + 0.8 * (Math.abs(pnl) / maxAbs)).toFixed(2);
    return pnl >= 0 ? `rgba(34,197,94,${a})` : `rgba(239,68,68,${a})`;
  }

  // Month label on the week that contains the 1st of a month
  const monthLabels = weeks.map(week => {
    const pivot = week.find(c => c.date.slice(8, 10) === "01");
    if (pivot) return new Date(pivot.date + "T12:00:00").toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { month: "short" });
    return null;
  });

  if (!hasData) return <p className="text-xs text-[var(--r-text-faint)] py-4 text-center">{t("calendarNoTrades")}</p>;

  return (
    <div className="flex flex-col sm:flex-row gap-6 sm:items-start">
      {/* Calendar grid — fluid on mobile (fills width), fixed on desktop */}
      <div className="w-full sm:w-[220px] sm:shrink-0">
        {/* Month axis */}
        <div className="flex gap-[2px] mb-1">
          {weeks.map((_, wi) => (
            <div key={wi} className="flex-1 text-[8px] text-[var(--r-text-faint)] leading-none overflow-hidden">
              {monthLabels[wi] ?? ""}
            </div>
          ))}
        </div>
        {/* Day grid — flex-1 columns + aspect-square cells fill container width */}
        <div className="flex gap-[2px]">
          {weeks.map((week, wi) => (
            <div key={wi} className="flex-1 flex flex-col gap-[2px]">
              {week.map((cell, di) => (
                <div
                  key={di}
                  className="relative w-full aspect-square rounded-[2px]"
                  style={{ background: bg(cell.pnl) }}
                  title={
                    cell.pnl != null
                      ? `${cell.date}: ${cell.pnl >= 0 ? "+" : ""}$${cell.pnl.toFixed(2)}`
                      : cell.date
                  }
                >
                  {cell.pnl != null && cell.pnl !== 0 && (
                    <span className="absolute inset-0 flex items-center justify-center text-[5px] leading-none font-mono text-white/80 sm:hidden pointer-events-none select-none">
                      {Math.abs(cell.pnl) >= 1000
                        ? `${(Math.abs(cell.pnl) / 1000).toFixed(1)}k`
                        : Math.abs(cell.pnl) >= 10
                          ? `${Math.round(Math.abs(cell.pnl))}`
                          : `${Math.abs(cell.pnl).toFixed(1)}`}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
        {/* Legend */}
        <div className="flex items-center gap-1.5 mt-3 text-[9px] text-[var(--r-text-faint)]">
          <span>{t("calendarLoss")}</span>
          {[1.0, 0.5, 0.2].map(a => <div key={a} className="w-3 h-3 rounded-[2px]" style={{ background: `rgba(239,68,68,${a})` }} />)}
          <div className="w-3 h-3 rounded-[2px]" style={{ background: "rgba(255,255,255,0.06)" }} />
          {[0.2, 0.5, 1.0].map(a => <div key={a} className="w-3 h-3 rounded-[2px]" style={{ background: `rgba(34,197,94,${a})` }} />)}
          <span>{t("calendarWin")}</span>
        </div>
      </div>

      {/* Period stats panel — fills remaining width */}
      <div className="w-full sm:flex-1 grid grid-cols-2 gap-2">
        <div className="glass-card px-3 py-2.5">
          <p className="text-[10px] text-[var(--r-text-muted)] mb-1">{t("calendarPeriodPnl")}</p>
          {(() => { const v = fundRealizedPnl ?? periodPnl; return (
            <p className={`text-base font-bold font-mono ${v >= 0 ? "pnl-positive" : "pnl-negative"}`}>
              {v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}
            </p>
          ); })()}
          <p className="text-[10px] text-[var(--r-text-faint)] mt-0.5">{t("calendarLast91Days")}</p>
        </div>
        <div className="glass-card px-3 py-2.5">
          <p className="text-[10px] text-[var(--r-text-muted)] mb-1">{t("calendarWinDays")}</p>
          <p className="text-base font-bold font-mono">
            {windowVals.length > 0 ? `${Math.round((winDays / windowVals.length) * 100)}%` : "—"}
          </p>
          <p className="text-[10px] text-[var(--r-text-faint)] mt-0.5">
            {winDays}{t("wins")} / {windowVals.length - winDays}{t("losses")} · {windowVals.length} {t("calendarActiveDays")}
          </p>
        </div>
        <div className="glass-card px-3 py-2.5">
          <p className="text-[10px] text-[var(--r-text-muted)] mb-1">{t("calendarBestDay")}</p>
          <p className="text-base font-bold font-mono pnl-positive">
            {bestDay != null ? `+$${bestDay.toFixed(2)}` : "—"}
          </p>
        </div>
        <div className="glass-card px-3 py-2.5">
          <p className="text-[10px] text-[var(--r-text-muted)] mb-1">{t("calendarWorstDay")}</p>
          <p className="text-base font-bold font-mono pnl-negative">
            {worstDay != null && worstDay < 0 ? `-$${Math.abs(worstDay).toFixed(2)}` : "—"}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── localStorage helpers ─────────────────────────────────────────────────────
function readLS<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v !== null ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
function writeLS(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore quota */ }
}

const HISTORY_FILTER_KEY = "petri-fd-history-filter";
const EQUITY_VIEW_KEY    = "petri-fd-equity-view";
const GENE_VIEW_KEY      = "petri-fd-gene-view";
const TRADE_VIEW_KEY     = "petri-fd-trade-view";
const HISTORY_PAGE_SIZE  = 20;
type HistoryFilter = "all" | "win" | "loss" | "void";
type GeneView  = "params" | "radar";
type TradeView = "list"   | "calendar";

/** Normalize a config value to [0, 1] for radar display */
function normParam(v: number, min: number, max: number): number {
  return Math.min(1, Math.max(0, (v - min) / (max - min)));
}

function TradeHistorySection({
  trades, maxHoldDays,
  fundRealizedPnl, fundWinCount, fundLossCount, fundWinRate,
  snapshots,
}: {
  trades: Trade[]; maxHoldDays?: number;
  fundRealizedPnl?: number;
  fundWinCount?: number;
  fundLossCount?: number;
  fundWinRate?: number;
  snapshots?: Snapshot[];
}) {
  const { t } = useI18n();
  const [filter, setFilterRaw] = useState<HistoryFilter>(() => readLS<HistoryFilter>(HISTORY_FILTER_KEY, "all"));
  const [visible, setVisible]  = useState(HISTORY_PAGE_SIZE);
  const [tradeView, setTradeViewRaw] = useState<TradeView>(() => readLS<TradeView>(TRADE_VIEW_KEY, "list"));

  function setFilter(f: HistoryFilter) {
    setFilterRaw(f);
    setVisible(HISTORY_PAGE_SIZE);
    writeLS(HISTORY_FILTER_KEY, f);
  }
  function setTradeView(v: TradeView) { setTradeViewRaw(v); writeLS(TRADE_VIEW_KEY, v); }

  const countable = useMemo(() => trades.filter(tr => tr.counts_toward_performance !== false && tr.status !== "INVALIDATED"), [trades]);
  const wins       = useMemo(() => countable.filter(tr => (tr.pnl ?? 0) >= 0), [countable]);
  const losses     = useMemo(() => countable.filter(tr => (tr.pnl ?? 0) < 0),  [countable]);
  const totalPnl   = useMemo(() => countable.reduce((s, tr) => s + (tr.pnl ?? 0), 0), [countable]);
  const avgWin     = wins.length  > 0 ? wins.reduce((s, tr) => s + (tr.pnl ?? 0), 0) / wins.length  : null;
  const avgLoss    = losses.length > 0 ? losses.reduce((s, tr) => s + (tr.pnl ?? 0), 0) / losses.length : null;
  const bestPnl    = wins.length  > 0 ? Math.max(...wins.map(tr => tr.pnl ?? 0)) : null;
  const winRate    = countable.length > 0 ? wins.length / countable.length : null;
  const voidCount  = trades.length - countable.length;

  const filtered = useMemo(() => {
    switch (filter) {
      case "win":  return trades.filter(tr => (tr.pnl ?? 0) >= 0 && tr.status !== "INVALIDATED" && tr.counts_toward_performance !== false);
      case "loss": return trades.filter(tr => (tr.pnl ?? 0) < 0);
      case "void": return trades.filter(tr => tr.status === "INVALIDATED" || tr.counts_toward_performance === false);
      default:     return trades;
    }
  }, [trades, filter]);

  const shown      = filtered.slice(0, visible);
  const hasMore    = filtered.length > visible;
  const maxAbsPnl  = useMemo(
    () => Math.max(0, ...filtered.filter(tr => tr.pnl != null).map(tr => Math.abs(tr.pnl!))),
    [filtered],
  );

  const filterOpts: { key: HistoryFilter; label: string; count: number }[] = [
    { key: "all",  label: t("filterAll"),    count: trades.length },
    { key: "win",  label: t("filterWins"),   count: wins.length   },
    { key: "loss", label: t("filterLosses"), count: losses.length },
    { key: "void", label: t("filterVoid"),   count: voidCount     },
  ];

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest flex items-center gap-1.5">
          {t("tradeHistory")} ({trades.length})
          {tradeView === "calendar" && <InfoPopover text={t("tipCalendarHeatmap")} />}
        </h3>
        {/* List / Calendar toggle */}
        <div className="flex items-center gap-1 ml-auto">
          {(["list", "calendar"] as const).map(v => (
            <button
              key={v}
              type="button"
              onClick={() => setTradeView(v)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
                tradeView === v
                  ? "bg-[var(--r-accent)] text-white"
                  : "text-[var(--r-text-muted)] hover:text-[var(--r-text)] hover:bg-white/[0.05]"
              }`}
            >
              {v === "list" ? t("tradeViewList") : t("tradeViewCalendar")}
            </button>
          ))}
        </div>
      </div>

      {tradeView === "calendar" ? (
        <CalendarHeatmap trades={trades} fundRealizedPnl={fundRealizedPnl} snapshots={snapshots} />
      ) : trades.length > 0 ? (
        <>
          {/* Stats header — totalPnl/winRate use authoritative backend fields when available */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
            <div className="glass-card px-3 py-2.5">
              <p className="text-[10px] text-[var(--r-text-muted)] mb-1">{t("historyTotalPnl")}</p>
              {(() => { const v = fundRealizedPnl ?? totalPnl; return (
                <p className={`text-base font-bold font-mono ${v >= 0 ? "pnl-positive" : "pnl-negative"}`}>
                  {v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}
                </p>
              ); })()}
              <p className="text-[10px] text-[var(--r-text-faint)] mt-0.5">
                {(fundWinCount ?? wins.length)}{t("wins")} / {(fundLossCount ?? losses.length)}{t("losses")}
              </p>
            </div>
            <div className="glass-card px-3 py-2.5">
              <p className="text-[10px] text-[var(--r-text-muted)] mb-1">{t("winRate")}</p>
              {(() => { const r = fundWinRate ?? winRate; return (
                <>
                  <p className="text-base font-bold font-mono">{r != null ? `${Math.round(r * 100)}%` : "—"}</p>
                  {r != null && (
                    <div className="h-1 rounded-full bg-[var(--r-border)] overflow-hidden mt-1">
                      <div className="h-full rounded-full bg-[var(--r-accent)]" style={{ width: `${Math.round(r * 100)}%` }} />
                    </div>
                  )}
                </>
              ); })()}
            </div>
            <div className="glass-card px-3 py-2.5">
              <p className="text-[10px] text-[var(--r-text-muted)] mb-1">{t("historyAvgWin")}</p>
              <p className="text-base font-bold font-mono pnl-positive">{avgWin != null ? `+$${avgWin.toFixed(2)}` : "—"}</p>
              <p className="text-[10px] text-[var(--r-text-faint)] mt-0.5">
                {t("historyAvgLoss")}: {avgLoss != null ? `-$${Math.abs(avgLoss).toFixed(2)}` : "—"}
              </p>
            </div>
            <div className="glass-card px-3 py-2.5">
              <p className="text-[10px] text-[var(--r-text-muted)] mb-1">{t("historyBest")}</p>
              <p className="text-base font-bold font-mono pnl-positive">{bestPnl != null ? `+$${bestPnl.toFixed(2)}` : "—"}</p>
            </div>
          </div>

          {/* Filter tabs */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {filterOpts.map(({ key, label, count }) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  filter === key
                    ? "bg-[var(--r-accent)] text-white"
                    : "text-[var(--r-text-muted)] hover:text-[var(--r-text)] hover:bg-white/[0.05]"
                }`}
              >
                {label}{count > 0 && <span className="ml-1 opacity-60">{count}</span>}
              </button>
            ))}
          </div>

          {/* Trade list */}
          {shown.length > 0 ? (
            <>
              <div className="space-y-1.5">
                {shown.map(tr => <TradeRow key={tr.id} trade={tr} maxHoldDays={maxHoldDays} maxAbsPnl={maxAbsPnl} />)}
              </div>
              {hasMore && (
                <button
                  type="button"
                  onClick={() => setVisible(v => v + HISTORY_PAGE_SIZE)}
                  className="mt-3 w-full py-2 rounded-lg text-xs text-[var(--r-text-muted)] hover:text-[var(--r-text)] hover:bg-white/[0.05] transition-colors border border-[var(--r-border)]"
                >
                  {t("showMore")} · {filtered.length - visible} {t("remainingCount")}
                </button>
              )}
            </>
          ) : (
            <p className="text-xs text-[var(--r-text-faint)] py-4 text-center">
              {filter === "win"  ? t("filterEmptyWins")
               : filter === "loss" ? t("filterEmptyLosses")
               : filter === "void" ? t("filterEmptyVoid")
               : t("filterEmpty")}
            </p>
          )}
        </>
      ) : (
        <div className="glass-card p-8 text-center">
          <Target className="w-8 h-8 mx-auto mb-3 text-[var(--r-accent)] opacity-60" />
          <p className="font-medium text-sm mb-1">{t("emptyTradesTitle")}</p>
          <p className="text-xs text-[var(--r-text-muted)]">{t("emptyTradesDesc")}</p>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon: IconComp, label, value, sub }: {
  icon: typeof TrendingUp; label: string; value: string; sub: string;
}) {
  return (
    <div className="glass-card p-4 text-center">
      <IconComp className="w-4 h-4 mx-auto mb-1.5 text-[var(--r-accent)]" />
      <p className="text-xs text-[var(--r-text-muted)] mb-1">{label}</p>
      <p className="text-xl font-bold font-mono">{value}</p>
      <p className="text-xs text-[var(--r-text-faint)] mt-0.5">{sub}</p>
    </div>
  );
}

// ─── Evolution log helpers ───────────────────────────────────────────────────
function relativeTime(dateStr: string, locale: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60_000);
  const h = Math.floor(diff / 3_600_000);
  const d = Math.floor(diff / 86_400_000);
  if (locale === "zh") {
    if (m < 2)  return "刚刚";
    if (m < 60) return `${m} 分钟前`;
    if (h < 24) return `${h} 小时前`;
    if (d < 30) return `${d} 天前`;
    return `${Math.floor(d / 30)} 月前`;
  }
  if (m < 2)  return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

type EvoTypeConfig = { Icon: React.ComponentType<{ className?: string }>; color: string; bg: string };
const EVO_TYPE_CONFIG: Record<string, EvoTypeConfig> = {
  STANDARD_PBT:      { Icon: TrendingUp,  color: "text-[var(--r-accent)]", bg: "bg-[var(--r-accent)]/10" },
  MICRO_EVOLUTION:   { Icon: Zap,         color: "text-yellow-400",        bg: "bg-yellow-400/10"        },
  GLOBAL_RESET:      { Icon: RefreshCw,   color: "text-orange-400",        bg: "bg-orange-400/10"        },
  PBT_INHERIT_MUTATE:{ Icon: GitBranch,   color: "text-purple-400",        bg: "bg-purple-400/10"        },
};
const EVO_TYPE_DEFAULT: EvoTypeConfig = { Icon: Fingerprint, color: "text-[var(--r-accent)]", bg: "bg-[var(--r-accent)]/10" };

function EvoLogEntry({
  log, isLatest, isBestJump,
}: { log: EvolutionLog; isLatest: boolean; isBestJump: boolean }) {
  const { t, locale } = useI18n();
  const [paramExpanded, setParamExpanded] = useState(false);

  const fd = log.fitness_before != null && log.fitness_after != null
    ? log.fitness_after - log.fitness_before : null;
  const improved = fd != null && fd >= 0;
  const { Icon, color, bg } = EVO_TYPE_CONFIG[log.action] ?? EVO_TYPE_DEFAULT;

  // P2: background heat proportional to |fitness_delta|
  const heatAlpha = fd != null ? Math.min(0.12, Math.abs(fd) * 0.9) : 0;
  const heatRgb   = improved ? "34,197,94" : "239,68,68";

  // Count param changes for collapse toggle
  let paramCount = 0;
  try {
    const b = JSON.parse(log.params_before); const a = JSON.parse(log.params_after);
    paramCount = Object.keys({ ...b, ...a }).filter(k => b[k] !== a[k]).length;
  } catch { /* ignore */ }

  return (
    <div
      className="glass-card px-4 py-3 transition-colors"
      style={heatAlpha > 0.01 ? { background: `rgba(${heatRgb},${heatAlpha})` } : undefined}
    >
      {/* ── Header row ── */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {/* Type icon + badge */}
        <div className={`p-1 rounded-md shrink-0 ${bg}`}>
          <Icon className={`w-3.5 h-3.5 ${color}`} />
        </div>
        <span className={`text-xs font-semibold ${color}`}>
          {REASON_I18N[log.action] ? t(REASON_I18N[log.action]) : log.action}
        </span>

        {/* Semantic labels */}
        {isLatest && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border border-[var(--r-accent)] text-[var(--r-accent)] leading-none">
            {t("evoLatest")}
          </span>
        )}
        {isBestJump && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border border-yellow-400/60 text-yellow-400 leading-none">
            {t("evoBestJump")}
          </span>
        )}

        {/* Epoch + relative time */}
        <span className="text-xs text-[var(--r-text-faint)] ml-auto shrink-0">
          {t("epoch")} {log.epoch} · {relativeTime(log.executed_at, locale)}
        </span>
      </div>

      {/* ── Fitness progress bars (P0-①) ── */}
      {log.fitness_before != null && log.fitness_after != null && (
        <div className="mt-2.5 space-y-1">
          {/* Before bar */}
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1 rounded-full bg-[var(--r-border)] overflow-hidden">
              <div className="h-full rounded-full bg-[var(--r-text-faint)] opacity-40"
                style={{ width: `${(log.fitness_before * 100).toFixed(1)}%` }} />
            </div>
            <span className="text-[10px] font-mono text-[var(--r-text-faint)] w-10 text-right shrink-0">
              {log.fitness_before.toFixed(3)}
            </span>
          </div>
          {/* After bar */}
          <div className="flex items-center gap-2">
            <div className="flex-1 h-[5px] rounded-full bg-[var(--r-border)] overflow-hidden">
              <div className={`h-full rounded-full ${improved ? "bg-[var(--r-accent)]" : "bg-red-400"}`}
                style={{ width: `${(log.fitness_after * 100).toFixed(1)}%` }} />
            </div>
            <span className={`text-[10px] font-mono w-10 text-right shrink-0 ${improved ? "pnl-positive" : "pnl-negative"}`}>
              {log.fitness_after.toFixed(3)}
            </span>
          </div>
          {/* Delta */}
          <p className="text-[10px] font-mono text-right">
            <span className={improved ? "pnl-positive" : "pnl-negative"}>
              {improved ? "+" : ""}{fd!.toFixed(3)}
            </span>
          </p>
        </div>
      )}

      {/* ── Reason text ── */}
      {log.reason && (
        <p className="text-xs text-[var(--r-text-muted)] mt-1.5">
          {REASON_I18N[log.reason] ? t(REASON_I18N[log.reason]) : log.reason}
        </p>
      )}

      {/* ── Param changes — collapsed by default (P0-③) ── */}
      {paramCount > 0 && (
        <>
          <button
            type="button"
            className="mt-2 flex items-center gap-1 text-xs text-[var(--r-text-faint)] hover:text-[var(--r-text)] transition-colors"
            onClick={() => setParamExpanded(e => !e)}
          >
            {paramExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {paramCount} {t("evoParamChanges")}
          </button>
          {paramExpanded && <EvoParamDiff before={log.params_before} after={log.params_after} />}
        </>
      )}
    </div>
  );
}

const EVO_PAGE_SIZE = 5;
const EVO_SKIP_ACTIONS = new Set(["SKIP_INSUFFICIENT", "SKIP_ALL_GOOD"]);

function EvoLogSection({ logs }: { logs: EvolutionLog[] }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter]     = useState<"all" | "evo" | "skip">("all");
  const [sortBy, setSortBy]     = useState<"time" | "jump">("time");

  // ── Sort source: always by executed_at DESC (wall-clock newest first)
  const sorted = useMemo(() =>
    [...logs].sort((a, b) => b.executed_at.localeCompare(a.executed_at)),
    [logs]
  );

  // ── LATEST = most recent by wall-clock; BEST JUMP = max positive delta only
  const latestId   = sorted[0]?.id;
  const bestJumpId = useMemo(() => {
    const candidates = sorted.filter(
      l => l.fitness_before != null && l.fitness_after != null &&
           (l.fitness_after! - l.fitness_before!) > 0.001
    );
    return candidates.length > 0
      ? candidates.reduce((b, l) =>
          (l.fitness_after! - l.fitness_before!) > (b.fitness_after! - b.fitness_before!) ? l : b
        ).id
      : null;
  }, [sorted]);

  // ── Filter
  const filtered = useMemo(() => {
    if (filter === "evo")  return sorted.filter(l => !EVO_SKIP_ACTIONS.has(l.action));
    if (filter === "skip") return sorted.filter(l => EVO_SKIP_ACTIONS.has(l.action));
    return sorted;
  }, [sorted, filter]);

  // ── Secondary sort (within filter result)
  const displayed = useMemo(() => {
    if (sortBy === "jump") {
      return [...filtered].sort((a, b) => {
        const da = a.fitness_after != null && a.fitness_before != null
          ? a.fitness_after - a.fitness_before : -Infinity;
        const db = b.fitness_after != null && b.fitness_before != null
          ? b.fitness_after - b.fitness_before : -Infinity;
        return db - da;
      });
    }
    return filtered;
  }, [filtered, sortBy]);

  // ── Sparkline — chronological (oldest → newest), always from full sorted list
  const sparkData = useMemo(() =>
    [...sorted]
      .filter(l => l.fitness_after != null)
      .reverse()
      .map((l, i) => ({ i, f: l.fitness_after! })),
    [sorted]
  );

  const visible = expanded ? displayed : displayed.slice(0, EVO_PAGE_SIZE);
  const hasMore = displayed.length > EVO_PAGE_SIZE;

  const filterBtns: { key: "all" | "evo" | "skip"; label: TranslationKey }[] = [
    { key: "all",  label: "evoFilterAll"  },
    { key: "evo",  label: "evoFilterEvo"  },
    { key: "skip", label: "evoFilterSkip" },
  ];
  const sortBtns: { key: "time" | "jump"; label: TranslationKey }[] = [
    { key: "time", label: "evoSortTime" },
    { key: "jump", label: "evoSortJump" },
  ];

  return (
    <div>
      <h3 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-3 flex items-center gap-1.5">
        {t("evolutionLog")} ({logs.length})
        <InfoPopover text={t("tipEvoLogFitness")} />
      </h3>

      {/* ── Fitness sparkline ── */}
      {sparkData.length >= 3 && (
        <div className="h-10 mb-4 -mx-0.5 opacity-70">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={sparkData} margin={{ top: 3, bottom: 3, left: 0, right: 0 }}>
              <Line type="monotone" dataKey="f" stroke="var(--r-accent)" strokeWidth={1.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── Filter + Sort bar ── */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {/* Type filter chips */}
        <div className="flex items-center gap-1 flex-1 min-w-0">
          {filterBtns.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => { setFilter(key); setExpanded(false); }}
              className={`px-2.5 py-1 rounded-full text-xs transition-colors whitespace-nowrap
                ${filter === key
                  ? "bg-[var(--r-accent)]/20 text-[var(--r-accent)] border border-[var(--r-accent)]/40"
                  : "text-[var(--r-text-faint)] hover:text-[var(--r-text)] border border-[var(--r-border)]"
                }`}
            >
              {t(label)}
              {key === "all"  && ` (${sorted.length})`}
              {key === "evo"  && ` (${sorted.filter(l => !EVO_SKIP_ACTIONS.has(l.action)).length})`}
              {key === "skip" && ` (${sorted.filter(l =>  EVO_SKIP_ACTIONS.has(l.action)).length})`}
            </button>
          ))}
        </div>
        {/* Sort toggle */}
        <div className="flex items-center gap-1 shrink-0">
          {sortBtns.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => { setSortBy(key); setExpanded(false); }}
              className={`px-2.5 py-1 rounded-full text-xs transition-colors whitespace-nowrap
                ${sortBy === key
                  ? "bg-[var(--r-accent)]/20 text-[var(--r-accent)] border border-[var(--r-accent)]/40"
                  : "text-[var(--r-text-faint)] hover:text-[var(--r-text)] border border-[var(--r-border)]"
                }`}
            >
              {t(label)}
            </button>
          ))}
        </div>
      </div>

      {/* ── Log entries ── */}
      <div className="space-y-1.5">
        {visible.map(log => (
          <EvoLogEntry
            key={log.id}
            log={log}
            isLatest={log.id === latestId}
            isBestJump={log.id === bestJumpId}
          />
        ))}
      </div>

      {/* ── Show more ── */}
      {hasMore && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-3 w-full py-2 rounded-lg text-xs text-[var(--r-text-muted)] hover:text-[var(--r-text)] hover:bg-white/[0.05] transition-colors border border-[var(--r-border)]"
        >
          {t("showMore")} · {displayed.length - EVO_PAGE_SIZE} {t("remainingCount")}
        </button>
      )}
    </div>
  );
}


function EvoParamDiff({ before, after }: { before: string; after: string }) {
  const { t } = useI18n();
  let b: Record<string, number> = {};
  let a: Record<string, number> = {};
  try { b = JSON.parse(before); } catch { return null; }
  try { a = JSON.parse(after); } catch { return null; }
  const changes = Object.keys({ ...b, ...a }).filter(k => b[k] !== a[k]);
  if (changes.length === 0) return null;
  return (
    <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-0.5 text-xs font-mono">
      {changes.slice(0, 6).map(k => {
        const diff = (a[k] ?? 0) - (b[k] ?? 0);
        const pct = b[k] ? ((diff / b[k]) * 100).toFixed(1) : t("paramChangeNew");
        const labelKey = PARAM_LABELS[k];
        return (
          <div key={k} className="flex justify-between">
            <span className="text-[var(--r-text-muted)]">{labelKey ? t(labelKey) : k}</span>
            <span className={diff >= 0 ? "pnl-positive" : "pnl-negative"}>
              {diff >= 0 ? "+" : ""}{pct}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

function formatConfigValue(key: string, value: unknown, t: (k: TranslationKey) => string): string {
  if (key === "allowedTypes" && Array.isArray(value)) {
    return value.map(v => {
      const k = SIGNAL_TYPE_KEYS[String(v)];
      return k ? t(k) : String(v);
    }).join(", ");
  }
  if (key === "sizingMode" && typeof value === "string") {
    const k = SIZING_MODE_KEYS[value];
    return k ? t(k) : value;
  }
  if (typeof value === "number") {
    if (key.includes("Percent") || key.includes("Limit") || key === "drawdownSoftLimit" || key === "monthlyTarget") {
      return `${(value * 100).toFixed(1)}%`;
    }
    if (key.includes("Volume") || key.includes("Liquidity") || key === "sizingBase") {
      return fmtUSD(value, 0);
    }
    return String(value);
  }
  return String(value ?? "—");
}
