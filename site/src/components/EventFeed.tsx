import { useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import {
  Link, Search, Crosshair, TrendingUp, OctagonX, Timer, CheckCircle2,
  BarChart3, Dna, Trophy, Snowflake, Flame, XCircle, ChevronDown, ChevronUp,
  ExternalLink, CircleDollarSign, TrendingDown, RotateCcw, Zap,
} from "lucide-react";
import type { AgentEvent } from "../hooks/useWebSocket";
import { useI18n } from "../i18n/context";
import type { TranslationKey } from "../i18n/translations";
import { fundDisplayName } from "../lib/fundMeta";
import type { LucideIcon } from "lucide-react";

interface EventCfg {
  icon: LucideIcon;
  labelKey: TranslationKey;
  color: string;
  category: string;
}

const EVENT_CONFIG: Record<string, EventCfg> = {
  CONNECTED:           { icon: Link,         labelKey: "eventConnected",  color: "text-emerald-400", category: "system" },
  SCAN_COMPLETE:       { icon: Search,       labelKey: "eventScan",       color: "text-blue-400",    category: "scan" },
  SIGNAL_FOUND:        { icon: Crosshair,    labelKey: "eventSignal",     color: "text-yellow-400",  category: "signal" },
  TRADE_OPENED:        { icon: TrendingUp,   labelKey: "eventOpened",     color: "text-green-400",   category: "trade" },
  TRADE_STOPPED:       { icon: OctagonX,     labelKey: "eventStopped",    color: "text-red-400",     category: "trade" },
  TRADE_EXPIRED:       { icon: Timer,        labelKey: "eventExpired",    color: "text-orange-400",  category: "trade" },
  TRADE_INVALIDATED:   { icon: XCircle,      labelKey: "eventInvalidated", color: "text-slate-300",  category: "trade" },
  TRADE_SETTLED:       { icon: CheckCircle2, labelKey: "eventSettled",    color: "text-emerald-400", category: "trade" },
  TRADE_PROFIT_TAKEN:  { icon: CircleDollarSign, labelKey: "eventProfitTaken", color: "text-green-300", category: "trade" },
  TRADE_TRAILING_STOPPED: { icon: TrendingDown, labelKey: "eventTrailingStopped", color: "text-amber-400", category: "trade" },
  TRADE_REVERSED:      { icon: RotateCcw,   labelKey: "eventReversed",   color: "text-rose-400",    category: "trade" },
  MICRO_EVOLUTION:     { icon: Zap,          labelKey: "eventMicroEvolution", color: "text-purple-400", category: "evolution" },
  SNAPSHOT_UPDATED:    { icon: BarChart3,    labelKey: "eventSnapshot",   color: "text-violet-400",  category: "system" },
  EVOLUTION_STARTED:   { icon: Dna,          labelKey: "eventEvolution",  color: "text-teal-400",    category: "evolution" },
  EVOLUTION_COMPLETED: { icon: Trophy,       labelKey: "eventEvolved",    color: "text-teal-300",    category: "evolution" },
  FUND_FROZEN:         { icon: Snowflake,    labelKey: "eventFrozen",     color: "text-cyan-400",    category: "trade" },
  FUND_UNFROZEN:       { icon: Flame,        labelKey: "eventUnfrozen",   color: "text-amber-400",   category: "trade" },
  ERROR:               { icon: XCircle,      labelKey: "eventError",      color: "text-red-500",     category: "system" },
};

type FilterCategory = "all" | "scan" | "signal" | "trade" | "evolution";

const FILTER_TABS: { key: FilterCategory; labelKey: TranslationKey }[] = [
  { key: "all",       labelKey: "filterAll" },
  { key: "scan",      labelKey: "filterScan" },
  { key: "signal",    labelKey: "filterSignal" },
  { key: "trade",     labelKey: "filterTrade" },
  { key: "evolution", labelKey: "filterEvolution" },
];

function formatRelativeTime(ts: string, t: (k: TranslationKey) => string): string {
  try {
    const d = new Date(ts);
    const now = Date.now();
    const diffSec = Math.floor((now - d.getTime()) / 1000);
    if (diffSec < 60) return t("timeJustNow");
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} ${t("timeMinAgo")}`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} ${t("timeHourAgo")}`;
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return ts;
  }
}

function formatFullTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return ts;
  }
}

type EventWeight = "high" | "normal" | "low";
function getEventWeight(event: AgentEvent): EventWeight {
  const t = event.type;
  const p = event.payload;
  if (t === "TRADE_INVALIDATED") return "low";
  if (t === "TRADE_SETTLED" || t === "TRADE_STOPPED" || t === "TRADE_EXPIRED" || t === "TRADE_PROFIT_TAKEN" || t === "TRADE_TRAILING_STOPPED" || t === "TRADE_REVERSED") {
    return Math.abs(Number(p.pnl)) > 10 ? "high" : "normal";
  }
  if (t === "EVOLUTION_COMPLETED" || t === "FUND_FROZEN" || t === "FUND_UNFROZEN" || t === "MICRO_EVOLUTION") return "high";
  if (t === "SIGNAL_FOUND" && Number(p.edge) > 20) return "high";
  if (t === "SCAN_COMPLETE" || t === "SNAPSHOT_UPDATED" || t === "CONNECTED") return "low";
  return "normal";
}


const ACTION_KEYS: Record<string, TranslationKey> = {
  STANDARD_PBT: "actionPbt",
  PBT_INHERIT_MUTATE: "actionInherit",
  GLOBAL_RESET: "actionReset",
  SKIP_INSUFFICIENT: "actionSkipInsufficient",
  SKIP_ALL_GOOD: "actionSkipGood",
  UNCHANGED: "actionUnchanged",
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

const SIGNAL_TYPE_KEYS: Record<string, TranslationKey> = {
  MISPRICING: "signalMispricing",
  MULTI_OUTCOME_ARB: "signalMultiOutcomeArb",
  SPREAD: "signalSpread",
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

function tSignalType(t: (k: TranslationKey) => string, raw: unknown): string {
  const k = SIGNAL_TYPE_KEYS[String(raw)];
  return k ? t(k) : String(raw);
}

function tDirection(t: (k: TranslationKey) => string, raw: unknown): string {
  if (raw == null || raw === "") return "—";
  const k = DIRECTION_KEYS[String(raw).toUpperCase()];
  return k ? t(k) : String(raw);
}

function tFundName(t: (k: TranslationKey) => string, raw: unknown): string {
  if (raw == null || raw === "") return "—";
  return fundDisplayName(String(raw).toLowerCase(), t);
}

function tAction(t: (k: TranslationKey) => string, raw: unknown): string {
  const k = ACTION_KEYS[String(raw)];
  return k ? t(k) : String(raw);
}

function EventSummary({ event }: { event: AgentEvent }) {
  const { t } = useI18n();
  const p = event.payload;
  switch (event.type) {
    case "SIGNAL_FOUND":
      return <span className="text-[var(--r-text-muted)]">{tSignalType(t, p.type)} · {t("edge")} {String(p.edge)}% · {String(p.question).slice(0, 50)}</span>;
    case "TRADE_OPENED":
      return <span className="text-[var(--r-text-muted)]">{tFundName(t, p.fundName)} · ${String(p.amount)} · {String(p.question).slice(0, 40)}</span>;
    case "TRADE_SETTLED":
    case "TRADE_STOPPED":
    case "TRADE_EXPIRED":
    case "TRADE_INVALIDATED":
    case "TRADE_PROFIT_TAKEN":
    case "TRADE_TRAILING_STOPPED":
    case "TRADE_REVERSED": {
      if (event.type === "TRADE_INVALIDATED") {
        return <span className="text-[var(--r-text-muted)]">{t("notApplicable")} · {String(p.question).slice(0, 40)}</span>;
      }
      const pnl = Number(p.pnl);
      return <span className={pnl >= 0 ? "pnl-positive" : "pnl-negative"}>{pnl >= 0 ? "+" : ""}{pnl.toFixed(2)} · {String(p.question).slice(0, 40)}</span>;
    }
    case "MICRO_EVOLUTION": {
      return <span className="text-[var(--r-text-muted)]">{tFundName(t, p.fundId)} · {String(p.adjustedParams ?? 0)} {t("microEvoParams")}</span>;
    }
    case "SCAN_COMPLETE":
      return <span className="text-[var(--r-text-muted)]">{String(p.marketsFiltered)} {t("markets")} · {String(p.signalsFound)} {t("signals")} · {t("avgEdge")} {String(p.avgEdge)}%</span>;
    default:
      return null;
  }
}

function eventPolymarketUrl(slug: unknown, question: unknown): string {
  const s = String(slug || "");
  if (s) return `https://polymarket.com/event/${s}`;
  return `https://polymarket.com/markets?_q=${encodeURIComponent(String(question || ""))}`;
}

function QuestionLink({ slug, question }: { slug: unknown; question: unknown }) {
  const { t } = useI18n();
  const q = String(question || "");
  return (
    <a
      href={eventPolymarketUrl(slug, question)}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[var(--r-text)] hover:text-[var(--r-accent)] transition-colors inline-flex items-center gap-1"
      title={t("viewOnPolymarket")}
    >
      {q}
      <ExternalLink className="w-3 h-3 shrink-0 opacity-40" />
    </a>
  );
}

function ExpandedDetail({ event }: { event: AgentEvent }) {
  const { t } = useI18n();
  const p = event.payload;

  switch (event.type) {
    case "SCAN_COMPLETE": {
      const topMarkets = Array.isArray(p.topMarkets) ? p.topMarkets as Array<Record<string, unknown>> : [];
      return (
        <div className="space-y-3 text-xs">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <DetailItem label={t("totalFetched")} value={String(p.totalFetched)} />
            <DetailItem label={t("marketsFiltered")} value={String(p.marketsFiltered)} />
            <DetailItem label={t("signalsFound")} value={String(p.signalsFound)} accent />
            <DetailItem label={t("avgEdge")} value={`${Number(p.avgEdge).toFixed(2)}%`} accent />
          </div>
          {topMarkets.length > 0 && (
            <div>
              <p className="text-[var(--r-text-muted)] font-medium mb-1.5">{t("topMarkets")}</p>
              <div className="space-y-1">
                {topMarkets.map((m, i) => (
                  <div key={i} className="flex items-center gap-2 text-[var(--r-text-faint)]">
                    <span className="w-4 text-right opacity-50">{i + 1}</span>
                    <span className="flex-1 min-w-0 truncate text-[var(--r-text)]">{String(m.question)}</span>
                    <span className="shrink-0 font-mono">${Number(m.volume24hr).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }

    case "SIGNAL_FOUND":
      return (
        <div className="space-y-2 text-xs">
          <QuestionLink slug={p.slug} question={p.question} />
          <div className="grid grid-cols-3 gap-3">
            <DetailItem label={t("signalType")} value={tSignalType(t, p.type)} />
            <DetailItem label={t("edge")} value={`${Number(p.edge).toFixed(2)}%`} accent />
            <DetailItem label={t("confidence")} value={p.confidence != null ? `${Number(p.confidence).toFixed(0)}%` : t("notApplicable")} />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <DetailItem label={t("direction")} value={tDirection(t, p.direction)} />
            <DetailItem label={t("volume24hr")} value={Number(p.volume24hr) > 0 ? `$${Number(p.volume24hr).toLocaleString()}` : "—"} />
            <DetailItem label={t("marketLiquidity")} value={Number(p.liquidity) > 0 ? `$${Number(p.liquidity).toLocaleString()}` : "—"} />
            {p.signalId != null && <DetailItem label={t("signalId")} value={String(p.signalId).slice(0, 8)} />}
          </div>
        </div>
      );

    case "TRADE_OPENED": {
      const fundId = String(p.fundId || p.fundName || "");
      return (
        <div className="space-y-2 text-xs">
          <QuestionLink slug={p.slug} question={p.question} />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <DetailItem label={t("fund")} value={
              <RouterLink to={`/fund/${fundId}`} className="text-[var(--r-accent)] hover:underline">{tFundName(t, p.fundName || fundId)}</RouterLink>
            } />
            <DetailItem label={t("amount")} value={`$${String(p.amount)}`} />
            <DetailItem label={t("entryPrice")} value={p.price != null ? `$${Number(p.price).toFixed(3)}` : "—"} />
            <DetailItem label={t("direction")} value={tDirection(t, p.direction)} />
          </div>
        </div>
      );
    }

    case "TRADE_SETTLED":
    case "TRADE_STOPPED":
    case "TRADE_EXPIRED":
    case "TRADE_INVALIDATED":
    case "TRADE_PROFIT_TAKEN":
    case "TRADE_TRAILING_STOPPED":
    case "TRADE_REVERSED": {
      const pnl = Number(p.pnl);
      const fundId = String(p.fundId || p.fundName || "");
      const exitPrice = p.exitPrice ?? p.currentPrice;
      const isInvalidated = event.type === "TRADE_INVALIDATED";
      const closeReasonKey = p.closeReasonCode ? CLOSE_REASON_KEYS[String(p.closeReasonCode)] : undefined;
      const closeReasonLabel = closeReasonKey ? t(closeReasonKey) : String(p.reason ?? "");
      const showReasonDetail =
        p.reason != null &&
        (
          p.closeReasonCode === "SYSTEM_INVALIDATED" ||
          p.closeReasonCode === "STOP_LOSS_TRIGGERED" ||
          p.closeReasonCode === "TAKE_PROFIT_TRIGGERED" ||
          p.closeReasonCode === "TRAILING_STOP_TRIGGERED" ||
          p.closeReasonCode === "PROBABILITY_REVERSED" ||
          p.closeReasonCode == null
        );
      return (
        <div className="space-y-2 text-xs">
          <QuestionLink slug={p.slug} question={p.question} />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <DetailItem label={t("fund")} value={
              <RouterLink to={`/fund/${fundId}`} className="text-[var(--r-accent)] hover:underline">{tFundName(t, p.fundName || p.fundId)}</RouterLink>
            } />
            <div>
              <span className="text-[var(--r-text-muted)]">{t("pnl")}</span>
              <p className={`font-mono font-bold ${isInvalidated ? "text-[var(--r-text-muted)]" : pnl >= 0 ? "pnl-positive" : "pnl-negative"}`}>
                {isInvalidated ? t("notApplicable") : `${pnl >= 0 ? "+$" : "-$"}${Math.abs(pnl).toFixed(2)}`}
              </p>
            </div>
            {p.entryPrice != null && <DetailItem label={t("entryPrice")} value={`$${Number(p.entryPrice).toFixed(3)}`} />}
            {exitPrice != null
              ? <DetailItem label={t("exitPrice")} value={`$${Number(exitPrice).toFixed(3)}`} />
              : isInvalidated
                ? <DetailItem label={t("exitPrice")} value={t("notApplicable")} />
                : null}
            {p.closeReasonCode != null && (
              <DetailItem label={t("closeReason")} value={closeReasonLabel} />
            )}
          </div>
          {showReasonDetail && <p className="text-[var(--r-text-faint)] italic">{String(p.reason)}</p>}
        </div>
      );
    }

    case "MICRO_EVOLUTION": {
      const adjustments = (p.adjustments ?? []) as Array<Record<string, unknown>>;
      return (
        <div className="space-y-2 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <DetailItem label={t("fund")} value={tFundName(t, p.fundId)} />
            <DetailItem label={t("microEvolutionLabel")} value={`${String(p.adjustedParams ?? 0)} ${t("microEvoParams")}`} />
          </div>
          {adjustments.length > 0 && (
            <div className="space-y-0.5 mt-1">
              {adjustments.map((a, i) => (
                <div key={i} className="flex items-center gap-2 text-[var(--r-text-muted)]">
                  <span className="font-mono">{String(a.param)}</span>
                  <span>{String(a.before)} &rarr; {String(a.after)}</span>
                </div>
              ))}
            </div>
          )}
          {p.trigger != null && <p className="text-[var(--r-text-faint)] italic">{String(p.trigger)}</p>}
        </div>
      );
    }

    case "EVOLUTION_COMPLETED": {
      const mutations = (p.mutations ?? []) as Array<Record<string, unknown>>;
      return (
        <div className="space-y-2 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <DetailItem label={t("epoch")} value={String(p.epoch)} />
            <DetailItem label={t("action")} value={tAction(t, p.action)} />
          </div>
          {mutations.length > 0 && (
            <div className="space-y-1 mt-2">
              <p className="text-[var(--r-text-muted)] font-medium">{t("affectedFunds")}:</p>
              {mutations.map((m, i) => (
                <div key={i} className="flex items-center gap-2">
                  <RouterLink to={`/fund/${String(m.fundId)}`} className="text-[var(--r-accent)] hover:underline">
                    {tFundName(t, m.fundName || m.fundId)}
                  </RouterLink>
                  <span className="text-[var(--r-text-muted)]">{tAction(t, m.action)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

    default:
      return null;
  }
}

function DetailItem({ label, value, accent }: { label: string; value: string | React.JSX.Element; accent?: boolean }) {
  return (
    <div>
      <span className="text-[var(--r-text-muted)]">{label}</span>
      <p className={`font-mono font-medium ${accent ? "text-[var(--r-accent)]" : ""}`}>{value}</p>
    </div>
  );
}

export function EventFeed({ events }: { events: AgentEvent[] }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<FilterCategory>("all");
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const filtered = filter === "all"
    ? events
    : events.filter(e => EVENT_CONFIG[e.type]?.category === filter);

  if (events.length === 0) {
    return (
      <div className="glass-card p-8 text-center">
        <Search className="w-8 h-8 mx-auto mb-3 text-[var(--r-accent)] animate-pulse" />
        <p className="font-medium text-sm mb-1">{t("emptyEventsTitle")}</p>
        <p className="text-xs text-[var(--r-text-muted)]">{t("emptyEventsDesc")}</p>
      </div>
    );
  }

  return (
    <div>
      {/* Filter tabs */}
      <div className="flex gap-1 mb-3 overflow-x-auto pb-1">
        {FILTER_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => { setFilter(tab.key); setExpandedIdx(null); }}
            className={`px-2.5 py-2 rounded-full text-xs font-medium transition-all whitespace-nowrap ${
              filter === tab.key
                ? "bg-[var(--r-accent)] text-white"
                : "border border-[var(--r-border)] text-[var(--r-text-muted)] hover:border-[var(--r-border-hover)] hover:text-[var(--r-text)]"
            }`}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {/* Events list — height fills remaining viewport so sticky column never shows blank space */}
      <div className="space-y-1.5 max-h-[calc(100vh-220px)] overflow-y-auto pr-1">
        {filtered.map((event, i) => {
          const config = EVENT_CONFIG[event.type];
          const IconComp = config?.icon ?? Link;
          const label = config ? t(config.labelKey) : event.type;
          const color = config?.color ?? "text-gray-400";
          const isExpanded = expandedIdx === i;
          const hasDetail = ["SCAN_COMPLETE", "SIGNAL_FOUND", "TRADE_OPENED", "TRADE_SETTLED", "TRADE_STOPPED", "TRADE_EXPIRED", "TRADE_INVALIDATED", "TRADE_PROFIT_TAKEN", "TRADE_TRAILING_STOPPED", "TRADE_REVERSED", "MICRO_EVOLUTION", "EVOLUTION_COMPLETED"].includes(event.type);
          const weight = getEventWeight(event);
          const isNew = i === 0;

          return (
            <div
              key={`${event.timestamp}-${i}`}
              className={`glass-card overflow-hidden transition-all ${
                isNew ? "animate-slide-in" : ""
              } ${
                weight === "high" ? "border-[var(--r-accent)]/40 shadow-sm shadow-[var(--r-accent-glow)]" : ""
              } ${
                weight === "low" ? "opacity-70" : ""
              }`}
            >
              <button
                onClick={() => hasDetail ? setExpandedIdx(isExpanded ? null : i) : undefined}
                className={`w-full px-4 ${weight === "low" ? "py-1.5" : "py-2.5"} flex items-start gap-3 text-sm text-left ${
                  hasDetail ? "cursor-pointer hover:bg-[var(--r-overlay-3)]" : ""
                } transition-colors`}
              >
                <IconComp className={`w-4 h-4 shrink-0 mt-0.5 ${color}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`font-medium ${color}`}>{label}</span>
                    <span className="text-xs text-[var(--r-text-muted)]" title={formatFullTime(event.timestamp)}>
                      {formatRelativeTime(event.timestamp, t)}
                    </span>
                    {weight === "high" && <span className="w-1.5 h-1.5 rounded-full bg-[var(--r-accent)] animate-pulse shrink-0" />}
                  </div>
                  <div className="text-xs mt-0.5 sm:truncate">
                    <EventSummary event={event} />
                  </div>
                </div>
                {hasDetail && (
                  isExpanded
                    ? <ChevronUp className="w-3.5 h-3.5 text-[var(--r-text-muted)] shrink-0 mt-1" />
                    : <ChevronDown className="w-3.5 h-3.5 text-[var(--r-text-muted)] shrink-0 mt-1" />
                )}
              </button>

              {isExpanded && (
                <div className="px-4 pb-3 pt-1 border-t border-[var(--r-border)] animate-in">
                  <ExpandedDetail event={event} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
