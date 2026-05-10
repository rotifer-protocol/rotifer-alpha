import { useI18n } from "../i18n/context";
import type { TranslationKey } from "../i18n/translations";
import { useFetch } from "../hooks/useApi";
import { GitBranch, Zap, Trophy, XCircle, Activity } from "lucide-react";

const FIDELITY_KEYS: Record<string, TranslationKey> = {
  native: "fidelityNative",
  hybrid: "fidelityHybrid",
  wrapped: "fidelityWrapped",
};

const LIFECYCLE_KEYS: Record<string, TranslationKey> = {
  embedded: "lifecycleEmbedded",
  published: "lifecyclePublished",
  trial: "lifecycleTrial",
  active: "lifecycleActive",
};

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

const STATUS_COLORS: Record<string, string> = {
  active: "text-[var(--r-green)]",
  eliminated: "text-[var(--r-red)]",
  retired: "text-[var(--r-text-faint)]",
};

const ACTION_ICONS: Record<string, typeof Zap> = {
  variant_promoted: Trophy,
  variant_eliminated: XCircle,
  variant_added: GitBranch,
  epoch_started: Zap,
  epoch_completed: Activity,
};

export function GeneEvolutionPanel() {
  const { t, locale } = useI18n();
  const { data: varData, loading: varLoading, error: varError } = useFetch<VariantsResponse>(`/api/gene-variants?lang=${locale}`, 60000);
  const { data: evoData, loading: evoLoading } = useFetch<EvolutionResponse>("/api/gene-evolution?limit=30", 60000);

  if (varLoading || evoLoading) {
    return <div className="glass-card p-6 animate-pulse h-48" />;
  }

  if (varError && !varData) {
    return (
      <div className="glass-card p-6 text-center text-sm text-[var(--r-red)]">
        {varError}
      </div>
    );
  }

  const variants = varData?.variants ?? [];
  const activeConfig = varData?.activeConfig ?? {};
  const log = evoData?.log ?? [];
  const epoch = evoData?.epoch ?? 0;

  const registry = varData?.registry ?? [];
  const registryMap = new Map(registry.map(r => [r.id, r]));

  const geneGroups = new Map<string, GeneVariant[]>();
  for (const v of variants) {
    const arr = geneGroups.get(v.geneId) || [];
    arr.push(v);
    geneGroups.set(v.geneId, arr);
  }

  if (variants.length === 0) {
    return (
      <div className="glass-card p-6 text-center text-[var(--r-text-muted)] text-sm">
        {t("geneNoVariants")}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Epoch banner */}
      <div className="glass-card p-4 flex items-center justify-between">
        <div>
          <p className="text-xs text-[var(--r-text-faint)]">{t("geneCurrentEpoch")}</p>
          <p className="text-2xl font-bold font-mono">{epoch}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-[var(--r-text-faint)]">{t("geneVariants")}</p>
          <p className="text-2xl font-bold font-mono">{variants.length}</p>
        </div>
      </div>

      {/* Variant cards per Gene */}
      <div>
        <h3 className="text-xs font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-3">
          {t("geneVariants")}
        </h3>
        <div className="space-y-3">
          {[...geneGroups.entries()].map(([geneId, gv]) => {
            const meta = registryMap.get(geneId);
            const fidelityColor = meta?.fidelity === "hybrid"
              ? "bg-amber-500/10 text-amber-600"
              : meta?.fidelity === "native"
                ? "bg-emerald-500/10 text-emerald-600"
                : "bg-zinc-500/10 text-zinc-400";
            return (
            <div key={geneId} className="glass-card p-4">
              <div className="flex items-center gap-2 mb-3">
                <GitBranch className="w-4 h-4 text-[var(--r-accent)]" />
                <span className="text-sm font-medium">{locale === "zh" && meta?.name ? meta.name : geneId.replace("polymarket-", "")}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--r-accent)]/10 text-[var(--r-accent)]">
                  {gv.filter(v => v.status === "active").length} {t("geneActiveCount")}
                </span>
                {meta && (
                  <>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${fidelityColor}`}>
                      {FIDELITY_KEYS[meta.fidelity] ? t(FIDELITY_KEYS[meta.fidelity]) : meta.fidelity}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--r-surface)] text-[var(--r-text-faint)] border border-[var(--r-border)]">
                      {LIFECYCLE_KEYS[meta.lifecycleStatus] ? t(LIFECYCLE_KEYS[meta.lifecycleStatus]) : meta.lifecycleStatus}
                    </span>
                  </>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[var(--r-text-faint)] border-b border-[var(--r-border)]">
                      <th className="text-left py-1 pr-3">{t("geneStrategy")}</th>
                      <th className="text-right py-1 px-2">{t("genePetriScore")}</th>
                      <th className="text-right py-1 px-2">{t("geneTradesEvaluated")}</th>
                      <th className="text-right py-1 px-2">{t("geneWinRate")}</th>
                      <th className="text-right py-1 px-2">{t("pnl")}</th>
                      <th className="text-right py-1 pl-2">{t("geneStatus")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gv.map(v => {
                      const isActive = activeConfig[v.geneId] === v.id;
                      const wr = v.tradesEvaluated > 0 ? ((v.winCount / v.tradesEvaluated) * 100).toFixed(0) : "—";
                      const pnlColor = v.totalPnl > 0 ? "text-[var(--r-green)]" : v.totalPnl < 0 ? "text-[var(--r-red)]" : "";
                      return (
                        <tr key={v.id} className={`border-b border-[var(--r-border)]/50 ${isActive ? "bg-[var(--r-accent)]/5" : ""}`}>
                          <td className="py-1.5 pr-3">
                            <div className="flex items-center gap-1.5">
                              {isActive && <span className="w-1.5 h-1.5 rounded-full bg-[var(--r-green)] animate-pulse" />}
                              <span className="font-mono">{v.strategyKey}</span>
                              <span className="text-[var(--r-text-faint)]">g{v.generation}</span>
                            </div>
                            {v.description && <p className="text-[var(--r-text-faint)] mt-0.5 truncate max-w-[300px]">{v.description}</p>}
                          </td>
                          <td className="text-right py-1.5 px-2 font-mono">{v.petriScore.toFixed(1)}</td>
                          <td className="text-right py-1.5 px-2 font-mono">{v.tradesEvaluated}</td>
                          <td className="text-right py-1.5 px-2 font-mono">{wr}{wr !== "—" ? "%" : ""}</td>
                          <td className={`text-right py-1.5 px-2 font-mono ${pnlColor}`}>
                            {v.totalPnl > 0 ? "+" : ""}{v.totalPnl.toFixed(2)}
                          </td>
                          <td className={`text-right py-1.5 pl-2 ${STATUS_COLORS[v.status] ?? ""}`}>
                            {t(`geneStatus${v.status.charAt(0).toUpperCase() + v.status.slice(1)}` as any)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            );
          })}
        </div>
      </div>

      {/* Evolution Log */}
      <div>
        <h3 className="text-xs font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-3">
          {t("geneEvolutionLog")}
        </h3>
        {log.length === 0 ? (
          <div className="glass-card p-4 text-center text-[var(--r-text-faint)] text-xs">
            {t("geneNoVariants")}
          </div>
        ) : (
          <div className="space-y-1">
            {log.map(entry => {
              const Icon = ACTION_ICONS[entry.action] ?? Activity;
              const actionKey = `gene${entry.action.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("")}` as any;
              const label = t(actionKey) || entry.action;
              return (
                <div key={entry.id} className="glass-card px-3 py-2 flex items-center gap-3">
                  <Icon className="w-3.5 h-3.5 text-[var(--r-accent)] shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-medium">{label}</span>
                      {entry.geneId !== "*" && (
                        <span className="text-[var(--r-text-faint)]">{locale === "zh" && registryMap.get(entry.geneId)?.name ? registryMap.get(entry.geneId)!.name : entry.geneId.replace("polymarket-", "")}</span>
                      )}
                      {entry.petriScore !== null && (
                        <span className="text-[var(--r-text-faint)] font-mono">{t("geneScoreLabel")}: {entry.petriScore.toFixed(1)}</span>
                      )}
                    </div>
                    {entry.variantId && (
                      <p className="text-[10px] text-[var(--r-text-faint)] font-mono truncate">{entry.variantId}</p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <span className="text-[10px] text-[var(--r-text-faint)]">
                      {t("geneEpoch")} {entry.epoch}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
