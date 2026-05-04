import { useI18n } from "../i18n/context";
import type { TranslationKey } from "../i18n/translations";
import { useFetch } from "../hooks/useApi";
import { AlertTriangle, CheckCircle, XCircle, Activity, TrendingUp, TrendingDown } from "lucide-react";

const FUND_NAME_KEYS: Record<string, TranslationKey> = {
  cheetah: "fundCheetah", octopus: "fundOctopus", turtle: "fundTurtle",
  shark: "fundShark", gambler: "fundGambler",
  beluga: "fundBeluga", leviathan: "fundLeviathan",
};

interface ShadowOrder {
  id: string;
  paper_trade_id: string;
  fund_id: string;
  market_id: string;
  slug: string;
  question: string;
  direction: string;
  side: string;
  shares: number;
  price: number;
  order_type: string;
  status: string;
  simulated_fill_price: number;
  simulated_slippage: number;
  paper_pnl: number | null;
  shadow_pnl: number | null;
  created_at: string;
}

interface ShadowSummary {
  wouldFill: number;
  wouldReject: number;
  fillRate: number;
  avgSlippageImpact: number;
  totalPaperPnl: number;
  totalShadowPnl: number;
  pnlDivergence: number;
}

interface ShadowResponse {
  orders: ShadowOrder[];
  total: number;
  summary: ShadowSummary | null;
}

interface SystemResponse {
  killSwitch: boolean;
  executionMode: string;
}

function StatCard({ label, value, sub, icon, color }: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <div className="glass-card p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className={`${color}`}>{icon}</span>
        <span className="text-xs text-[var(--r-text-muted)]">{label}</span>
      </div>
      <p className="text-xl font-bold font-mono tabular-nums">{value}</p>
      {sub && <p className="text-xs text-[var(--r-text-faint)] mt-1">{sub}</p>}
    </div>
  );
}

function SystemStatusBanner({ system }: { system: SystemResponse }) {
  const { t } = useI18n();
  const isHalted = system.killSwitch;
  const isShadow = system.executionMode === "shadow";

  return (
    <div className={`glass-card p-4 mb-6 flex items-center justify-between ${isHalted ? "border-[var(--r-red)]/30" : ""}`}>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${isHalted ? "bg-[var(--r-red)]" : "bg-[var(--r-green)] animate-pulse"}`} />
          <span className="text-sm font-medium">
            {t("killSwitch")}: {isHalted ? t("killSwitchActive") : t("killSwitchInactive")}
          </span>
        </div>
        <div className="h-4 w-px bg-[var(--r-border)]" />
        <div className="flex items-center gap-2">
          <Activity className="w-3.5 h-3.5 text-[var(--r-text-muted)]" />
          <span className="text-sm">
            {t("executionMode")}:{" "}
            <span className={`font-medium ${isShadow ? "text-[var(--r-accent)]" : "text-[var(--r-text-muted)]"}`}>
              {isShadow ? t("executionModeShadow") : t("executionModePaper")}
            </span>
          </span>
        </div>
      </div>
      {isHalted && (
        <div className="flex items-center gap-1.5 text-[var(--r-red)]">
          <AlertTriangle className="w-4 h-4" />
          <span className="text-xs font-medium">{t("shadowTradingHalted")}</span>
        </div>
      )}
    </div>
  );
}

function formatTime(iso: string, locale: string): string {
  const d = new Date(iso);
  return d.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function ShadowPanel() {
  const { t, locale } = useI18n();
  const { data: shadowData, loading: shadowLoading } = useFetch<ShadowResponse>("/api/shadow?limit=100", 30_000);
  const { data: systemData, loading: systemLoading } = useFetch<SystemResponse>("/api/system", 10_000);

  if (shadowLoading || systemLoading) {
    return (
      <div className="space-y-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="glass-card p-5 h-24 animate-pulse" />
        ))}
      </div>
    );
  }

  const system = systemData ?? { killSwitch: false, executionMode: "paper" };
  const shadow = shadowData ?? { orders: [], total: 0, summary: null };
  const summary = shadow.summary;

  return (
    <div>
      <SystemStatusBanner system={system} />

      {summary && shadow.total > 0 ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <StatCard
              label={t("shadowFillRate")}
              value={`${summary.fillRate}%`}
              sub={`${summary.wouldFill} / ${summary.wouldFill + summary.wouldReject}`}
              icon={<CheckCircle className="w-4 h-4" />}
              color={summary.fillRate >= 90 ? "text-[var(--r-green)]" : "text-[var(--r-yellow)]"}
            />
            <StatCard
              label={t("shadowAvgSlippage")}
              value={`$${Math.abs(summary.avgSlippageImpact).toFixed(2)}`}
              sub={summary.avgSlippageImpact > 0 ? t("shadowSlippagePaperGt") : t("shadowSlippageShadowGt")}
              icon={<Activity className="w-4 h-4" />}
              color="text-[var(--r-text-muted)]"
            />
            <StatCard
              label={t("shadowPaperPnl")}
              value={`${summary.totalPaperPnl >= 0 ? "+$" : "-$"}${Math.abs(summary.totalPaperPnl).toFixed(2)}`}
              icon={summary.totalPaperPnl >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
              color={summary.totalPaperPnl >= 0 ? "text-[var(--r-green)]" : "text-[var(--r-red)]"}
            />
            <StatCard
              label={t("shadowDivergence")}
              value={`$${Math.abs(summary.pnlDivergence).toFixed(2)}`}
              sub={summary.pnlDivergence > 0 ? t("shadowPaperOutperforms") : summary.pnlDivergence < 0 ? t("shadowShadowOutperforms") : t("shadowEqual")}
              icon={summary.pnlDivergence >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
              color={Math.abs(summary.pnlDivergence) < 10 ? "text-[var(--r-green)]" : "text-[var(--r-yellow)]"}
            />
          </div>

          <div className="glass-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--r-border)]">
                    <th className="text-left p-3 text-[var(--r-text-muted)] font-medium">{t("fund")}</th>
                    <th className="text-left p-3 text-[var(--r-text-muted)] font-medium">{t("direction")}</th>
                    <th className="text-left p-3 text-[var(--r-text-muted)] font-medium">{t("shadowSide")}</th>
                    <th className="text-right p-3 text-[var(--r-text-muted)] font-medium">{t("entryPrice")}</th>
                    <th className="text-right p-3 text-[var(--r-text-muted)] font-medium">{t("shadowSimFillPrice")}</th>
                    <th className="text-right p-3 text-[var(--r-text-muted)] font-medium">{t("shadowSlippage")}</th>
                    <th className="text-center p-3 text-[var(--r-text-muted)] font-medium">{t("shadowStatus")}</th>
                    <th className="text-right p-3 text-[var(--r-text-muted)] font-medium">{t("shadowPaperPnl")}</th>
                    <th className="text-right p-3 text-[var(--r-text-muted)] font-medium">{t("shadowRealPnl")}</th>
                    <th className="text-right p-3 text-[var(--r-text-muted)] font-medium">{t("shadowTime")}</th>
                  </tr>
                </thead>
                <tbody>
                  {shadow.orders.map((order) => (
                    <tr key={order.id} className="border-b border-[var(--r-border)]/50 hover:bg-[var(--r-surface-hover)]">
                      <td className="p-3 font-medium">{FUND_NAME_KEYS[order.fund_id] ? t(FUND_NAME_KEYS[order.fund_id]) : order.fund_id}</td>
                      <td className="p-3">{({"BUY_YES": t("directionBuyYes"), "SELL_YES": t("directionSellYes"), "BUY_BOTH": t("directionBuyBoth"), "SELL_BOTH": t("directionSellBoth"), "BUY_STRONGEST": t("directionBuyStrongest"), "SELL_WEAKEST": t("directionSellWeakest"), "PROVIDE_LIQUIDITY": t("directionProvideLiquidity")} as Record<string, string>)[order.direction] ?? order.direction}</td>
                      <td className="p-3">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${order.side === "BUY" ? "bg-[var(--r-green)]/15 text-[var(--r-green)]" : "bg-[var(--r-red)]/15 text-[var(--r-red)]"}`}>
                          {order.side === "BUY" ? t("shadowBuy") : t("shadowSell")}
                        </span>
                      </td>
                      <td className="p-3 text-right font-mono">{order.price.toFixed(4)}</td>
                      <td className="p-3 text-right font-mono">{order.simulated_fill_price.toFixed(4)}</td>
                      <td className="p-3 text-right font-mono text-[var(--r-text-faint)]">{(order.simulated_slippage * 100).toFixed(2)}%</td>
                      <td className="p-3 text-center">
                        {order.status === "WOULD_FILL" ? (
                          <span className="inline-flex items-center gap-1 text-[var(--r-green)]">
                            <CheckCircle className="w-3 h-3" /> {t("shadowFill")}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[var(--r-red)]">
                            <XCircle className="w-3 h-3" /> {t("shadowReject")}
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-right font-mono">
                        {order.paper_pnl !== null ? (
                          <span className={order.paper_pnl >= 0 ? "text-[var(--r-green)]" : "text-[var(--r-red)]"}>
                            {order.paper_pnl >= 0 ? "+" : ""}{order.paper_pnl.toFixed(2)}
                          </span>
                        ) : "—"}
                      </td>
                      <td className="p-3 text-right font-mono">
                        {order.shadow_pnl !== null ? (
                          <span className={order.shadow_pnl >= 0 ? "text-[var(--r-green)]" : "text-[var(--r-red)]"}>
                            {order.shadow_pnl >= 0 ? "+" : ""}{order.shadow_pnl.toFixed(2)}
                          </span>
                        ) : "—"}
                      </td>
                      <td className="p-3 text-right text-[var(--r-text-faint)]">{formatTime(order.created_at, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        <div className="glass-card p-10 text-center">
          <Activity className="w-10 h-10 text-[var(--r-text-faint)] mx-auto mb-3" />
          <p className="text-sm text-[var(--r-text-muted)]">{t("shadowNoData")}</p>
        </div>
      )}
    </div>
  );
}
