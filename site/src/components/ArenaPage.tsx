/**
 * ArenaPage — F(g) competitive standings and race chart.
 *
 * Shows current fitness rankings per tier (S/M/L) plus the F(g) race chart
 * so users can see who is winning, who is at risk of mutation, and how the
 * competition has evolved across epochs.
 *
 * Data source: GET /api/evolution (same as EvolutionPanel)
 *
 * P0: semantic bar + delta + danger row + champion glow
 * P1: hover↔chart linkage + tier colors + hero KPI + mobile collapse
 */

import { useState, useMemo, useEffect } from "react";
import { Trophy, AlertTriangle, TrendingUp, CheckCircle2, Clock, Zap } from "lucide-react";
import { useI18n } from "../i18n/context";
import { useFetch } from "../hooks/useApi";
import {
  FUND_HEX_COLORS,
  fundDisplayName,
  groupByTier,
  type FundTier,
  type TierGroup,
} from "../lib/fundMeta";
import { FitnessChart } from "./FitnessChart";

// ─── Data types ───────────────────────────────────────────────────────────────

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

interface EpochProgress {
  tradesThisEpoch: number;
  tradesTarget: number;
  minEpochDays: number;
  maxEpochDays: number;
  lastEpochAt: string | null;
}

interface EvolutionResponse {
  logs: EvolutionLog[];
  epochs: EpochSummary[];
  lineage: FundLineage[];
  epochProgress?: EpochProgress;
}

// ─── Latest fitness per fund ─────────────────────────────────────────────────

interface FundFitnessEntry {
  fundId: string;
  fitness: number | null;
  latestEpoch: number | null;
  /** Δ vs previous epoch's fitness. null = first epoch or no prior data. */
  delta: number | null;
}

// ─── Tier color identity (P1-2) ───────────────────────────────────────────────

const TIER_COLORS: Record<FundTier, string> = {
  small:  "#60a5fa",       // blue
  medium: "var(--r-accent)", // teal
  large:  "#f59e0b",       // amber
};

// ─── Fitness zone color (P0-1) ────────────────────────────────────────────────

function fitnessZoneColor(fitness: number): string {
  if (fitness < 0.2) return "#ef4444";
  if (fitness < 0.4) return "#f97316";
  if (fitness < 0.6) return "#eab308";
  return "var(--r-accent)";
}

// ─── Latest fitness + delta ───────────────────────────────────────────────────

function computeLatestFitness(
  logs: EvolutionLog[],
  allFundIds: string[],
): FundFitnessEntry[] {
  const perFund: Record<string, Map<number, number>> = {};

  for (const log of logs) {
    const fit =
      log.fitness_after !== null ? log.fitness_after
      : log.fitness_before !== null ? log.fitness_before
      : null;
    if (fit === null) continue;
    if (!perFund[log.fund_id]) perFund[log.fund_id] = new Map();
    const existing = perFund[log.fund_id].get(log.epoch);
    if (existing === undefined || log.fitness_after !== null) {
      perFund[log.fund_id].set(log.epoch, fit);
    }
  }

  return allFundIds.map(fundId => {
    const epochEntries = perFund[fundId]
      ? [...perFund[fundId].entries()].sort((a, b) => b[0] - a[0])
      : [];
    const [latest, prev] = epochEntries;
    return {
      fundId,
      fitness: latest?.[1] ?? null,
      latestEpoch: latest?.[0] ?? null,
      delta:
        latest !== undefined && prev !== undefined
          ? latest[1] - prev[1]
          : null,
    };
  });
}

// ─── Tier config ──────────────────────────────────────────────────────────────

const TIER_LABELS: Record<FundTier, { key: "arenaTierS" | "arenaTierM" | "arenaTierL"; badge: "S" | "M" | "L" }> = {
  small:  { key: "arenaTierS", badge: "S" },
  medium: { key: "arenaTierM", badge: "M" },
  large:  { key: "arenaTierL", badge: "L" },
};

const TIER_ORDER: FundTier[] = ["small", "medium", "large"];
const MEDALS = ["🥇", "🥈", "🥉"];

function medalFor(rank: number): string | null {
  return MEDALS[rank] ?? null;
}

// ─── P1-3: Hero KPI strip ─────────────────────────────────────────────────────

function ArenaHeroKpi({
  fitnessEntries,
  epochProgress,
  t,
}: {
  fitnessEntries: FundFitnessEntry[];
  epochProgress: EpochProgress | undefined;
  t: (k: string) => string;
}) {
  const valid = fitnessEntries.filter(e => e.fitness !== null);
  if (valid.length === 0) return null;

  const leader  = valid.reduce((b, e) => (e.fitness ?? 0) > (b.fitness ?? 0) ? e : b);
  const weakest = valid.reduce((w, e) => (e.fitness ?? 1) < (w.fitness ?? 1) ? e : w);
  const avg = valid.reduce((s, e) => s + (e.fitness ?? 0), 0) / valid.length;

  const deltaEntries = valid.filter(e => e.delta !== null);
  const avgDelta = deltaEntries.length > 0
    ? deltaEntries.reduce((s, e) => s + (e.delta ?? 0), 0) / deltaEntries.length
    : null;

  const pct = epochProgress
    ? Math.min(100, Math.round((epochProgress.tradesThisEpoch / Math.max(1, epochProgress.tradesTarget)) * 100))
    : null;

  const leaderColor  = fitnessZoneColor(leader.fitness!);
  const weakestColor = fitnessZoneColor(weakest.fitness!);
  const avgColor     = fitnessZoneColor(avg);

  const KpiCell = ({
    label, primary, secondary, primaryColor, warn,
  }: {
    label: string;
    primary: string;
    secondary?: string;
    primaryColor?: string;
    warn?: boolean;
  }) => (
    <div className={`glass-card p-3 ${warn ? "border-red-500/20" : ""}`}>
      <p className="text-[10px] text-[var(--r-text-faint)] uppercase tracking-wider mb-1.5">
        {label}
      </p>
      <p
        className="text-sm font-semibold truncate leading-tight"
        style={{ color: primaryColor ?? "var(--r-text)" }}
      >
        {primary}
      </p>
      {secondary && (
        <p className="text-[11px] text-[var(--r-text-faint)] font-mono mt-0.5">{secondary}</p>
      )}
    </div>
  );

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <KpiCell
        label={t("arenaHeroLeader")}
        primary={fundDisplayName(leader.fundId, t as any)}
        secondary={leader.fitness!.toFixed(4)}
        primaryColor={leaderColor}
      />
      <KpiCell
        label={t("arenaHeroAvg")}
        primary={`${avg.toFixed(4)}${
          avgDelta !== null
            ? (avgDelta > 0.001 ? "  ↑" : avgDelta < -0.001 ? "  ↓" : "  →")
            : ""
        }`}
        primaryColor={avgColor}
      />
      <KpiCell
        label={t("arenaHeroWeakest")}
        primary={fundDisplayName(weakest.fundId, t as any)}
        secondary={weakest.fitness!.toFixed(4)}
        primaryColor={weakestColor}
        warn={weakest.fitness! < 0.2}
      />
      <KpiCell
        label={t("arenaHeroEpochPct")}
        primary={pct !== null ? `${pct}%` : "—"}
        secondary={epochProgress ? `${epochProgress.tradesThisEpoch} / ${epochProgress.tradesTarget}` : undefined}
        primaryColor="var(--r-accent)"
      />
    </div>
  );
}

// ─── P0 + P1-1: Standings row ─────────────────────────────────────────────────

function StandingsRow({
  rank,
  entry,
  tierSize,
  t,
  onHover,
}: {
  rank: number;
  entry: FundFitnessEntry;
  tierSize: number;
  t: (k: string) => string;
  onHover?: (id: string | null) => void;
}) {
  const color = FUND_HEX_COLORS[entry.fundId] ?? "#6b7280";
  const isChampion = rank === 0;
  const isLast = rank === tierSize - 1;
  const fitnessValid = entry.fitness !== null && entry.fitness >= 0;
  const fitness = entry.fitness ?? 0;
  const { delta } = entry;

  const zoneColor  = fitnessValid ? fitnessZoneColor(fitness) : "#52525b";
  const barWidth   = fitnessValid ? Math.min(100, fitness * 100) : 0;
  const dangerLevel = fitnessValid && fitness < 0.2 ? (1 - fitness / 0.2) : 0;

  const medal = medalFor(rank);
  const name  = fundDisplayName(entry.fundId, t as any);

  const deltaArrow = delta === null ? null : delta > 0.001 ? "↑" : delta < -0.001 ? "↓" : null;
  const deltaStr   = delta === null || Math.abs(delta) < 0.001 ? null
    : (delta > 0 ? "+" : "") + delta.toFixed(3);
  const deltaColor = delta !== null && delta > 0.001 ? "#22c55e"
    : delta !== null && delta < -0.001 ? "#ef4444"
    : "#52525b";

  return (
    <div
      className={`relative flex items-center gap-3 py-2.5 px-3 rounded-xl transition-all overflow-hidden cursor-default ${
        isChampion
          ? "bg-[var(--r-accent)]/10 border border-[var(--r-accent)]/20"
          : isLast && dangerLevel > 0
          ? "border border-red-500/25"
          : isLast
          ? "bg-amber-500/5 border border-amber-500/15"
          : "hover:bg-[var(--r-surface-2)]"
      }`}
      style={
        dangerLevel > 0
          ? { background: `rgba(239,68,68,${(dangerLevel * 0.10).toFixed(3)})` }
          : undefined
      }
      onMouseEnter={() => onHover?.(entry.fundId)}
      onMouseLeave={() => onHover?.(null)}
    >
      {/* Champion left color accent strip */}
      {isChampion && (
        <span
          className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full"
          style={{ background: color }}
        />
      )}

      {/* Rank */}
      <span className="w-7 text-center text-sm shrink-0 pl-1">
        {medal ?? <span className="text-xs text-[var(--r-text-faint)] font-mono">#{rank + 1}</span>}
      </span>

      {/* Color dot + name */}
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
      <span className="flex-1 text-sm font-medium text-[var(--r-text)] truncate min-w-0">{name}</span>

      {/* Semantic bar — always visible, with threshold markers */}
      <div className="relative w-16 sm:w-24 h-2 rounded-full bg-[var(--r-border)] shrink-0 overflow-hidden">
        <span className="absolute inset-y-0 w-px bg-red-500/50"    style={{ left: "20%" }} />
        <span className="absolute inset-y-0 w-px bg-yellow-400/25" style={{ left: "60%" }} />
        <span
          className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
          style={{ width: `${barWidth}%`, background: zoneColor }}
        />
      </div>

      {/* Fitness value + delta */}
      <div className="flex flex-col items-end shrink-0 w-[52px]">
        <span
          className="font-mono text-xs tabular-nums leading-tight"
          style={{ color: fitnessValid ? zoneColor : "var(--r-text-faint)" }}
        >
          {fitnessValid ? fitness.toFixed(4) : "—"}
        </span>
        {deltaArrow && deltaStr && (
          <span className="text-[9px] font-mono tabular-nums leading-tight" style={{ color: deltaColor }}>
            {deltaArrow}{deltaStr}
          </span>
        )}
      </div>

      {/* Status icon */}
      <span className="w-5 text-center shrink-0">
        {isChampion && fitnessValid && (
          <Trophy
            className="w-4 h-4 inline text-[var(--r-accent)]"
            style={{ filter: "drop-shadow(0 0 5px var(--r-accent))" }}
            aria-label={t("arenaProtected")}
          />
        )}
        {isLast && fitnessValid && (
          <AlertTriangle
            className={`w-3.5 h-3.5 inline ${dangerLevel > 0.3 ? "text-red-400 animate-pulse" : "text-amber-400"}`}
            aria-label={t("arenaMutationCandidate")}
          />
        )}
      </span>
    </div>
  );
}

// ─── P0 + P1-1 + P1-2 + P1-4: Tier standings card ────────────────────────────

const MOBILE_COLLAPSE = 3;

function TierStandings({
  group,
  allEntries,
  t,
  onHoverFund,
}: {
  group: TierGroup;
  allEntries: FundFitnessEntry[];
  t: (k: string) => string;
  onHoverFund?: (id: string | null) => void;
}) {
  const cfg = TIER_LABELS[group.tier];
  const tierColor = TIER_COLORS[group.tier];

  const [isCollapsed, setIsCollapsed] = useState(true);

  const sorted = group.funds
    .map(
      fid =>
        allEntries.find(e => e.fundId === fid) ?? {
          fundId: fid,
          fitness: null,
          latestEpoch: null,
          delta: null,
        },
    )
    .sort((a, b) => {
      if (a.fitness === null && b.fitness === null) return 0;
      if (a.fitness === null) return 1;
      if (b.fitness === null) return -1;
      return b.fitness - a.fitness;
    });

  const champion = sorted[0];
  const championFitness = champion?.fitness;
  const hasMore = sorted.length > MOBILE_COLLAPSE;

  return (
    <div className="glass-card p-4">
      {/* Tier header with P1-2 tier color */}
      <div className="flex items-center gap-2 mb-4">
        <span
          className="px-2 py-0.5 rounded-full text-[11px] font-bold border"
          style={{
            color: tierColor,
            borderColor: `${tierColor}50`,
            background: `${tierColor}15`,
          }}
        >
          {cfg.badge}
        </span>
        <span className="text-sm font-medium text-[var(--r-text)]">
          {t(cfg.key)}
        </span>
        {championFitness !== null && championFitness !== undefined && (
          <span className="ml-auto text-[10px] text-[var(--r-text-faint)]">
            <span
              className="font-mono tabular-nums"
              style={{ color: fitnessZoneColor(championFitness) }}
            >
              {championFitness.toFixed(4)}
            </span>{" "}
            {t("arenaChampion")}
          </span>
        )}
      </div>

      {/* Ranked list with P1-4 mobile collapse */}
      <div className="space-y-0.5">
        {sorted.map((entry, rank) => (
          <div
            key={entry.fundId}
            className={rank >= MOBILE_COLLAPSE && isCollapsed ? "lg:block hidden" : ""}
          >
            <StandingsRow
              rank={rank}
              entry={entry}
              tierSize={sorted.length}
              t={t}
              onHover={onHoverFund}
            />
          </div>
        ))}
      </div>

      {/* P1-4: Expand / collapse toggle — hidden on desktop (lg:hidden) */}
      {hasMore && (
        <button
          className="lg:hidden w-full text-center text-[10px] text-[var(--r-text-faint)] hover:text-[var(--r-accent)] py-1.5 mt-1.5 transition-colors"
          onClick={() => setIsCollapsed(v => !v)}
        >
          {isCollapsed
            ? `▾ 展开全部（共 ${sorted.length} 位）`
            : "▴ 收起"}
        </button>
      )}
    </div>
  );
}

// ─── Epoch progress strip — 3-phase state machine ────────────────────────────
//
//  Phase 1 TRADES:    tradesThisEpoch < tradesTarget
//                     → trade progress bar  X / 60
//  Phase 2 TIME_GATE: trades met + daysSince < minEpochDays
//                     → time-gate countdown bar  (ticks every 60s)
//  Phase 3 READY:     both conditions met
//                     → pulsing "触发就绪" + live countdown to next cron tick

/** Returns ms until next midnight UTC (when the evolution cron fires). */
function msToNextMidnightUTC(): number {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return next.getTime() - Date.now();
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "0m";
  const totalMin = Math.ceil(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function EpochProgressStrip({
  progress,
  latestEpoch,
  t,
}: {
  progress: EpochProgress | undefined;
  latestEpoch: number | null;
  t: (k: string) => string;
}) {
  // Live clock — re-render every 60 s so countdowns tick
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  if (!progress) return null;

  const { tradesThisEpoch, tradesTarget, minEpochDays, lastEpochAt } = progress;
  const nowMs      = Date.now();
  const lastEpochMs = lastEpochAt ? new Date(lastEpochAt).getTime() : 0;
  const daysSince  = lastEpochMs > 0 ? (nowMs - lastEpochMs) / 86_400_000 : 99;

  const tradesMet  = tradesThisEpoch >= tradesTarget;
  const timeMet    = daysSince >= minEpochDays;

  // ── Phase 1: trade progress ────────────────────────────────────────────────
  if (!tradesMet) {
    const pct = Math.min(100, Math.round((tradesThisEpoch / Math.max(1, tradesTarget)) * 100));
    return (
      <div className="glass-card p-4 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2 shrink-0">
          <TrendingUp className="w-3.5 h-3.5 text-[var(--r-accent)]" />
          <span className="text-xs font-medium text-[var(--r-text-muted)]">{t("arenaEpochProgress")}</span>
          {latestEpoch !== null && (
            <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-[var(--r-surface-2)] text-[var(--r-text-faint)] border border-[var(--r-border)]">
              {t("arenaEpochBadge")} {latestEpoch}
            </span>
          )}
        </div>
        <div className="flex-1 flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full bg-[var(--r-border)] overflow-hidden">
            <div
              className="h-full rounded-full bg-[var(--r-accent)] transition-all duration-700"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-[10px] font-mono tabular-nums text-[var(--r-text-faint)] shrink-0">
            {tradesThisEpoch}/{tradesTarget}
          </span>
        </div>
      </div>
    );
  }

  // ── Phase 2: time-gate countdown ──────────────────────────────────────────
  if (!timeMet) {
    const gateMs   = minEpochDays * 86_400_000;
    const elapsedMs = nowMs - lastEpochMs;
    const timePct  = Math.min(100, Math.round((elapsedMs / gateMs) * 100));
    const remainMs = Math.max(0, gateMs - elapsedMs);
    return (
      <div className="glass-card p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Clock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span className="text-xs font-medium text-[var(--r-text-muted)]">{t("arenaEpochProgress")}</span>
          {latestEpoch !== null && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[var(--r-surface-2)] text-[var(--r-text-faint)] border border-[var(--r-border)]">
              {t("arenaEpochBadge")} {latestEpoch}
            </span>
          )}
          <span className="flex items-center gap-1 ml-auto text-[11px] text-amber-400 font-medium">
            <CheckCircle2 className="w-3 h-3 text-green-500" />
            <span className="text-green-500">{t("arenaCondTrades")}</span>
            <span className="text-[var(--r-border)] mx-1">·</span>
            <Clock className="w-3 h-3 text-amber-400" />
            <span>{t("arenaCondTime")} {formatCountdown(remainMs)}</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full bg-[var(--r-border)] overflow-hidden">
            <div
              className="h-full rounded-full bg-amber-400 transition-all duration-700"
              style={{ width: `${timePct}%` }}
            />
          </div>
          <span className="text-[10px] font-mono tabular-nums text-[var(--r-text-faint)] shrink-0">
            {daysSince.toFixed(1)}/{minEpochDays}d
          </span>
        </div>
      </div>
    );
  }

  // ── Phase 3: ready — both conditions met, waiting for cron ────────────────
  const cronMs = msToNextMidnightUTC();
  return (
    <div className="glass-card p-4 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex items-center gap-2 shrink-0">
        <Zap className="w-3.5 h-3.5 text-green-400 animate-pulse" />
        <span className="text-xs font-semibold text-green-400">{t("arenaEpochReady")}</span>
        {latestEpoch !== null && (
          <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-[var(--r-surface-2)] text-[var(--r-text-faint)] border border-[var(--r-border)]">
            {t("arenaEpochBadge")} {latestEpoch} → {latestEpoch + 1}
          </span>
        )}
      </div>
      <div className="flex-1 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 text-[11px]">
          <CheckCircle2 className="w-3 h-3 text-green-500" />
          <span className="text-green-500">{t("arenaCondTrades")}</span>
        </div>
        <div className="flex items-center gap-1 text-[11px]">
          <CheckCircle2 className="w-3 h-3 text-green-500" />
          <span className="text-green-500">{t("arenaCondTimeOk")}</span>
        </div>
        <span className="ml-auto text-[11px] text-[var(--r-text-faint)]">
          {t("arenaNextCron")} <span className="font-mono tabular-nums text-[var(--r-text-muted)]">{formatCountdown(cronMs)}</span>
        </span>
      </div>
      {/* Full pulsing progress bar */}
      <div className="w-full sm:hidden h-1.5 rounded-full overflow-hidden bg-green-500/20">
        <div className="h-full w-full rounded-full bg-green-500 animate-pulse" />
      </div>
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function ArenaPageContent() {
  const { t } = useI18n();
  const { data, loading, error } = useFetch<EvolutionResponse>("/api/evolution", 120_000);

  const [selectedTier, setSelectedTier] = useState<FundTier | null>(null);
  // P1-1: hover state shared between standings and chart
  const [hoveredFundId, setHoveredFundId] = useState<string | null>(null);

  const logs      = data?.logs ?? [];
  const lineage   = data?.lineage ?? [];
  const allFundIds = lineage.map(l => l.id);
  const latestEpoch = data?.epochs?.length
    ? Math.max(...data.epochs.map(e => e.epoch))
    : null;

  const fitnessEntries = useMemo(
    () => computeLatestFitness(logs, allFundIds),
    [logs, allFundIds],
  );

  const tierGroups: TierGroup[] = useMemo(
    () => groupByTier(allFundIds),
    [allFundIds],
  );

  const visibleGroups = selectedTier
    ? tierGroups.filter(g => g.tier === selectedTier)
    : tierGroups;

  const filteredLogs = useMemo(() => {
    if (!selectedTier) return logs;
    const ids = tierGroups.find(g => g.tier === selectedTier)?.funds ?? [];
    return logs.filter(l => ids.includes(l.fund_id));
  }, [logs, tierGroups, selectedTier]);

  const filteredFundIds = selectedTier
    ? (tierGroups.find(g => g.tier === selectedTier)?.funds ?? [])
    : allFundIds;

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        {[0, 1, 2].map(i => (
          <div key={i} className="h-56 rounded-2xl bg-[var(--r-surface-2)]" />
        ))}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="glass-card p-8 text-center text-[var(--r-text-muted)]">
        {t("arenaNoData")}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* P1-3: Hero KPI strip */}
      <ArenaHeroKpi
        fitnessEntries={fitnessEntries}
        epochProgress={data.epochProgress}
        t={t as any}
      />

      {/* Epoch progress (kept as secondary info below hero) */}
      <EpochProgressStrip
        progress={data.epochProgress}
        latestEpoch={latestEpoch}
        t={t as any}
      />

      {/* Tier filter tabs */}
      <div className="flex items-center gap-1 bg-[var(--r-surface)] border border-[var(--r-border)] rounded-xl p-1 w-fit">
        <button
          onClick={() => setSelectedTier(null)}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
            selectedTier === null
              ? "bg-[var(--r-accent)] text-[var(--r-bg)] shadow-sm"
              : "text-[var(--r-text-muted)] hover:text-[var(--r-text)]"
          }`}
        >
          {t("arenaTierAll")}
        </button>
        {TIER_ORDER.map(tier => {
          const cfg = TIER_LABELS[tier];
          return (
            <button
              key={tier}
              onClick={() => setSelectedTier(tier)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                selectedTier === tier
                  ? "bg-[var(--r-accent)] text-[var(--r-bg)] shadow-sm"
                  : "text-[var(--r-text-muted)] hover:text-[var(--r-text)]"
              }`}
            >
              {cfg.badge}
            </button>
          );
        })}
      </div>

      {/* Current standings */}
      <div>
        <h2 className="text-xs font-medium uppercase tracking-widest text-[var(--r-text-faint)] mb-3">
          {t("arenaCurrentStandings")}
        </h2>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {visibleGroups.map(group => (
            <TierStandings
              key={group.tier}
              group={group}
              allEntries={fitnessEntries}
              t={t as any}
              onHoverFund={setHoveredFundId}
            />
          ))}
        </div>
      </div>

      {/* P1-1: F(g) race chart receives external hover for linkage */}
      {filteredLogs.length > 0 && (
        <div>
          <h2 className="text-xs font-medium uppercase tracking-widest text-[var(--r-text-faint)] mb-3">
            {t("arenaRaceChart")}
          </h2>
          <FitnessChart
            logs={filteredLogs}
            allFundIds={filteredFundIds}
            externalHoveredId={hoveredFundId}
          />
        </div>
      )}
    </div>
  );
}
