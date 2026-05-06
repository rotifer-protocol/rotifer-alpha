import { useState } from "react";
import { useI18n } from "../i18n/context";
import type { TranslationKey } from "../i18n/translations";
import { fundDisplayName } from "../lib/fundMeta";

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
  /** Full list of all funds from fund_configs. When provided, all funds are
   *  shown as tabs even if they have no evolution log entries yet. */
  allFundIds?: string[];
}

const PARAM_I18N: Record<string, TranslationKey> = {
  minEdge:          "paramMinEdge",
  minConfidence:    "paramMinConfidence",
  minVolume:        "paramMinVolume",
  minLiquidity:     "paramMinLiquidity",
  maxPerEvent:      "paramMaxPerEvent",
  maxOpenPositions: "paramMaxPositions",
  monthlyTarget:    "paramMonthlyTarget",
  drawdownLimit:    "paramDrawdownLimit",
  stopLossPercent:       "paramStopLoss",
  maxHoldDays:           "paramMaxHold",
  takeProfitPercent:     "takeProfitLabel",
  trailingStopPercent:   "trailingStopLabel",
  probReversalThreshold: "probReversalLabel",
  sizingBase:            "paramSizingBase",
  sizingScale:           "paramSizingScale",
};


const PARAM_KEYS = Object.keys(PARAM_I18N);

function intensityColor(pctChange: number): string {
  if (pctChange === 0) return "rgba(39, 39, 42, 0.5)";
  const abs = Math.min(Math.abs(pctChange), 50);
  const intensity = abs / 50;
  if (pctChange > 0) {
    return `rgba(34, 197, 94, ${0.15 + intensity * 0.55})`;
  }
  return `rgba(239, 68, 68, ${0.15 + intensity * 0.55})`;
}

export function ParamHeatmap({ logs, selectedFund, allFundIds }: Props) {
  const { t } = useI18n();
  // Use the full fund list if provided; fall back to deriving from logs.
  // This ensures funds without any evolution history still appear as buttons.
  const fundIdsFromLogs = [...new Set(logs.map(l => l.fund_id))];
  const fundIds = allFundIds && allFundIds.length > 0 ? allFundIds : fundIdsFromLogs;
  const [activeFund, setActiveFund] = useState<string | null>(selectedFund);
  const targetFund = activeFund || fundIdsFromLogs[0] || fundIds[0];
  const epochs = [...new Set(logs.map(l => l.epoch))].sort((a, b) => a - b);

  if (epochs.length === 0 || !targetFund) {
    return (
      <div className="glass-card p-6 text-center text-sm text-[var(--r-text-muted)]">
        {t("heatmapEmpty")}
      </div>
    );
  }

  const fundLogs = logs.filter(l => l.fund_id === targetFund && l.action !== "UNCHANGED");

  const grid: Array<{ param: string; epoch: number; pctChange: number }> = [];
  for (const log of fundLogs) {
    let before: Record<string, number> = {};
    let after: Record<string, number> = {};
    try { before = JSON.parse(log.params_before); } catch { continue; }
    try { after = JSON.parse(log.params_after); } catch { continue; }

    for (const param of PARAM_KEYS) {
      const bv = before[param];
      const av = after[param];
      if (bv === undefined && av === undefined) continue;
      const pctChange = bv && bv !== 0 ? ((av ?? bv) - bv) / bv * 100 : 0;
      grid.push({ param, epoch: log.epoch, pctChange });
    }
  }

  const activeParams = PARAM_KEYS.filter(p => grid.some(g => g.param === p));

  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest">
          {t("heatmapTitle")}
        </h3>
        <div className="flex gap-1">
          {fundIds.map(fid => (
            <button
              key={fid}
              onClick={() => setActiveFund(fid)}
              className={`text-xs px-2 py-0.5 rounded transition-all ${
                fid === targetFund
                  ? "bg-[var(--r-accent)] text-white"
                  : "text-[var(--r-text-muted)] bg-[var(--r-surface)] hover:bg-[var(--r-surface-hover)]"
              }`}
            >
              {fundDisplayName(fid, t)}
            </button>
          ))}
        </div>
      </div>

      {activeParams.length === 0 ? (
        <div className="text-center text-sm text-[var(--r-text-muted)] py-4">
          {t("noMutationsFor")} {targetFund}.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th className="text-left text-[var(--r-text-muted)] font-normal pb-1 pr-2 w-20">
                  {t("param")}
                </th>
                {epochs.map(e => (
                  <th
                    key={e}
                    className="text-center text-[var(--r-text-muted)] font-normal pb-1 px-1 min-w-[40px]"
                  >
                    E{e}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activeParams.map(param => (
                <tr key={param} className="hover:bg-[var(--r-overlay-3)] transition-colors">
                  <td className="text-[var(--r-text-muted)] font-mono pr-2 py-0.5 whitespace-nowrap">
                    {PARAM_I18N[param] ? t(PARAM_I18N[param]) : param}
                  </td>
                  {epochs.map(epoch => {
                    const cell = grid.find(g => g.param === param && g.epoch === epoch);
                    const pct = cell?.pctChange ?? 0;
                    return (
                      <td
                        key={epoch}
                        className="text-center py-0.5 px-0.5"
                        title={`${PARAM_I18N[param] ? t(PARAM_I18N[param]) : param} E${epoch}: ${pct.toFixed(1)}%`}
                      >
                        <div
                          className="rounded h-6 flex items-center justify-center font-mono"
                          style={{ background: intensityColor(pct) }}
                        >
                          {pct !== 0 && (
                            <span className={pct > 0 ? "pnl-positive" : "pnl-negative"}>
                              {pct > 0 ? "+" : ""}{pct.toFixed(0)}
                            </span>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center gap-3 mt-3 text-[10px] text-[var(--r-text-muted)]">
        <span>{t("intensity")}</span>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded" style={{ background: "rgba(239,68,68,0.5)" }} />
          <span>{t("decrease")}</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded" style={{ background: "rgba(39,39,42,0.5)" }} />
          <span>{t("noChange")}</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded" style={{ background: "rgba(34,197,94,0.5)" }} />
          <span>{t("increase")}</span>
        </div>
      </div>
    </div>
  );
}
