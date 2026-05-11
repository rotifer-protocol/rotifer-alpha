import { FUND_ICONS } from "./icons/FundIcons";
import { useI18n } from "../i18n/context";
import { formatFundGeneration } from "../i18n/translations";
import { FUND_COLORS, fundDisplayName } from "../lib/fundMeta";

interface FundLineage {
  id: string;
  name: string;
  emoji: string;
  generation: number;
  parent_id: string | null;
}

interface Props {
  lineage: FundLineage[];
}

// Build DFS-ordered tree entries with ASCII-tree prefix strings
type TreeEntry = { fund: FundLineage; prefix: string };
function buildTreeEntries(lineage: FundLineage[]): TreeEntry[] {
  const childMap = new Map<string | null, FundLineage[]>();
  for (const f of lineage) {
    const arr = childMap.get(f.parent_id) ?? [];
    childMap.set(f.parent_id, [...arr, f]);
  }
  const result: TreeEntry[] = [];
  function dfs(parentId: string | null, linePrefix: string) {
    const children = childMap.get(parentId) ?? [];
    children.forEach((f, i) => {
      const isLast = i === children.length - 1;
      result.push({ fund: f, prefix: linePrefix + (linePrefix ? (isLast ? "└─ " : "├─ ") : "") });
      dfs(f.id, linePrefix + (linePrefix ? (isLast ? "    " : "│   ") : "│   "));
    });
  }
  // Roots (generation 0, no parent)
  const roots = lineage.filter(f => f.parent_id == null);
  roots.forEach((root, i) => {
    const isLast = i === roots.length - 1;
    result.push({ fund: root, prefix: "" });
    dfs(root.id, roots.length > 1 && !isLast ? "│   " : "    ");
  });
  return result;
}

export function LineageTree({ lineage }: Props) {
  const { t, locale } = useI18n();

  if (lineage.length === 0) {
    return (
      <div className="glass-card p-6 text-center text-sm text-[var(--r-text-muted)]">
        {t("lineageEmpty")}
      </div>
    );
  }

  const maxGen = Math.max(...lineage.map(f => f.generation));
  const hasLineage = maxGen > 0;

  return (
    <div className="glass-card p-4">
      <h3 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-4">
        {t("lineageTitle")}
      </h3>

      {!hasLineage ? (
        /* Gen-0 only: icon row (unchanged) */
        <div className="text-center py-4">
          <div className="flex justify-center gap-4 mb-4">
            {lineage.map(f => {
              const Icon = FUND_ICONS[f.id];
              const color = FUND_COLORS[f.id] || "text-[var(--r-text-muted)]";
              return (
                <div key={f.id} className="flex flex-col items-center">
                  {Icon ? (
                    <span className={color}><Icon size={28} /></span>
                  ) : (
                    <span className="text-2xl">{f.emoji}</span>
                  )}
                  <span className="text-xs text-[var(--r-text-muted)] mt-1">{fundDisplayName(f.id, t)}</span>
                  <span
                    className="text-[10px] font-mono text-[var(--r-text-muted)] cursor-help"
                    title={t("generationBadgeTooltip")}
                  >
                    {formatFundGeneration(locale, f.generation)}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-[var(--r-text-muted)]">{t("gen0All")}</p>
        </div>
      ) : (
        /* Multi-generation: DFS tree with ASCII connectors */
        <div className="space-y-1.5">
          {buildTreeEntries(lineage).map(({ fund, prefix }) => {
            const Icon = FUND_ICONS[fund.id];
            const color = FUND_COLORS[fund.id] || "text-[var(--r-text-muted)]";
            return (
              <div key={fund.id} className="flex items-center gap-2 px-2 py-2 rounded-lg bg-[var(--r-surface)]">
                {/* ASCII tree prefix */}
                {prefix && (
                  <span className="font-mono text-xs text-[var(--r-border)] whitespace-pre shrink-0 select-none leading-none">
                    {prefix}
                  </span>
                )}
                {/* Fund icon */}
                {Icon ? (
                  <span className={`shrink-0 ${color}`}><Icon size={22} /></span>
                ) : (
                  <span className="text-xl shrink-0">{fund.emoji}</span>
                )}
                {/* Name + generation badge */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{fundDisplayName(fund.id, t)}</span>
                    <span
                      className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--r-accent)]/20 text-[var(--r-accent)] shrink-0 cursor-help"
                      title={t("generationBadgeTooltip")}
                    >
                      {formatFundGeneration(locale, fund.generation)}
                    </span>
                  </div>
                  {fund.parent_id == null && (
                    <div className="text-xs text-[var(--r-text-muted)] mt-0.5">{t("originalStrain")}</div>
                  )}
                </div>
                {/* Generation depth dots */}
                <div className="shrink-0 flex gap-0.5">
                  {Array.from({ length: Math.min(fund.generation, 5) }, (_, i) => (
                    <span key={i} className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--r-accent)]" />
                  ))}
                  {fund.generation === 0 && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--r-text-muted)]" />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
