import { useState, useEffect, useMemo, useRef } from "react";
import { Dna, Shuffle, RotateCcw, SkipForward, Sparkles, Minus, Swords, BarChart3, GitBranch, Zap, Clock, TrendingUp, RefreshCw, ChevronDown, ChevronUp, Fingerprint, X } from "lucide-react";
import { useFetch } from "../hooks/useApi";
import { FitnessChart } from "./FitnessChart";
import { ParamHeatmap } from "./ParamHeatmap";
import { LineageTree } from "./LineageTree";
import { useI18n } from "../i18n/context";
import type { TranslationKey } from "../i18n/translations";
import type { LucideIcon } from "lucide-react";
import { fundDisplayName } from "../lib/fundMeta";
import { InfoPopover } from "./InfoPopover";

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

// ─── Visual weight classification ────────────────────────────────────────────
const NOISE_ACTIONS  = new Set(["SKIP_INSUFFICIENT", "SKIP_ALL_GOOD"]);
const RESET_ACTIONS  = ["GLOBAL_RESET"];
const EVO_ACTIONS    = ["STANDARD_PBT", "PBT_INHERIT_MUTATE", "MICRO_EVOLUTION"];
const MAJOR_DELTA_THRESHOLD = 0.05;

function logWeight(log: EvolutionLog): { isNoise: boolean; isMajor: boolean } {
  const fd = log.fitness_before != null && log.fitness_after != null
    ? log.fitness_after - log.fitness_before : null;
  return {
    isNoise: NOISE_ACTIONS.has(log.action),
    isMajor: log.action === "GLOBAL_RESET" || (fd != null && Math.abs(fd) >= MAJOR_DELTA_THRESHOLD),
  };
}

// ─── Compact mutation card (collapsed by default, expand on click) ────────────
function EvoMutCard({ log }: { log: EvolutionLog }) {
  const { t, locale } = useI18n();
  const [expanded, setExpanded] = useState(false);

  const fd = log.fitness_before != null && log.fitness_after != null
    ? log.fitness_after - log.fitness_before : null;
  const improved = fd != null && fd >= 0;
  const { Icon, color, bg } = EVO_PANEL_TYPE_CFG[log.action] ?? EVO_PANEL_TYPE_DEFAULT;
  const { isNoise, isMajor } = logWeight(log);

  let paramCount = 0;
  try {
    const b = JSON.parse(log.params_before);
    const a = JSON.parse(log.params_after);
    paramCount = Object.keys({ ...b, ...a }).filter(k => b[k] !== a[k]).length;
  } catch { /* ignore */ }

  const hasDetails = fd != null || paramCount > 0 || !!log.reason;

  return (
    <div className={`glass-card overflow-hidden transition-all
      ${isNoise ? "opacity-55" : ""}
      ${isMajor ? "border-l-[3px] border-l-[var(--r-accent)]" : ""}
    `}>
      {/* ── Compact single-line header ─────────────────────────────────── */}
      <button
        type="button"
        className={`w-full flex items-center gap-2 px-3 text-left
          ${isNoise ? "py-1.5" : "py-2.5"}
          ${hasDetails ? "cursor-pointer hover:bg-white/[0.02]" : "cursor-default"}
        `}
        onClick={() => hasDetails && setExpanded(e => !e)}
        disabled={!hasDetails}
      >
        {/* Type icon */}
        <div className={`p-1 rounded-md shrink-0 ${bg}`}>
          <Icon className={`w-3 h-3 ${color}`} />
        </div>

        {/* Action label — fixed width for alignment */}
        <span className={`text-[11px] font-semibold ${color} shrink-0 w-[76px] truncate`}>
          {ACTION_CONFIG[log.action] ? t(ACTION_CONFIG[log.action].labelKey) : log.action}
        </span>

        {/* Fund name */}
        <span className="text-[11px] text-[var(--r-text-muted)] font-medium shrink-0">
          {fundDisplayName(log.fund_id, t)}
        </span>

        {/* Inline fitness summary */}
        {fd != null ? (
          <span className="flex items-center gap-1 flex-1 min-w-0 ml-1 overflow-hidden">
            <span className="text-[10px] font-mono text-[var(--r-text-faint)] shrink-0">
              {log.fitness_before!.toFixed(3)}
            </span>
            <span className="text-[9px] text-[var(--r-border)] shrink-0">→</span>
            <span className="text-[10px] font-mono text-[var(--r-text-muted)] shrink-0">
              {log.fitness_after!.toFixed(3)}
            </span>
            <span className={`text-[10px] font-mono ml-0.5 shrink-0 font-semibold
              ${improved ? "pnl-positive" : "pnl-negative"}`}>
              {improved ? "+" : ""}{fd.toFixed(3)}
            </span>
          </span>
        ) : (
          <span className="flex-1" />
        )}

        {/* Epoch + time */}
        <span className="text-[10px] text-[var(--r-text-faint)] shrink-0 ml-auto">
          {t("epoch")} {log.epoch}
          {!isNoise && ` · ${relativeTime(log.executed_at, locale)}`}
        </span>

        {/* Chevron */}
        {hasDetails && (
          <ChevronDown className={`w-3 h-3 text-[var(--r-text-faint)] shrink-0 transition-transform ml-1
            ${expanded ? "rotate-180" : ""}`}
          />
        )}
      </button>

      {/* ── Expanded detail panel ──────────────────────────────────────── */}
      {expanded && hasDetails && (
        <div className="px-3 pb-3 pt-2 border-t border-[var(--r-border)] space-y-1.5">
          {/* Full fitness bars */}
          {log.fitness_before != null && log.fitness_after != null && (
            <div className="space-y-1">
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
                    style={{ width: `${(log.fitness_after! * 100).toFixed(1)}%` }} />
                </div>
                <span className={`text-[10px] font-mono w-10 text-right shrink-0
                  ${improved ? "pnl-positive" : "pnl-negative"}`}>
                  {log.fitness_after!.toFixed(3)}
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
            <p className="text-xs text-[var(--r-text-muted)]">
              {translateReason(t, log.reason)}
            </p>
          )}
          {/* Param diff */}
          {paramCount > 0 && (
            <EvoInlineParamDiff before={log.params_before} after={log.params_after} />
          )}
        </div>
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

// ─── Custom dropdown (replaces native <select> to match dark design system) ──
interface SelectOption { value: string; label: string }

function DropdownSelect({
  value, options, onChange, className,
}: {
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  const selected = options.find(o => o.value === value);

  return (
    <div ref={wrapRef} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        onMouseDown={e => { e.preventDefault(); setOpen(o => !o); }}
        className={`flex items-center gap-1 text-[11px] text-[var(--r-text-muted)] border rounded px-2 py-0.5
          transition-colors outline-none
          ${open
            ? "border-[var(--r-accent)]/60 text-[var(--r-text)]"
            : "border-[var(--r-border)] hover:border-[var(--r-text-faint)]"
          }`}
      >
        {selected?.label}
        <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 min-w-[130px] glass-card py-1 shadow-xl
          border border-[var(--r-border)] rounded-lg overflow-hidden">
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => { onChange(opt.value); setOpen(false); }}
              className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors outline-none
                ${opt.value === value
                  ? "bg-[var(--r-accent)]/15 text-[var(--r-accent)]"
                  : "text-[var(--r-text-muted)] hover:bg-white/5 hover:text-[var(--r-text)]"
                }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EvoKpiStrip({ logs, epochs }: { logs: EvolutionLog[]; epochs: EpochSummary[] }) {
  const { t } = useI18n();
  const { days, hours, minutes } = useCountdown();
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

  const countdownValue = days > 0 ? `${days}D ${hours}H` : hours > 0 ? `${hours}H ${minutes}M` : `${minutes}M`;

  const items = [
    { label: t("epoch"),       value: String(epochs.length), mono: true,  dim: false, tooltip: t("tipEpoch") },
    { label: t("evoKpiAvg"),   value: avgFitness != null ? avgFitness.toFixed(3) : "—", mono: true, dim: false },
    { label: t("evoKpiBest"),  value: bestFitness != null ? bestFitness.toFixed(3) : "—", mono: true, dim: false, green: true, tooltip: t("tipBestFitness") },
    { label: t("evoKpiLast"),  value: lastEvo ? relativeTime(lastEvo, "") : "—", mono: false, dim: true },
    { label: t("evoNextEvo"),  value: countdownValue, mono: true, dim: true },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
      {items.map(({ label, value, mono, green, dim, tooltip }, idx) => (
        <div key={label} className={`glass-card px-4 py-3 text-center ${idx === 4 ? "col-span-2 sm:col-span-1" : ""}`}>
          <div className="flex items-center justify-center gap-0.5 mb-1">
            <span className="text-[10px] text-[var(--r-text-muted)] uppercase tracking-wider">{label}</span>
            {tooltip && <InfoPopover text={tooltip} />}
          </div>
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
  const { t, locale } = useI18n();
  const [activeEpoch, setActiveEpoch] = useState<number | null>(null);
  const [selectedFund, setSelectedFund] = useState<string | null>(null);

  // ── Mutation filter/sort state ────────────────────────────────────────────
  const [mutTypeGroup, setMutTypeGroup] = useState<string>("evolution");
  const [mutSortKey,   setMutSortKey]   = useState<string>("time");
  const [mutFundId,    setMutFundId]    = useState<string>("all");
  const [mutShowAll,   setMutShowAll]   = useState(false);
  const MUT_PAGE_SIZE = 10;

  // ── Epoch stats — must live before early returns (Rules of Hooks) ─────────
  const epochStats = useMemo(() => {
    if (activeEpoch == null || !data?.logs) return null;
    const epLogs = data.logs.filter(l => l.epoch === activeEpoch && l.action !== "UNCHANGED");
    const evolved  = epLogs.filter(l => EVO_ACTIONS.includes(l.action) || RESET_ACTIONS.includes(l.action)).length;
    const skipped  = epLogs.filter(l => NOISE_ACTIONS.has(l.action)).length;
    const deltas   = epLogs.filter(l => l.fitness_before != null && l.fitness_after != null)
      .map(l => l.fitness_after! - l.fitness_before!);
    const avgDelta = deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
    const bestLog  = epLogs.reduce<EvolutionLog | null>((best, l) => {
      if (l.fitness_before == null || l.fitness_after == null) return best;
      const d = l.fitness_after - l.fitness_before;
      if (!best || d > (best.fitness_after! - best.fitness_before!)) return l;
      return best;
    }, null);
    return { total: epLogs.length, evolved, skipped, avgDelta, bestLog };
  }, [data?.logs, activeEpoch]);

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

  // ── Mutation filter/sort logic ────────────────────────────────────────────
  const mutTypeMap: Record<string, string[]> = {
    evolution: EVO_ACTIONS,
    skip:      [...NOISE_ACTIONS],
    reset:     RESET_ACTIONS,
  };
  const mutTypeActions = mutTypeMap[mutTypeGroup] ?? [];

  // Base: epoch filter only (for empty-state discrimination)
  const baseMutLogs = data.logs.filter(l =>
    l.action !== "UNCHANGED" && (activeEpoch == null || l.epoch === activeEpoch)
  );
  // Count per type for filter chip badges
  const filterCounts: Record<string, number> = {
    all:       baseMutLogs.length,
    evolution: baseMutLogs.filter(l => [...EVO_ACTIONS, ...RESET_ACTIONS].includes(l.action)).length,
    skip:      baseMutLogs.filter(l => NOISE_ACTIONS.has(l.action)).length,
    reset:     baseMutLogs.filter(l => RESET_ACTIONS.includes(l.action)).length,
  };
  // Active: epoch + type + fund
  const activeMutLogs = baseMutLogs.filter(l =>
    (mutTypeActions.length === 0 || mutTypeActions.includes(l.action)) &&
    (mutFundId === "all" || l.fund_id === mutFundId)
  );
  const sortedMutLogs = [...activeMutLogs].sort((a, b) => {
    if (mutSortKey === "best") {
      const da = (a.fitness_after ?? 0) - (a.fitness_before ?? 0);
      const db = (b.fitness_after ?? 0) - (b.fitness_before ?? 0);
      return db - da;
    }
    if (mutSortKey === "worst") {
      const da = (a.fitness_after ?? 0) - (a.fitness_before ?? 0);
      const db = (b.fitness_after ?? 0) - (b.fitness_before ?? 0);
      return da - db;
    }
    return b.executed_at.localeCompare(a.executed_at);
  });
  const displayedMutLogs = mutShowAll ? sortedMutLogs : sortedMutLogs.slice(0, MUT_PAGE_SIZE);
  const hiddenMutCount   = sortedMutLogs.length - displayedMutLogs.length;
  const isFilterActive   = mutTypeGroup !== "all" || mutFundId !== "all";
  const availableFunds   = [...new Set(baseMutLogs.map(l => l.fund_id))].sort();

  // Epoch fitness deltas for cards
  const epochDelta = (ep: number) => {
    const logs = data.logs.filter(l => l.epoch === ep);
    const vBefore = logs.filter(l => l.fitness_before != null).map(l => l.fitness_before!);
    const vAfter  = logs.filter(l => l.fitness_after  != null).map(l => l.fitness_after!);
    if (vBefore.length === 0 || vAfter.length === 0) return null;
    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    return avg(vAfter) - avg(vBefore);
  };

  // Epoch action breakdown for compact card labels (P0-③)
  const getEpochBreakdown = (ep: number) => {
    const epLogs = data.logs.filter(l => l.epoch === ep && l.action !== "UNCHANGED");
    return {
      evolved:  epLogs.filter(l => EVO_ACTIONS.includes(l.action)).length,
      reset:    epLogs.filter(l => RESET_ACTIONS.includes(l.action)).length,
      skipped:  epLogs.filter(l => NOISE_ACTIONS.has(l.action)).length,
    };
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
          <div className="text-[11px] text-[var(--r-text-faint)]">{locale === "zh" ? "全部" : "All"}</div>
        </button>

          {sortedEpochs.map(ep => {
          const mainAction = ep.action_types.split(",")[0];
          const config = ACTION_CONFIG[mainAction] || ACTION_CONFIG.UNCHANGED;
          const Icon = config.icon;
          const delta = epochDelta(ep.epoch);
          const isActive = activeEpoch === ep.epoch;
          const { evolved, reset, skipped } = getEpochBreakdown(ep.epoch);
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
              {/* P0-③ Action breakdown */}
              {(evolved + reset + skipped) > 0 && (
                <div className="flex items-center justify-center gap-1.5 mt-1">
                  {evolved > 0 && <span className="text-[9px] pnl-positive">{evolved}↑</span>}
                  {reset  > 0 && <span className="text-[9px] text-orange-400">{reset}↩</span>}
                  {skipped > 0 && <span className="text-[9px] text-[var(--r-text-faint)]">{skipped}—</span>}
                </div>
              )}
            </button>
          );
        })}
      </div>

      <FitnessChart logs={data.logs} allFundIds={data.lineage.map(l => l.id)} activeEpoch={activeEpoch} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <LineageTree
          lineage={data.lineage}
          logs={data.logs}
          selectedFund={selectedFund}
          onSelectFund={setSelectedFund}
        />
        <ParamHeatmap
          logs={data.logs}
          selectedFund={selectedFund}
          allFundIds={data.lineage.map(l => l.id)}
          activeEpoch={activeEpoch}
        />
      </div>

      {/* ── Mutations section ─────────────────────────────────────────── */}
      <div>
        {/* Header + toolbar */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-3">
          <h3 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest shrink-0 inline-flex items-center gap-1">
            <span>{t("recentMutations")}</span>
            <InfoPopover text={t("tipMutationType")} />
            {activeEpoch != null && (
              <span className="ml-2 normal-case font-normal text-[var(--r-accent)]">· {t("epoch")} {activeEpoch}</span>
            )}
          </h3>

          {/* Type filter pills */}
          <div className="flex items-center gap-1 flex-1 min-w-0">
            {([
              { key: "all",       label: t("evoFilterAll")   },
              { key: "evolution", label: t("evoFilterEvo")   },
              { key: "skip",      label: t("evoFilterSkip")  },
              { key: "reset",     label: t("evoFilterReset") },
            ] as const).map(opt => (
              <button
                key={opt.key}
                type="button"
                onClick={() => { setMutTypeGroup(opt.key); setMutShowAll(false); }}
                className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors
                  ${mutTypeGroup === opt.key
                    ? "bg-[var(--r-accent)]/20 text-[var(--r-accent)] ring-1 ring-[var(--r-accent)]/40"
                    : "text-[var(--r-text-faint)] hover:text-[var(--r-text-muted)] hover:bg-white/5"
                  }`}
              >
                {opt.label}
                <span className="ml-0.5 text-[10px] opacity-50">({filterCounts[opt.key] ?? 0})</span>
              </button>
            ))}
          </div>

          {/* Sort dropdown */}
          <DropdownSelect
            value={mutSortKey}
            options={[
              { value: "time",  label: t("evoSortTime") },
              { value: "best",  label: t("evoSortJump") },
              { value: "worst", label: t("evoSortWorst") },
            ]}
            onChange={v => { setMutSortKey(v); setMutShowAll(false); }}
          />

          {/* Fund dropdown */}
          {availableFunds.length > 1 && (
            <DropdownSelect
              value={mutFundId}
              options={[
                { value: "all", label: t("evoAllFunds") },
                ...availableFunds.map(fid => ({ value: fid, label: fundDisplayName(fid, t) })),
              ]}
              onChange={v => { setMutFundId(v); setMutShowAll(false); }}
            />
          )}

          {/* Clear filter button */}
          {isFilterActive && (
            <button
              type="button"
              onClick={() => { setMutTypeGroup("all"); setMutFundId("all"); setMutShowAll(false); }}
              className="flex items-center gap-0.5 text-[11px] text-[var(--r-text-faint)] hover:text-[var(--r-text)] transition-colors ml-auto"
            >
              <X className="w-3 h-3" />
              {t("evoClearFilters")}
            </button>
          )}
        </div>

        {/* P2: Epoch stats bar */}
        {epochStats && epochStats.total > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] font-mono
            text-[var(--r-text-faint)] bg-white/[0.03] border border-[var(--r-border)]
            rounded-lg px-3 py-2 mb-3">
            <span>{t("epoch")} {activeEpoch} · {epochStats.total} {locale === "zh" ? "条" : "events"}</span>
            <span className="pnl-positive">{epochStats.evolved} {t("evoEvolvedCount")}</span>
            <span>{epochStats.skipped} {t("evoSkippedCount")}</span>
            {epochStats.avgDelta != null && (
              <span>
                {t("evoAvgDelta")}{" "}
                <span className={epochStats.avgDelta >= 0 ? "pnl-positive" : "pnl-negative"}>
                  {epochStats.avgDelta >= 0 ? "+" : ""}{epochStats.avgDelta.toFixed(3)}
                </span>
              </span>
            )}
            {epochStats.bestLog?.fitness_before != null && (
              <span>
                {t("evoBestDelta")}{" "}
                <span className="pnl-positive">
                  +{(epochStats.bestLog.fitness_after! - epochStats.bestLog.fitness_before!).toFixed(3)}
                </span>
                {" "}({fundDisplayName(epochStats.bestLog.fund_id, t)})
              </span>
            )}
          </div>
        )}

        {/* P1-③: Mobile active-epoch sticky indicator */}
        {activeEpoch != null && (
          <div className="sm:hidden flex items-center gap-1.5 text-[10px] text-[var(--r-accent)]
            bg-[var(--r-surface)] border border-[var(--r-accent)]/20 rounded-lg px-2.5 py-1.5 mb-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--r-accent)] shrink-0" />
            <span>{t("epoch")} {activeEpoch} · {t("evoCurrentFilter")}</span>
          </div>
        )}

        {/* Card list */}
        <div className="space-y-1">
          {displayedMutLogs.map(log => (
            <EvoMutCard key={log.id} log={log} />
          ))}
        </div>

        {/* Load more / collapse */}
        {hiddenMutCount > 0 && (
          <button
            type="button"
            onClick={() => setMutShowAll(true)}
            className="mt-2 w-full text-center text-xs text-[var(--r-text-faint)]
              hover:text-[var(--r-text-muted)] transition-colors py-1.5 glass-card"
          >
            {t("evoShowMore")} {sortedMutLogs.length} {locale === "zh" ? "条" : "records"} ↓
          </button>
        )}
        {mutShowAll && sortedMutLogs.length > MUT_PAGE_SIZE && (
          <button
            type="button"
            onClick={() => setMutShowAll(false)}
            className="mt-2 w-full text-center text-xs text-[var(--r-text-faint)]
              hover:text-[var(--r-text-muted)] transition-colors py-1.5 glass-card"
          >
            <ChevronUp className="inline w-3 h-3 mr-1" />{t("evoShowLess")}
          </button>
        )}

        {/* Empty states */}
        {sortedMutLogs.length === 0 && (
          <div className="py-6 text-center space-y-2">
            {isFilterActive && baseMutLogs.length > 0 ? (
              <>
                <p className="text-sm text-[var(--r-text-muted)]">{t("evoNoResults")}</p>
                <button
                  type="button"
                  onClick={() => { setMutTypeGroup("all"); setMutFundId("all"); }}
                  className="text-xs text-[var(--r-accent)] hover:underline"
                >
                  {t("evoClearFilters")}
                </button>
              </>
            ) : baseMutLogs.length === 0 && activeEpoch != null && epochStats?.evolved === 0 ? (
              <p className="text-sm text-[var(--r-text-muted)]">{t("evoAllSkipped")}</p>
            ) : (
              <p className="text-sm text-[var(--r-text-muted)]">{t("fitnessEmpty")}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
