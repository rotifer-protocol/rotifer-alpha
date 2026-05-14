/**
 * AnalysisPage — Historical analysis view for all funds.
 * Three tabs: NAV Trend Chart, Daily Returns Heatmap, Trade History.
 */

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { ArrowLeft, Download, ChevronDown } from "lucide-react";
import { useI18n } from "../i18n/context";
import { useFetch } from "../hooks/useApi";
import {
  fundDisplayName,
  fmtCompact,
  FUND_HEX_COLORS,
  fundTierLabel,
} from "../lib/fundMeta";
import type { FundData } from "../App";

// ─── Local types ──────────────────────────────────────────────────────────────

interface SnapshotData {
  fund_id: string;
  date: string; // "YYYY-MM-DD"
  total_value: number;
}

// ─── Trade data (from /api/trades, not /api/events) ──────────────────────────

/** Row shape returned by GET /api/trades — direct from paper_trades table. */
interface TradeRow {
  fund_id: string;          // snake_case, matches FundData.id (e.g. "shark", "shark_m")
  market_id?: string;
  slug?: string;
  question?: string;
  direction?: string;
  amount?: number;
  status: string;           // OPEN | RESOLVED | STOPPED | EXPIRED | PROFIT_TAKEN | TRAILING_STOPPED | REVERSED
  pnl?: number | null;
  opened_at?: string;       // ISO string
  closed_at?: string | null;
}

const TRADE_STATUSES = [
  "OPEN",
  "RESOLVED",
  "PROFIT_TAKEN",
  "STOPPED",
  "EXPIRED",
  "TRAILING_STOPPED",
  "REVERSED",
] as const;

const STATUS_META: Record<string, { zh: string; en: string; badge: string }> = {
  OPEN:              { zh: "开仓",    en: "Opened",     badge: "text-[var(--r-accent)] bg-[var(--r-accent)]/10" },
  RESOLVED:         { zh: "结算",    en: "Settled",    badge: "text-[var(--r-green)] bg-[var(--r-green)]/10" },
  PROFIT_TAKEN:     { zh: "止盈",    en: "Profit",     badge: "text-[var(--r-green)] bg-[var(--r-green)]/10" },
  STOPPED:          { zh: "止损",    en: "Stopped",    badge: "text-[var(--r-text-faint)] bg-white/5" },
  EXPIRED:          { zh: "到期",    en: "Expired",    badge: "text-[var(--r-text-faint)] bg-white/5" },
  TRAILING_STOPPED: { zh: "跟踪止损", en: "Trail-Stop", badge: "text-[var(--r-text-faint)] bg-white/5" },
  REVERSED:         { zh: "反向",    en: "Reversed",   badge: "text-yellow-400/80 bg-yellow-400/10" },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dateCutoff(range: "7d" | "30d" | "90d" | "all"): string | null {
  if (range === "all") return null;
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function shortDate(isoDate: string): string {
  const [, m, d] = isoDate.split("-");
  return `${parseInt(m)}/${parseInt(d)}`;
}

function fullDate(isoDate: string, isZh: boolean): string {
  const [y, m, d] = isoDate.split("-");
  return isZh
    ? `${y}年${parseInt(m)}月${parseInt(d)}日`
    : `${y}-${m}-${d}`;
}

function returnCell(ret: number | null): { bg: string; fg: string } {
  if (ret === null) return { bg: "", fg: "" };
  if (ret > 3) return { bg: "bg-green-500/65", fg: "text-white" };
  if (ret > 1) return { bg: "bg-green-400/38", fg: "text-green-300" };
  if (ret > 0) return { bg: "bg-green-300/22", fg: "text-green-400" };
  if (ret > -1) return { bg: "bg-red-300/22", fg: "text-red-400" };
  if (ret > -3) return { bg: "bg-red-400/38", fg: "text-red-300" };
  return { bg: "bg-red-500/65", fg: "text-white" };
}

function downloadCSV(trades: TradeRow[], funds: FundData[]) {
  const fundMap = new Map(funds.map((f) => [f.id, f]));
  const header = "Time,Fund,Status,Market,Direction,Amount,PnL";
  const lines = trades.map((t) => {
    const time = new Date(t.closed_at ?? t.opened_at ?? "").toISOString();
    const fund = fundMap.get(t.fund_id);
    const name = fund ? fundDisplayName(fund.id, (k) => k) : t.fund_id;
    const market = `"${(t.question ?? "").replace(/"/g, '""').slice(0, 100)}"`;
    return [time, name, t.status, market, t.direction ?? "", t.amount ?? "", t.pnl ?? ""].join(",");
  });
  const csv = [header, ...lines].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `petri-trades-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Shared micro-components ──────────────────────────────────────────────────

function Pill({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-all whitespace-nowrap focus:outline-none ${
        active
          ? "bg-[var(--r-accent)] text-white"
          : "border border-[var(--r-border)] text-[var(--r-text-muted)] hover:border-[var(--r-accent)] hover:text-[var(--r-text)]"
      }`}
    >
      {children}
    </button>
  );
}

function ControlRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-5">{children}</div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="glass-card p-14 text-center text-[var(--r-text-faint)] text-sm">
      {label}
    </div>
  );
}

// ─── GlassDropdown — design-system-consistent select ─────────────────────────

function GlassDropdown({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: React.ReactNode }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onOutsideClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [open]);

  const selected = options.find((o) => o.value === value);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((s) => !s)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] border
          border-[var(--r-border)] bg-[var(--r-surface)] text-[var(--r-text-muted)]
          hover:border-[var(--r-accent)] hover:text-[var(--r-text)] transition-colors focus:outline-none"
      >
        {selected?.label ?? value}
        <ChevronDown
          className={`w-3 h-3 opacity-50 transition-transform shrink-0 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          className="absolute top-full left-0 mt-1 z-40 glass-card py-1 shadow-2xl
            min-w-full max-h-64 overflow-y-auto"
          style={{ minWidth: 160 }}
        >
          {options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors
                flex items-center gap-2 whitespace-nowrap hover:bg-white/5 ${
                  opt.value === value
                    ? "text-[var(--r-accent)]"
                    : "text-[var(--r-text-muted)]"
                }`}
            >
              <span
                className={`text-[9px] shrink-0 ${opt.value === value ? "visible" : "invisible"}`}
              >
                ✓
              </span>
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── NAV chart tooltip ────────────────────────────────────────────────────────

function NavTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { dataKey: string; name: string; value: number; stroke: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const sorted = [...payload]
    .filter((e) => e.value != null)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  return (
    <div className="glass-card px-3 py-2.5 text-[11px] min-w-[160px] shadow-xl">
      <div className="text-[var(--r-text-faint)] mb-2 font-medium">{label}</div>
      {sorted.map((entry) => (
        <div
          key={entry.dataKey}
          className="flex items-center justify-between gap-3 leading-relaxed"
        >
          <div className="flex items-center gap-1 min-w-0">
            <span style={{ color: entry.stroke }}>●</span>
            <span
              className="text-[var(--r-text-muted)] truncate"
              style={{ maxWidth: 96 }}
            >
              {entry.name}
            </span>
          </div>
          <span
            className={`font-mono tabular-nums font-medium ${
              (entry.value ?? 100) >= 100
                ? "text-[var(--r-green)]"
                : "text-[var(--r-red)]"
            }`}
          >
            {entry.value != null ? entry.value.toFixed(1) : "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Tab 1 — NAV Trend Chart ──────────────────────────────────────────────────

function NavTrendPanel({
  snapshots,
  funds,
}: {
  snapshots: SnapshotData[];
  funds: FundData[];
}) {
  const { t, locale } = useI18n();
  const isZh = locale === "zh";
  const [tierFilter, setTierFilter] = useState<"all" | "s" | "m" | "l">("s");
  const [timeRange, setTimeRange] = useState<"7d" | "30d" | "90d" | "all">("all");
  const [hiddenFunds, setHiddenFunds] = useState<Set<string>>(new Set());

  const activeFunds = useMemo(
    () =>
      funds.filter((f) => {
        if (tierFilter === "all") return true;
        return fundTierLabel(f.id).toLowerCase() === tierFilter;
      }),
    [funds, tierFilter]
  );

  const { chartData, xTicks } = useMemo(() => {
    const cutoff = dateCutoff(timeRange);
    const filtered = cutoff
      ? snapshots.filter((s) => s.date >= cutoff)
      : snapshots;

    // Build: fund_id → Map<date, value>
    const byFund = new Map<string, Map<string, number>>();
    filtered.forEach((s) => {
      if (!byFund.has(s.fund_id)) byFund.set(s.fund_id, new Map());
      byFund.get(s.fund_id)!.set(s.date, s.total_value);
    });

    const allDates = [...new Set(filtered.map((s) => s.date))].sort();

    const data = allDates.map((date) => {
      const point: Record<string, string | number | null> = {
        date,
        label: shortDate(date),
        fullDate: fullDate(date, isZh),
      };
      activeFunds.forEach((fund) => {
        const val = byFund.get(fund.id)?.get(date);
        if (val != null && fund.initialBalance > 0) {
          point[fund.id] =
            Math.round((val / fund.initialBalance) * 1000) / 10;
        } else {
          point[fund.id] = null;
        }
      });
      return point;
    });

    // Evenly spaced x-axis ticks (max 8)
    let ticks: string[] = [];
    if (data.length <= 8) {
      ticks = data.map((d) => d.label as string);
    } else {
      const step = Math.ceil(data.length / 7);
      ticks = data
        .filter((_, i) => i === 0 || i % step === 0 || i === data.length - 1)
        .map((d) => d.label as string);
    }

    return { chartData: data, xTicks: ticks };
  }, [snapshots, activeFunds, timeRange, isZh]);

  const toggleFund = useCallback((id: string) => {
    setHiddenFunds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (snapshots.length === 0) return <EmptyState label={t("analysisNoData")} />;

  const tierOpts = (
    [
      { v: "all" as const, l: t("analysisAllTiers") },
      { v: "s" as const, l: t("analysisTierS") },
      { v: "m" as const, l: t("analysisTierM") },
      { v: "l" as const, l: t("analysisTierL") },
    ] as const
  );

  const rangeOpts = (
    [
      { v: "7d" as const, l: t("analysis7D") },
      { v: "30d" as const, l: t("analysis30D") },
      { v: "90d" as const, l: t("analysis90D") },
      { v: "all" as const, l: t("analysisAllTime") },
    ] as const
  );

  return (
    <div>
      <ControlRow>
        {tierOpts.map(({ v, l }) => (
          <Pill key={v} active={tierFilter === v} onClick={() => setTierFilter(v)}>
            {l}
          </Pill>
        ))}
        <div className="flex-1 min-w-0" />
        {rangeOpts.map(({ v, l }) => (
          <Pill key={v} active={timeRange === v} onClick={() => setTimeRange(v)}>
            {l}
          </Pill>
        ))}
      </ControlRow>

      <div className="glass-card p-4 mb-4">
        <div className="text-[10px] text-[var(--r-text-faint)] mb-2 font-mono">
          {t("analysisNAVIndexLabel")} · 100 = start
        </div>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart
            data={chartData}
            margin={{ top: 4, right: 8, left: -14, bottom: 0 }}
          >
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="rgba(255,255,255,0.04)"
            />
            <XAxis
              dataKey="label"
              ticks={xTicks}
              tick={{ fontSize: 10, fill: "var(--r-text-faint)" }}
              axisLine={{ stroke: "rgba(255,255,255,0.06)" }}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "var(--r-text-faint)" }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `${v}`}
              width={42}
            />
            <Tooltip content={<NavTooltip />} />
            <ReferenceLine
              y={100}
              stroke="rgba(255,255,255,0.10)"
              strokeDasharray="4 3"
            />
            {activeFunds
              .filter((f) => !hiddenFunds.has(f.id))
              .map((fund) => (
                <Line
                  key={fund.id}
                  type="monotone"
                  dataKey={fund.id}
                  name={fundDisplayName(fund.id, t)}
                  stroke={FUND_HEX_COLORS[fund.id] ?? "#6b7280"}
                  dot={false}
                  strokeWidth={1.5}
                  connectNulls={false}
                  activeDot={{ r: 3, strokeWidth: 0 }}
                />
              ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Fund toggle legend */}
      <div className="flex flex-wrap gap-1.5">
        {activeFunds.map((fund) => {
          const color = FUND_HEX_COLORS[fund.id] ?? "#6b7280";
          const hidden = hiddenFunds.has(fund.id);
          return (
            <button
              key={fund.id}
              onClick={() => toggleFund(fund.id)}
              className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] border transition-all focus:outline-none"
              style={{
                borderColor: hidden ? "rgba(255,255,255,0.08)" : color,
                color: hidden ? "var(--r-text-faint)" : color,
                opacity: hidden ? 0.4 : 1,
              }}
            >
              <span>{fund.emoji}</span>
              <span>{fundDisplayName(fund.id, t)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Tab 2 — Daily Returns Heatmap ───────────────────────────────────────────

function DailyReturnsPanel({
  snapshots,
  funds,
}: {
  snapshots: SnapshotData[];
  funds: FundData[];
}) {
  const { t, locale } = useI18n();
  const isZh = locale === "zh";
  const [days, setDays] = useState<7 | 14 | 30>(14);

  const { dates, returnMap } = useMemo(() => {
    const byFund = new Map<string, { date: string; value: number }[]>();
    snapshots.forEach((s) => {
      if (!byFund.has(s.fund_id)) byFund.set(s.fund_id, []);
      byFund.get(s.fund_id)!.push({ date: s.date, value: s.total_value });
    });
    byFund.forEach((arr) => arr.sort((a, b) => a.date.localeCompare(b.date)));

    const allDates = [...new Set(snapshots.map((s) => s.date))].sort();
    const recentDates = allDates.slice(-days);

    const rmap = new Map<string, Map<string, number | null>>();
    byFund.forEach((arr, fundId) => {
      const fmap = new Map<string, number | null>();
      const dateToVal = new Map(arr.map((a) => [a.date, a.value]));
      recentDates.forEach((date, i) => {
        if (i === 0) {
          fmap.set(date, null);
          return;
        }
        const prevDate = recentDates[i - 1];
        const curr = dateToVal.get(date);
        const prev = dateToVal.get(prevDate);
        if (curr == null || prev == null || prev === 0) {
          fmap.set(date, null);
          return;
        }
        fmap.set(date, ((curr - prev) / prev) * 100);
      });
      rmap.set(fundId, fmap);
    });

    return { dates: recentDates, returnMap: rmap };
  }, [snapshots, days]);

  if (snapshots.length === 0) return <EmptyState label={t("analysisNoData")} />;

  const dayOpts = ([7, 14, 30] as const).map((d) => ({
    v: d,
    l: d === 7 ? t("analysis7D") : d === 14 ? (isZh ? "14 天" : "14D") : t("analysis30D"),
  }));

  return (
    <div>
      <ControlRow>
        {dayOpts.map(({ v, l }) => (
          <Pill key={v} active={days === v} onClick={() => setDays(v)}>
            {l}
          </Pill>
        ))}
        <span className="text-[10px] text-[var(--r-text-faint)] ml-1">
          {isZh ? "（数值为当日相较前日的收益率 %）" : "(% change vs. previous day)"}
        </span>
      </ControlRow>

      {/* Scrollable heatmap table */}
      <div className="overflow-x-auto -mx-4 px-4 pb-2">
        <table
          className="text-[11px] border-collapse"
          style={{ minWidth: Math.max(520, 110 + dates.length * 46) }}
        >
          <thead>
            <tr>
              <th
                className="text-left text-[var(--r-text-faint)] font-normal py-1.5 pr-3 sticky left-0 z-20"
                style={{
                  background: "var(--r-bg)",
                  minWidth: 112,
                  width: 112,
                  boxShadow: "2px 0 4px -1px var(--r-bg)",
                }}
              >
                {isZh ? "基金" : "Fund"}
              </th>
              {dates.map((d) => (
                <th
                  key={d}
                  className="text-center text-[var(--r-text-faint)] font-normal py-1.5 px-1"
                  style={{ minWidth: 44 }}
                >
                  {shortDate(d)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {funds.map((fund) => {
              const fmap = returnMap.get(fund.id);
              return (
                <tr key={fund.id}>
                  <td
                    className="py-1 pr-3 sticky left-0 z-20"
                    style={{ background: "var(--r-bg)", boxShadow: "2px 0 4px -1px var(--r-bg)" }}
                  >
                    <div className="flex items-center gap-1.5 whitespace-nowrap">
                      <span>{fund.emoji}</span>
                      <span className="text-[var(--r-text-muted)]">
                        {fundDisplayName(fund.id, t)}
                      </span>
                    </div>
                  </td>
                  {dates.map((d) => {
                    const ret = fmap?.get(d) ?? null;
                    const { bg, fg } = returnCell(ret);
                    return (
                      <td key={d} className="py-1 px-1 text-center">
                        <div
                          className={`rounded px-0.5 py-1.5 font-mono tabular-nums text-[10px] ${bg} ${fg}`}
                          title={
                            ret != null
                              ? `${fullDate(d, isZh)}\n${ret >= 0 ? "+" : ""}${ret.toFixed(3)}%`
                              : d
                          }
                        >
                          {ret != null
                            ? `${ret >= 0 ? "+" : ""}${ret.toFixed(1)}`
                            : "—"}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-4 text-[10px] text-[var(--r-text-faint)]">
        {[
          { bg: "bg-green-500/65", label: ">+3%" },
          { bg: "bg-green-400/38", label: "+1~3%" },
          { bg: "bg-green-300/22", label: "0~+1%" },
          { bg: "bg-red-300/22", label: "0~-1%" },
          { bg: "bg-red-400/38", label: "-1~-3%" },
          { bg: "bg-red-500/65", label: "<-3%" },
        ].map(({ bg, label }) => (
          <span key={label} className="flex items-center gap-1">
            <span className={`inline-block w-3 h-3 rounded ${bg}`} />
            <span>{label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Tab 3 — Trade History ────────────────────────────────────────────────────

function TradeHistoryPanel({
  trades,
  funds,
}: {
  trades: TradeRow[];
  funds: FundData[];
}) {
  const { t, locale } = useI18n();
  const isZh = locale === "zh";

  const [fundFilter, setFundFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const statusLabel = (s: string) =>
    isZh ? (STATUS_META[s]?.zh ?? s) : (STATUS_META[s]?.en ?? s);

  const fundMap = useMemo(
    () => new Map(funds.map((f) => [f.id, f])),
    [funds]
  );

  const filtered = useMemo(
    () =>
      trades
        .filter((t) => {
          if (fundFilter !== "all" && t.fund_id !== fundFilter) return false;
          if (statusFilter !== "all" && t.status !== statusFilter) return false;
          return true;
        })
        .slice(0, 400),
    [trades, fundFilter, statusFilter]
  );

  const fmtTradeTime = (trade: TradeRow): string => {
    const ts = trade.closed_at ?? trade.opened_at ?? "";
    if (!ts) return "—";
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${d
      .getHours()
      .toString()
      .padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  };

  if (trades.length === 0) return <EmptyState label={t("analysisNoData")} />;

  return (
    <div>
      <ControlRow>
        {/* Fund filter */}
        <GlassDropdown
          value={fundFilter}
          onChange={setFundFilter}
          options={[
            { value: "all", label: t("analysisSelectFund") },
            ...funds.map((f) => ({
              value: f.id,
              label: (
                <span className="flex items-center gap-1.5">
                  <span>{f.emoji}</span>
                  <span>{fundDisplayName(f.id, t)}</span>
                </span>
              ),
            })),
          ]}
        />

        {/* Status filter */}
        <GlassDropdown
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: "all", label: t("analysisAllEventTypes") },
            ...TRADE_STATUSES.map((s) => ({
              value: s,
              label: statusLabel(s),
            })),
          ]}
        />

        <div className="flex-1 min-w-0" />

        {/* Export CSV */}
        <button
          onClick={() => downloadCSV(filtered, funds)}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] border
            border-[var(--r-border)] text-[var(--r-text-muted)]
            hover:border-[var(--r-accent)] hover:text-[var(--r-text)] transition-colors focus:outline-none"
        >
          <Download className="w-3 h-3" />
          {t("analysisExportCSV")}
        </button>
      </ControlRow>

      {/* Count + note */}
      <div className="text-[10px] text-[var(--r-text-faint)] mb-3">
        {isZh
          ? `共 ${filtered.length} 条交易记录（最近 200 条）`
          : `${filtered.length} trade records (latest 200)`}
      </div>

      {/* Desktop table */}
      <div className="hidden sm:block overflow-x-auto -mx-4 px-4">
        <table className="w-full min-w-[660px] text-[11px]">
          <thead>
            <tr className="border-b border-[var(--r-border)] text-[var(--r-text-faint)]">
              <th className="text-left font-normal py-2 pr-3 whitespace-nowrap">
                {isZh ? "时间" : "Time"}
              </th>
              <th className="text-left font-normal py-2 pr-3 whitespace-nowrap">
                {isZh ? "基金" : "Fund"}
              </th>
              <th className="text-left font-normal py-2 pr-3 whitespace-nowrap">
                {isZh ? "状态" : "Status"}
              </th>
              <th className="text-left font-normal py-2 pr-3">
                {isZh ? "市场" : "Market"}
              </th>
              <th className="text-right font-normal py-2 pr-3 whitespace-nowrap">
                {isZh ? "仓位" : "Amount"}
              </th>
              <th className="text-right font-normal py-2 whitespace-nowrap">
                {isZh ? "收益" : "P&L"}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((trade, i) => {
              const fund = fundMap.get(trade.fund_id);
              const meta = STATUS_META[trade.status];
              const slug = trade.slug ?? "";
              const question = (trade.question ?? "").slice(0, 64);
              return (
                <tr
                  key={i}
                  className="border-b border-[var(--r-border)]/30 hover:bg-white/[0.02] transition-colors"
                >
                  <td className="py-2 pr-3 text-[var(--r-text-faint)] font-mono whitespace-nowrap">
                    {fmtTradeTime(trade)}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <span className="mr-1">{fund?.emoji ?? "?"}</span>
                    <span className="text-[var(--r-text-muted)]">
                      {fund ? fundDisplayName(fund.id, t) : trade.fund_id}
                    </span>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        meta?.badge ?? "bg-white/5 text-[var(--r-text-faint)]"
                      }`}
                    >
                      {statusLabel(trade.status)}
                    </span>
                  </td>
                  <td className="py-2 pr-3 max-w-[220px]">
                    {slug ? (
                      <a
                        href={`https://polymarket.com/event/${slug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--r-text-muted)] hover:text-[var(--r-accent)] transition-colors truncate block no-underline"
                        title={question}
                      >
                        {question || "—"}
                      </a>
                    ) : (
                      <span className="text-[var(--r-text-faint)] truncate block">
                        {question || "—"}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-[var(--r-text-muted)] whitespace-nowrap">
                    {trade.amount != null ? fmtCompact(trade.amount) : "—"}
                  </td>
                  <td className="py-2 text-right font-mono font-medium whitespace-nowrap">
                    {trade.pnl != null ? (
                      <span
                        className={
                          trade.pnl >= 0
                            ? "text-[var(--r-green)]"
                            : "text-[var(--r-red)]"
                        }
                      >
                        {trade.pnl >= 0 ? "+" : ""}
                        {fmtCompact(Math.abs(trade.pnl))}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile card list */}
      <div className="sm:hidden space-y-2">
        {filtered.map((trade, i) => {
          const fund = fundMap.get(trade.fund_id);
          const meta = STATUS_META[trade.status];
          const question = (trade.question ?? "").slice(0, 60);
          return (
            <div key={i} className="glass-card px-3 py-2.5 text-[11px]">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="shrink-0">{fund?.emoji ?? "?"}</span>
                  <span className="text-[var(--r-text-muted)] font-medium whitespace-nowrap">
                    {fund ? fundDisplayName(fund.id, t) : trade.fund_id}
                  </span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${
                      meta?.badge ?? "bg-white/5 text-[var(--r-text-faint)]"
                    }`}
                  >
                    {statusLabel(trade.status)}
                  </span>
                </div>
                {trade.pnl != null && (
                  <span
                    className={`font-mono font-medium shrink-0 ml-2 ${
                      trade.pnl >= 0
                        ? "text-[var(--r-green)]"
                        : "text-[var(--r-red)]"
                    }`}
                  >
                    {trade.pnl >= 0 ? "+" : ""}
                    {fmtCompact(Math.abs(trade.pnl))}
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[var(--r-text-faint)] truncate">
                  {question || "—"}
                </span>
                <span className="text-[var(--r-text-faint)] font-mono whitespace-nowrap shrink-0 text-[10px]">
                  {fmtTradeTime(trade)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function AnalysisSkeleton() {
  return (
    <div className="space-y-3">
      {[...Array(5)].map((_, i) => (
        <div
          key={i}
          className="glass-card h-14 animate-pulse rounded-lg"
          style={{ animationDelay: `${i * 0.08}s` }}
        />
      ))}
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function AnalysisPage() {
  const { t } = useI18n();

  const { data: fundsData, loading: fundsLoading } = useFetch<{
    funds: FundData[];
  }>("/api/funds", 120_000);
  const { data: snapData, loading: snapLoading } = useFetch<{
    snapshots: SnapshotData[];
  }>("/api/snapshots?limit=500", 300_000);
  const { data: tradesData, loading: tradesLoading } = useFetch<{
    trades: TradeRow[];
  }>("/api/trades?limit=200", 120_000);

  const funds = fundsData?.funds ?? [];
  const snapshots = snapData?.snapshots ?? [];
  const trades = tradesData?.trades ?? [];

  const [activeTab, setActiveTab] = useState<"nav" | "returns" | "trades">(
    "nav"
  );

  const tabs = [
    { id: "nav" as const, label: t("analysisTabNav") },
    { id: "returns" as const, label: t("analysisTabReturns") },
    { id: "trades" as const, label: t("analysisTabTrades") },
  ];

  const isLoading =
    fundsLoading ||
    (activeTab !== "trades" && snapLoading) ||
    (activeTab === "trades" && tradesLoading);

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start gap-3 mb-6">
        <Link
          to="/"
          className="flex items-center gap-1 text-xs text-[var(--r-text-faint)] hover:text-[var(--r-text)] transition-colors no-underline mt-1 whitespace-nowrap shrink-0"
        >
          <ArrowLeft className="w-3 h-3" />
          {t("analysisBackToLive")}
        </Link>
        <div>
          <h1 className="text-base font-semibold text-[var(--r-text)] leading-tight">
            {t("analysisPageTitle")}
          </h1>
          <p className="text-xs text-[var(--r-text-faint)] mt-0.5 leading-relaxed">
            {t("analysisPageSub")}
          </p>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-0 mb-6 border-b border-[var(--r-border)]">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2.5 text-sm font-medium transition-all border-b-2 -mb-px whitespace-nowrap focus:outline-none ${
              activeTab === tab.id
                ? "border-[var(--r-accent)] text-[var(--r-text)]"
                : "border-transparent text-[var(--r-text-faint)] hover:text-[var(--r-text-muted)]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {isLoading ? (
        <AnalysisSkeleton />
      ) : (
        <>
          {activeTab === "nav" && (
            <NavTrendPanel snapshots={snapshots} funds={funds} />
          )}
          {activeTab === "returns" && (
            <DailyReturnsPanel snapshots={snapshots} funds={funds} />
          )}
          {activeTab === "trades" && (
            <TradeHistoryPanel trades={trades} funds={funds} />
          )}
        </>
      )}
    </div>
  );
}
