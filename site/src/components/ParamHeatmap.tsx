import { useState, useEffect } from "react";
import { useI18n } from "../i18n/context";
import type { TranslationKey } from "../i18n/translations";
import { fundDisplayName, fundPersonality, FUND_HEX_COLORS } from "../lib/fundMeta";
import { InfoPopover } from "./InfoPopover";

interface EvolutionLog {
  epoch: number;
  fund_id: string;
  params_before: string;
  params_after: string;
  action: string;
}

interface Props {
  logs: EvolutionLog[];
  selectedFund: string | null;
  allFundIds?: string[];
  activeEpoch?: number | null;
}

// ─── Param metadata ──────────────────────────────────────────────────────────
const PARAM_I18N: Record<string, TranslationKey> = {
  minEdge:               "paramMinEdge",
  minConfidence:         "paramMinConfidence",
  minVolume:             "paramMinVolume",
  minLiquidity:          "paramMinLiquidity",
  probReversalThreshold: "probReversalLabel",
  maxPerEvent:           "paramMaxPerEvent",
  drawdownLimit:         "paramDrawdownLimit",
  stopLossPercent:       "paramStopLoss",
  takeProfitPercent:     "takeProfitLabel",
  trailingStopPercent:   "trailingStopLabel",
  monthlyTarget:         "paramMonthlyTarget",
  maxOpenPositions:      "paramMaxPositions",
  maxHoldDays:           "paramMaxHold",
  sizingBase:            "paramSizingBase",
  sizingScale:           "paramSizingScale",
};

// Semantic groups — order determines row order within groups
const PARAM_GROUPS: { labelKey: TranslationKey; params: string[] }[] = [
  {
    labelKey: "heatmapGroupSignal",
    params: ["minEdge", "minConfidence", "minVolume", "minLiquidity", "probReversalThreshold"],
  },
  {
    labelKey: "heatmapGroupRisk",
    params: ["maxPerEvent", "drawdownLimit", "stopLossPercent", "takeProfitPercent", "trailingStopPercent", "monthlyTarget"],
  },
  {
    labelKey: "heatmapGroupPosition",
    params: ["maxOpenPositions", "maxHoldDays", "sizingBase", "sizingScale"],
  },
];

const PARAM_KEYS = PARAM_GROUPS.flatMap(g => g.params);

// ─── Color helpers ────────────────────────────────────────────────────────────
function intensityColor(pctChange: number): string {
  if (pctChange === 0) return "rgba(39, 39, 42, 0.5)";
  const abs = Math.min(Math.abs(pctChange), 50);
  const intensity = abs / 50;
  if (pctChange > 0) return `rgba(34, 197, 94, ${0.15 + intensity * 0.55})`;
  return `rgba(239, 68, 68, ${0.15 + intensity * 0.55})`;
}

// ─── Main component ───────────────────────────────────────────────────────────
export function ParamHeatmap({ logs, selectedFund, allFundIds, activeEpoch }: Props) {
  const { t } = useI18n();

  const fundIdsFromLogs = [...new Set(logs.map(l => l.fund_id))];
  const fundIds = allFundIds && allFundIds.length > 0 ? allFundIds : fundIdsFromLogs;

  const [activeFund, setActiveFund] = useState<string | null>(selectedFund);

  // Sync when parent updates selectedFund (P2-② linkage from LineageTree)
  useEffect(() => {
    if (selectedFund != null) setActiveFund(selectedFund);
  }, [selectedFund]);

  const targetFund = activeFund || fundIdsFromLogs[0] || fundIds[0];
  const epochs = [...new Set(logs.map(l => l.epoch))].sort((a, b) => a - b);

  if (epochs.length === 0 || !targetFund) {
    return (
      <div className="glass-card p-6 text-center text-sm text-[var(--r-text-muted)]">
        {t("heatmapEmpty")}
      </div>
    );
  }

  // ── Grid data (with absolute before/after) ──────────────────────────────────
  const fundLogs = logs.filter(l => l.fund_id === targetFund && l.action !== "UNCHANGED");
  const grid: Array<{
    param: string;
    epoch: number;
    pctChange: number;
    before: number | null;
    after: number | null;
  }> = [];

  for (const log of fundLogs) {
    let before: Record<string, number> = {};
    let after: Record<string, number> = {};
    try { before = JSON.parse(log.params_before); } catch { continue; }
    try { after = JSON.parse(log.params_after); } catch { continue; }

    for (const param of PARAM_KEYS) {
      const bv = before[param] ?? null;
      const av = after[param] ?? null;
      if (bv === null && av === null) continue;
      const pctChange = bv && bv !== 0 ? ((av ?? bv) - bv) / bv * 100 : 0;
      grid.push({ param, epoch: log.epoch, pctChange, before: bv, after: av });
    }
  }

  // ── Active params per group, sorted by Σ|Δ%| descending ───────────────────
  const sumAbs = (param: string) =>
    grid.filter(g => g.param === param).reduce((s, g) => s + Math.abs(g.pctChange), 0);

  const activeParamsSet = new Set(grid.map(g => g.param));

  // ── Adaptive cell sizing ───────────────────────────────────────────────────
  const epochCount = epochs.length;
  const cellW = epochCount <= 6 ? 44 : epochCount <= 12 ? 30 : 18;
  const showNum = epochCount <= 12;

  // ── Activity bar scale ─────────────────────────────────────────────────────
  const maxActivity = Math.max(
    1,
    ...PARAM_KEYS.filter(p => activeParamsSet.has(p)).map(sumAbs),
  );

  // ── Personality-grouped fund selector ──────────────────────────────────────
  const personalities = [...new Set(fundIds.map(fundPersonality))];

  return (
    <div className="glass-card p-4">
      {/* Title */}
      <h3 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-2 flex items-center gap-1.5">
        {t("heatmapTitle")}
        <InfoPopover text={t("tipParamHeatmap")} />
      </h3>

      {/* Fund selector — grouped by personality */}
      <div className="flex gap-1 overflow-x-auto pb-1 mb-3 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        {personalities.flatMap((p, pi) => {
          const group = fundIds.filter(fid => fundPersonality(fid) === p);
          const hex = FUND_HEX_COLORS[p] ?? "#a1a1aa";
          const separator = pi > 0
            ? [<div key={`sep-${p}`} className="w-px h-5 bg-[var(--r-border)] mx-0.5 self-center shrink-0" />]
            : [];
          const buttons = group.map(fid => {
            const hasData = fundIdsFromLogs.includes(fid);
            const isActive = fid === targetFund;
            return (
              <button
                key={fid}
                onClick={() => setActiveFund(fid)}
                className={`flex items-center gap-1 text-xs px-2 py-1.5 rounded transition-all whitespace-nowrap ${
                  isActive
                    ? "bg-[var(--r-accent)] text-white"
                    : hasData
                      ? "text-[var(--r-text-muted)] bg-[var(--r-surface)] hover:bg-[var(--r-surface-hover)]"
                      : "text-[var(--r-text-faint)] bg-[var(--r-surface)]/50 opacity-60 hover:opacity-80"
                }`}
                title={hasData ? undefined : t("heatmapEmpty")}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: isActive ? "white" : hex }}
                />
                {fundDisplayName(fid, t)}
              </button>
            );
          });
          return [...separator, ...buttons];
        })}
      </div>

      {/* Content */}
      {!grid.some(g => g) || PARAM_KEYS.filter(p => activeParamsSet.has(p)).length === 0 ? (
        <div className="text-center text-sm text-[var(--r-text-muted)] py-4">
          {t("noMutationsFor")} {fundDisplayName(targetFund, t)}.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="text-xs" style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
            <thead>
              <tr>
                <th className="text-left text-[var(--r-text-muted)] font-normal pb-1 pr-2 sticky left-0 bg-transparent w-28 min-w-[112px]">
                  {t("param")}
                </th>
                {epochs.map(e => (
                  <th
                    key={e}
                    className={`text-center font-normal pb-1 px-0.5 transition-opacity ${
                      activeEpoch != null && e !== activeEpoch ? "opacity-30" : ""
                    }`}
                    style={{ width: cellW, minWidth: cellW }}
                  >
                    <span
                      className={`block text-center text-[10px] rounded-sm ${
                        activeEpoch === e
                          ? "text-[var(--r-accent)] font-semibold border-b-2 border-[var(--r-accent)] pb-0.5"
                          : "text-[var(--r-text-muted)]"
                      }`}
                    >
                      E{e}
                    </span>
                  </th>
                ))}
                {/* Activity column header */}
                <th className="text-right text-[10px] text-[var(--r-text-muted)] font-normal pb-1 pl-3 pr-1 w-14 min-w-[56px]">
                  {t("heatmapActivity")}
                </th>
              </tr>
            </thead>
            <tbody>
              {PARAM_GROUPS.map((group, gi) => {
                const groupParams = group.params.filter(p => activeParamsSet.has(p))
                  .sort((a, b) => sumAbs(b) - sumAbs(a));
                if (groupParams.length === 0) return null;

                return [
                  // Group header row
                  <tr key={`grp-${gi}`}>
                    <td
                      colSpan={epochs.length + 2}
                      className="pt-2 pb-0.5 text-[9px] font-semibold uppercase tracking-widest text-[var(--r-text-muted)] opacity-60"
                    >
                      {t(group.labelKey)}
                    </td>
                  </tr>,
                  // Param rows
                  ...groupParams.map(param => {
                    const paramLabel = PARAM_I18N[param] ? t(PARAM_I18N[param]) : param;
                    const activity = sumAbs(param);
                    const actPct = maxActivity > 0 ? (activity / maxActivity) * 100 : 0;

                    return (
                      <tr
                        key={param}
                        className="hover:bg-[var(--r-overlay-3)] transition-colors"
                      >
                        {/* Param label */}
                        <td className="text-[var(--r-text-muted)] pr-2 py-0.5 whitespace-nowrap sticky left-0">
                          <span className="truncate block max-w-[110px]" title={paramLabel}>
                            {paramLabel}
                          </span>
                        </td>

                        {/* Epoch cells */}
                        {epochs.map(epoch => {
                          const cell = grid.find(g => g.param === param && g.epoch === epoch);
                          const pct = cell?.pctChange ?? 0;
                          const isHighlightEpoch = activeEpoch != null && epoch === activeEpoch;
                          const isDimEpoch = activeEpoch != null && epoch !== activeEpoch;

                          return (
                            <td
                              key={epoch}
                              className="text-center py-0.5 px-0.5 relative group/cell"
                              style={{
                                width: cellW,
                                minWidth: cellW,
                                opacity: isDimEpoch ? 0.35 : 1,
                              }}
                              title={cell
                                ? `${paramLabel} E${epoch}: ${cell.before != null ? cell.before.toFixed(4) : "?"} → ${cell.after != null ? cell.after.toFixed(4) : "?"} (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%)`
                                : undefined
                              }
                            >
                              {/* Cell background */}
                              <div
                                className={`rounded h-6 flex items-center justify-center font-mono ${
                                  isHighlightEpoch ? "ring-1 ring-[var(--r-accent)]/60" : ""
                                }`}
                                style={{ background: intensityColor(pct) }}
                              >
                                {showNum && pct !== 0 && (
                                  <span className={`text-[9px] ${pct > 0 ? "pnl-positive" : "pnl-negative"}`}>
                                    {pct > 0 ? "+" : ""}{pct.toFixed(0)}
                                  </span>
                                )}
                              </div>

                              {/* Hover tooltip (desktop) */}
                              {cell && (
                                <div className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-1.5 opacity-0 group-hover/cell:opacity-100 pointer-events-none transition-opacity duration-100">
                                  <div className="bg-[#111113] border border-[#27272a] rounded-lg px-2.5 py-2 text-[11px] whitespace-nowrap shadow-lg">
                                    <div className="text-[var(--r-text-muted)] mb-1.5 font-medium">
                                      {paramLabel} · E{epoch}
                                    </div>
                                    <div className="flex items-center gap-1.5 font-mono">
                                      <span className="text-[var(--r-text-muted)]">{t("heatmapBefore")}:</span>
                                      <span>{cell.before != null ? cell.before.toFixed(4) : "–"}</span>
                                    </div>
                                    <div className="flex items-center gap-1.5 font-mono">
                                      <span className="text-[var(--r-text-muted)]">{t("heatmapAfter")}:</span>
                                      <span>{cell.after != null ? cell.after.toFixed(4) : "–"}</span>
                                      <span className={pct > 0 ? "pnl-positive" : "pnl-negative"}>
                                        ({pct > 0 ? "+" : ""}{pct.toFixed(1)}%)
                                      </span>
                                    </div>
                                  </div>
                                  {/* Arrow */}
                                  <div className="absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-[#27272a]" />
                                </div>
                              )}
                            </td>
                          );
                        })}

                        {/* Activity bar */}
                        <td className="pl-3 pr-1 py-0.5">
                          <div className="h-3 bg-[var(--r-surface)] rounded-full overflow-hidden w-12">
                            <div
                              className="h-full bg-[var(--r-accent)]/50 rounded-full transition-all"
                              style={{ width: `${actPct}%` }}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  }),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Legend: gradient bar + labels */}
      <div className="flex items-center gap-3 mt-4 text-[10px] text-[var(--r-text-muted)]">
        <span className="shrink-0">{t("intensity")}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          <span>{t("decrease")}</span>
          <div
            className="w-28 h-2.5 rounded-full"
            style={{
              background: "linear-gradient(to right, rgba(239,68,68,0.7) 0%, rgba(39,39,42,0.5) 50%, rgba(34,197,94,0.7) 100%)",
            }}
          />
          <span>{t("increase")}</span>
        </div>
        {epochCount > 12 && (
          <span className="italic opacity-60">{t("heatmapColorOnly")}</span>
        )}
      </div>
    </div>
  );
}
