/**
 * AnalysisPage — Historical analysis view for all funds.
 * Three tabs: NAV Trend Chart, Daily Returns Heatmap, Trade History.
 */

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import {
  Brush,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { Download, ChevronDown, ChevronUp, ExternalLink, Trophy, TrendingDown, Gamepad2, CircleDot, Landmark, DollarSign, Cpu, Globe } from "lucide-react";
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

interface EpochStat {
  epoch: number;
  started_at: string; // ISO datetime — MIN(executed_at) for that epoch
  actions: number;
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
  // Enriched fields (present in /api/trades response)
  entry_price?: number | null;
  exit_price?: number | null;
  current_price?: number | null;
  current_value?: number | null;
  unrealized_pnl?: number | null;
  live_return_pct?: number | null;
  outcome_name?: string | null;
  close_reason?: string | null;
  close_reason_code?: string | null;
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
  OPEN:              { zh: "开仓",    en: "Open",       badge: "text-[var(--r-accent)] bg-[var(--r-accent)]/10" },
  RESOLVED:         { zh: "结算",    en: "Settled",    badge: "text-[var(--r-green)] bg-[var(--r-green)]/10" },
  PROFIT_TAKEN:     { zh: "止盈",    en: "Profit",     badge: "text-[var(--r-green)] bg-[var(--r-green)]/10" },
  STOPPED:          { zh: "止损",    en: "Stopped",    badge: "text-red-400 bg-red-400/10" },
  EXPIRED:          { zh: "到期",    en: "Expired",    badge: "text-[var(--r-text-faint)] bg-white/5" },
  TRAILING_STOPPED: { zh: "跟踪止损", en: "Trail-Stop", badge: "text-orange-400 bg-orange-400/10" },
  REVERSED:         { zh: "反向",    en: "Reversed",   badge: "text-yellow-400/80 bg-yellow-400/10" },
};

// ─── Market category icon (P0-1) ─────────────────────────────────────────────

function marketCategory(question: string): React.ReactNode | null {
  const q = question.toLowerCase();
  if (/esports|\bvs\b.*round|lck|lpl|cs2|dota|valorant|overwatch|league of legends/.test(q))
    return <Gamepad2 size={11} style={{ color: "#a78bfa" }} />;
  if (/\bvs\b|nba|nfl|nhl|mlb|mls|ufc|match|playoff|championship|tournament|cup|soccer|football|basketball/.test(q))
    return <CircleDot size={11} style={{ color: "#34d399" }} />;
  if (/election|president|senator|congress|parliament|vote|ballot|candidate|by-election|democrat|republican|minister/.test(q))
    return <Landmark size={11} style={{ color: "#f87171" }} />;
  if (/bitcoin|btc|\beth\b|crypto|price reach|stock|fed |inflation|interest rate|gdp|treasury/.test(q))
    return <DollarSign size={11} style={{ color: "#fbbf24" }} />;
  if (/\bai\b|openai|gpt|llm|apple|google|microsoft|nvidia|meta\b|elon musk.*tweet|tweet/.test(q))
    return <Cpu size={11} style={{ color: "#38bdf8" }} />;
  if (/war|nuclear|military|conflict|missile|sanction|treaty|airspace|iran|russia|ukraine|nato|troops/.test(q))
    return <Globe size={11} style={{ color: "#94a3b8" }} />;
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dateCutoff(range: "7d" | "30d" | "90d" | "all"): string | null {
  if (range === "all") return null;
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

type TradeTimeRange = "today" | "7d" | "30d" | "90d" | "all";

// Server-side `since` filter for /api/trades. Anchors to local midnight so
// "Today" / "7D" align with what the user sees on their calendar, not UTC.
function tradeSinceTimestamp(range: TradeTimeRange): string | null {
  if (range === "all") return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (range !== "today") {
    const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
    d.setDate(d.getDate() - days);
  }
  return d.toISOString();
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

// P0-3 / heatmap P0-3: weekday labels
const WEEKDAYS_ZH = ["日", "一", "二", "三", "四", "五", "六"];
const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function weekdayLabel(isoDate: string, isZh: boolean): string {
  const d = new Date(isoDate + "T12:00:00");
  return isZh ? `周${WEEKDAYS_ZH[d.getDay()]}` : WEEKDAYS_EN[d.getDay()];
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
  a.download = `rotifer-alpha-trades-${new Date().toISOString().slice(0, 10)}.csv`;
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
          style={{
            minWidth: 160,
            background: "var(--r-surface)",
            backdropFilter: "none",
            WebkitBackdropFilter: "none",
          }}
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
  viewMode = "index",
}: {
  active?: boolean;
  payload?: { dataKey: string; name: string; value: number; stroke: string }[];
  label?: string;
  viewMode?: "index" | "pnl";
}) {
  if (!active || !payload?.length) return null;
  const sorted = [...payload]
    .filter((e) => e.value != null)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const refVal = viewMode === "index" ? 100 : 0;

  const fmtVal = (v: number) => {
    const delta = v - refVal;
    if (viewMode === "index") return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`;
    return `${delta >= 0 ? "+" : "-"}$${fmtCompact(Math.abs(delta))}`;
  };

  return (
    <div
      className="glass-card px-3 py-2.5 text-[11px] min-w-[170px] shadow-xl"
      style={{ background: "var(--r-surface)", backdropFilter: "none", WebkitBackdropFilter: "none" }}
    >
      <div className="text-[var(--r-text-faint)] mb-2 font-medium">{label}</div>
      {sorted.map((entry, idx) => (
        <div
          key={entry.dataKey}
          className="flex items-center justify-between gap-3 leading-relaxed"
        >
          <div className="flex items-center gap-1 min-w-0">
            <span className="text-[9px] text-[var(--r-text-faint)] w-3 tabular-nums shrink-0">
              {idx + 1}
            </span>
            <span style={{ color: entry.stroke }}>●</span>
            <span className="text-[var(--r-text-muted)] truncate" style={{ maxWidth: 88 }}>
              {entry.name}
            </span>
          </div>
          <span
            className={`font-mono tabular-nums font-medium ${
              (entry.value - refVal) >= 0 ? "text-[var(--r-green)]" : "text-[var(--r-red)]"
            }`}
          >
            {fmtVal(entry.value)}
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
  epochStats = [],
}: {
  snapshots: SnapshotData[];
  funds: FundData[];
  epochStats?: EpochStat[];
}) {
  const { t, locale } = useI18n();
  const isZh = locale === "zh";
  const [tierFilter, setTierFilter] = useState<"all" | "s" | "m" | "l">("s");
  const [timeRange, setTimeRange] = useState<"7d" | "30d" | "90d" | "all">("all");
  const [hiddenFunds, setHiddenFunds] = useState<Set<string>>(new Set());
  // P1-2: baseline toggle (index vs absolute P&L)
  const [viewMode, setViewMode] = useState<"index" | "pnl">("index");

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
            viewMode === "index"
              ? Math.round((val / fund.initialBalance) * 1000) / 10
              : Math.round(val - fund.initialBalance);
        } else {
          point[fund.id] = null;
        }
      });
      return point;
    });

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
  }, [snapshots, activeFunds, timeRange, isZh, viewMode]);

  // P0-3: performance summary
  const perfSummary = useMemo(() => {
    if (!chartData.length) return null;
    const last = chartData[chartData.length - 1];
    const visible = activeFunds
      .filter((f) => !hiddenFunds.has(f.id))
      .map((f) => ({ fund: f, val: last[f.id] as number | null }))
      .filter((x): x is { fund: FundData; val: number } => x.val != null);
    if (visible.length < 2) return null;
    visible.sort((a, b) => b.val - a.val);
    const ref = viewMode === "index" ? 100 : 0;
    return {
      best: { fund: visible[0].fund, delta: visible[0].val - ref },
      worst: { fund: visible[visible.length - 1].fund, delta: visible[visible.length - 1].val - ref },
      divergence: visible[0].val - visible[visible.length - 1].val,
    };
  }, [chartData, activeFunds, hiddenFunds, viewMode]);

  // P0-2: epoch markers — map epoch start dates to chart labels
  const epochMarkers = useMemo(() => {
    const labelSet = new Set(chartData.map((d) => d.label as string));
    return epochStats
      .map((e) => {
        const label = shortDate((e.started_at ?? "").slice(0, 10));
        if (!labelSet.has(label)) return null;
        return { epoch: e.epoch, label };
      })
      .filter((x): x is { epoch: number; label: string } => x != null);
  }, [epochStats, chartData]);

  // P1-3: latest value per fund for legend Δ%
  const lastValues = useMemo(() => {
    if (!chartData.length) return {} as Record<string, number | null>;
    const last = chartData[chartData.length - 1];
    return Object.fromEntries(
      activeFunds.map((f) => [f.id, last[f.id] as number | null])
    );
  }, [chartData, activeFunds]);

  const toggleFund = useCallback((id: string) => {
    setHiddenFunds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (snapshots.length === 0) return <EmptyState label={t("analysisNoData")} />;

  const ref = viewMode === "index" ? 100 : 0;
  const fmtDelta = (delta: number) =>
    viewMode === "index"
      ? `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}%`
      : `${delta >= 0 ? "+" : "-"}$${fmtCompact(Math.abs(delta))}`;

  const yFormatter =
    viewMode === "index"
      ? (v: number) => `${v}`
      : (v: number) => `$${fmtCompact(v)}`;

  const tierOpts = [
    { v: "all" as const, l: t("analysisAllTiers") },
    { v: "s" as const, l: t("analysisTierS") },
    { v: "m" as const, l: t("analysisTierM") },
    { v: "l" as const, l: t("analysisTierL") },
  ];
  const rangeOpts = [
    { v: "7d" as const, l: t("analysis7D") },
    { v: "30d" as const, l: t("analysis30D") },
    { v: "90d" as const, l: t("analysis90D") },
    { v: "all" as const, l: t("analysisAllTime") },
  ];

  return (
    <div>
      <ControlRow>
        {tierOpts.map(({ v, l }) => (
          <Pill key={v} active={tierFilter === v} onClick={() => setTierFilter(v)}>
            {l}
          </Pill>
        ))}
        <div className="flex-1 min-w-0" />
        {/* P1-2: baseline toggle */}
        <button
          onClick={() => setViewMode((m) => (m === "index" ? "pnl" : "index"))}
          className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-all whitespace-nowrap focus:outline-none border ${
            viewMode === "pnl"
              ? "bg-[var(--r-accent)] text-white border-[var(--r-accent)]"
              : "border-[var(--r-border)] text-[var(--r-text-muted)] hover:border-[var(--r-accent)] hover:text-[var(--r-text)]"
          }`}
        >
          {viewMode === "index" ? (isZh ? "$ 盈亏" : "$ P&L") : (isZh ? "归一" : "Index")}
        </button>
        {rangeOpts.map(({ v, l }) => (
          <Pill key={v} active={timeRange === v} onClick={() => setTimeRange(v)}>
            {l}
          </Pill>
        ))}
      </ControlRow>

      {/* P0-3: Performance summary */}
      {perfSummary && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 mb-3 px-1 text-[11px]">
          <div className="flex items-center gap-1.5">
            <Trophy size={11} style={{ color: "#f59e0b" }} />
            <span style={{ color: FUND_HEX_COLORS[perfSummary.best.fund.id] ?? "var(--r-text-muted)" }}>
              {fundDisplayName(perfSummary.best.fund.id, t)}
            </span>
            <span className="font-mono font-medium text-[var(--r-green)]">
              {fmtDelta(perfSummary.best.delta)}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <TrendingDown size={11} style={{ color: "var(--r-red)" }} />
            <span style={{ color: FUND_HEX_COLORS[perfSummary.worst.fund.id] ?? "var(--r-text-muted)" }}>
              {fundDisplayName(perfSummary.worst.fund.id, t)}
            </span>
            <span
              className={`font-mono font-medium ${
                perfSummary.worst.delta >= 0 ? "text-[var(--r-green)]" : "text-[var(--r-red)]"
              }`}
            >
              {fmtDelta(perfSummary.worst.delta)}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[var(--r-text-faint)]">{isZh ? "分化" : "Spread"}</span>
            <span className="font-mono text-[var(--r-text-muted)]">
              {viewMode === "index"
                ? `${perfSummary.divergence.toFixed(1)} ppt`
                : `$${fmtCompact(perfSummary.divergence)}`}
            </span>
          </div>
        </div>
      )}

      {/* Chart */}
      <div className="glass-card p-4 mb-4">
        <div className="text-[10px] text-[var(--r-text-faint)] mb-2 font-mono">
          {viewMode === "index"
            ? `${t("analysisNAVIndexLabel")} · 100 = start`
            : isZh ? "绝对盈亏 (USD)" : "Absolute P&L (USD)"}
        </div>
        <ResponsiveContainer width="100%" height={340}>
          <LineChart
            data={chartData}
            margin={{ top: 4, right: 8, left: -10, bottom: 0 }}
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
              tickFormatter={yFormatter}
              width={50}
            />
            {/* P0-1: crosshair cursor */}
            <Tooltip
              content={<NavTooltip viewMode={viewMode} />}
              cursor={{ stroke: "rgba(255,255,255,0.12)", strokeWidth: 1, strokeDasharray: "4 4" }}
            />
            {/* baseline */}
            <ReferenceLine
              y={ref}
              stroke="rgba(255,255,255,0.10)"
              strokeDasharray="4 3"
            />
            {/* P0-2: Epoch milestone markers */}
            {epochMarkers.map((em) => (
              <ReferenceLine
                key={em.epoch}
                x={em.label}
                stroke="var(--r-accent)"
                strokeDasharray="3 3"
                strokeOpacity={0.45}
                label={{
                  value: `E${em.epoch}`,
                  position: "insideTopRight",
                  fill: "var(--r-accent)",
                  fontSize: 9,
                  opacity: 0.75,
                }}
              />
            ))}
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
            {/* P1-1: Brush for range zoom */}
            <Brush
              dataKey="label"
              height={18}
              stroke="rgba(255,255,255,0.08)"
              fill="var(--r-bg)"
              travellerWidth={6}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* P1-3: Fund legend with Δ% */}
      <div className="flex flex-wrap gap-2">
        {activeFunds.map((fund) => {
          const color = FUND_HEX_COLORS[fund.id] ?? "#6b7280";
          const hidden = hiddenFunds.has(fund.id);
          const lastVal = lastValues[fund.id];
          const delta = lastVal != null ? lastVal - ref : null;
          return (
            <button
              key={fund.id}
              onClick={() => toggleFund(fund.id)}
              className="flex items-center gap-1 px-2 py-1 rounded-full text-[10px] border transition-all focus:outline-none"
              style={{
                borderColor: hidden ? "rgba(255,255,255,0.08)" : color,
                color: hidden ? "var(--r-text-faint)" : color,
                opacity: hidden ? 0.4 : 1,
              }}
            >
              <span>{fund.emoji}</span>
              <span>{fundDisplayName(fund.id, t)}</span>
              {delta != null && !hidden && (
                <span
                  className="font-mono ml-0.5"
                  style={{ color: delta >= 0 ? "var(--r-green)" : "var(--r-red)" }}
                >
                  {fmtDelta(delta)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Tab 2 — Daily Returns Heatmap ───────────────────────────────────────────

type HeatSortMode = "default" | "total" | "maxUp" | "maxDown";

function DailyReturnsPanel({
  snapshots,
  funds,
  onDrillDown,
}: {
  snapshots: SnapshotData[];
  funds: FundData[];
  onDrillDown?: (fundId: string) => void;
}) {
  const { t, locale } = useI18n();
  const isZh = locale === "zh";
  const [days, setDays] = useState<7 | 14 | 30 | "all">(14);
  // P0-1: row sort
  const [sortMode, setSortMode] = useState<HeatSortMode>("default");
  // P1-2: mobile collapse
  const [isMobile] = useState(() => typeof window !== "undefined" && window.innerWidth < 640);
  const [mobileExpanded, setMobileExpanded] = useState(false);

  const { dates, returnMap, totalReturnMap, sortValues } = useMemo(() => {
    const byFund = new Map<string, { date: string; value: number }[]>();
    snapshots.forEach((s) => {
      if (!byFund.has(s.fund_id)) byFund.set(s.fund_id, []);
      byFund.get(s.fund_id)!.push({ date: s.date, value: s.total_value });
    });
    byFund.forEach((arr) => arr.sort((a, b) => a.date.localeCompare(b.date)));

    const allDates = [...new Set(snapshots.map((s) => s.date))].sort();
    const recentDates = days === "all" ? allDates : allDates.slice(-days);

    const rmap = new Map<string, Map<string, number | null>>();
    const totalMap = new Map<string, number | null>();
    const svMap = new Map<string, { total: number | null; maxUp: number | null; maxDown: number | null }>();

    byFund.forEach((arr, fundId) => {
      const dateToVal = new Map(arr.map((a) => [a.date, a.value]));
      const fmap = new Map<string, number | null>();

      recentDates.forEach((date, i) => {
        if (i === 0) { fmap.set(date, null); return; }
        const prevDate = recentDates[i - 1];
        const curr = dateToVal.get(date);
        const prev = dateToVal.get(prevDate);
        if (curr == null || prev == null || prev === 0) { fmap.set(date, null); return; }
        fmap.set(date, ((curr - prev) / prev) * 100);
      });
      rmap.set(fundId, fmap);

      // P0-2: cumulative return over period
      const firstDate = recentDates.find((d) => dateToVal.has(d));
      const lastDate = [...recentDates].reverse().find((d) => dateToVal.has(d));
      let totalRet: number | null = null;
      if (firstDate && lastDate && firstDate !== lastDate) {
        const v0 = dateToVal.get(firstDate)!;
        const v1 = dateToVal.get(lastDate)!;
        if (v0 > 0) totalRet = ((v1 - v0) / v0) * 100;
      }
      totalMap.set(fundId, totalRet);

      // P0-1: sort values
      const dailyRets = recentDates
        .slice(1)
        .map((d) => fmap.get(d) ?? null)
        .filter((v): v is number => v != null);
      svMap.set(fundId, {
        total: totalRet,
        maxUp: dailyRets.length ? Math.max(...dailyRets) : null,
        maxDown: dailyRets.length ? Math.min(...dailyRets) : null,
      });
    });

    return { dates: recentDates, returnMap: rmap, totalReturnMap: totalMap, sortValues: svMap };
  }, [snapshots, days]);

  // P0-1: apply row sort
  const sortedFunds = useMemo(() => {
    if (sortMode === "default") return funds;
    return [...funds].sort((a, b) => {
      const av = sortValues.get(a.id);
      const bv = sortValues.get(b.id);
      if (sortMode === "total") return (bv?.total ?? -Infinity) - (av?.total ?? -Infinity);
      if (sortMode === "maxUp") return (bv?.maxUp ?? -Infinity) - (av?.maxUp ?? -Infinity);
      if (sortMode === "maxDown") return (av?.maxDown ?? Infinity) - (bv?.maxDown ?? Infinity);
      return 0;
    });
  }, [funds, sortMode, sortValues]);

  // P1-2: mobile column collapse
  const displayDates = (!isMobile || mobileExpanded) ? dates : dates.slice(-7);

  // Auto-scroll the heatmap to the right edge when the window changes or new
  // snapshot data lands. The "newest" column is the most relevant one and
  // sits at the far right (time-axis convention), so without this nudge the
  // user has to manually scroll to see today.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lastDate = displayDates[displayDates.length - 1];
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [days, lastDate]);

  if (snapshots.length === 0) return <EmptyState label={t("analysisNoData")} />;

  const dayOpts: { v: 7 | 14 | 30 | "all"; l: string }[] = [
    { v: 7,     l: t("analysis7D") },
    { v: 14,    l: isZh ? "14 天" : "14D" },
    { v: 30,    l: t("analysis30D") },
    { v: "all", l: t("analysisAllTime") },
  ];
  const sortOpts: { v: HeatSortMode; l: string }[] = [
    { v: "default", l: isZh ? "默认" : "Default" },
    { v: "total",   l: isZh ? "总收益" : "Total" },
    { v: "maxUp",   l: isZh ? "最大涨幅" : "Best Day" },
    { v: "maxDown", l: isZh ? "最大跌幅" : "Worst Day" },
  ];

  return (
    <div>
      <ControlRow>
        {dayOpts.map(({ v, l }) => (
          <Pill key={v} active={days === v} onClick={() => setDays(v)}>
            {l}
          </Pill>
        ))}
        <span className="text-[10px] text-[var(--r-text-faint)] ml-1 hidden sm:inline">
          {isZh ? "（当日相较前日 %）" : "(% vs. prev day)"}
        </span>
        <div className="flex-1 min-w-0" />
        {/* P0-1: sort dropdown */}
        <GlassDropdown
          value={sortMode}
          onChange={(v) => setSortMode(v as HeatSortMode)}
          options={sortOpts.map((o) => ({ value: o.v, label: o.l }))}
        />
      </ControlRow>

      {/* Scrollable heatmap table */}
      <div ref={scrollContainerRef} className="overflow-x-auto pb-2">
        <table
          className="text-[11px] border-collapse"
          style={{ minWidth: Math.max(520, 112 + displayDates.length * 46 + 56) }}
        >
          <thead>
            <tr>
              {/* Sticky fund name column */}
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
              {/* P0-3: date + weekday — newest column gets an accent left border */}
              {displayDates.map((d, i) => {
                const isLatest = i === displayDates.length - 1;
                return (
                  <th
                    key={d}
                    className={`text-center font-normal py-1 px-1 ${
                      isLatest
                        ? "text-[var(--r-accent)] border-l border-[var(--r-accent)]/50"
                        : "text-[var(--r-text-faint)]"
                    }`}
                    style={{ minWidth: 44 }}
                  >
                    <div>{shortDate(d)}</div>
                    <div className="text-[9px] opacity-45">{weekdayLabel(d, isZh)}</div>
                  </th>
                );
              })}
              {/* P0-2: Total column header — sticky right */}
              <th
                className="text-center text-[var(--r-text-faint)] font-normal py-1 px-1 sticky right-0 z-20"
                style={{
                  background: "var(--r-bg)",
                  minWidth: 52,
                  boxShadow: "-3px 0 6px 0px var(--r-bg)",
                }}
              >
                {isZh ? "总计" : "Total"}
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedFunds.map((fund) => {
              const fmap = returnMap.get(fund.id);
              const totalRet = totalReturnMap.get(fund.id) ?? null;
              return (
                <tr key={fund.id}>
                  {/* Fund name — sticky left */}
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
                  {/* Daily return cells */}
                  {displayDates.map((d, i) => {
                    const isLatest = i === displayDates.length - 1;
                    const ret = fmap?.get(d) ?? null;
                    const { bg, fg } = returnCell(ret);
                    const clickable = ret != null && !!onDrillDown;
                    return (
                      <td
                        key={d}
                        className={`py-1 px-1 text-center ${
                          isLatest ? "border-l border-[var(--r-accent)]/50" : ""
                        }`}
                      >
                        {/* P1-1: click → drill down to trade records */}
                        <div
                          className={`rounded px-0.5 py-1.5 font-mono tabular-nums text-[10px] ${bg} ${fg} ${
                            clickable ? "cursor-pointer hover:ring-1 hover:ring-white/25 transition-all" : ""
                          }`}
                          title={
                            ret != null
                              ? `${fullDate(d, isZh)}\n${ret >= 0 ? "+" : ""}${ret.toFixed(3)}%${
                                  clickable ? (isZh ? "\n点击查看交易记录" : "\nClick to view trades") : ""
                                }`
                              : d
                          }
                          onClick={() => clickable && onDrillDown!(fund.id)}
                        >
                          {ret != null ? `${ret >= 0 ? "+" : ""}${ret.toFixed(1)}` : "—"}
                        </div>
                      </td>
                    );
                  })}
                  {/* P0-2: Cumulative total — sticky right */}
                  <td
                    className="py-1 px-1 text-center sticky right-0 z-20"
                    style={{ background: "var(--r-bg)", boxShadow: "-3px 0 6px 0px var(--r-bg)" }}
                  >
                    {totalRet != null ? (
                      <div
                        className={`rounded px-0.5 py-1.5 font-mono tabular-nums text-[10px] font-semibold ${
                          totalRet >= 0
                            ? "text-[var(--r-green)] bg-[var(--r-green)]/8"
                            : "text-[var(--r-red)] bg-[var(--r-red)]/8"
                        }`}
                      >
                        {totalRet >= 0 ? "+" : ""}{totalRet.toFixed(1)}%
                      </div>
                    ) : (
                      <span className="text-[var(--r-text-faint)] text-[10px]">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* P1-2: Mobile expand/collapse button */}
      {isMobile && dates.length > 7 && (
        <button
          onClick={() => setMobileExpanded((e) => !e)}
          className="mt-2 w-full text-center text-[11px] text-[var(--r-text-faint)] hover:text-[var(--r-text)] transition-colors py-1.5 border border-[var(--r-border)] rounded-lg"
        >
          {mobileExpanded
            ? (isZh ? "折叠 ‹" : "Collapse ‹")
            : days === "all"
              ? (isZh ? `展开全部 ${dates.length} 天 ›` : `Expand all ${dates.length}D ›`)
              : (isZh ? `展开全部 ${days} 天 ›` : `Expand all ${days}D ›`)}
        </button>
      )}

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-4 text-[10px] text-[var(--r-text-faint)]">
        {[
          { bg: "bg-green-500/65", label: ">+3%" },
          { bg: "bg-green-400/38", label: "+1~3%" },
          { bg: "bg-green-300/22", label: "0~+1%" },
          { bg: "bg-red-300/22",   label: "0~-1%" },
          { bg: "bg-red-400/38",   label: "-1~-3%" },
          { bg: "bg-red-500/65",   label: "<-3%" },
        ].map(({ bg, label }) => (
          <span key={label} className="flex items-center gap-1">
            <span className={`inline-block w-3 h-3 rounded ${bg}`} />
            <span>{label}</span>
          </span>
        ))}
        {onDrillDown && (
          <span className="ml-2 text-[var(--r-accent)]/60">
            {isZh ? "· 点击格子查看当日交易" : "· Click cell to view trades"}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Tab 3 — Trade History ────────────────────────────────────────────────────

type SortCol = "time" | "amount" | "pnl";

// Module-level helpers used by both TradeHistoryPanel and the sub-row components
function fmtTradeTime(trade: TradeRow): string {
  const ts = trade.closed_at ?? trade.opened_at ?? "";
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${d
    .getHours()
    .toString()
    .padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function statusLabel(s: string, isZh: boolean): string {
  return isZh ? (STATUS_META[s]?.zh ?? s) : (STATUS_META[s]?.en ?? s);
}

// ─── Expandable desktop trade row ────────────────────────────────────────────

interface TRProps {
  trade: TradeRow;
  index: number;
  fund: FundData | undefined;
  maxAmount: number;
  isZh: boolean;
}

function ExpandableTradeRow({ trade, index, fund, maxAmount, isZh }: TRProps) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const meta    = STATUS_META[trade.status];
  const question     = trade.question ?? "";
  const questionShort = question.slice(0, 72);
  const catIcon  = marketCategory(question);
  const amtPct   = trade.amount != null ? Math.min(100, (trade.amount / maxAmount) * 100) : 0;
  const isTradeOpen = trade.status === "OPEN";
  const pnl      = trade.pnl ?? null;
  const livePnl  = trade.unrealized_pnl ?? 0;

  const isCategoricalOutcome =
    trade.outcome_name != null &&
    trade.outcome_name !== "Yes" &&
    trade.outcome_name !== "No";
  const displayOutcome = isCategoricalOutcome ? trade.outcome_name : null;
  const openedDate  = trade.opened_at  ? new Date(trade.opened_at ).toLocaleDateString()  : null;
  const closedDate  = trade.closed_at  ? new Date(trade.closed_at ).toLocaleDateString()  : null;
  const holdDays    = trade.opened_at
    ? Math.max(0, Math.floor(
        ((trade.closed_at ? new Date(trade.closed_at) : new Date()).getTime() -
          new Date(trade.opened_at).getTime()) / 86_400_000
      ))
    : null;

  return (
    <>
      <tr
        onClick={() => setOpen(o => !o)}
        className={`border-b border-[var(--r-border)]/30 cursor-pointer hover:bg-white/[0.04] transition-colors select-none ${
          open ? "bg-white/[0.03]" : index % 2 === 1 ? "bg-white/[0.015]" : ""
        }`}
      >
        {/* Time */}
        <td className="py-2 pr-3 text-[var(--r-text-faint)] font-mono whitespace-nowrap">
          {fmtTradeTime(trade)}
        </td>

        {/* Fund */}
        <td className="py-2 pr-3 whitespace-nowrap overflow-hidden">
          <span className="mr-1">{fund?.emoji ?? "?"}</span>
          <span className="text-[var(--r-text-muted)]">
            {fund ? fundDisplayName(fund.id, t) : trade.fund_id}
          </span>
        </td>

        {/* Status */}
        <td className="py-2 pr-3 whitespace-nowrap">
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
            meta?.badge ?? "bg-white/5 text-[var(--r-text-faint)]"
          }`}>
            {statusLabel(trade.status, isZh)}
          </span>
        </td>

        {/* Market */}
        <td className="py-2 pr-3 overflow-hidden">
          <div className="flex items-center gap-1 min-w-0">
            {catIcon && <span className="shrink-0 leading-none">{catIcon}</span>}
            {trade.slug ? (
              <a
                href={`https://polymarket.com/event/${trade.slug}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="text-[var(--r-text-muted)] hover:text-[var(--r-accent)] transition-colors truncate no-underline block"
                title={question}
              >
                {questionShort || "—"}
              </a>
            ) : (
              <span className="text-[var(--r-text-faint)] truncate block" title={question}>
                {questionShort || "—"}
              </span>
            )}
          </div>
        </td>

        {/* Amount */}
        <td className="py-2 pr-3 text-right whitespace-nowrap">
          <div className="flex flex-col items-end gap-0.5">
            <span className="font-mono text-[var(--r-text-muted)]">
              {trade.amount != null ? fmtCompact(trade.amount) : "—"}
            </span>
            {trade.amount != null && (
              <div className="w-12 h-[3px] rounded-full bg-[var(--r-border)] overflow-hidden">
                <div className="h-full rounded-full bg-[var(--r-text-faint)]/40" style={{ width: `${amtPct}%` }} />
              </div>
            )}
          </div>
        </td>

        {/* P&L + chevron */}
        <td className="py-2 pr-0 text-right whitespace-nowrap">
          <div className="flex items-center justify-end gap-1.5 pr-2">
            {pnl != null ? (
              <span className={`font-mono font-medium ${pnl >= 0 ? "text-[var(--r-green)]" : "text-[var(--r-red)]"}`}>
                {pnl >= 0 ? "+" : ""}{fmtCompact(Math.abs(pnl))}
              </span>
            ) : isTradeOpen ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded font-medium text-[var(--r-accent)]/80 bg-[var(--r-accent)]/8">
                {isZh ? "持仓中" : "Open"}
              </span>
            ) : (
              <span className="text-[var(--r-text-faint)]">—</span>
            )}
            <span className="text-[var(--r-text-faint)] shrink-0">
              {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            </span>
          </div>
        </td>
      </tr>

      {/* Expanded detail row */}
      {open && (
        <tr className="bg-white/[0.02]">
          <td colSpan={6} className="px-4 pb-3 pt-2.5 border-b border-[var(--r-border)]/30">
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-x-6 gap-y-2.5 text-[11px]">
              <div>
                <p className="text-[var(--r-text-faint)] mb-0.5 text-[10px]">{isZh ? "入场价" : "Entry Price"}</p>
                <p className="font-mono font-medium">
                  {trade.entry_price != null ? `$${trade.entry_price.toFixed(3)}` : "—"}
                </p>
              </div>
              <div>
                <p className="text-[var(--r-text-faint)] mb-0.5 text-[10px]">
                  {isTradeOpen ? (isZh ? "当前价" : "Current Price") : (isZh ? "出场价" : "Exit Price")}
                </p>
                <p className="font-mono font-medium">
                  {isTradeOpen
                    ? trade.current_price != null ? `$${trade.current_price.toFixed(3)}` : "—"
                    : trade.exit_price    != null ? `$${trade.exit_price.toFixed(3)}`    : "—"}
                </p>
              </div>
              <div>
                <p className="text-[var(--r-text-faint)] mb-0.5 text-[10px]">{isZh ? "方向" : "Direction"}</p>
                <p className="font-medium capitalize">{trade.direction ?? "—"}</p>
              </div>
              {displayOutcome && (
                <div>
                  <p className="text-[var(--r-text-faint)] mb-0.5 text-[10px]">{isZh ? "标的" : "Outcome"}</p>
                  <p className="font-medium truncate" title={displayOutcome}>{displayOutcome}</p>
                </div>
              )}
              <div>
                <p className="text-[var(--r-text-faint)] mb-0.5 text-[10px]">{isZh ? "开仓时间" : "Opened"}</p>
                <p className="font-mono">{openedDate ?? "—"}</p>
              </div>
              {!isTradeOpen && closedDate && (
                <div>
                  <p className="text-[var(--r-text-faint)] mb-0.5 text-[10px]">{isZh ? "平仓时间" : "Closed"}</p>
                  <p className="font-mono">
                    {closedDate}
                    {holdDays != null && (
                      <span className="text-[var(--r-text-faint)] ml-1.5">· {holdDays}{isZh ? " 天" : "d"}</span>
                    )}
                  </p>
                </div>
              )}
              {isTradeOpen && trade.unrealized_pnl != null && (
                <div>
                  <p className="text-[var(--r-text-faint)] mb-0.5 text-[10px]">{isZh ? "浮盈" : "Unrealized"}</p>
                  <p className={`font-mono font-bold ${livePnl >= 0 ? "text-[var(--r-green)]" : "text-[var(--r-red)]"}`}>
                    {livePnl >= 0 ? "+$" : "-$"}{Math.abs(livePnl).toFixed(2)}
                  </p>
                </div>
              )}
              {!isTradeOpen && trade.close_reason_code && (
                <div>
                  <p className="text-[var(--r-text-faint)] mb-0.5 text-[10px]">{isZh ? "平仓原因" : "Close Reason"}</p>
                  <p className="font-medium text-[var(--r-text-muted)]">
                    {trade.close_reason_code.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase())}
                  </p>
                </div>
              )}
            </div>
            {/* Full question when truncated */}
            {question.length > 72 && (
              <div className="mt-2.5 pt-2.5 border-t border-[var(--r-border)]/30 text-[11px]">
                <p className="text-[var(--r-text-faint)] mb-0.5 text-[10px]">{isZh ? "完整题目" : "Full Question"}</p>
                {trade.slug ? (
                  <a
                    href={`https://polymarket.com/event/${trade.slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--r-text-muted)] hover:text-[var(--r-accent)] transition-colors inline-flex items-start gap-1"
                  >
                    <span>{question}</span>
                    <ExternalLink size={10} className="mt-0.5 shrink-0 opacity-40" />
                  </a>
                ) : (
                  <p className="text-[var(--r-text-muted)]">{question}</p>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Mobile expandable trade card ────────────────────────────────────────────

interface MobileTCProps {
  trade: TradeRow;
  fund: FundData | undefined;
  isZh: boolean;
}

function MobileTradeCard({ trade, fund, isZh }: MobileTCProps) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const meta        = STATUS_META[trade.status];
  const question    = (trade.question ?? "").slice(0, 60);
  const catIcon     = marketCategory(trade.question ?? "");
  const isTradeOpen = trade.status === "OPEN";
  const pnl         = trade.pnl ?? null;
  const livePnl     = trade.unrealized_pnl ?? 0;

  const isCategoricalOutcome =
    trade.outcome_name != null && trade.outcome_name !== "Yes" && trade.outcome_name !== "No";
  const displayOutcome = isCategoricalOutcome ? trade.outcome_name : null;
  const openedDate = trade.opened_at ? new Date(trade.opened_at).toLocaleDateString() : null;
  const closedDate = trade.closed_at ? new Date(trade.closed_at).toLocaleDateString() : null;
  const holdDays   = trade.opened_at
    ? Math.max(0, Math.floor(
        ((trade.closed_at ? new Date(trade.closed_at) : new Date()).getTime() -
          new Date(trade.opened_at).getTime()) / 86_400_000
      ))
    : null;

  return (
    <div className="glass-card text-[11px] overflow-hidden">
      <button className="w-full px-3 py-2.5 text-left" onClick={() => setOpen(o => !o)}>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="shrink-0">{fund?.emoji ?? "?"}</span>
            <span className="text-[var(--r-text-muted)] font-medium whitespace-nowrap">
              {fund ? fundDisplayName(fund.id, t) : trade.fund_id}
            </span>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${
              meta?.badge ?? "bg-white/5 text-[var(--r-text-faint)]"
            }`}>
              {statusLabel(trade.status, isZh)}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 ml-2">
            {pnl != null ? (
              <span className={`font-mono font-medium ${pnl >= 0 ? "text-[var(--r-green)]" : "text-[var(--r-red)]"}`}>
                {pnl >= 0 ? "+" : ""}{fmtCompact(Math.abs(pnl))}
              </span>
            ) : isTradeOpen ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded font-medium text-[var(--r-accent)]/80 bg-[var(--r-accent)]/8">
                {isZh ? "持仓中" : "Open"}
              </span>
            ) : null}
            <span className="text-[var(--r-text-faint)]">
              {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1 min-w-0">
            {catIcon && <span className="shrink-0 leading-none">{catIcon}</span>}
            <span className="text-[var(--r-text-faint)] truncate">{question || "—"}</span>
          </div>
          <span className="text-[var(--r-text-faint)] font-mono whitespace-nowrap shrink-0 text-[10px]">
            {fmtTradeTime(trade)}
          </span>
        </div>
      </button>

      {/* Expanded detail */}
      {open && (
        <div className="px-3 pb-3 pt-2 border-t border-[var(--r-border)] bg-white/[0.02] text-[11px]">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
            <div>
              <p className="text-[var(--r-text-faint)] mb-0.5 text-[10px]">{isZh ? "入场价" : "Entry Price"}</p>
              <p className="font-mono font-medium">
                {trade.entry_price != null ? `$${trade.entry_price.toFixed(3)}` : "—"}
              </p>
            </div>
            <div>
              <p className="text-[var(--r-text-faint)] mb-0.5 text-[10px]">
                {isTradeOpen ? (isZh ? "当前价" : "Current Price") : (isZh ? "出场价" : "Exit Price")}
              </p>
              <p className="font-mono font-medium">
                {isTradeOpen
                  ? trade.current_price != null ? `$${trade.current_price.toFixed(3)}` : "—"
                  : trade.exit_price    != null ? `$${trade.exit_price.toFixed(3)}`    : "—"}
              </p>
            </div>
            <div>
              <p className="text-[var(--r-text-faint)] mb-0.5 text-[10px]">{isZh ? "方向" : "Direction"}</p>
              <p className="font-medium capitalize">{trade.direction ?? "—"}</p>
            </div>
            <div>
              <p className="text-[var(--r-text-faint)] mb-0.5 text-[10px]">{isZh ? "开仓时间" : "Opened"}</p>
              <p className="font-mono">{openedDate ?? "—"}</p>
            </div>
            {!isTradeOpen && closedDate && (
              <div>
                <p className="text-[var(--r-text-faint)] mb-0.5 text-[10px]">{isZh ? "平仓时间" : "Closed"}</p>
                <p className="font-mono">
                  {closedDate}
                  {holdDays != null && (
                    <span className="text-[var(--r-text-faint)] ml-1">· {holdDays}{isZh ? " 天" : "d"}</span>
                  )}
                </p>
              </div>
            )}
            {isTradeOpen && trade.unrealized_pnl != null && (
              <div>
                <p className="text-[var(--r-text-faint)] mb-0.5 text-[10px]">{isZh ? "浮盈" : "Unrealized"}</p>
                <p className={`font-mono font-bold ${livePnl >= 0 ? "text-[var(--r-green)]" : "text-[var(--r-red)]"}`}>
                  {livePnl >= 0 ? "+$" : "-$"}{Math.abs(livePnl).toFixed(2)}
                </p>
              </div>
            )}
            {displayOutcome && (
              <div>
                <p className="text-[var(--r-text-faint)] mb-0.5 text-[10px]">{isZh ? "标的" : "Outcome"}</p>
                <p className="font-medium truncate" title={displayOutcome}>{displayOutcome}</p>
              </div>
            )}
            {!isTradeOpen && trade.close_reason_code && (
              <div className="col-span-2">
                <p className="text-[var(--r-text-faint)] mb-0.5 text-[10px]">{isZh ? "平仓原因" : "Close Reason"}</p>
                <p className="font-medium text-[var(--r-text-muted)]">
                  {trade.close_reason_code.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase())}
                </p>
              </div>
            )}
          </div>
          {trade.slug && (
            <div className="mt-2 pt-2 border-t border-[var(--r-border)]/30">
              <a
                href={`https://polymarket.com/event/${trade.slug}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[var(--r-accent)]/80 hover:text-[var(--r-accent)] transition-colors text-[10px]"
              >
                {isZh ? "在 Polymarket 查看" : "View on Polymarket"}
                <ExternalLink size={9} className="opacity-60" />
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TradeHistoryPanel({
  funds,
  externalFundFilter,
}: {
  funds: FundData[];
  externalFundFilter?: string;
}) {
  const { t, locale } = useI18n();
  const isZh = locale === "zh";

  const [fundFilter, setFundFilter] = useState<string>(externalFundFilter ?? "all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [timeRange, setTimeRange] = useState<TradeTimeRange>("all");

  // P1-1 drill-down: when parent sets externalFundFilter, sync local state
  useEffect(() => {
    if (externalFundFilter !== undefined) setFundFilter(externalFundFilter);
  }, [externalFundFilter]);
  // P1-1: sorting state
  const [sortCol, setSortCol] = useState<SortCol | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Always request the server's max cap so KPI aggregates (realized P&L,
  // win rate, avg position) reflect every trade in the chosen window — and
  // crucially so "All" never appears to have fewer rows than "7D" / "30D".
  const apiPath = useMemo(() => {
    const since = tradeSinceTimestamp(timeRange);
    if (!since) return "/api/trades?limit=1000";
    return `/api/trades?since=${encodeURIComponent(since)}&limit=1000`;
  }, [timeRange]);

  const { data, loading } = useFetch<{ trades: TradeRow[] }>(apiPath, 120_000);
  const trades = data?.trades ?? [];

  const fundMap = useMemo(
    () => new Map(funds.map((f) => [f.id, f])),
    [funds]
  );

  const filtered = useMemo(() => {
    // The server already caps response size (≤1000 rows). No client-side
    // slice here — it would silently shrink the KPI window below what the
    // user picked (e.g. "All" looked smaller than "7D" because of an
    // arbitrary slice(0, 400) leftover from when the server hard-capped at 200).
    let rows = trades.filter((tr) => {
      if (fundFilter !== "all" && tr.fund_id !== fundFilter) return false;
      if (statusFilter !== "all" && tr.status !== statusFilter) return false;
      return true;
    });

    // P1-1: apply sort
    if (sortCol) {
      rows = [...rows].sort((a, b) => {
        let av: number, bv: number;
        if (sortCol === "time") {
          av = new Date(a.closed_at ?? a.opened_at ?? "").getTime();
          bv = new Date(b.closed_at ?? b.opened_at ?? "").getTime();
        } else if (sortCol === "amount") {
          av = a.amount ?? -1;
          bv = b.amount ?? -1;
        } else {
          av = a.pnl ?? -Infinity;
          bv = b.pnl ?? -Infinity;
        }
        return sortDir === "asc" ? av - bv : bv - av;
      });
    }
    return rows;
  }, [trades, fundFilter, statusFilter, sortCol, sortDir]);

  // P0-3: KPI aggregations
  const closedWithPnl = filtered.filter((tr) => tr.status !== "OPEN" && tr.pnl != null);
  const totalPnl = closedWithPnl.reduce((s, tr) => s + (tr.pnl ?? 0), 0);
  const winCount = closedWithPnl.filter((tr) => (tr.pnl ?? 0) > 0).length;
  const winRate = closedWithPnl.length > 0 ? (winCount / closedWithPnl.length) * 100 : null;
  const amountRows = filtered.filter((tr) => tr.amount != null);
  const avgAmount =
    amountRows.length > 0
      ? amountRows.reduce((s, tr) => s + (tr.amount ?? 0), 0) / amountRows.length
      : null;
  // P1-4: max amount for bar width
  const maxAmount = amountRows.length > 0 ? Math.max(...amountRows.map((tr) => tr.amount!)) : 1;

  const toggleSort = (col: SortCol) => {
    if (sortCol === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("desc"); }
  };

  // P1-1: sortable column header

  // P1-1: sortable column header
  const SortTh = ({
    col,
    label,
    right,
  }: {
    col: SortCol;
    label: string;
    right?: boolean;
  }) => (
    <th
      className={`font-normal py-2 pr-3 whitespace-nowrap cursor-pointer select-none
        hover:text-[var(--r-text)] transition-colors ${right ? "text-right" : "text-left"}`}
      onClick={() => toggleSort(col)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span
          className={`text-[9px] transition-opacity ${
            sortCol === col ? "opacity-100 text-[var(--r-accent)]" : "opacity-25"
          }`}
        >
          {sortCol === col ? (sortDir === "asc" ? "↑" : "↓") : "⇅"}
        </span>
      </span>
    </th>
  );

  if (loading && !data) return <AnalysisSkeleton />;
  if (trades.length === 0) return <EmptyState label={t("analysisNoData")} />;

  const timeOpts = [
    { v: "today" as const, l: t("analysisToday") },
    { v: "7d" as const,    l: t("analysis7D") },
    { v: "30d" as const,   l: t("analysis30D") },
    { v: "90d" as const,   l: t("analysis90D") },
    { v: "all" as const,   l: t("analysisAllTime") },
  ];

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
              label: statusLabel(s, isZh),
            })),
          ]}
        />
        {/* Time range pills — aligned with Tab 1 / Tab 2 visual treatment */}
        {timeOpts.map(({ v, l }) => (
          <Pill key={v} active={timeRange === v} onClick={() => setTimeRange(v)}>
            {l}
          </Pill>
        ))}
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

      {/* P0-3: KPI aggregate bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        {[
          {
            label: isZh ? "已筛选" : "Showing",
            value: `${filtered.length}${isZh ? " 条" : ""}`,
            color: undefined,
          },
          {
            label: isZh ? "已实现盈亏" : "Realized P&L",
            value: closedWithPnl.length > 0
              ? `${totalPnl >= 0 ? "+" : ""}${fmtCompact(Math.abs(totalPnl))}`
              : "—",
            color: closedWithPnl.length > 0
              ? totalPnl >= 0 ? "var(--r-green)" : "var(--r-red)"
              : undefined,
          },
          {
            label: isZh ? "胜率" : "Win Rate",
            value: winRate != null ? `${winRate.toFixed(1)}%` : "—",
            color: winRate != null
              ? winRate >= 50 ? "var(--r-green)" : "var(--r-red)"
              : undefined,
          },
          {
            label: isZh ? "平均仓位" : "Avg Position",
            value: avgAmount != null ? fmtCompact(avgAmount) : "—",
            color: undefined,
          },
        ].map(({ label, value, color }) => (
          <div key={label} className="glass-card px-3 py-2">
            <p className="text-[10px] text-[var(--r-text-faint)] mb-1 truncate">{label}</p>
            <p
              className="text-sm font-semibold font-mono tabular-nums leading-tight"
              style={{ color: color ?? "var(--r-text)" }}
            >
              {value}
            </p>
          </div>
        ))}
      </div>

      {/* P1-3: Desktop table with fixed layout for proper truncation */}
      <div className="hidden sm:block overflow-x-auto -mx-4 px-4">
        <table
          className="w-full min-w-[680px] text-[11px]"
          style={{ tableLayout: "fixed" }}
        >
          <colgroup>
            <col style={{ width: 108 }} />
            <col style={{ width: 100 }} />
            <col style={{ width: 96 }} />
            <col />{/* market — takes remaining */}
            <col style={{ width: 96 }} />
            <col style={{ width: 84 }} />
          </colgroup>
          <thead>
            <tr className="border-b border-[var(--r-border)] text-[var(--r-text-faint)]">
              <SortTh col="time"   label={isZh ? "时间" : "Time"} />
              <th className="text-left font-normal py-2 pr-3 whitespace-nowrap">
                {isZh ? "基金" : "Fund"}
              </th>
              <th className="text-left font-normal py-2 pr-3 whitespace-nowrap">
                {isZh ? "状态" : "Status"}
              </th>
              <th className="text-left font-normal py-2 pr-3">
                {isZh ? "市场" : "Market"}
              </th>
              <SortTh col="amount" label={isZh ? "仓位" : "Amount"} right />
              <SortTh col="pnl"    label={isZh ? "收益" : "P&L"}    right />
            </tr>
          </thead>
          <tbody>
            {filtered.map((trade, i) => (
              <ExpandableTradeRow
                key={`${trade.fund_id}-${trade.opened_at}-${i}`}
                trade={trade}
                index={i}
                fund={fundMap.get(trade.fund_id)}
                maxAmount={maxAmount}
                isZh={isZh}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile card list */}
      <div className="sm:hidden space-y-2">
        {filtered.map((trade, i) => (
          <MobileTradeCard
            key={`m-${trade.fund_id}-${trade.opened_at}-${i}`}
            trade={trade}
            fund={fundMap.get(trade.fund_id)}
            isZh={isZh}
          />
        ))}
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
  // Trades are fetched inside TradeHistoryPanel so the request URL can react
  // to the user's time-range selection.
  // Epoch data for NAV milestone markers
  const { data: evoData } = useFetch<{
    epochs: EpochStat[];
  }>("/api/evolution?limit=50", 600_000);

  const funds = fundsData?.funds ?? [];
  const snapshots = snapData?.snapshots ?? [];
  const epochStats = evoData?.epochs ?? [];

  const [activeTab, setActiveTab] = useState<"nav" | "returns" | "trades">("nav");
  // Heatmap cell → trade records drill-down
  const [drillDownFund, setDrillDownFund] = useState<string | undefined>();

  const handleDrillDown = useCallback((fundId: string) => {
    setDrillDownFund(fundId);
    setActiveTab("trades");
  }, []);

  const handleTabChange = useCallback((tab: "nav" | "returns" | "trades") => {
    setActiveTab(tab);
    if (tab !== "trades") setDrillDownFund(undefined);
  }, []);

  const tabs = [
    { id: "nav" as const, label: t("analysisTabNav") },
    { id: "returns" as const, label: t("analysisTabReturns") },
    { id: "trades" as const, label: t("analysisTabTrades") },
  ];

  const isLoading =
    fundsLoading ||
    (activeTab !== "trades" && snapLoading);
    // Tab "trades" manages its own loading state inside TradeHistoryPanel.

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-base font-semibold text-[var(--r-text)] leading-tight">
          {t("analysisPageTitle")}
        </h1>
        <p className="text-xs text-[var(--r-text-faint)] mt-0.5 leading-relaxed">
          {t("analysisPageSub")}
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-0 mb-6 border-b border-[var(--r-border)]">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => handleTabChange(tab.id)}
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
            <NavTrendPanel snapshots={snapshots} funds={funds} epochStats={epochStats} />
          )}
          {activeTab === "returns" && (
            <DailyReturnsPanel snapshots={snapshots} funds={funds} onDrillDown={handleDrillDown} />
          )}
          {activeTab === "trades" && (
            <TradeHistoryPanel funds={funds} externalFundFilter={drillDownFund} />
          )}
        </>
      )}
    </div>
  );
}
