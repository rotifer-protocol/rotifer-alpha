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
          <p className="text-xs text-[var(--r-text-muted)]">
            {t("gen0All")}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {lineage
            .sort((a, b) => b.generation - a.generation)
            .map(fund => {
              const parent = fund.parent_id
                ? lineage.find(f => f.id === fund.parent_id)
                : null;
              const Icon = FUND_ICONS[fund.id];
              const color = FUND_COLORS[fund.id] || "text-[var(--r-text-muted)]";

              return (
                <div
                  key={fund.id}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[var(--r-surface)]"
                >
                  {Icon ? (
                    <span className={`shrink-0 ${color}`}><Icon size={24} /></span>
                  ) : (
                    <span className="text-xl shrink-0">{fund.emoji}</span>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{fundDisplayName(fund.id, t)}</span>
                      <span
                        className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--r-accent)]/20 text-[var(--r-accent)] cursor-help"
                        title={t("generationBadgeTooltip")}
                      >
                        {formatFundGeneration(locale, fund.generation)}
                      </span>
                    </div>
                    {parent && (
                      <div className="flex items-center gap-1 mt-0.5 text-xs text-[var(--r-text-muted)]">
                        <span>← {t("lineageFrom")}</span>
                        <span>{fundDisplayName(parent.id, t)}</span>
                      </div>
                    )}
                    {!parent && fund.generation === 0 && (
                      <div className="text-xs text-[var(--r-text-muted)] mt-0.5">
                        {t("originalStrain")}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0">
                    {Array.from({ length: Math.min(fund.generation, 5) }, (_, i) => (
                      <span
                        key={i}
                        className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--r-accent)] ml-0.5"
                      />
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
