import { useState, useMemo } from "react";
import { useI18n } from "../i18n/context";
import type { TranslationKey } from "../i18n/translations";
import { useFetch } from "../hooks/useApi";
import {
  GitBranch, Zap, Trophy, XCircle, Activity, ChevronDown, ChevronUp, RefreshCw,
} from "lucide-react";
import { fmtCompact } from "../lib/fundMeta";
import { InfoPopover } from "./InfoPopover";

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface GeneVariant {
  id: string;
  geneId: string;
  variantName: string;
  description: string | null;
  strategyKey: string;
  generation: number;
  status: "active" | "eliminated" | "retired";
  petriScore: number;
  tradesEvaluated: number;
  winCount: number;
  lossCount: number;
  totalPnl: number;
  createdAt: string;
  eliminatedAt: string | null;
}

interface EvolutionLogEntry {
  id: string;
  epoch: number;
  geneId: string;
  action: string;
  variantId: string | null;
  details: string | null;
  petriScore: number | null;
  createdAt: string;
}

interface GeneRegistryEntry {
  id: string;
  name: string;
  version: string;
  fidelity: string;
  lifecycleStatus: string;
  externalDependencies?: string[];
}

interface VariantsResponse {
  variants: GeneVariant[];
  activeConfig: Record<string, string>;
  registry: GeneRegistryEntry[];
}

interface EvolutionResponse {
  epoch: number;
  log: EvolutionLogEntry[];
}

// ─── Lookup tables ────────────────────────────────────────────────────────────

/** One color theme per Gene group (assigned by index, stable across renders). */
const GENE_GROUP_COLORS = [
  { accent: "text-indigo-400", border: "border-l-indigo-500/50", bg: "bg-indigo-500/10",  hex: "#818cf8" },
  { accent: "text-sky-400",    border: "border-l-sky-500/50",    bg: "bg-sky-500/10",     hex: "#38bdf8" },
  { accent: "text-emerald-400",border: "border-l-emerald-500/50",bg: "bg-emerald-500/10", hex: "#34d399" },
  { accent: "text-amber-400",  border: "border-l-amber-500/50",  bg: "bg-amber-500/10",   hex: "#fbbf24" },
  { accent: "text-rose-400",   border: "border-l-rose-500/50",   bg: "bg-rose-500/10",    hex: "#fb7185" },
  { accent: "text-purple-400", border: "border-l-purple-500/50", bg: "bg-purple-500/10",  hex: "#a78bfa" },
  { accent: "text-cyan-400",   border: "border-l-cyan-500/50",   bg: "bg-cyan-500/10",    hex: "#22d3ee" },
];

const FIDELITY_KEYS: Record<string, TranslationKey> = {
  native:  "fidelityNative",
  hybrid:  "fidelityHybrid",
  wrapped: "fidelityWrapped",
};

const FIDELITY_COLORS: Record<string, string> = {
  native:  "bg-emerald-500/10 text-emerald-400",
  hybrid:  "bg-amber-500/10 text-amber-400",
  wrapped: "bg-zinc-500/10 text-zinc-400",
};

const LIFECYCLE_KEYS: Record<string, TranslationKey> = {
  embedded:  "lifecycleEmbedded",
  published: "lifecyclePublished",
  trial:     "lifecycleTrial",
  active:    "lifecycleActive",
};

const STATUS_COLORS: Record<string, string> = {
  active:     "text-[var(--r-green)]",
  eliminated: "text-[var(--r-red)]",
  retired:    "text-[var(--r-text-faint)]",
};

const STATUS_KEYS: Record<string, TranslationKey> = {
  active:     "geneStatusActive",
  eliminated: "geneStatusEliminated",
  retired:    "geneStatusRetired",
};

const ACTION_ICONS: Record<string, typeof Zap> = {
  variant_promoted:   Trophy,
  variant_eliminated: XCircle,
  variant_respawned:  RefreshCw,
  variant_added:      GitBranch,
  epoch_started:      Zap,
  epoch_completed:    Activity,
};

const ACTION_KEYS: Record<string, TranslationKey> = {
  variant_promoted:   "genePromoted",
  variant_eliminated: "geneEliminated",
  variant_respawned:  "geneRespawned",
  variant_added:      "geneVariantAdded",
  epoch_started:      "geneEpochStarted",
  epoch_completed:    "geneEpochCompleted",
};

const LOG_FILTER_KEYS: Record<string, TranslationKey> = {
  all:          "geneFilterAll",
  promotions:   "geneFilterPromotions",
  eliminations: "geneFilterEliminations",
  epoch:        "geneFilterEpoch",
};

/** Display names for strategy keys: raw identifier → human-readable label. */
const STRATEGY_DISPLAY: Record<string, { en: string; zh: string }> = {
  "baseline":        { en: "baseline",       zh: "基线" },
  "aggressive":      { en: "aggressive",     zh: "激进" },
  "conservative":    { en: "conservative",   zh: "保守" },
  "high-edge":       { en: "high-edge",      zh: "高边缘" },
  "trend-following": { en: "trend-following",zh: "趋势跟踪" },
  "adaptive":        { en: "adaptive",       zh: "自适应" },
  "llm-config":      { en: "llm-config",     zh: "LLM 配置" },
};

function strategyLabel(key: string, locale: string): string {
  return STRATEGY_DISPLAY[key]?.[locale === "zh" ? "zh" : "en"] ?? key;
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function pnlStr(v: number): string {
  if (v === 0) return "—";
  return (v > 0 ? "+" : "-") + fmtCompact(Math.abs(v));
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Mini horizontal PBT score bar + number. Shows — when insufficient data. */
function ScoreBar({ score, evaluated }: { score: number; evaluated: number }) {
  if (evaluated < 3) {
    return <span className="text-[var(--r-text-faint)] text-xs font-mono">—</span>;
  }
  const color =
    score >= 70 ? "bg-emerald-500" :
    score >= 40 ? "bg-amber-500" :
    "bg-rose-500";
  return (
    <div className="flex items-center gap-1.5 justify-end">
      <div className="w-12 h-1 bg-[var(--r-border)] rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, score)}%` }} />
      </div>
      <span className="font-mono text-xs tabular-nums">{score.toFixed(1)}</span>
    </div>
  );
}

/** Mini inline win-rate bar. */
function WinRateBar({ wins, total }: { wins: number; total: number }) {
  if (total < 1) return <span className="text-[var(--r-text-faint)] font-mono text-xs">—</span>;
  const rate = (wins / total) * 100;
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-10 h-1 bg-[var(--r-border)] rounded-full overflow-hidden">
        <div className="h-full bg-[var(--r-green)] rounded-full" style={{ width: `${Math.min(100, rate)}%` }} />
      </div>
      <span className="font-mono text-xs tabular-nums">{rate.toFixed(0)}%</span>
    </div>
  );
}

/** Tiny SVG sparkline of champion score across epochs. */
function ScoreSparkline({ points, colorHex }: { points: number[]; colorHex: string }) {
  if (points.length < 2) return null;
  const W = 56, H = 18, pad = 2;
  const maxV = Math.max(...points);
  const minV = Math.min(...points);
  const range = maxV - minV || 1;
  const pts = points.map((v, i) => {
    const x = pad + (i / (points.length - 1)) * (W - 2 * pad);
    const y = pad + (1 - (v - minV) / range) * (H - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg width={W} height={H} className="shrink-0 opacity-70">
      <polyline
        points={pts}
        fill="none"
        stroke={colorHex}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface VariantRowProps {
  v: GeneVariant;
  t: (key: TranslationKey) => string;
  locale: string;
  expandedDesc: Set<string>;
  onToggleDesc: (id: string) => void;
}

/** Desktop table row for a non-champion variant. */
function VariantRow({ v, t, locale, expandedDesc, onToggleDesc }: VariantRowProps) {
  const pnlColor = v.totalPnl > 0 ? "text-[var(--r-green)]" : v.totalPnl < 0 ? "text-[var(--r-red)]" : "";
  return (
    <tr className="border-b border-[var(--r-border)]/50">
      <td className="py-1.5 pr-3">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs">{strategyLabel(v.strategyKey, locale)}</span>
          <span className="text-[var(--r-text-faint)] text-[11px]">{t("geneGenPrefix")}{v.generation}</span>
        </div>
        {v.description && (
          <p
            className={`text-[var(--r-text-faint)] mt-0.5 text-[11px] cursor-pointer leading-relaxed ${expandedDesc.has(v.id) ? "" : "truncate max-w-[260px]"}`}
            onClick={() => onToggleDesc(v.id)}
          >
            {v.description}
          </p>
        )}
      </td>
      <td className="text-right py-1.5 px-2">
        <ScoreBar score={v.petriScore} evaluated={v.tradesEvaluated} />
      </td>
      <td className="text-right py-1.5 px-2 font-mono text-xs">{v.tradesEvaluated}</td>
      <td className="text-right py-1.5 px-2">
        <div className="flex justify-end">
          <WinRateBar wins={v.winCount} total={v.tradesEvaluated} />
        </div>
      </td>
      <td className={`text-right py-1.5 px-2 font-mono text-xs ${pnlColor}`}>
        {pnlStr(v.totalPnl)}
      </td>
      <td className={`text-right py-1.5 pl-2 text-xs ${STATUS_COLORS[v.status] ?? ""}`}>
        {STATUS_KEYS[v.status] ? t(STATUS_KEYS[v.status]) : v.status}
      </td>
    </tr>
  );
}

/** Mobile card for a non-champion variant. */
function VariantCard({ v, t, locale, expandedDesc, onToggleDesc }: VariantRowProps) {
  const pnlColor = v.totalPnl > 0 ? "text-[var(--r-green)]" : v.totalPnl < 0 ? "text-[var(--r-red)]" : "";
  return (
    <div className="rounded-lg border border-[var(--r-border)] bg-[var(--r-surface)] px-3 py-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs font-medium">{strategyLabel(v.strategyKey, locale)}</span>
          <span className="text-[var(--r-text-faint)] text-[10px]">{t("geneGenPrefix")}{v.generation}</span>
        </div>
        <span className={`text-[10px] ${STATUS_COLORS[v.status] ?? ""}`}>
          {STATUS_KEYS[v.status] ? t(STATUS_KEYS[v.status]) : v.status}
        </span>
      </div>
      {v.description && (
        <p
          className={`text-[10px] text-[var(--r-text-faint)] mb-2 cursor-pointer leading-relaxed ${expandedDesc.has(v.id) ? "" : "line-clamp-1"}`}
          onClick={() => onToggleDesc(v.id)}
        >
          {v.description}
        </p>
      )}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-[var(--r-text-faint)]">{t("geneScoreLabel")}</span>
          <ScoreBar score={v.petriScore} evaluated={v.tradesEvaluated} />
        </div>
        <div className="flex items-center gap-1.5 justify-end">
          <span className="text-[10px] text-[var(--r-text-faint)]">{t("geneTradesEvaluated")}</span>
          <span className="font-mono text-xs">{v.tradesEvaluated}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-[var(--r-text-faint)]">{t("geneWinRate")}</span>
          <WinRateBar wins={v.winCount} total={v.tradesEvaluated} />
        </div>
        <div className="flex items-center gap-1.5 justify-end">
          <span className="text-[10px] text-[var(--r-text-faint)]">{t("pnl")}</span>
          <span className={`font-mono text-xs font-medium ${pnlColor}`}>{pnlStr(v.totalPnl)}</span>
        </div>
      </div>
    </div>
  );
}

/** Reusable desktop-table + mobile-cards section for a list of variants. */
function VariantSection({
  variants,
  t,
  locale,
  expandedDesc,
  onToggleDesc,
  showHeader = false,
}: {
  variants: GeneVariant[];
  t: (key: TranslationKey) => string;
  locale: string;
  expandedDesc: Set<string>;
  onToggleDesc: (id: string) => void;
  showHeader?: boolean;
}) {
  return (
    <>
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full text-xs">
          {showHeader && (
            <thead>
              <tr className="text-[var(--r-text-faint)] border-b border-[var(--r-border)]">
                <th className="text-left py-1 pr-3">{t("geneStrategy")}</th>
                <th className="text-right py-1 px-2">
                  <span className="flex items-center justify-end gap-1">
                    {t("genePetriScore")}
                    <InfoPopover text={t("tipGenePetriScore")} />
                  </span>
                </th>
                <th className="text-right py-1 px-2">{t("geneTradesEvaluated")}</th>
                <th className="text-right py-1 px-2">{t("geneWinRate")}</th>
                <th className="text-right py-1 px-2">{t("pnl")}</th>
                <th className="text-right py-1 pl-2">{t("geneStatus")}</th>
              </tr>
            </thead>
          )}
          <tbody>
            {variants.map(v => (
              <VariantRow
                key={v.id}
                v={v}
                t={t}
                locale={locale}
                expandedDesc={expandedDesc}
                onToggleDesc={onToggleDesc}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="sm:hidden space-y-2">
        {variants.map(v => (
          <VariantCard
            key={v.id}
            v={v}
            t={t}
            locale={locale}
            expandedDesc={expandedDesc}
            onToggleDesc={onToggleDesc}
          />
        ))}
      </div>
    </>
  );
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function GeneEvolutionPanel() {
  const { t, locale } = useI18n();

  const { data: varData, loading: varLoading, error: varError } =
    useFetch<VariantsResponse>(`/api/gene-variants?lang=${locale}`, 60000);
  const { data: evoData, loading: evoLoading } =
    useFetch<EvolutionResponse>("/api/gene-evolution?limit=30", 60000);

  // ── All hooks before any conditional return ───────────────────────────────
  const [showEliminated, setShowEliminated] = useState<Record<string, boolean>>({});
  const [expandedDesc,   setExpandedDesc]   = useState<Set<string>>(new Set());
  const [logFilter, setLogFilter] = useState<"all" | "promotions" | "eliminations" | "epoch">("all");

  const variants    = varData?.variants    ?? [];
  const activeConfig= varData?.activeConfig ?? {};
  const log         = evoData?.log         ?? [];
  const epoch       = evoData?.epoch       ?? 0;
  const registry    = varData?.registry    ?? [];

  const registryMap = useMemo(
    () => new Map(registry.map(r => [r.id, r])),
    [registry],
  );

  const { geneOrder, geneGroups } = useMemo(() => {
    const order: string[]                   = [];
    const groups = new Map<string, GeneVariant[]>();
    for (const v of variants) {
      if (!groups.has(v.geneId)) { groups.set(v.geneId, []); order.push(v.geneId); }
      groups.get(v.geneId)!.push(v);
    }
    return { geneOrder: order, geneGroups: groups };
  }, [variants]);

  /** Per-gene champion score history (sorted chronologically by epoch). */
  const sparklineData = useMemo(() => {
    const map: Record<string, number[]> = {};
    const promotions = [...log]
      .filter(e => e.action === "variant_promoted" && e.petriScore !== null)
      .sort((a, b) => a.epoch - b.epoch);
    for (const e of promotions) {
      if (!map[e.geneId]) map[e.geneId] = [];
      map[e.geneId].push(e.petriScore!);
    }
    return map;
  }, [log]);

  const filteredLog = useMemo(() => {
    switch (logFilter) {
      case "promotions":   return log.filter(e => e.action === "variant_promoted");
      case "eliminations": return log.filter(e => e.action === "variant_eliminated");
      case "epoch":        return log.filter(e => e.action.startsWith("epoch_"));
      default:             return log;
    }
  }, [log, logFilter]);

  const handleToggleDesc = (id: string) =>
    setExpandedDesc(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // ── Early returns ─────────────────────────────────────────────────────────
  if (varLoading || evoLoading) {
    return (
      <div className="space-y-4">
        <div className="glass-card p-4 animate-pulse h-20" />
        <div className="glass-card p-4 animate-pulse h-48" />
        <div className="glass-card p-4 animate-pulse h-32" />
      </div>
    );
  }

  if (varError && !varData) {
    return (
      <div className="glass-card p-6 text-center text-sm text-[var(--r-red)]">{varError}</div>
    );
  }

  if (variants.length === 0) {
    return (
      <div className="glass-card p-10 text-center text-[var(--r-text-muted)] text-sm">
        <GitBranch className="w-6 h-6 mx-auto mb-3 opacity-30" />
        {t("geneNoVariants")}
      </div>
    );
  }

  const totalActive     = variants.filter(v => v.status === "active").length;
  const totalEliminated = variants.filter(v => v.status === "eliminated").length;

  return (
    <div className="space-y-6">

      {/* ── KPI strip ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: t("geneCurrentEpoch"),   value: epoch,            },
          { label: t("geneVariants"),        value: variants.length,  },
          { label: t("geneActiveVariants"),  value: totalActive,      green: true },
          { label: t("geneEliminatedTotal"), value: totalEliminated,  dim: true },
        ].map(({ label, value, green, dim }) => (
          <div key={label} className="glass-card px-4 py-3 text-center">
            <p className="text-[10px] text-[var(--r-text-faint)] uppercase tracking-widest mb-1 truncate">{label}</p>
            <p className={`text-2xl font-bold font-mono tabular-nums ${green ? "text-[var(--r-green)]" : dim ? "text-[var(--r-text-muted)]" : ""}`}>
              {value}
            </p>
          </div>
        ))}
      </div>

      {/* ── Gene groups ───────────────────────────────────────────────────── */}
      <div className="space-y-4">
        {geneOrder.map((geneId, gIdx) => {
          const gv          = geneGroups.get(geneId) ?? [];
          const meta        = registryMap.get(geneId);
          const color       = GENE_GROUP_COLORS[gIdx % GENE_GROUP_COLORS.length];
          const displayName = locale === "zh" && meta?.name
            ? meta.name
            : geneId.replace("polymarket-", "");

          const champion    = gv.find(v => activeConfig[v.geneId] === v.id);
          const otherActive = gv.filter(v => v.status === "active" && v !== champion);
          const eliminated  = gv.filter(v => v.status !== "active");
          const showingElim = showEliminated[geneId] ?? false;
          const sparkPts    = sparklineData[geneId] ?? [];

          return (
            <div key={geneId} className={`glass-card overflow-hidden border-l-2 ${color.border}`}>

              {/* ── Group header ──────────────────────────────────────────── */}
              <div className="flex flex-wrap items-center gap-2 px-4 pt-4 pb-3">
                <GitBranch className={`w-4 h-4 ${color.accent} shrink-0`} />
                <span className="text-sm font-semibold">{displayName}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${color.bg} ${color.accent}`}>
                  {gv.filter(v => v.status === "active").length} {t("geneActiveCount")}
                </span>
                {meta && (
                  <>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${FIDELITY_COLORS[meta.fidelity] ?? "bg-zinc-500/10 text-zinc-400"}`}>
                      {FIDELITY_KEYS[meta.fidelity] ? t(FIDELITY_KEYS[meta.fidelity]) : meta.fidelity}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--r-surface)] text-[var(--r-text-faint)] border border-[var(--r-border)]">
                      {LIFECYCLE_KEYS[meta.lifecycleStatus]
                        ? t(LIFECYCLE_KEYS[meta.lifecycleStatus])
                        : meta.lifecycleStatus}
                    </span>
                  </>
                )}
              </div>

              {/* ── Champion hero card ────────────────────────────────────── */}
              {champion && (
                <div className={`mx-4 mb-3 rounded-lg ${color.bg} border border-[var(--r-border)] p-3`}>
                  <div className="flex items-start justify-between gap-3 mb-2.5">
                    {/* Left: identity + description */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-1">
                        <Trophy className={`w-3.5 h-3.5 ${color.accent} shrink-0`} />
                        <span className="text-[10px] font-semibold text-[var(--r-text-muted)] uppercase tracking-widest">
                          {t("geneChampion")}
                        </span>
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--r-green)] animate-pulse shrink-0" />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-sm font-bold">{strategyLabel(champion.strategyKey, locale)}</span>
                        <span className="text-xs text-[var(--r-text-faint)]">{t("geneGenPrefix")}{champion.generation}</span>
                      </div>
                      {champion.description && (
                        <p
                          className={`text-[11px] text-[var(--r-text-faint)] mt-1 leading-relaxed cursor-pointer ${expandedDesc.has(champion.id) ? "" : "line-clamp-1"}`}
                          onClick={() => handleToggleDesc(champion.id)}
                          title={t("geneExpandDesc")}
                        >
                          {champion.description}
                        </p>
                      )}
                    </div>

                    {/* Right: sparkline + score */}
                    <div className="flex items-center gap-2 shrink-0">
                      {sparkPts.length >= 2 && (
                        <div title={t("geneScoreTrajectory")}>
                          <ScoreSparkline points={sparkPts} colorHex={color.hex} />
                        </div>
                      )}
                      {champion.tradesEvaluated >= 3 ? (
                        <div className="flex items-center gap-1.5">
                          <div className="w-14 h-1.5 bg-[var(--r-border)] rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${champion.petriScore >= 70 ? "bg-emerald-500" : champion.petriScore >= 40 ? "bg-amber-500" : "bg-rose-500"}`}
                              style={{ width: `${Math.min(100, champion.petriScore)}%` }}
                            />
                          </div>
                          <span className={`font-mono text-lg font-bold tabular-nums ${color.accent}`}>
                            {champion.petriScore.toFixed(1)}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-[var(--r-text-faint)] italic">{t("geneAwaitingEval")}</span>
                      )}
                    </div>
                  </div>

                  {/* Stats row */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-2.5 border-t border-[var(--r-border)]/50 text-xs">
                    <span className="text-[var(--r-text-faint)]">
                      {t("geneTradesEvaluated")}:{" "}
                      <span className="font-mono text-[var(--r-text)]">{champion.tradesEvaluated}</span>
                    </span>
                    <span className="text-[var(--r-text-faint)] flex items-center gap-1.5">
                      {t("geneWinRate")}:
                      <WinRateBar wins={champion.winCount} total={champion.tradesEvaluated} />
                    </span>
                    <span className={`ml-auto font-mono font-semibold ${champion.totalPnl > 0 ? "text-[var(--r-green)]" : champion.totalPnl < 0 ? "text-[var(--r-red)]" : ""}`}>
                      {pnlStr(champion.totalPnl)}
                    </span>
                  </div>
                </div>
              )}

              {/* ── Other active variants (competing, not yet champion) ──── */}
              {otherActive.length > 0 && (
                <div className="px-4 mb-2">
                  <VariantSection
                    variants={otherActive}
                    t={t}
                    locale={locale}
                    expandedDesc={expandedDesc}
                    onToggleDesc={handleToggleDesc}
                    showHeader={true}
                  />
                </div>
              )}

              {/* ── Fallback: no activeConfig entry, show all active ──────── */}
              {!champion && otherActive.length === 0 && gv.filter(v => v.status === "active").length > 0 && (
                <div className="px-4 mb-2">
                  <VariantSection
                    variants={gv.filter(v => v.status === "active")}
                    t={t}
                    locale={locale}
                    expandedDesc={expandedDesc}
                    onToggleDesc={handleToggleDesc}
                    showHeader
                  />
                </div>
              )}

              {/* ── Eliminated / retired variants (collapsible) ───────────── */}
              {eliminated.length > 0 && (
                <div className="px-4 pb-3">
                  <button
                    type="button"
                    onClick={() => setShowEliminated(prev => ({ ...prev, [geneId]: !prev[geneId] }))}
                    className="flex items-center gap-1.5 text-[10px] text-[var(--r-text-faint)] hover:text-[var(--r-text-muted)] transition-colors py-1 outline-none"
                  >
                    {showingElim ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    {showingElim
                      ? t("geneHideEliminated")
                      : `${t("geneShowEliminated")} (${eliminated.length})`}
                  </button>
                  {showingElim && (
                    <div className="mt-1 opacity-60">
                      <VariantSection
                        variants={eliminated}
                        t={t}
                        locale={locale}
                        expandedDesc={expandedDesc}
                        onToggleDesc={handleToggleDesc}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Evolution Log ─────────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-medium text-[var(--r-text-muted)] uppercase tracking-widest">
            {t("geneEvolutionLog")}
          </h3>
          {/* Filter chips */}
          <div className="flex gap-1 flex-wrap justify-end">
            {(["all", "promotions", "eliminations", "epoch"] as const).map(key => (
              <button
                key={key}
                type="button"
                onClick={() => setLogFilter(key)}
                className={`text-[10px] px-2 py-0.5 rounded-full transition-colors outline-none border ${
                  logFilter === key
                    ? "bg-[var(--r-accent)]/15 text-[var(--r-accent)] border-[var(--r-accent)]/30"
                    : "text-[var(--r-text-faint)] hover:text-[var(--r-text-muted)] border-transparent"
                }`}
              >
                {LOG_FILTER_KEYS[key] ? t(LOG_FILTER_KEYS[key]) : key}
              </button>
            ))}
          </div>
        </div>

        {filteredLog.length === 0 ? (
          <div className="glass-card p-4 text-center text-[var(--r-text-faint)] text-xs">
            {t("geneLogEmpty")}
          </div>
        ) : (
          <div className="space-y-1">
            {filteredLog.map(entry => {
              const Icon          = ACTION_ICONS[entry.action] ?? Activity;
              const label         = ACTION_KEYS[entry.action] ? t(ACTION_KEYS[entry.action]) : entry.action;
              const isPromotion   = entry.action === "variant_promoted";
              const isElimination = entry.action === "variant_eliminated";
              const geneName      = locale === "zh" && registryMap.get(entry.geneId)?.name
                ? registryMap.get(entry.geneId)!.name
                : entry.geneId.replace("polymarket-", "");

              return (
                <div key={entry.id} className="glass-card px-3 py-2 flex items-center gap-3">
                  <Icon
                    className={`w-3.5 h-3.5 shrink-0 ${
                      isPromotion   ? "text-[var(--r-green)]" :
                      isElimination ? "text-[var(--r-red)]" :
                      "text-[var(--r-accent)]"
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                      <span className={`font-medium ${isPromotion ? "text-[var(--r-green)]" : isElimination ? "text-[var(--r-red)]" : ""}`}>
                        {label}
                      </span>
                      {entry.geneId !== "*" && (
                        <span className="text-[var(--r-text-faint)]">{geneName}</span>
                      )}
                      {entry.petriScore !== null && (
                        <span className="text-[var(--r-text-faint)] font-mono">
                          {t("geneScoreLabel")}: {entry.petriScore.toFixed(1)}
                        </span>
                      )}
                    </div>
                    {entry.variantId && (
                      <p className="text-[10px] text-[var(--r-text-faint)] font-mono truncate">
                        {entry.variantId.replace(/^[^:]+:/, "")}
                      </p>
                    )}
                  </div>
                  <span className="text-[10px] text-[var(--r-text-faint)] shrink-0">
                    {t("geneEpoch")} {entry.epoch}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
