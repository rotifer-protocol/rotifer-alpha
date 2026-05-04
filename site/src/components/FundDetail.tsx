import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ArrowLeft, TrendingUp, Activity, Target,
  Shield, ChevronDown, ChevronUp, Fingerprint, ExternalLink,
} from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { useFetch } from "../hooks/useApi";
import { FUND_ICONS } from "./icons/FundIcons";
import { FUND_COLORS } from "./FundRanking";
import { useI18n } from "../i18n/context";
import { formatFundGeneration, type TranslationKey } from "../i18n/translations";
import { FUND_NAME_KEYS, FUND_MOTTO_KEYS, fundDisplayName, fundTierLabel } from "../lib/fundMeta";

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

function TradeRow({ trade, maxHoldDays }: { trade: Trade; maxHoldDays?: number }) {
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

  return (
    <div className="glass-card overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
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
        <span className="text-xs font-mono shrink-0">${trade.amount}</span>
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
  const { data: fundResp, loading: fundLoading } = useFetch<{ fund: FundDetailData }>(`/api/funds/${fundId}`, 30_000);
  const { data: closedTradesResp } = useFetch<{ trades: Trade[] }>(`/api/trades?fund=${fundId}&status=CLOSED&limit=50`, 30_000);
  const { data: openTradesResp } = useFetch<{ trades: Trade[] }>(`/api/trades?fund=${fundId}&status=OPEN&limit=20`, 30_000);
  const { data: snapshotsResp } = useFetch<{ snapshots: Snapshot[] }>(`/api/snapshots?fund=${fundId}&limit=30`);
  const { data: evoResp } = useFetch<{ logs: EvolutionLog[] }>("/api/evolution");

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
        <p className="text-[var(--r-text-muted)]">{t("fundNotFound")}</p>
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
  const snapshotPoints = (snapshotsResp?.snapshots ?? [])
    .slice()
    .reverse()
    .map(s => ({ date: s.date, value: s.total_value }));
  const lastDate = snapshotPoints[snapshotPoints.length - 1]?.date;
  const chartData = lastDate === today
    ? snapshotPoints.map(p => p.date === today ? { ...p, value: fund.totalValue } : p)
    : [...snapshotPoints, { date: today, value: fund.totalValue }];

  const openTrades = openTradesResp?.trades ?? [];
  const closedTrades = closedTradesResp?.trades ?? [];

  const fundEvoLogs = evoResp?.logs?.filter((l: EvolutionLog) => l.fund_id === fundId && l.action !== "UNCHANGED") ?? [];

  const pnlClass = fund.returnPct >= 0 ? "pnl-positive" : "pnl-negative";
  const sign = fund.returnPct >= 0 ? "+" : "";

  const cfg = fund.config;

  return (
    <div className="space-y-6 animate-in">
      {/* Back + Header */}
      <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-[var(--r-text-muted)] hover:text-[var(--r-accent)] transition-colors">
        <ArrowLeft className="w-4 h-4" /> {t("backToArena")}
      </Link>

      <div className="glass-card p-6">
        <div className="flex items-center gap-4">
          {Icon && <span className={color}><Icon size={48} /></span>}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-baseline gap-1.5 flex-wrap min-w-0">
                <h2 className="text-2xl font-bold">{nameKey ? fundDisplayName(fund.id, t) : fund.name}</h2>
                <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-[var(--r-surface)] text-[var(--r-text-muted)] border border-[var(--r-border)] shrink-0">{tierBadge}</span>
                <span
                  className="text-[10px] text-[var(--r-text-faint)] font-normal tracking-wide opacity-70 shrink-0"
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
            <p className="text-sm text-[var(--r-text-muted)] mt-1">{mottoKey ? t(mottoKey as any) : fund.motto}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-3xl font-bold font-mono">${fund.totalValue.toLocaleString()}</p>
            <p className={`text-lg font-mono font-medium ${pnlClass}`}>{sign}{fund.returnPct.toFixed(2)}%</p>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard icon={TrendingUp} label={t("winRate")} value={`${Math.round(fund.winRate * 100)}%`} sub={`${fund.winCount}${t("wins")} / ${fund.lossCount}${t("losses")}`} />
        <StatCard icon={Activity} label={t("openPositions")} value={String(fund.openPositions)} sub={`${t("max")} ${cfg.maxOpenPositions}`} />
        <StatCard icon={Target} label={t("monthlyTarget")} value={`+${(fund.monthlyTarget * 100).toFixed(0)}%`} sub={`$${fund.initialBalance.toLocaleString()} ${t("initial")}`} />
        <StatCard icon={Shield} label={t("drawdown")} value={`${(cfg.drawdownLimit * 100).toFixed(0)}%`} sub={`${t("soft")} ${(cfg.drawdownSoftLimit * 100).toFixed(0)}%`} />
      </div>

      {/* Equity Curve */}
      <div className="glass-card p-5">
        <h3 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-4">{t("equityCurve")}</h3>
        {chartData.length > 1 ? (
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--r-accent)" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="var(--r-accent)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--r-border)" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--r-text-muted)" }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 10, fill: "var(--r-text-muted)" }} tickLine={false} axisLine={false} domain={["dataMin - 100", "dataMax + 100"]} tickFormatter={(v: number) => `$${v.toLocaleString()}`} />
              <Tooltip
                contentStyle={{ background: "var(--r-surface)", border: "1px solid var(--r-border)", borderRadius: 8, fontSize: 12 }}
                formatter={(value: unknown) => [`$${Number(value).toLocaleString()}`, t("totalValue")]}
              />
              <Area type="monotone" dataKey="value" stroke="var(--r-accent)" fill="url(#equityGrad)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-center text-[var(--r-text-muted)] text-sm py-8">{t("equityCurveEmpty")}</p>
        )}
      </div>

      {/* Strategy Gene */}
      <div className="glass-card p-5">
        <h3 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-4">
          <Fingerprint className="w-4 h-4 inline-block mr-1.5 -mt-0.5" />{t("strategyGene")}
        </h3>
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
      </div>

      {/* Open Positions */}
      {openTrades.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-3">
            <Activity className="w-4 h-4 inline-block mr-1.5 -mt-0.5 text-yellow-400" />{t("openPositions")} ({openTrades.length})
          </h3>
          <div className="space-y-1.5">
            {openTrades.map(trade => <TradeRow key={trade.id} trade={trade} maxHoldDays={cfg.maxHoldDays} />)}
          </div>
        </div>
      )}

      {/* Trade History */}
      <div>
        <h3 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-3">
          {t("tradeHistory")} ({closedTrades.length})
        </h3>
        {closedTrades.length > 0 ? (
          <div className="space-y-1.5">
            {closedTrades.map(trade => <TradeRow key={trade.id} trade={trade} maxHoldDays={cfg.maxHoldDays} />)}
          </div>
        ) : (
          <div className="glass-card p-8 text-center">
            <Target className="w-8 h-8 mx-auto mb-3 text-[var(--r-accent)] opacity-60" />
            <p className="font-medium text-sm mb-1">{t("emptyTradesTitle")}</p>
            <p className="text-xs text-[var(--r-text-muted)]">{t("emptyTradesDesc")}</p>
          </div>
        )}
      </div>

      {/* Evolution Log */}
      {fundEvoLogs.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-3">
            {t("evolutionLog")} ({fundEvoLogs.length})
          </h3>
          <div className="space-y-1.5">
            {fundEvoLogs.slice(0, 10).map((log: EvolutionLog) => (
              <div key={log.id} className="glass-card px-4 py-3">
                <div className="flex items-center gap-2 text-sm">
                  <Fingerprint className="w-4 h-4 text-[var(--r-accent)]" />
                  <span className="font-medium text-[var(--r-accent)]">{REASON_I18N[log.action] ? t(REASON_I18N[log.action]) : log.action}</span>
                  <span className="text-xs text-[var(--r-text-muted)]">{t("epoch")} {log.epoch}</span>
                  {log.fitness_before != null && log.fitness_after != null && (
                    <span className="text-xs font-mono ml-auto">
                      {t("fitnessLabel")} {log.fitness_before.toFixed(3)} → {log.fitness_after.toFixed(3)}
                      <span className={log.fitness_after >= log.fitness_before ? " pnl-positive" : " pnl-negative"}>
                        {" "}({log.fitness_after >= log.fitness_before ? "+" : ""}{(log.fitness_after - log.fitness_before).toFixed(3)})
                      </span>
                    </span>
                  )}
                </div>
                <p className="text-xs text-[var(--r-text-muted)] mt-1">{REASON_I18N[log.reason] ? t(REASON_I18N[log.reason]) : log.reason}</p>
                <EvoParamDiff before={log.params_before} after={log.params_after} />
              </div>
            ))}
          </div>
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
      return `$${value.toLocaleString()}`;
    }
    return String(value);
  }
  return String(value ?? "—");
}
