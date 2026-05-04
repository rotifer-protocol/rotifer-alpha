import { useState, useEffect } from "react";
import { Dna, Shuffle, RotateCcw, SkipForward, Sparkles, Minus, Swords, BarChart3, GitBranch, Zap, Clock } from "lucide-react";
import { useFetch } from "../hooks/useApi";
import { FitnessChart } from "./FitnessChart";
import { ParamHeatmap } from "./ParamHeatmap";
import { LineageTree } from "./LineageTree";
import { useI18n } from "../i18n/context";
import type { TranslationKey } from "../i18n/translations";
import type { LucideIcon } from "lucide-react";
import { fundDisplayName } from "../lib/fundMeta";

const PARAM_I18N: Record<string, TranslationKey> = {
  minEdge: "paramMinEdge", minConfidence: "paramMinConfidence",
  minVolume: "paramMinVolume", minLiquidity: "paramMinLiquidity",
  maxPerEvent: "paramMaxPerEvent", maxOpenPositions: "paramMaxPositions",
  monthlyTarget: "paramMonthlyTarget", drawdownLimit: "paramDrawdownLimit",
  stopLossPercent: "paramStopLoss", maxHoldDays: "paramMaxHold",
  takeProfitPercent: "takeProfitLabel", trailingStopPercent: "trailingStopLabel",
  probReversalThreshold: "probReversalLabel",
  sizingBase: "paramSizingBase", sizingScale: "paramSizingScale",
};

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

function ParamDiff({ before, after }: { before: string; after: string }) {
  const { t } = useI18n();
  let b: Record<string, number> = {};
  let a: Record<string, number> = {};
  try { b = JSON.parse(before); } catch { return null; }
  try { a = JSON.parse(after); } catch { return null; }

  const allKeys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const changes = allKeys.filter(k => b[k] !== a[k]);
  if (changes.length === 0) return null;

  return (
    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs font-mono">
      {changes.slice(0, 6).map(k => {
        const diff = (a[k] ?? 0) - (b[k] ?? 0);
        const pct = b[k] ? ((diff / b[k]) * 100).toFixed(1) : t("paramChangeNew");
        const labelKey = PARAM_I18N[k];
        return (
          <div key={k} className="flex justify-between">
            <span className="text-[var(--r-text-muted)]">{labelKey ? t(labelKey) : k}</span>
            <span className={diff >= 0 ? "pnl-positive" : "pnl-negative"}>
              {diff >= 0 ? "+" : ""}{pct}%
            </span>
          </div>
        );
      })}
      {changes.length > 6 && (
        <div className="text-[var(--r-text-muted)]">+{changes.length - 6} {t("nMore")}</div>
      )}
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
  const { data, loading } = useFetch<EvolutionResponse>("/api/evolution", 120_000);
  const { t } = useI18n();

  if (loading) {
    return (
      <div className="glass-card p-8 text-center text-[var(--r-text-muted)]">
        {t("loadingEvolution")}
      </div>
    );
  }

  if (!data || data.epochs.length === 0) {
    return <EvolutionEmptyState />;
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-2 overflow-x-auto pb-2">
        {data.epochs.map(ep => {
          const mainAction = ep.action_types.split(",")[0];
          const config = ACTION_CONFIG[mainAction] || ACTION_CONFIG.UNCHANGED;
          const Icon = config.icon;
          return (
            <div
              key={ep.epoch}
              className="glass-card px-4 py-3 shrink-0 min-w-[120px] text-center"
            >
              <Icon className={`w-5 h-5 mx-auto mb-1 ${config.color}`} />
              <div className="text-sm font-bold">{t("epoch")} {ep.epoch}</div>
              <div className={`text-xs ${config.color}`}>{t(config.labelKey)}</div>
              <div className="text-xs text-[var(--r-text-muted)] mt-1">
                {formatDate(ep.started_at)}
              </div>
            </div>
          );
        })}
      </div>

      <FitnessChart logs={data.logs} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <LineageTree lineage={data.lineage} />
        <ParamHeatmap logs={data.logs} selectedFund={null} />
      </div>

      <div>
        <h3 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-3">
          {t("recentMutations")}
        </h3>
        <div className="space-y-2">
          {data.logs
            .filter(l => l.action !== "UNCHANGED")
            .slice(0, 10)
            .map(log => {
              const config = ACTION_CONFIG[log.action] || ACTION_CONFIG.UNCHANGED;
              const Icon = config.icon;
              return (
                <div key={log.id} className="glass-card px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Icon className={`w-4 h-4 ${config.color}`} />
                    <span className={`font-medium text-sm ${config.color}`}>
                      {t(config.labelKey)}
                    </span>
                    <span className="text-xs text-[var(--r-text-muted)]">
                      {fundDisplayName(log.fund_id, t)} · {t("epoch")} {log.epoch}
                    </span>
                    {log.fitness_before !== null && (
                      <span className="text-xs font-mono text-[var(--r-text-muted)] ml-auto">
                        {t("fitnessLabel")}={log.fitness_before.toFixed(4)}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[var(--r-text-muted)] mt-1">{translateReason(t, log.reason)}</p>
                  <ParamDiff before={log.params_before} after={log.params_after} />
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}
