import { useState, useEffect, useMemo } from "react";
import { Dna, Shuffle, RotateCcw, SkipForward, Sparkles, Minus, Swords, BarChart3, GitBranch, Zap, Clock, TrendingUp, RefreshCw, ChevronDown, ChevronUp, Fingerprint } from "lucide-react";
import { useFetch } from "../hooks/useApi";
import { FitnessChart } from "./FitnessChart";
import { ParamHeatmap } from "./ParamHeatmap";
import { LineageTree } from "./LineageTree";
import { useI18n } from "../i18n/context";
import type { TranslationKey } from "../i18n/translations";
import type { LucideIcon } from "lucide-react";
import { fundDisplayName } from "../lib/fundMeta";

interface EvolutionLog {
  id: string;
  epoch: number;
  executed_at: string;
  action: string;
  fund_id: string;
  params_before: string;
  params_after: string;
  fitness_before: number | null;
  fitness_after: number | null;
  reason: string;
}

interface EpochSummary {
  epoch: number;
  actions: number;
  started_at: string;
  action_types: string;
}

interface FundLineage {
  id: string;
  name: string;
  emoji: string;
  generation: number;
  parent_id: string | null;
}

interface EvolutionResponse {
  logs: EvolutionLog[];
  epochs: EpochSummary[];
  lineage: FundLineage[];
}

interface ActionCfg {
  labelKey: TranslationKey;
  icon: LucideIcon;
  color: string;
}

const ACTION_CONFIG: Record<string, ActionCfg> = {
  STANDARD_PBT:       { labelKey: "actionPbt",              icon: Dna,         color: "text-teal-400" },
  PBT_INHERIT_MUTATE: { labelKey: "actionInherit",          icon: Shuffle,     color: "text-teal-300" },
  GLOBAL_RESET:       { labelKey: "actionReset",            icon: RotateCcw,   color: "text-red-400" },
  SKIP_INSUFFICIENT:  { labelKey: "actionSkipInsufficient", icon: SkipForward, color: "text-gray-400" },
  SKIP_ALL_GOOD:      { labelKey: "actionSkipGood",         icon: Sparkles,    color: "text-green-400" },
  UNCHANGED:          { labelKey: "actionUnchanged",        icon: Minus,       color: "text-gray-500" },
  MICRO_EVOLUTION:    { labelKey: "microEvolutionLabel",    icon: Zap,         color: "text-purple-400" },
};

function translateReason(t: (k: TranslationKey) => string, reason: string): string {
  const cfg = ACTION_CONFIG[reason];
  if (cfg) return t(cfg.labelKey);
  return reason;
}

function formatDate(ts: string): string {
  try {
    return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return ts;
  }
}


// ─── Helpers shared with EvolutionPanel ─────────────────────────────────────
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

type EvoTypeCfg = { Icon: React.ComponentType<{ className?: string }>; color: string; bg: string };
const EVO_PANEL_TYPE_CFG: Record<string, EvoTypeCfg> = {
  STANDARD_PBT:      { Icon: TrendingUp,  color: "text-[var(--r-accent)]", bg: "bg-[var(--r-accent)]/10" },
  MICRO_EVOLUTION:   { Icon: Zap,         color: "text-yellow-400",        bg: "bg-yellow-400/10"        },
  GLOBAL_RESET:      { Icon: RefreshCw,   color: "text-orange-400",        bg: "bg-orange-400/10"        },
  PBT_INHERIT_MUTATE:{ Icon: GitBranch,   color: "text-purple-400",        bg: "bg-purple-400/10"        },
  SKIP_INSUFFICIENT: { Icon: SkipForward, color: "text-zinc-400",          bg: "bg-zinc-400/10"          },
  SKIP_ALL_GOOD:     { Icon: Sparkles,    color: "text-green-400",         bg: "bg-green-400/10"         },
};
const EVO_PANEL_TYPE_DEFAULT: EvoTypeCfg = { Icon: Fingerprint, color: "text-[var(--r-accent)]", bg: "bg-[var(--r-accent)]/10" };

const PANEL_PARAM_I18N: Record<string, TranslationKey> = {
  minEdge: "paramMinEdge", minConfidence: "paramMinConfidence",
  minVolume: "paramMinVolume", minLiquidity: "paramMinLiquidity",
  maxPerEvent: "paramMaxPerEvent", maxOpenPositions: "paramMaxPositions",
  monthlyTarget: "paramMonthlyTarget", drawdownLimit: "paramDrawdownLimit",
  stopLossPercent: "paramStopLoss", maxHoldDays: "paramMaxHold",
  takeProfitPercent: "takeProfitLabel", trailingStopPercent: "trailingStopLabel",
  probReversalThreshold: "probReversalLabel",
  sizingBase: "paramSizingBase", sizingScale: "paramSizingScale",
};

function EvoMutCard({ log }: { log: EvolutionLog }) {
  const { t, locale } = useI18n();
  const [paramExpanded, setParamExpanded] = useState(false);

  const fd = log.fitness_before != null && log.fitness_after != null
    ? log.fitness_after - log.fitness_before : null;
  const improved = fd != null && fd >= 0;
  const { Icon, color, bg } = EVO_PANEL_TYPE_CFG[log.action] ?? EVO_PANEL_TYPE_DEFAULT;
  const heatAlpha = fd != null ? Math.min(0.10, Math.abs(fd) * 0.8) : 0;

  let paramCount = 0;
  try {
    const b = JSON.parse(log.params_before); const a = JSON.parse(log.params_after);
    paramCount = Object.keys({ ...b, ...a }).filter(k => b[k] !== a[k]).length;
  } catch { /* ignore */ }

  return (
    <div
      className="glass-card px-4 py-3 transition-colors"
      style={heatAlpha > 0.01 ? { background: `rgba(${improved ? "34,197,94" : "239,68,68"},${heatAlpha})` } : undefined}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <div className={`p-1 rounded-md shrink-0 ${bg}`}>
          <Icon className={`w-3.5 h-3.5 ${color}`} />
        </div>
        <span className={`text-xs font-semibold ${color}`}>
          {ACTION_CONFIG[log.action] ? t(ACTION_CONFIG[log.action].labelKey) : log.action}
        </span>
        <span className="text-xs text-[var(--r-text-muted)] font-medium">
          {fundDisplayName(log.fund_id, t)}
        </span>
        <span className="text-xs text-[var(--r-text-faint)] ml-auto shrink-0">
          {t("epoch")} {log.epoch} · {relativeTime(log.executed_at, locale)}
        </span>
      </div>

      {/* Fitness bars */}
      {log.fitness_before != null && log.fitness_after != null && (
        <div className="mt-2 space-y-1">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1 rounded-full bg-[var(--r-border)] overflow-hidden">
              <div className="h-full rounded-full bg-[var(--r-text-faint)] opacity-40"
                style={{ width: `${(log.fitness_before * 100).toFixed(1)}%` }} />
            </div>
            <span className="text-[10px] font-mono text-[var(--r-text-faint)] w-10 text-right shrink-0">
              {log.fitness_before.toFixed(3)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 h-[5px] rounded-full bg-[var(--r-border)] overflow-hidden">
              <div className={`h-full rounded-full ${improved ? "bg-[var(--r-accent)]" : "bg-red-400"}`}
                style={{ width: `${(log.fitness_after * 100).toFixed(1)}%` }} />
            </div>
            <span className={`text-[10px] font-mono w-10 text-right shrink-0 ${improved ? "pnl-positive" : "pnl-negative"}`}>
              {log.fitness_after.toFixed(3)}
            </span>
          </div>
          <p className="text-[10px] font-mono text-right">
            <span className={improved ? "pnl-positive" : "pnl-negative"}>
              {improved ? "+" : ""}{fd!.toFixed(3)}
            </span>
          </p>
        </div>
      )}

      {/* Reason */}
      {log.reason && (
        <p className="text-xs text-[var(--r-text-muted)] mt-1.5">
          {translateReason(t, log.reason)}
        </p>
      )}

      {/* Param diff — collapsed */}
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
          {paramExpanded && <EvoInlineParamDiff before={log.params_before} after={log.params_after} />}
        </>
      )}
    </div>
  );
}

function EvoInlineParamDiff({ before, after }: { before: string; after: string }) {
  const { t } = useI18n();
  let b: Record<string, number> = {}; let a: Record<string, number> = {};
  try { b = JSON.parse(before); } catch { return null; }
  try { a = JSON.parse(after); } catch { return null; }
  const changes = Object.keys({ ...b, ...a }).filter(k => b[k] !== a[k]);
  if (changes.length === 0) return null;
  return (
    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs font-mono">
      {changes.slice(0, 6).map(k => {
        const diff = (a[k] ?? 0) - (b[k] ?? 0);
        const pct = b[k] ? ((diff / b[k]) * 100).toFixed(1) : t("paramChangeNew");
        return (
          <div key={k} className="flex justify-between">
            <span className="text-[var(--r-text-muted)]">{PANEL_PARAM_I18N[k] ? t(PANEL_PARAM_I18N[k]) : k}</span>
            <span className={diff >= 0 ? "pnl-positive" : "pnl-negative"}>
              {diff >= 0 ? "+" : ""}{pct}%
            </span>
          </div>
        );
      })}
      {changes.length > 6 && <div className="text-[var(--r-text-muted)]">+{changes.length - 6} {t("nMore")}</div>}
    </div>
  );
}

function EvoKpiStrip({ logs, epochs }: { logs: EvolutionLog[]; epochs: EpochSummary[] }) {
  const { t } = useI18n();
  const latestEpochNum = useMemo(() =>
    epochs.length > 0 ? Math.max(...epochs.map(e => e.epoch)) : null, [epochs]
  );
  const avgFitness = useMemo(() => {
    if (latestEpochNum == null) return null;
    const vals = logs.filter(l => l.epoch === latestEpochNum && l.fitness_after != null).map(l => l.fitness_after!);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }, [logs, latestEpochNum]);
  const bestFitness = useMemo(() => {
    const vals = logs.filter(l => l.fitness_after != null).map(l => l.fitness_after!);
    return vals.length > 0 ? Math.max(...vals) : null;
  }, [logs]);
  const lastEvo = useMemo(() =>
    [...logs].sort((a, b) => b.executed_at.localeCompare(a.executed_at))[0]?.executed_at,
    [logs]
  );

  const items = [
    { label: t("epoch"), value: String(epochs.length), mono: true, dim: false },
    { label: t("evoKpiAvg"), value: avgFitness != null ? avgFitness.toFixed(3) : "—", mono: true, dim: false },
    { label: t("evoKpiBest"), value: bestFitness != null ? bestFitness.toFixed(3) : "—", mono: true, dim: false, green: true },
    { label: t("evoKpiLast"), value: lastEvo ? relativeTime(lastEvo, "") : "—", mono: false, dim: true },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {items.map(({ label, value, mono, green, dim }) => (
        <div key={label} className="glass-card px-4 py-3 text-center">
          <div className="text-[10px] text-[var(--r-text-muted)] uppercase tracking-wider mb-1">{label}</div>
          <div className={`text-xl font-bold ${mono ? "font-mono" : ""} ${green ? "pnl-positive" : ""} ${dim ? "text-base text-[var(--r-text-muted)]" : ""}`}>
            {value}
          </div>
        </div>
      ))}
    </div>
  );
}

function useCountdown() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const d = new Date(now);
  const dayOfWeek = d.getUTCDay();
  let daysUntil = (7 - dayOfWeek) % 7;
  if (daysUntil === 0 && d.getUTCHours() >= 0) daysUntil = 7;
  const nextSunday = new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysUntil, 0, 0, 0
  ));
  const diff = nextSunday.getTime() - now;
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  return { days, hours, minutes };
}

const STEPS = [
  { iconKey: "swords" as const, titleKey: "evoStep1Title" as TranslationKey, descKey: "evoStep1Desc" as TranslationKey },
  { iconKey: "barChart" as const, titleKey: "evoStep2Title" as TranslationKey, descKey: "evoStep2Desc" as TranslationKey },
  { iconKey: "gitBranch" as const, titleKey: "evoStep3Title" as TranslationKey, descKey: "evoStep3Desc" as TranslationKey },
  { iconKey: "zap" as const, titleKey: "evoStep4Title" as TranslationKey, descKey: "evoStep4Desc" as TranslationKey },
];

const STEP_ICONS: Record<string, LucideIcon> = {
  swords: Swords, barChart: BarChart3, gitBranch: GitBranch, zap: Zap,
};

function EvolutionEmptyState() {
  const { t } = useI18n();
  const { days, hours, minutes } = useCountdown();

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Countdown hero */}
      <div className="glass-card p-8 text-center">
        <Dna className="w-10 h-10 mx-auto mb-4 text-[var(--r-accent)] animate-pulse" />
        <h2 className="text-lg font-semibold mb-4">{t("evoEmptyTitle")}</h2>

        <div className="flex items-center justify-center gap-3 mb-4">
          {[
            { value: days, unit: "D" },
            { value: hours, unit: "H" },
            { value: minutes, unit: "M" },
          ].map(({ value, unit }) => (
            <div key={unit} className="flex flex-col items-center">
              <span className="text-3xl font-mono font-bold text-[var(--r-accent)] tabular-nums leading-none">
                {String(value).padStart(2, "0")}
              </span>
              <span className="text-[10px] uppercase tracking-widest text-[var(--r-text-muted)] mt-1">{unit}</span>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-center gap-1.5 text-xs text-[var(--r-text-muted)]">
          <Clock className="w-3.5 h-3.5" />
          <span>{t("evoEmptyAuto")}</span>
        </div>
      </div>

      {/* 4-step mechanism */}
      <div>
        <h3 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-3">
          {t("evoMechanismTitle")}
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {STEPS.map((step, i) => {
            const Icon = STEP_ICONS[step.iconKey];
            return (
              <div key={i} className="glass-card px-4 py-5 text-center relative overflow-hidden group">
                <div className="absolute top-2 left-3 text-[var(--r-border)] text-xs font-mono opacity-50">{i + 1}</div>
                <Icon className="w-6 h-6 mx-auto mb-2 text-[var(--r-accent)] opacity-80" />
                <div className="text-sm font-medium mb-1">{t(step.titleKey)}</div>
                <div className="text-xs text-[var(--r-text-muted)] leading-relaxed">{t(step.descKey)}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Skeleton preview */}
      <div className="space-y-4 opacity-40">
        <div className="glass-card p-6">
          <div className="h-3 w-32 rounded bg-[var(--r-border)] mb-4" />
          <div className="h-32 rounded bg-[var(--r-border)]" />
          <p className="text-xs text-center text-[var(--r-text-faint)] mt-3">{t("evoPreviewFitness")}</p>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="glass-card p-6">
            <div className="h-3 w-24 rounded bg-[var(--r-border)] mb-4" />
            <div className="h-24 rounded bg-[var(--r-border)]" />
            <p className="text-xs text-center text-[var(--r-text-faint)] mt-3">{t("evoPreviewLineage")}</p>
          </div>
          <div className="glass-card p-6">
            <div className="h-3 w-28 rounded bg-[var(--r-border)] mb-4" />
            <div className="h-24 rounded bg-[var(--r-border)]" />
            <p className="text-xs text-center text-[var(--r-text-faint)] mt-3">{t("evoPreviewHeatmap")}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function EvolutionPanel() {
  const { data, loading, error } = useFetch<EvolutionResponse>("/api/evolution", 120_000);
  const { t } = useI18n();
  const [activeEpoch, setActiveEpoch] = useState<number | null>(null);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="glass-card p-6 h-24 animate-pulse" />
        <div className="glass-card p-6 h-48 animate-pulse" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="glass-card p-8 text-center text-sm text-[var(--r-red)]">
        {error}
      </div>
    );
  }

  if (!data || data.epochs.length === 0) {
    return <EvolutionEmptyState />;
  }

  const sortedEpochs = [...data.epochs].sort((a, b) => a.epoch - b.epoch);
  const filteredLogs = data.logs.filter(l => l.action !== "UNCHANGED" &&
    (activeEpoch == null || l.epoch === activeEpoch));

  // Epoch fitness deltas for cards
  const epochDelta = (ep: number) => {
    const logs = data.logs.filter(l => l.epoch === ep);
    const vBefore = logs.filter(l => l.fitness_before != null).map(l => l.fitness_before!);
    const vAfter  = logs.filter(l => l.fitness_after  != null).map(l => l.fitness_after!);
    if (vBefore.length === 0 || vAfter.length === 0) return null;
    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    return avg(vAfter) - avg(vBefore);
  };

  return (
    <div className="space-y-6">
      {/* KPI strip */}
      <EvoKpiStrip logs={data.logs} epochs={data.epochs} />

      {/* Epoch timeline — interactive */}
      <div className="flex gap-2 overflow-x-auto pb-2 pt-1 -mt-1 px-0.5 -mx-0.5">
        {/* "All" chip */}
        <button
          type="button"
          onClick={() => setActiveEpoch(null)}
          className={`glass-card px-4 py-3 shrink-0 min-w-[90px] text-center transition-colors
            ${activeEpoch == null ? "ring-1 ring-[var(--r-accent)]" : "opacity-70 hover:opacity-100"}`}
        >
          <div className="text-xs text-[var(--r-text-muted)] mb-0.5">{t("evoAllEpochs")}</div>
          <div className="text-base font-bold font-mono">{data.logs.filter(l => l.action !== "UNCHANGED").length}</div>
        </button>

        {sortedEpochs.map(ep => {
          const mainAction = ep.action_types.split(",")[0];
          const config = ACTION_CONFIG[mainAction] || ACTION_CONFIG.UNCHANGED;
          const Icon = config.icon;
          const delta = epochDelta(ep.epoch);
          const isActive = activeEpoch === ep.epoch;
          // P2-②: convergence/divergence top color bar
          const barColor = delta != null && delta > 0.005
            ? "bg-green-400/20"
            : delta != null && delta < -0.005
              ? "bg-red-400/20"
              : "bg-transparent";
          return (
            <button
              key={ep.epoch}
              type="button"
              onClick={() => setActiveEpoch(isActive ? null : ep.epoch)}
              className={`glass-card px-4 py-3 shrink-0 min-w-[120px] text-center transition-colors relative
                ${isActive ? "ring-1 ring-[var(--r-accent)]" : "opacity-70 hover:opacity-100"}`}
            >
              {/* Convergence/divergence top bar */}
              <div className={`absolute top-0 left-0 right-0 h-0.5 ${barColor}`} />
              <Icon className={`w-4 h-4 mx-auto mb-1 ${config.color}`} />
              <div className="text-sm font-bold">{t("epoch")} {ep.epoch}</div>
              <div className={`text-xs ${config.color}`}>{t(config.labelKey)}</div>
              {delta != null ? (
                <div className={`text-[10px] font-mono mt-0.5 ${delta >= 0 ? "pnl-positive" : "pnl-negative"}`}>
                  {delta >= 0 ? "+" : ""}{delta.toFixed(3)}
                </div>
              ) : (
                <div className="text-[10px] text-[var(--r-text-faint)] mt-0.5">{formatDate(ep.started_at)}</div>
              )}
            </button>
          );
        })}
      </div>

      <FitnessChart logs={data.logs} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <LineageTree lineage={data.lineage} />
        <ParamHeatmap
          logs={data.logs}
          selectedFund={null}
          allFundIds={data.lineage.map(l => l.id)}
        />
      </div>

      {/* Mutations section — upgraded cards */}
      <div>
        <h3 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-3">
          {t("recentMutations")}
          {activeEpoch != null && (
            <span className="ml-2 normal-case text-[var(--r-accent)]">· {t("epoch")} {activeEpoch}</span>
          )}
        </h3>
        <div className="space-y-1.5">
          {filteredLogs.slice(0, 15).map(log => (
            <EvoMutCard key={log.id} log={log} />
          ))}
          {filteredLogs.length === 0 && (
            <p className="text-center text-sm text-[var(--r-text-muted)] py-4">{t("fitnessEmpty")}</p>
          )}
        </div>
      </div>
    </div>
  );
}
