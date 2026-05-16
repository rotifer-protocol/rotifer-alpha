/**
 * ArenaPage — F(g) competitive standings and race chart.
 *
 * Shows current fitness rankings per tier (S/M/L) plus the F(g) race chart
 * so users can see who is winning, who is at risk of mutation, and how the
 * competition has evolved across epochs.
 *
 * Data source: GET /api/evolution (same as EvolutionPanel)
 */

import { useState, useMemo } from "react";
import { Trophy, AlertTriangle, TrendingUp } from "lucide-react";
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

// ─── Data types (mirrors EvolutionPanel) ────────────────────────────────────

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
  /** Δ vs previous epoch's fitness_after. null = first epoch or no prior data. */
  delta: number | null;
}

// ─── Fitness zone color ───────────────────────────────────────────────────────

/**
 * Returns a semantic color based on absolute F(g) value:
 *   <0.2  → red (danger / mutation candidate)
 *   <0.4  → orange (warning)
 *   <0.6  → yellow (fair)
 *   ≥0.6  → teal accent (good)
 */
function fitnessZoneColor(fitness: number): string {
  if (fitness < 0.2) return "#ef4444";
  if (fitness < 0.4) return "#f97316";
  if (fitness < 0.6) return "#eab308";
  return "var(--r-accent)";
}

// ─── Latest fitness with delta ───────────────────────────────────────────────

function computeLatestFitness(
  logs: EvolutionLog[],
  allFundIds: string[],
): FundFitnessEntry[] {
  // Per-fund map: epoch → best fitness value (prefer fitness_after over fitness_before)
  const perFund: Record<string, Map<number, number>> = {};

  for (const log of logs) {
    const fit =
      log.fitness_after !== null ? log.fitness_after
      : log.fitness_before !== null ? log.fitness_before
      : null;
    if (fit === null) continue;
    if (!perFund[log.fund_id]) perFund[log.fund_id] = new Map();
    const existing = perFund[log.fund_id].get(log.epoch);
    // Only overwrite with fitness_before if there's no entry yet
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

// ─── Tier labels ──────────────────────────────────────────────────────────────

const TIER_LABELS: Record<FundTier, { key: "arenaTierS" | "arenaTierM" | "arenaTierL"; badge: "S" | "M" | "L" }> = {
  small:  { key: "arenaTierS", badge: "S" },
  medium: { key: "arenaTierM", badge: "M" },
  large:  { key: "arenaTierL", badge: "L" },
};

const TIER_ORDER: FundTier[] = ["small", "medium", "large"];

// ─── Medal rendering ─────────────────────────────────────────────────────────

const MEDALS = ["🥇", "🥈", "🥉"];

function medalFor(rank: number): string | null {
  return MEDALS[rank] ?? null;
}

// ─── Standings row ────────────────────────────────────────────────────────────

function StandingsRow({
  rank,
  entry,
  tierSize,
  t,
}: {
  rank: number;
  entry: FundFitnessEntry;
  tierSize: number;
  t: (k: string) => string;
}) {
  const color = FUND_HEX_COLORS[entry.fundId] ?? "#6b7280";
  const isChampion = rank === 0;
  const isLast = rank === tierSize - 1;
  const fitnessValid = entry.fitness !== null && entry.fitness >= 0;
  const fitness = entry.fitness ?? 0;
  const { delta } = entry;

  // Semantic color derived from zone (P0-1)
  const zoneColor = fitnessValid ? fitnessZoneColor(fitness) : "#52525b";
  const barWidth = fitnessValid ? Math.min(100, fitness * 100) : 0;

  // How deep is this fund in the danger zone (0..1, positive only when fitness < 0.2) (P0-3)
  const dangerLevel = fitnessValid && fitness < 0.2 ? (1 - fitness / 0.2) : 0;

  const medal = medalFor(rank);
  const name = fundDisplayName(entry.fundId, t as any);

  // Delta labels (P0-2)
  const deltaArrow =
    delta === null ? null
    : delta > 0.001 ? "↑"
    : delta < -0.001 ? "↓"
    : null;
  const deltaStr =
    delta === null || Math.abs(delta) < 0.001 ? null
    : (delta > 0 ? "+" : "") + delta.toFixed(3);
  const deltaColor =
    delta !== null && delta > 0.001 ? "#22c55e"
    : delta !== null && delta < -0.001 ? "#ef4444"
    : "#52525b";

  return (
    <div
      className={`relative flex items-center gap-3 py-2.5 px-3 rounded-xl transition-all overflow-hidden ${
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
    >
      {/* P0-4 Champion: left fund-color accent strip */}
      {isChampion && (
        <span
          className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full"
          style={{ background: color }}
        />
      )}

      {/* Rank badge */}
      <span className="w-7 text-center text-sm shrink-0 pl-1">
        {medal ?? (
          <span className="text-xs text-[var(--r-text-faint)] font-mono">
            #{rank + 1}
          </span>
        )}
      </span>

      {/* Fund color dot + name */}
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
      <span className="flex-1 text-sm font-medium text-[var(--r-text)] truncate min-w-0">
        {name}
      </span>

      {/* P0-1 Semantic fitness bar — always visible (removed hidden sm:flex) */}
      <div className="relative w-16 sm:w-24 h-2 rounded-full bg-[var(--r-border)] shrink-0 overflow-hidden">
        {/* Threshold markers: 0.2 danger line + 0.6 good-zone line */}
        <span
          className="absolute inset-y-0 w-px bg-red-500/50"
          style={{ left: "20%" }}
        />
        <span
          className="absolute inset-y-0 w-px bg-yellow-400/25"
          style={{ left: "60%" }}
        />
        {/* Filled portion */}
        <span
          className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
          style={{ width: `${barWidth}%`, background: zoneColor }}
        />
      </div>

      {/* P0-1 + P0-2 Fitness value (zone-colored) + delta */}
      <div className="flex flex-col items-end shrink-0 w-[52px]">
        <span
          className="font-mono text-xs tabular-nums leading-tight"
          style={{ color: fitnessValid ? zoneColor : "var(--r-text-faint)" }}
        >
          {fitnessValid ? fitness.toFixed(4) : "—"}
        </span>
        {deltaArrow && deltaStr && (
          <span
            className="text-[9px] font-mono tabular-nums leading-tight"
            style={{ color: deltaColor }}
          >
            {deltaArrow}{deltaStr}
          </span>
        )}
      </div>

      {/* Status icon */}
      <span className="w-5 text-center shrink-0">
        {/* P0-4 Champion: Trophy with accent glow */}
        {isChampion && fitnessValid && (
          <Trophy
            className="w-4 h-4 inline text-[var(--r-accent)]"
            style={{ filter: "drop-shadow(0 0 5px var(--r-accent))" }}
            aria-label={t("arenaProtected")}
          />
        )}
        {/* P0-3 Danger: pulse if deep in danger zone */}
        {isLast && fitnessValid && (
          <AlertTriangle
            className={`w-3.5 h-3.5 inline ${
              dangerLevel > 0.3 ? "text-red-400 animate-pulse" : "text-amber-400"
            }`}
            aria-label={t("arenaMutationCandidate")}
          />
        )}
      </span>
    </div>
  );
}

// ─── Tier standings card ──────────────────────────────────────────────────────

function TierStandings({
  group,
  allEntries,
  t,
}: {
  group: TierGroup;
  allEntries: FundFitnessEntry[];
  t: (k: string) => string;
}) {
  const cfg = TIER_LABELS[group.tier];

  // Sort by fitness desc; null fitness goes to the bottom
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

  return (
    <div className="glass-card p-4">
      {/* Tier header */}
      <div className="flex items-center gap-2 mb-4">
        <span
          className="px-2 py-0.5 rounded-full text-xs font-bold border"
          style={{
            color: "#a1a1aa",
            borderColor: "#3f3f46",
            background: "#1c1c1f",
          }}
        >
          {cfg.badge}
        </span>
        <span className="text-sm font-medium text-[var(--r-text)]">
          {t(cfg.key)}
        </span>
        {/* P0-4 Champion fitness in header uses semantic zone color */}
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

      {/* Ranked list */}
      <div className="space-y-0.5">
        {sorted.map((entry, rank) => (
          <StandingsRow
            key={entry.fundId}
            rank={rank}
            entry={entry}
            tierSize={sorted.length}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Epoch progress strip ─────────────────────────────────────────────────────

function EpochProgressStrip({
  progress,
  latestEpoch,
  t,
}: {
  progress: EpochProgress | undefined;
  latestEpoch: number | null;
  t: (k: string) => string;
}) {
  if (!progress) return null;

  const pct = Math.min(
    100,
    Math.round((progress.tradesThisEpoch / Math.max(1, progress.tradesTarget)) * 100),
  );

  return (
    <div className="glass-card p-4 flex flex-col sm:flex-row sm:items-center gap-3">
      <div className="flex items-center gap-2 shrink-0">
        <TrendingUp className="w-3.5 h-3.5 text-[var(--r-accent)]" />
        <span className="text-xs font-medium text-[var(--r-text-muted)]">
          {t("arenaEpochProgress")}
        </span>
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
          {progress.tradesThisEpoch}/{progress.tradesTarget}
        </span>
      </div>
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function ArenaPageContent() {
  const { t } = useI18n();
  const { data, loading, error } = useFetch<EvolutionResponse>("/api/evolution", 120_000);

  // Tier filter: null = show all tiers
  const [selectedTier, setSelectedTier] = useState<FundTier | null>(null);

  const logs = data?.logs ?? [];
  const lineage = data?.lineage ?? [];
  const allFundIds = lineage.map(l => l.id);
  // Exclude epoch=-1 (MICRO_EVOLUTION) — only show real PBT epoch number.
  const latestEpoch = useMemo(() => {
    const real = (data?.epochs ?? []).filter(e => e.epoch > 0);
    return real.length > 0 ? Math.max(...real.map(e => e.epoch)) : null;
  }, [data?.epochs]);

  // Compute latest F(g) + delta per fund
  const fitnessEntries = useMemo(
    () => computeLatestFitness(logs, allFundIds),
    [logs, allFundIds],
  );

  // Group by tier
  const tierGroups: TierGroup[] = useMemo(
    () => groupByTier(allFundIds),
    [allFundIds],
  );

  // Filtered tier groups for display
  const visibleGroups = selectedTier
    ? tierGroups.filter(g => g.tier === selectedTier)
    : tierGroups;

  // Filtered logs for the race chart
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
      {/* Epoch progress */}
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

      {/* Current standings: one card per visible tier */}
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
            />
          ))}
        </div>
      </div>

      {/* F(g) race chart */}
      {filteredLogs.length > 0 && (
        <div>
          <h2 className="text-xs font-medium uppercase tracking-widest text-[var(--r-text-faint)] mb-3">
            {t("arenaRaceChart")}
          </h2>
          <FitnessChart
            logs={filteredLogs}
            allFundIds={filteredFundIds}
          />
        </div>
      )}
    </div>
  );
}
