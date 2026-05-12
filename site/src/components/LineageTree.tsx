import { FUND_ICONS } from "./icons/FundIcons";
import { useI18n } from "../i18n/context";
import { formatFundGeneration } from "../i18n/translations";
import { FUND_COLORS, fundDisplayName } from "../lib/fundMeta";
import { InfoPopover } from "./InfoPopover";

interface FundLineage {
  id: string;
  name: string;
  emoji: string;
  generation: number;
  parent_id: string | null;
}

interface LogFitness {
  fund_id: string;
  epoch: number;
  fitness_after: number | null;
}

interface Props {
  lineage: FundLineage[];
  /** Pass evolution logs to enable F(g) scores on nodes */
  logs?: LogFitness[];
  /** Currently selected fund (for highlight) */
  selectedFund?: string | null;
  /** Called when user clicks a fund node; null = deselect */
  onSelectFund?: (id: string | null) => void;
}

// ─── Tree structure ───────────────────────────────────────────────────────────
type TreeEntry = {
  fund: FundLineage;
  depth: number;
  isLast: boolean;
  /** ancestorIsLast[i] = whether the ancestor at level i was the last child */
  ancestorIsLast: boolean[];
};

function buildTreeEntries(lineage: FundLineage[]): TreeEntry[] {
  const childMap = new Map<string | null, FundLineage[]>();
  for (const f of lineage) {
    const arr = childMap.get(f.parent_id) ?? [];
    childMap.set(f.parent_id, [...arr, f]);
  }
  const result: TreeEntry[] = [];

  function dfs(parentId: string | null, depth: number, ancestorIsLast: boolean[]) {
    const children = childMap.get(parentId) ?? [];
    children.forEach((f, i) => {
      const isLast = i === children.length - 1;
      result.push({ fund: f, depth, isLast, ancestorIsLast });
      dfs(f.id, depth + 1, [...ancestorIsLast, isLast]);
    });
  }

  const roots = lineage.filter(f => f.parent_id == null);
  roots.forEach((root, i) => {
    const isLast = i === roots.length - 1;
    result.push({ fund: root, depth: 0, isLast, ancestorIsLast: [] });
    dfs(root.id, 1, [isLast]);
  });
  return result;
}

// ─── Fitness helpers ──────────────────────────────────────────────────────────
function fitnessTextColor(fg: number): string {
  if (fg >= 0.6) return "text-green-400";
  if (fg >= 0.2) return "text-yellow-400";
  return "text-red-400";
}

function fitnessDotColor(fg: number): string {
  if (fg >= 0.6) return "#22c55e";
  if (fg >= 0.2) return "#eab308";
  return "#ef4444";
}

// ─── Main component ───────────────────────────────────────────────────────────
export function LineageTree({ lineage, logs, selectedFund, onSelectFund }: Props) {
  const { t, locale } = useI18n();

  if (lineage.length === 0) {
    return (
      <div className="glass-card p-6 text-center text-sm text-[var(--r-text-muted)]">
        {t("lineageEmpty")}
      </div>
    );
  }

  // Compute latest F(g) per fund (use highest-epoch entry)
  const latestFitness: Record<string, number> = {};
  if (logs) {
    const epochOf: Record<string, number> = {};
    for (const log of logs) {
      if (log.fitness_after != null) {
        if (epochOf[log.fund_id] === undefined || log.epoch > epochOf[log.fund_id]) {
          latestFitness[log.fund_id] = log.fitness_after;
          epochOf[log.fund_id] = log.epoch;
        }
      }
    }
  }

  // Build parent→latest-fitness lookup for delta computation
  const getDelta = (fund: FundLineage): number | null => {
    if (fund.parent_id == null) return null;
    const own = latestFitness[fund.id];
    const par = latestFitness[fund.parent_id];
    if (own == null || par == null) return null;
    return own - par;
  };

  const maxGen = Math.max(...lineage.map(f => f.generation));
  const hasLineage = maxGen > 0;

  // Split: funds involved in actual evolution vs Gen.0 unstarted funds
  const fundsWithChildren = new Set(
    lineage.filter(f => f.parent_id != null).map(f => f.parent_id!),
  );
  // "Active" = has a parent, OR has been evolved (gen > 0), OR has children
  const activeFundIds = new Set(
    lineage
      .filter(f => f.parent_id != null || f.generation > 0 || fundsWithChildren.has(f.id))
      .map(f => f.id),
  );
  const activeLineage = lineage.filter(f => activeFundIds.has(f.id));
  const passiveFunds = lineage.filter(f => !activeFundIds.has(f.id));
  const isInteractive = !!onSelectFund;

  return (
    <div className="glass-card p-4">
      <h3 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-4 flex items-center gap-1.5">
        {t("lineageTitle")}
        <InfoPopover text={t("tipLineage")} />
      </h3>

      {!hasLineage ? (
        /* Gen-0 only: compact icon grid */
        <div className="text-center py-2">
          <div className="flex flex-wrap justify-center gap-4 mb-4">
            {lineage.map(f => {
              const Icon = FUND_ICONS[f.id];
              const color = FUND_COLORS[f.id] || "text-[var(--r-text-muted)]";
              const fg = latestFitness[f.id];
              const isSelected = selectedFund === f.id;
              return (
                <div
                  key={f.id}
                  className={`flex flex-col items-center gap-1 p-2 rounded-lg transition-colors cursor-default ${
                    isInteractive ? "cursor-pointer hover:bg-[var(--r-surface)]" : ""
                  } ${isSelected ? "bg-[var(--r-surface-hover)] ring-1 ring-[var(--r-accent)]" : ""}`}
                  onClick={() => onSelectFund?.(isSelected ? null : f.id)}
                >
                  {Icon ? (
                    <span className={color}><Icon size={26} /></span>
                  ) : (
                    <span className="text-2xl">{f.emoji}</span>
                  )}
                  <span className="text-xs text-[var(--r-text-muted)]">{fundDisplayName(f.id, t)}</span>
                  <span
                    className="text-[10px] font-mono text-[var(--r-text-muted)] cursor-help"
                    title={t("generationBadgeTooltip")}
                  >
                    {formatFundGeneration(locale, f.generation)}
                  </span>
                  {fg != null && (
                    <span className={`text-[11px] font-mono font-semibold ${fitnessTextColor(fg)}`}>
                      {fg.toFixed(3)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-xs text-[var(--r-text-muted)]">{t("gen0All")}</p>
        </div>
      ) : (
        /* Multi-generation: CSS tree with connectors + F(g) */
        <div className="space-y-0.5">
          {buildTreeEntries(activeLineage).map(({ fund, depth, isLast, ancestorIsLast }) => {
            const Icon = FUND_ICONS[fund.id];
            const colorClass = FUND_COLORS[fund.id] || "text-[var(--r-text-muted)]";
            const fg = latestFitness[fund.id];
            const delta = getDelta(fund);
            const isSelected = selectedFund === fund.id;

            return (
              <div key={fund.id} className="flex items-stretch min-h-[44px]">
                {/* ── CSS tree connector columns ── */}
                {ancestorIsLast.map((isAncLast, colIdx) => {
                  const isBranchCol = colIdx === depth - 1;
                  if (isBranchCol) {
                    return (
                      <div key={colIdx} className="relative w-4 shrink-0 self-stretch">
                        {/* Vertical: top → middle */}
                        <div className="absolute w-px bg-[var(--r-border)] left-[7px] top-0 bottom-1/2" />
                        {/* Vertical: middle → bottom (only if NOT last sibling) */}
                        {!isLast && (
                          <div className="absolute w-px bg-[var(--r-border)] left-[7px] top-1/2 bottom-0" />
                        )}
                        {/* Horizontal: branch line */}
                        <div className="absolute h-px bg-[var(--r-border)] left-[7px] right-0 top-1/2" />
                      </div>
                    );
                  }
                  // Ancestor continuation column
                  return (
                    <div key={colIdx} className="relative w-4 shrink-0 self-stretch">
                      {!isAncLast && (
                        <div className="absolute w-px bg-[var(--r-border)] left-[7px] inset-y-0" />
                      )}
                    </div>
                  );
                })}

                {/* ── Node card ── */}
                <div
                  className={`flex-1 flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors min-w-0 ${
                    isInteractive ? "cursor-pointer" : "cursor-default"
                  } ${
                    isSelected
                      ? "bg-[var(--r-surface-hover)] ring-1 ring-[var(--r-accent)]"
                      : isInteractive ? "hover:bg-[var(--r-surface)]" : "bg-[var(--r-surface)]/50"
                  }`}
                  onClick={() => onSelectFund?.(isSelected ? null : fund.id)}
                >
                  {/* Fund icon */}
                  {Icon ? (
                    <span className={`shrink-0 ${colorClass}`}><Icon size={18} /></span>
                  ) : (
                    <span className="text-base shrink-0">{fund.emoji}</span>
                  )}

                  {/* Name + generation badge */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-medium truncate">{fundDisplayName(fund.id, t)}</span>
                      <span
                        className="text-[9px] font-mono px-1 py-0.5 rounded bg-[var(--r-accent)]/15 text-[var(--r-accent)] shrink-0 cursor-help"
                        title={t("generationBadgeTooltip")}
                      >
                        {formatFundGeneration(locale, fund.generation)}
                      </span>
                      {fund.parent_id == null && (
                        <span className="text-[9px] text-[var(--r-text-muted)] shrink-0">
                          {t("originalStrain")}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* F(g) score + delta */}
                  <div className="shrink-0 flex items-center gap-2">
                    {delta != null && (
                      <span className={`text-[10px] font-mono ${delta >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {delta >= 0 ? "↑" : "↓"}{Math.abs(delta).toFixed(3)}
                      </span>
                    )}
                    {fg != null && (
                      <div className="flex items-center gap-1">
                        {/* Fitness status dot */}
                        <span
                          className="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ background: fitnessDotColor(fg) }}
                        />
                        <span className={`text-[11px] font-mono font-semibold tabular-nums ${fitnessTextColor(fg)}`}>
                          {fg.toFixed(3)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Gen.0 funds that have no evolution history – shown as a compact strip below the tree */}
      {hasLineage && passiveFunds.length > 0 && (
        <div className="mt-4 pt-3 border-t border-[var(--r-border)]">
          <p className="text-[10px] text-[var(--r-text-muted)] uppercase tracking-wider mb-2">
            {locale === "zh" ? "其余品系（第 0 代，未进化）" : "Other strains (Gen 0, unevolved)"}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {passiveFunds.map(f => {
              const Icon = FUND_ICONS[f.id];
              const colorClass = FUND_COLORS[f.id] || "text-[var(--r-text-muted)]";
              const isSelected = selectedFund === f.id;
              return (
                <div
                  key={f.id}
                  className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors ${
                    isInteractive ? "cursor-pointer hover:bg-[var(--r-surface)]" : "cursor-default"
                  } ${isSelected ? "bg-[var(--r-surface-hover)] ring-1 ring-[var(--r-accent)]" : "bg-[var(--r-surface)]/40"}`}
                  onClick={() => onSelectFund?.(isSelected ? null : f.id)}
                >
                  {Icon ? (
                    <span className={`shrink-0 ${colorClass}`}><Icon size={13} /></span>
                  ) : (
                    <span className="text-sm">{f.emoji}</span>
                  )}
                  <span className="text-[var(--r-text-muted)]">{fundDisplayName(f.id, t)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Fitness legend */}
      {Object.keys(latestFitness).length > 0 && (
        <div className="flex items-center gap-3 mt-3 text-[10px] text-[var(--r-text-muted)]">
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-green-400" /> ≥0.6</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-yellow-400" /> 0.2–0.6</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-red-400" /> &lt;0.2</span>
          {isInteractive && (
            <span className="ml-auto opacity-60">
              {locale === "zh" ? "点击筛选热力图" : "Click to filter heatmap"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
