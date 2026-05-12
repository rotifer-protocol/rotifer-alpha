import { useState, useMemo, useEffect, useRef } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip,
  ResponsiveContainer,
} from "recharts";
import {
  AlertTriangle, CheckCircle, XCircle, Activity,
  TrendingUp, TrendingDown, ChevronDown,
} from "lucide-react";
import { useI18n } from "../i18n/context";
import { useFetch } from "../hooks/useApi";
import { fundDisplayName, FUND_HEX_COLORS } from "../lib/fundMeta";
import type { TranslationKey } from "../i18n/translations";
import { InfoPopover } from "./InfoPopover";

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface ShadowOrder {
  id: string;
  paper_trade_id: string;
  fund_id: string;
  market_id: string;
  slug: string;
  question?: string;
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

interface FundStat {
  fundId: string;
  fillCount: number;
  rejectCount: number;
  fillRate: number;
  totalPaperPnl: number;
  totalShadowPnl: number;
  divergence: number;
  readiness: number; // 0-5
}

// ─── Utilities ───────────────────────────────────────────────────────────────

const DIR_SHORT: Record<string, { en: string; zh: string }> = {
  BUY_YES:           { en: "Yes ↑",  zh: "做多↑" },
  SELL_YES:          { en: "Yes ↓",  zh: "做空↓" },
  BUY_BOTH:          { en: "Both ↑", zh: "双↑"  },
  SELL_BOTH:         { en: "Both ↓", zh: "双↓"  },
  BUY_STRONGEST:     { en: "Str ↑",  zh: "强↑"  },
  SELL_WEAKEST:      { en: "Wk ↓",   zh: "弱↓"  },
  PROVIDE_LIQUIDITY: { en: "Liq",    zh: "流动" },
};

function relativeTime(iso: string, locale: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  const hrs  = Math.floor(mins / 60);
  const days = Math.floor(hrs  / 24);
  if (locale === "zh") {
    if (days > 0) return `${days}天前`;
    if (hrs > 0)  return `${hrs}小时前`;
    if (mins > 0) return `${mins}分钟前`;
    return "刚刚";
  }
  if (days > 0) return `${days}d ago`;
  if (hrs  > 0) return `${hrs}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}

function slippageColor(raw: number): string {
  const pct = Math.abs(raw) * 100;
  if (pct < 0.5) return "text-[var(--r-text-muted)]";
  if (pct < 2.0) return "text-[var(--r-yellow)]";
  return "text-[var(--r-red)]";
}

function computeFundStats(orders: ShadowOrder[]): FundStat[] {
  const map: Record<string, { fill: number; reject: number; paperPnl: number; shadowPnl: number }> = {};
  for (const o of orders) {
    if (!map[o.fund_id]) map[o.fund_id] = { fill: 0, reject: 0, paperPnl: 0, shadowPnl: 0 };
    if (o.status === "WOULD_FILL") map[o.fund_id].fill++;
    else map[o.fund_id].reject++;
    if (o.paper_pnl != null) map[o.fund_id].paperPnl += o.paper_pnl;
    if (o.shadow_pnl != null) map[o.fund_id].shadowPnl += o.shadow_pnl;
  }
  return Object.entries(map).map(([fundId, s]) => {
    const total = s.fill + s.reject;
    const fillRate = total > 0 ? Math.round((s.fill / total) * 100) : 0;
    const divergence = s.shadowPnl - s.paperPnl;
    const divPct = s.paperPnl !== 0 ? Math.abs(divergence / s.paperPnl) : 0;
    let readiness = 5;
    if (fillRate < 80) readiness--;
    if (fillRate < 60) readiness--;
    if (divPct > 0.2)  readiness--;
    if (divPct > 0.4)  readiness--;
    return {
      fundId, fillCount: s.fill, rejectCount: s.reject,
      fillRate, totalPaperPnl: s.paperPnl, totalShadowPnl: s.shadowPnl,
      divergence, readiness: Math.max(0, readiness),
    };
  }).sort((a, b) => b.readiness - a.readiness || b.fillRate - a.fillRate);
}

// ─── ReadinessDots ────────────────────────────────────────────────────────────

function ReadinessDots({ score }: { score: number }) {
  const color = score >= 4
    ? "text-[var(--r-green)]"
    : score >= 2 ? "text-[var(--r-yellow)]" : "text-[var(--r-red)]";
  return (
    <span className={`font-mono text-[11px] tracking-widest ${color}`}>
      {Array.from({ length: 5 }, (_, i) => i < score ? "●" : "○").join("")}
    </span>
  );
}

// ─── StatCard ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, icon, color }: {
  label: string; value: string; sub?: string;
  icon: React.ReactNode; color: string;
}) {
  return (
    <div className="glass-card p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className={color}>{icon}</span>
        <span className="text-xs text-[var(--r-text-muted)]">{label}</span>
      </div>
      <p className="text-xl font-bold font-mono tabular-nums">{value}</p>
      {sub && <p className="text-xs text-[var(--r-text-faint)] mt-1">{sub}</p>}
    </div>
  );
}

// ─── SystemStatusBanner ───────────────────────────────────────────────────────

function SystemStatusBanner({ system }: { system: SystemResponse }) {
  const { t } = useI18n();
  const isHalted = system.killSwitch;
  const isShadow = system.executionMode === "shadow";
  return (
    <div className={`glass-card p-4 mb-6 flex items-center justify-between ${isHalted ? "border-[var(--r-red)]/30" : ""}`}>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${isHalted ? "bg-[var(--r-red)]" : "bg-[var(--r-green)] animate-pulse"}`} />
          <span className="text-sm font-medium flex items-center gap-1">
            {t("killSwitch")}: {isHalted ? t("killSwitchActive") : t("killSwitchInactive")}
            <InfoPopover text={t("tipKillSwitch")} />
          </span>
        </div>
        <div className="h-4 w-px bg-[var(--r-border)]" />
        <div className="flex items-center gap-2">
          <Activity className="w-3.5 h-3.5 text-[var(--r-text-muted)]" />
          <span className="text-sm flex items-center gap-1">
            {t("executionMode")}:{" "}
            <span className={`font-medium ${isShadow ? "text-[var(--r-accent)]" : "text-[var(--r-text-muted)]"}`}>
              {isShadow ? t("executionModeShadow") : t("executionModePaper")}
            </span>
            <InfoPopover text={t("tipExecutionMode")} />
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

// ─── FundReadinessMatrix ──────────────────────────────────────────────────────

function FundReadinessMatrix({ fundStats, t }: {
  fundStats: FundStat[];
  t: (k: TranslationKey) => string;
}) {
  if (fundStats.length === 0) return null;
  return (
    <div className="glass-card mb-4">
      <div className="px-4 pt-3 pb-1 flex items-center gap-1.5">
        <h3 className="text-xs font-medium text-[var(--r-text-muted)] uppercase tracking-widest">
          {t("shadowFundMatrix")}
        </h3>
        <InfoPopover text={t("shadowReadinessTip")} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[var(--r-border)]">
              <th className="text-left px-4 py-2 text-[var(--r-text-muted)] font-medium">{t("fund")}</th>
              <th className="text-center px-3 py-2 text-[var(--r-text-muted)] font-medium">{t("shadowFillRate")}</th>
              <th className="text-right px-3 py-2 text-[var(--r-text-muted)] font-medium">{t("shadowPaperPnl")}</th>
              <th className="text-right px-3 py-2 text-[var(--r-text-muted)] font-medium">{t("shadowRealPnl")}</th>
              <th className="text-right px-3 py-2 text-[var(--r-text-muted)] font-medium">{t("shadowDivergence")}</th>
              <th className="text-center px-4 py-2 text-[var(--r-text-muted)] font-medium">{t("shadowReadiness")}</th>
            </tr>
          </thead>
          <tbody>
            {fundStats.map(s => {
              const color = FUND_HEX_COLORS[s.fundId] ?? "#a1a1aa";
              const rateColor = s.fillRate >= 90 ? "text-[var(--r-green)]"
                : s.fillRate >= 70 ? "text-[var(--r-yellow)]" : "text-[var(--r-red)]";
              const rateBarColor = s.fillRate >= 90 ? "bg-[var(--r-green)]"
                : s.fillRate >= 70 ? "bg-[var(--r-yellow)]" : "bg-[var(--r-red)]";
              const divColor = Math.abs(s.divergence) < 5 ? "text-[var(--r-green)]"
                : Math.abs(s.divergence) < 20 ? "text-[var(--r-yellow)]" : "text-[var(--r-red)]";
              return (
                <tr key={s.fundId} className="border-b border-[var(--r-border)]/40 hover:bg-[var(--r-surface-hover)]">
                  <td className="px-4 py-2.5 font-medium" style={{ color }}>
                    {fundDisplayName(s.fundId, t)}
                    <span className="ml-1.5 text-[10px] text-[var(--r-text-faint)]">
                      {s.fillCount}↑ {s.rejectCount}↓
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <div className="flex flex-col items-center gap-1">
                      <span className={`font-mono ${rateColor}`}>{s.fillRate}%</span>
                      <div className="w-14 h-1 bg-[var(--r-border)] rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${rateBarColor}`} style={{ width: `${s.fillRate}%` }} />
                      </div>
                    </div>
                  </td>
                  <td className={`px-3 py-2.5 text-right font-mono tabular-nums ${s.totalPaperPnl >= 0 ? "text-[var(--r-green)]" : "text-[var(--r-red)]"}`}>
                    {s.totalPaperPnl >= 0 ? "+" : ""}{s.totalPaperPnl.toFixed(2)}
                  </td>
                  <td className={`px-3 py-2.5 text-right font-mono tabular-nums ${s.totalShadowPnl >= 0 ? "text-[var(--r-green)]" : "text-[var(--r-red)]"}`}>
                    {s.totalShadowPnl >= 0 ? "+" : ""}{s.totalShadowPnl.toFixed(2)}
                  </td>
                  <td className={`px-3 py-2.5 text-right font-mono tabular-nums ${divColor}`}>
                    {s.divergence >= 0 ? "+" : ""}{s.divergence.toFixed(2)}
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    <ReadinessDots score={s.readiness} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── PnlComparisonChart ───────────────────────────────────────────────────────

function PnlComparisonChart({ fundStats, t }: {
  fundStats: FundStat[];
  t: (k: TranslationKey) => string;
}) {
  const chartData = fundStats
    .filter(s => s.totalPaperPnl !== 0 || s.totalShadowPnl !== 0)
    .map(s => ({
      fund: fundDisplayName(s.fundId, t),
      paper: parseFloat(s.totalPaperPnl.toFixed(2)),
      shadow: parseFloat(s.totalShadowPnl.toFixed(2)),
    }));

  if (chartData.length < 2) return null;
  const minWidth = Math.max(360, chartData.length * 80);

  return (
    <div className="glass-card mb-4 p-4">
      <h3 className="text-xs font-medium text-[var(--r-text-muted)] uppercase tracking-widest mb-3">
        {t("shadowPaperVsShadow")}
      </h3>
      <div className="overflow-x-auto">
        <div style={{ minWidth }}>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={chartData} barGap={2} barCategoryGap="30%">
              <XAxis dataKey="fund" tick={{ fill: "#a1a1aa", fontSize: 10 }} axisLine={{ stroke: "#27272a" }} tickLine={false} />
              <YAxis tick={{ fill: "#a1a1aa", fontSize: 10 }} axisLine={{ stroke: "#27272a" }} tickLine={false} tickFormatter={(v: number) => `$${v.toFixed(0)}`} />
              <RTooltip
                cursor={{ fill: "rgba(255,255,255,0.04)" }}
                contentStyle={{ background: "#111113", border: "1px solid #27272a", borderRadius: 8, fontSize: 12 }}
                content={(props: object) => {
                  const p = props as { active?: boolean; payload?: { name?: string; value?: number }[]; label?: string };
                  if (!p.active || !p.payload?.length) return null;
                  return (
                    <div style={{ background: "#111113", border: "1px solid #27272a", borderRadius: 8, padding: "8px 12px", fontSize: 12 }}>
                      <p style={{ color: "#a1a1aa", marginBottom: 4, fontSize: 11 }}>{p.label}</p>
                      {p.payload.map(entry => (
                        <div key={entry.name} style={{ display: "flex", justifyContent: "space-between", gap: 12, color: entry.name === "paper" ? "#22d3ee" : "#a78bfa" }}>
                          <span>{entry.name === "paper" ? t("shadowPaperPnl") : t("shadowRealPnl")}</span>
                          <span style={{ fontVariantNumeric: "tabular-nums" }}>
                            {(entry.value ?? 0) >= 0 ? "+" : ""}${(entry.value ?? 0).toFixed(2)}
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                }}
              />
              <Bar dataKey="paper"  fill="#22d3ee" fillOpacity={0.8} radius={[3, 3, 0, 0]} />
              <Bar dataKey="shadow" fill="#a78bfa" fillOpacity={0.8} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="flex items-center gap-4 mt-1 justify-end px-1">
        <span className="flex items-center gap-1.5 text-[10px] text-[var(--r-text-muted)]">
          <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: "#22d3ee" }} />
          {t("shadowPaperPnl")}
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-[var(--r-text-muted)]">
          <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: "#a78bfa" }} />
          {t("shadowRealPnl")}
        </span>
      </div>
    </div>
  );
}

// ─── FundDropdown ─────────────────────────────────────────────────────────────

function FundDropdown({ fundIds, value, onChange, t }: {
  fundIds: string[];
  value: string;
  onChange: (v: string) => void;
  t: (k: TranslationKey) => string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, []);

  const label = value === "all" ? t("shadowAllFunds") : fundDisplayName(value, t);
  return (
    <div ref={ref} className="relative">
      <button
        onMouseDown={e => { e.preventDefault(); setOpen(o => !o); }}
        className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border border-[var(--r-border)] text-[var(--r-text-muted)] hover:border-[var(--r-text-muted)] transition-colors bg-[var(--r-surface)]"
      >
        <span>{label}</span>
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-20 glass-card min-w-[144px] py-1 shadow-lg">
          {["all", ...fundIds].map(fid => (
            <button
              key={fid}
              onMouseDown={e => { e.preventDefault(); onChange(fid); setOpen(false); }}
              className={`w-full text-left text-xs px-3 py-1.5 hover:bg-[var(--r-surface-hover)] transition-colors ${value === fid ? "text-[var(--r-accent)]" : "text-[var(--r-text)]"}`}
            >
              {fid === "all" ? t("shadowAllFunds") : fundDisplayName(fid, t)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── FilterBar ────────────────────────────────────────────────────────────────

function FilterBar({ fundIds, filterFund, setFilterFund, filterStatus, setFilterStatus,
  sortKey, setSortKey, total, filtered, t, locale }: {
  fundIds: string[];
  filterFund: string; setFilterFund: (v: string) => void;
  filterStatus: "all" | "WOULD_FILL" | "WOULD_REJECT"; setFilterStatus: (v: "all" | "WOULD_FILL" | "WOULD_REJECT") => void;
  sortKey: "time" | "paperPnl" | "slippage"; setSortKey: (v: "time" | "paperPnl" | "slippage") => void;
  total: number; filtered: number;
  t: (k: TranslationKey) => string; locale: string;
}) {
  const statusOpts: { key: "all" | "WOULD_FILL" | "WOULD_REJECT"; label: string; icon?: React.ReactNode }[] = [
    { key: "all",          label: locale === "zh" ? "全部" : "All" },
    { key: "WOULD_FILL",   label: t("shadowFill"),   icon: <CheckCircle className="w-2.5 h-2.5" /> },
    { key: "WOULD_REJECT", label: t("shadowReject"), icon: <XCircle    className="w-2.5 h-2.5" /> },
  ];
  const sortOpts: { key: "time" | "paperPnl" | "slippage"; label: string }[] = [
    { key: "time",     label: t("shadowTime") },
    { key: "paperPnl", label: "PnL" },
    { key: "slippage", label: t("shadowSlippage") },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <FundDropdown fundIds={fundIds} value={filterFund} onChange={setFilterFund} t={t} />
      <div className="flex items-center gap-1">
        {statusOpts.map(opt => (
          <button
            key={opt.key}
            onMouseDown={e => { e.preventDefault(); setFilterStatus(opt.key); }}
            className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border transition-colors ${
              filterStatus === opt.key
                ? "bg-[var(--r-accent)]/20 text-[var(--r-accent)] border-[var(--r-accent)]/40"
                : "text-[var(--r-text-muted)] border-[var(--r-border)] hover:border-[var(--r-text-muted)]"
            }`}
          >
            {opt.icon}{opt.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1 ml-auto">
        <span className="text-[10px] text-[var(--r-text-faint)]">{locale === "zh" ? "排序:" : "Sort:"}</span>
        {sortOpts.map(opt => (
          <button
            key={opt.key}
            onMouseDown={e => { e.preventDefault(); setSortKey(opt.key); }}
            className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
              sortKey === opt.key
                ? "bg-[var(--r-accent)]/20 text-[var(--r-accent)] border-[var(--r-accent)]/40"
                : "text-[var(--r-text-muted)] border-[var(--r-border)] hover:border-[var(--r-text-muted)]"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {filtered !== total && (
        <span className="text-[10px] text-[var(--r-text-faint)]">{filtered}/{total}</span>
      )}
    </div>
  );
}

// ─── OrderTable (desktop) ─────────────────────────────────────────────────────

function OrderTable({ orders, t, locale }: {
  orders: ShadowOrder[];
  t: (k: TranslationKey) => string;
  locale: string;
}) {
  if (orders.length === 0) {
    return (
      <div className="glass-card p-8 text-center text-sm text-[var(--r-text-muted)]">
        {t("shadowNoFiltered")}
      </div>
    );
  }
  return (
    <div className="glass-card">
      <div className="overflow-x-auto rounded-[10px]">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-[var(--r-border)]">
              <th className="text-left p-3 text-[var(--r-text-muted)] font-medium">{t("fund")}</th>
              <th className="text-left p-3 text-[var(--r-text-muted)] font-medium">Dir.</th>
              <th className="text-right p-3 text-[var(--r-text-muted)] font-medium">{t("shadowEntryFill")}</th>
              <th className="text-right p-3 text-[var(--r-text-muted)] font-medium">{t("shadowSlippage")}</th>
              <th className="text-center p-3 text-[var(--r-text-muted)] font-medium">{t("shadowStatus")}</th>
              <th className="text-right p-3 text-[var(--r-text-muted)] font-medium">{t("shadowPaperPnl")}</th>
              <th className="text-right p-3 text-[var(--r-text-muted)] font-medium">{t("shadowRealPnl")}</th>
              <th className="text-right p-3 text-[var(--r-text-muted)] font-medium">{t("shadowTime")}</th>
            </tr>
          </thead>
          <tbody>
            {orders.map(order => {
              const fundColor = FUND_HEX_COLORS[order.fund_id] ?? "#a1a1aa";
              const dirInfo = DIR_SHORT[order.direction];
              const dirLabel = dirInfo ? (locale === "zh" ? dirInfo.zh : dirInfo.en) : order.direction;
              const slipPct = order.simulated_slippage * 100;
              const isFill = order.status === "WOULD_FILL";
              return (
                <tr key={order.id} className="border-b border-[var(--r-border)]/50 hover:bg-[var(--r-surface-hover)]">
                  {/* Fund + Side badge + question as native tooltip */}
                  <td className="p-3" title={order.question || undefined}>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium" style={{ color: fundColor }}>
                        {fundDisplayName(order.fund_id, t)}
                      </span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded self-start font-medium ${
                        order.side === "BUY"
                          ? "bg-[var(--r-green)]/15 text-[var(--r-green)]"
                          : "bg-[var(--r-red)]/15 text-[var(--r-red)]"
                      }`}>
                        {order.side === "BUY" ? t("shadowBuy") : t("shadowSell")}
                      </span>
                    </div>
                  </td>
                  {/* Direction (compact) */}
                  <td className="p-3 text-[var(--r-text-muted)]">{dirLabel}</td>
                  {/* Entry → Fill price (stacked) */}
                  <td className="p-3 text-right font-mono">
                    <div className="flex flex-col items-end gap-0.5">
                      <span className="text-[var(--r-text-faint)]">{order.price.toFixed(4)}</span>
                      <span className="text-[9px] text-[var(--r-text-faint)] leading-none">↓</span>
                      <span>{order.simulated_fill_price.toFixed(4)}</span>
                    </div>
                  </td>
                  {/* Slippage — color-coded */}
                  <td className={`p-3 text-right font-mono ${slippageColor(order.simulated_slippage)}`}>
                    {slipPct.toFixed(2)}%
                  </td>
                  {/* Status */}
                  <td className="p-3 text-center">
                    {isFill ? (
                      <span className="inline-flex items-center gap-1 text-[var(--r-green)] bg-[var(--r-green)]/10 px-1.5 py-0.5 rounded">
                        <CheckCircle className="w-3 h-3" />{t("shadowFill")}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[var(--r-red)] bg-[var(--r-red)]/10 px-1.5 py-0.5 rounded">
                        <XCircle className="w-3 h-3" />{t("shadowReject")}
                      </span>
                    )}
                  </td>
                  {/* Paper PnL */}
                  <td className="p-3 text-right font-mono">
                    {order.paper_pnl !== null ? (
                      <span className={order.paper_pnl >= 0 ? "text-[var(--r-green)]" : "text-[var(--r-red)]"}>
                        {order.paper_pnl >= 0 ? "+" : ""}{order.paper_pnl.toFixed(2)}
                      </span>
                    ) : "—"}
                  </td>
                  {/* Shadow PnL or opportunity cost for rejects */}
                  <td className="p-3 text-right font-mono">
                    {order.shadow_pnl !== null ? (
                      <span className={order.shadow_pnl >= 0 ? "text-[var(--r-green)]" : "text-[var(--r-red)]"}>
                        {order.shadow_pnl >= 0 ? "+" : ""}{order.shadow_pnl.toFixed(2)}
                      </span>
                    ) : !isFill && order.paper_pnl !== null ? (
                      <span className="text-[var(--r-text-faint)] text-[10px]">
                        ≈{order.paper_pnl >= 0 ? "+" : ""}{order.paper_pnl.toFixed(2)}{" "}
                        <span className="opacity-60">{t("shadowOpCost")}</span>
                      </span>
                    ) : "—"}
                  </td>
                  {/* Time (relative) */}
                  <td className="p-3 text-right text-[var(--r-text-faint)]">
                    {relativeTime(order.created_at, locale)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── OrderCard (mobile) ───────────────────────────────────────────────────────

function OrderCard({ order, t, locale }: {
  order: ShadowOrder;
  t: (k: TranslationKey) => string;
  locale: string;
}) {
  const fundColor = FUND_HEX_COLORS[order.fund_id] ?? "#a1a1aa";
  const isFill = order.status === "WOULD_FILL";
  const slipPct = order.simulated_slippage * 100;
  return (
    <div className="glass-card p-3">
      {/* Row 1: fund + side + status + time */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium" style={{ color: fundColor }}>
            {fundDisplayName(order.fund_id, t)}
          </span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
            order.side === "BUY"
              ? "bg-[var(--r-green)]/15 text-[var(--r-green)]"
              : "bg-[var(--r-red)]/15 text-[var(--r-red)]"
          }`}>
            {order.side === "BUY" ? t("shadowBuy") : t("shadowSell")}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isFill
            ? <CheckCircle className="w-3.5 h-3.5 text-[var(--r-green)]" />
            : <XCircle    className="w-3.5 h-3.5 text-[var(--r-red)]"   />}
          <span className="text-[10px] text-[var(--r-text-faint)]">{relativeTime(order.created_at, locale)}</span>
        </div>
      </div>
      {/* Row 2: Paper vs Shadow PnL */}
      <div className="flex items-center justify-between text-xs mb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[var(--r-text-faint)]">{t("shadowPaperShort")}</span>
          {order.paper_pnl !== null ? (
            <span className={`font-mono font-medium ${order.paper_pnl >= 0 ? "text-[var(--r-green)]" : "text-[var(--r-red)]"}`}>
              {order.paper_pnl >= 0 ? "+" : ""}{order.paper_pnl.toFixed(2)}
            </span>
          ) : <span className="text-[var(--r-text-faint)]">—</span>}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[var(--r-text-faint)]">{t("shadowShadowShort")}</span>
          {order.shadow_pnl !== null ? (
            <span className={`font-mono font-medium ${order.shadow_pnl >= 0 ? "text-[var(--r-green)]" : "text-[var(--r-red)]"}`}>
              {order.shadow_pnl >= 0 ? "+" : ""}{order.shadow_pnl.toFixed(2)}
            </span>
          ) : (
            <span className="text-[var(--r-text-faint)] text-[10px]">
              {!isFill && order.paper_pnl !== null
                ? `≈${order.paper_pnl.toFixed(2)} ${t("shadowOpCost")}`
                : "—"}
            </span>
          )}
        </div>
      </div>
      {/* Row 3: Slippage + Entry→Fill */}
      <div className="flex items-center justify-between text-[10px] text-[var(--r-text-faint)]">
        <span className={slippageColor(order.simulated_slippage)}>
          {t("shadowSlippage")}: {slipPct.toFixed(2)}%
        </span>
        <span className="font-mono">
          {order.price.toFixed(4)} → {order.simulated_fill_price.toFixed(4)}
        </span>
      </div>
      {/* Row 4: Market question (truncated) */}
      {order.question && (
        <p className="text-[10px] text-[var(--r-text-faint)] mt-1.5 truncate" title={order.question}>
          {order.question}
        </p>
      )}
    </div>
  );
}

// ─── Main ShadowPanel ─────────────────────────────────────────────────────────

export function ShadowPanel() {
  const { t, locale } = useI18n();
  const { data: shadowData, loading: shadowLoading, error: shadowError } = useFetch<ShadowResponse>("/api/shadow?limit=100", 30_000);
  const { data: systemData, loading: systemLoading } = useFetch<SystemResponse>("/api/system", 10_000);

  const [filterFund,   setFilterFund]   = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<"all" | "WOULD_FILL" | "WOULD_REJECT">("all");
  const [sortKey,      setSortKey]      = useState<"time" | "paperPnl" | "slippage">("time");
  const [isMobile,     setIsMobile]     = useState(
    typeof window !== "undefined" ? window.innerWidth < 640 : false,
  );

  useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);

  // All hooks before conditional returns
  const rawOrders = shadowData?.orders ?? [];
  // Deduplicate by paper_trade_id: each paper trade may have multiple shadow
  // evaluations (one per cron tick); keep only the most-recent per trade.
  const orders = useMemo(() => {
    const seen = new Map<string, ShadowOrder>();
    for (const o of rawOrders) {
      const existing = seen.get(o.paper_trade_id);
      if (!existing || new Date(o.created_at) > new Date(existing.created_at)) {
        seen.set(o.paper_trade_id, o);
      }
    }
    return [...seen.values()];
  }, [rawOrders]);

  // Recompute summary from deduped orders so KPI header is consistent with
  // Fund Matrix (which also operates on deduped orders).
  const summary = useMemo<ShadowSummary | null>(() => {
    if (orders.length === 0) return null;
    const wouldFill   = orders.filter(o => o.status === "WOULD_FILL").length;
    const wouldReject = orders.filter(o => o.status === "WOULD_REJECT").length;
    const totalPaperPnl  = orders.reduce((s, o) => s + (o.paper_pnl  ?? 0), 0);
    const totalShadowPnl = orders.reduce((s, o) => s + (o.shadow_pnl ?? 0), 0);
    const filled = orders.filter(o => o.paper_pnl !== null && o.shadow_pnl !== null);
    const avgSlippageImpact = filled.length > 0
      ? filled.reduce((s, o) => s + ((o.paper_pnl ?? 0) - (o.shadow_pnl ?? 0)), 0) / filled.length
      : 0;
    return {
      wouldFill,
      wouldReject,
      fillRate: Math.round((wouldFill / orders.length) * 100),
      avgSlippageImpact: Math.round(avgSlippageImpact * 100) / 100,
      totalPaperPnl:  Math.round(totalPaperPnl  * 100) / 100,
      totalShadowPnl: Math.round(totalShadowPnl * 100) / 100,
      pnlDivergence:  Math.round((totalPaperPnl - totalShadowPnl) * 100) / 100,
    };
  }, [orders]);
  const fundStats = useMemo(() => computeFundStats(orders), [orders]);
  const allFundIds = useMemo(
    () => [...new Set(orders.map(o => o.fund_id))].sort(),
    [orders],
  );
  const filteredOrders = useMemo(() => {
    let result = [...orders];
    if (filterFund !== "all")   result = result.filter(o => o.fund_id === filterFund);
    if (filterStatus !== "all") result = result.filter(o => o.status === filterStatus);
    result.sort((a, b) => {
      if (sortKey === "time")     return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      if (sortKey === "paperPnl") return (b.paper_pnl ?? 0) - (a.paper_pnl ?? 0);
      if (sortKey === "slippage") return Math.abs(b.simulated_slippage) - Math.abs(a.simulated_slippage);
      return 0;
    });
    return result;
  }, [orders, filterFund, filterStatus, sortKey]);

  if (shadowLoading || systemLoading) {
    return (
      <div className="space-y-4">
        {[...Array(4)].map((_, i) => <div key={i} className="glass-card p-5 h-24 animate-pulse" />)}
      </div>
    );
  }
  if (shadowError && !shadowData) {
    return <div className="glass-card p-8 text-center text-sm text-[var(--r-red)]">{shadowError}</div>;
  }

  const system = systemData ?? { killSwitch: false, executionMode: "paper" };

  return (
    <div>
      <SystemStatusBanner system={system} />

      {summary && orders.length > 0 ? (
        <>
          {/* ── KPI summary cards ── */}
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

          {/* ── Fund readiness matrix ── */}
          <FundReadinessMatrix fundStats={fundStats} t={t} />

          {/* ── PnL comparison chart ── */}
          <PnlComparisonChart fundStats={fundStats} t={t} />

          {/* ── Filter toolbar ── */}
          <FilterBar
            fundIds={allFundIds}
            filterFund={filterFund} setFilterFund={setFilterFund}
            filterStatus={filterStatus} setFilterStatus={setFilterStatus}
            sortKey={sortKey} setSortKey={setSortKey}
            total={orders.length} filtered={filteredOrders.length}
            t={t} locale={locale}
          />

          {/* ── Order list — card on mobile, table on desktop ── */}
          {isMobile ? (
            <div className="space-y-2">
              {filteredOrders.length === 0
                ? <div className="glass-card p-8 text-center text-sm text-[var(--r-text-muted)]">{t("shadowNoFiltered")}</div>
                : filteredOrders.map(order => <OrderCard key={order.id} order={order} t={t} locale={locale} />)}
            </div>
          ) : (
            <OrderTable orders={filteredOrders} t={t} locale={locale} />
          )}
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
