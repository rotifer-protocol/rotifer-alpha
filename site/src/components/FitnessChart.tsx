import { useState, useEffect, useRef } from "react";
import {
  ComposedChart, Line, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceArea,
} from "recharts";
import type { TranslationKey } from "../i18n/translations";
import { useI18n } from "../i18n/context";
import { FUND_HEX_COLORS, fundDisplayName, fundPersonality } from "../lib/fundMeta";

interface EvolutionLog {
  epoch: number;
  fund_id: string;
  fitness_before: number | null;
  fitness_after: number | null;
  action: string;
  reason?: string;
}

interface Props {
  logs: EvolutionLog[];
  /** All fund IDs from lineage — includes funds with no fitness data yet */
  allFundIds?: string[];
}

// ─── Custom Tooltip (excludes _min/_bandSize from display) ──────────────────
function ChartTooltip({
  active,
  payload,
  label,
  t,
  inheritAtEpoch,
}: {
  active?: boolean;
  payload?: { dataKey?: string; value?: unknown; stroke?: string }[];
  label?: string;
  t: (k: TranslationKey) => string;
  inheritAtEpoch?: { fundId: string; from: string }[];
}) {
  if (!active || !payload?.length) return null;
  const visible = payload.filter(p => {
    const k = String(p.dataKey ?? "");
    return (k.endsWith("_after") || k.endsWith("_before")) && !k.startsWith("_");
  });
  const hasInherit = (inheritAtEpoch?.length ?? 0) > 0;
  if (!visible.length && !hasInherit) return null;
  return (
    <div
      style={{
        background: "#111113",
        border: "1px solid #27272a",
        borderRadius: 8,
        fontSize: 12,
        padding: "8px 12px",
        minWidth: 180,
      }}
    >
      <p style={{ color: "#a1a1aa", marginBottom: 6, fontSize: 11 }}>{label}</p>
      {visible.map(entry => {
        const k = String(entry.dataKey ?? "");
        const isAfter = k.endsWith("_after");
        const baseFid = isAfter ? k.slice(0, -6) : k.slice(0, -7);
        const suffix = isAfter ? t("evoFitnessAfter") : t("evoFitnessBefore");
        const color = entry.stroke || "#a1a1aa";
        return (
          <div
            key={k}
            style={{ display: "flex", justifyContent: "space-between", gap: 16, color }}
          >
            <span>{fundDisplayName(baseFid, t)} ({suffix})</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              {Number(entry.value).toFixed(4)}
            </span>
          </div>
        );
      })}
      {hasInherit && (
        <>
          <div style={{ height: 1, background: "#27272a", margin: "6px 0" }} />
          {inheritAtEpoch!.map(ev => (
            <div
              key={ev.fundId}
              style={{ display: "flex", justifyContent: "space-between", gap: 12, color: "#a1a1aa", fontSize: 11 }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ opacity: 0.7 }}>⇅</span>
                <span style={{ color: FUND_HEX_COLORS[ev.fundId] ?? "#a1a1aa" }}>
                  {fundDisplayName(ev.fundId, t)}
                </span>
              </span>
              <span>
                {t("fitnessInheritFrom")} {fundDisplayName(ev.from, t)}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ─── Threshold label (Recharts injects viewBox via cloneElement) ─────────────
function ThresholdLabel({
  viewBox,
  text,
  color,
}: {
  viewBox?: { x: number; y: number; width: number };
  text: string;
  color: string;
}) {
  if (!viewBox) return null;
  return (
    <text
      x={viewBox.x + 4}
      y={viewBox.y - 4}
      fontSize={9}
      fill={color}
      opacity={0.72}
    >
      {text}
    </text>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────
export function FitnessChart({ logs, allFundIds: allFundIdsProp }: Props) {
  const { t, locale } = useI18n();
  const [showBefore, setShowBefore] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth < 640 : false,
  );

  // Recharts v3 re-renders the SVG on every interaction, resetting tabIndex="0" each time.
  // The only reliable fix: capture every focusin on the SVG and immediately blur it
  // synchronously, before the browser schedules the next paint (which would render the ring).
  const chartWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const wrap = chartWrapRef.current;
    if (!wrap) return;
    const suppressSvgFocus = (e: FocusEvent) => {
      if (e.target instanceof SVGElement) {
        (e.target as unknown as { blur?: () => void }).blur?.();
      }
    };
    wrap.addEventListener("focusin", suppressSvgFocus);
    return () => wrap.removeEventListener("focusin", suppressSvgFocus);
  });

  useEffect(() => {
    const h = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);

  // Funds that appear in logs
  const logFundIds = [...new Set(logs.map(l => l.fund_id))];
  // Full list: use lineage-passed prop so funds with no log entries are included
  const allFundIds = allFundIdsProp
    ? [...new Set([...logFundIds, ...allFundIdsProp])]
    : logFundIds;
  // Which funds have actual plotable fitness data (at least one non-null fitness_after)
  const fundsWithData = new Set(
    logs.filter(l => l.fitness_after != null).map(l => l.fund_id)
  );
  const epochs = [...new Set(logs.map(l => l.epoch))].sort((a, b) => a - b);

  // ── Inherit events: PBT_INHERIT_MUTATE (fitness_after=null, fitness_before=last known) ──
  const inheritEvents = logs.filter(
    l => l.action === "PBT_INHERIT_MUTATE" && l.fitness_before != null,
  );
  // Map: epochLabel ("E5") → [{fundId, from}]
  const inheritByEpoch: Record<string, { fundId: string; from: string }[]> = {};
  for (const ev of inheritEvents) {
    const key = `E${ev.epoch}`;
    if (!inheritByEpoch[key]) inheritByEpoch[key] = [];
    const match = ev.reason?.match(/inherited from (\S+)/);
    const from = match?.[1]?.replace(/[,)]/g, "") ?? "unknown";
    inheritByEpoch[key].push({ fundId: ev.fund_id, from });
  }

  if (epochs.length === 0) {
    return (
      <div className="glass-card p-6 text-center text-sm text-[var(--r-text-muted)]">
        {t("fitnessEmpty")}
      </div>
    );
  }

  // Group fund IDs by personality (family)
  const familyMap: Record<string, string[]> = {};
  for (const fid of allFundIds) {
    const p = fundPersonality(fid);
    if (!familyMap[p]) familyMap[p] = [];
    familyMap[p].push(fid);
  }
  const families = Object.keys(familyMap);

  // Mobile always uses family (collapsed) view
  const effectiveExpanded = isMobile ? false : expanded;
  const displayIds = effectiveExpanded ? allFundIds : families;
  const lastIdx = epochs.length - 1;

  // ── Build chart data ────────────────────────────────────────────────────────
  const data = epochs.map(epoch => {
    const point: Record<string, number | string> = { epoch: `E${epoch}` };
    const afterVals: number[] = [];

    for (const did of displayIds) {
      let afterVal: number | null = null;
      let beforeVal: number | null = null;

      if (effectiveExpanded) {
        const log = logs.find(l => l.epoch === epoch && l.fund_id === did);
        afterVal = log?.fitness_after ?? null;
        beforeVal = log?.fitness_before ?? null;
      } else {
        // Family representative: best (max) fitness across variants
        const varLogs = (familyMap[did] ?? [])
          .map(vid => logs.find(l => l.epoch === epoch && l.fund_id === vid))
          .filter(Boolean) as EvolutionLog[];
        afterVal = varLogs.reduce<number | null>((best, l) => {
          if (l.fitness_after === null) return best;
          return best === null ? l.fitness_after : Math.max(best, l.fitness_after);
        }, null);
        beforeVal = varLogs.reduce<number | null>((best, l) => {
          if (l.fitness_before === null) return best;
          return best === null ? l.fitness_before : Math.max(best, l.fitness_before);
        }, null);
      }

      if (afterVal !== null) {
        point[`${did}_after`] = afterVal;
        afterVals.push(afterVal);
      }
      if (showBefore && beforeVal !== null) {
        point[`${did}_before`] = beforeVal;
      }
    }

    // Min-max band (only when 2+ series)
    if (afterVals.length > 1) {
      const mn = Math.min(...afterVals);
      const mx = Math.max(...afterVals);
      point._min = mn;
      point._bandSize = mx - mn;
    }

    // Inherit markers (expanded mode only — individual fund view)
    if (effectiveExpanded) {
      for (const ev of inheritEvents) {
        if (ev.epoch === epoch && ev.fitness_before != null) {
          point[`${ev.fund_id}_inherit`] = ev.fitness_before;
        }
      }
    }

    return point;
  });

  // ── Best fund at last epoch ─────────────────────────────────────────────────
  const lastPt = data[lastIdx];
  let bestId: string | null = null;
  let bestVal = -Infinity;
  for (const did of displayIds) {
    const v = lastPt?.[`${did}_after`];
    if (typeof v === "number" && v > bestVal) {
      bestVal = v;
      bestId = did;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const getColor = (did: string) => FUND_HEX_COLORS[did] ?? "#a1a1aa";
  const getLabel = (did: string) => fundDisplayName(did, t);
  const getOpacity = (did: string) =>
    hoveredId === null ? 1 : hoveredId === did ? 1 : 0.15;

  // Custom dot: invisible everywhere; label + dot only at last index
  const makeEndDot = (did: string) => (props: {
    cx?: number;
    cy?: number;
    index?: number;
  }) => {
    const { cx, cy, index } = props;
    if (index !== lastIdx || cx === undefined || cy === undefined) {
      return (
        <circle
          key={`dot-${did}-${index}`}
          cx={cx ?? 0}
          cy={cy ?? 0}
          r={0}
          fill="none"
        />
      );
    }
    const color = getColor(did);
    const isBest = did === bestId;
    const label = getLabel(did);
    return (
      <g key={`dot-${did}-end`}>
        {isBest && <circle cx={cx} cy={cy} r={7} fill={color} opacity={0.15} />}
        <circle cx={cx} cy={cy} r={isBest ? 4 : 3} fill={color} />
        <text
          x={cx + 8}
          y={cy + 4}
          fontSize={9.5}
          fill={color}
          fontWeight={isBest ? 700 : 500}
        >
          {isBest ? `★ ${label}` : label}
        </text>
      </g>
    );
  };

  const rightMargin = isMobile ? 64 : 88;

  return (
    <div className="glass-card p-4">
      {/* ── Header ── */}
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <h3 className="text-sm font-medium text-[var(--r-text-muted)] uppercase tracking-widest">
          {t("fitnessTitle")}
        </h3>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShowBefore(v => !v)}
            className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
              showBefore
                ? "border-[var(--r-accent)] text-[var(--r-accent)] bg-[var(--r-accent)]/10"
                : "border-[var(--r-border)] text-[var(--r-text-muted)] hover:border-[var(--r-text-muted)]"
            }`}
          >
            {t("fitnessToggleBefore")}
          </button>
          {!isMobile && (
            <button
              onClick={() => setExpanded(v => !v)}
              className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                expanded
                  ? "border-[var(--r-accent)] text-[var(--r-accent)] bg-[var(--r-accent)]/10"
                  : "border-[var(--r-border)] text-[var(--r-text-muted)] hover:border-[var(--r-text-muted)]"
              }`}
            >
              {expanded ? t("fitnessCollapse") : t("fitnessExpand")}
            </button>
          )}
        </div>
      </div>

      {/* ── Chart ── */}
      <div ref={chartWrapRef}>
      <ResponsiveContainer width="100%" height={isMobile ? 200 : 260}>
        <ComposedChart
          data={data}
          margin={{ top: 8, right: rightMargin, bottom: 0, left: -8 }}
        >
          <XAxis
            dataKey="epoch"
            tick={{ fill: "#a1a1aa", fontSize: 11 }}
            axisLine={{ stroke: "#27272a" }}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: "#a1a1aa", fontSize: 11 }}
            axisLine={{ stroke: "#27272a" }}
            tickLine={false}
            domain={["auto", "auto"]}
            tickFormatter={(v: number) => v.toFixed(2)}
          />
          <Tooltip
            cursor={{ stroke: "rgba(255,255,255,0.12)", strokeWidth: 1, fill: "none" }}
            content={(props: object) => {
              const p = props as Parameters<typeof ChartTooltip>[0] & { label?: string };
              return (
                <ChartTooltip
                  {...p}
                  t={t}
                  inheritAtEpoch={inheritByEpoch[p.label ?? ""] ?? []}
                />
              );
            }} />

          {/* Threshold zones */}
          <ReferenceArea y1={0} y2={0.2} fill="#ef4444" fillOpacity={0.04} />
          <ReferenceArea y1={0.6} y2={1.2} fill="#22c55e" fillOpacity={0.04} />
          <ReferenceLine
            y={0.6}
            stroke="#22c55e"
            strokeDasharray="4 4"
            strokeOpacity={0.4}
            label={<ThresholdLabel text={t("fitnessGoodZone")} color="#22c55e" />}
          />
          <ReferenceLine
            y={0.2}
            stroke="#ef4444"
            strokeDasharray="4 4"
            strokeOpacity={0.4}
            label={<ThresholdLabel text={t("fitnessResetZone")} color="#ef4444" />}
          />

          {/* Min-max range band (stacked Area trick) */}
          <Area
            type="monotone"
            dataKey="_min"
            stroke="none"
            fill="none"
            dot={false}
            activeDot={false}
            legendType="none"
            stackId="band"
            connectNulls
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="_bandSize"
            stroke="none"
            fill="#a1a1aa"
            fillOpacity={0.08}
            dot={false}
            activeDot={false}
            legendType="none"
            stackId="band"
            connectNulls
            isAnimationActive={false}
          />

          {/* Before lines — dashed, dimmed */}
          {showBefore &&
            displayIds.map(did => (
              <Line
                key={`${did}_before`}
                type="monotone"
                dataKey={`${did}_before`}
                stroke={getColor(did)}
                strokeWidth={1.2}
                strokeDasharray="4 3"
                strokeOpacity={getOpacity(did) * 0.5}
                dot={false}
                connectNulls
                legendType="none"
                activeDot={false}
              />
            ))}

          {/* After lines — solid, primary, with end-of-line labels */}
          {displayIds.map(did => (
            <Line
              key={`${did}_after`}
              type="monotone"
              dataKey={`${did}_after`}
              stroke={getColor(did)}
              strokeWidth={hoveredId === did ? 2.5 : 2}
              strokeOpacity={getOpacity(did)}
              dot={makeEndDot(did) as (props: object) => React.ReactElement}
              activeDot={{ r: 5, fill: getColor(did) }}
              connectNulls
              legendType="none"
            />
          ))}

          {/* ── Inherit markers (hollow dashed ring) — expanded mode only ── */}
          {effectiveExpanded && inheritEvents.length > 0 &&
            [...new Set(inheritEvents.map(e => e.fund_id))].map(did => {
              const color = getColor(did);
              return (
                <Line
                  key={`${did}_inherit`}
                  type="monotone"
                  dataKey={`${did}_inherit`}
                  stroke="none"
                  dot={(props: object) => {
                    const { cx, cy } = props as { cx?: number; cy?: number; value?: unknown };
                    if (cx === undefined || cy === undefined) return <circle key="empty" r={0} fill="none" />;
                    return (
                      <g key={`inherit-marker-${did}-${cx}-${cy}`}>
                        {/* Outer dashed ring */}
                        <circle cx={cx} cy={cy} r={6} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray="3 2" opacity={0.75} />
                        {/* Inner dot */}
                        <circle cx={cx} cy={cy} r={2} fill={color} opacity={0.5} />
                      </g>
                    );
                  }}
                  activeDot={false}
                  legendType="none"
                  connectNulls={false}
                  isAnimationActive={false}
                />
              );
            })
          }
        </ComposedChart>
      </ResponsiveContainer>
      </div>

      {/* ── Interactive fund tags (hover to focus) ── */}
      <div
        className="flex flex-wrap gap-1.5 mt-2 px-1"
        onMouseLeave={() => setHoveredId(null)}
      >
        {/* Active tags — have fitness data, hover highlights their line */}
        {displayIds.filter(did => fundsWithData.has(did)).map(did => {
          const color = getColor(did);
          const isBest = did === bestId;
          const isHov = hoveredId === did;
          return (
            <button
              key={did}
              onMouseEnter={() => setHoveredId(did)}
              className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded transition-all duration-150 cursor-default"
              style={{
                color,
                opacity: hoveredId !== null && !isHov ? 0.4 : 1,
                background: `${color}18`,
                border: `1px solid ${color}${isHov ? "60" : "28"}`,
              }}
            >
              {isBest && <span className="mr-0.5">★</span>}
              <span>{getLabel(did)}</span>
            </button>
          );
        })}

        {/* Inactive tags — no fitness data yet; shown dimmed, no hover interaction */}
        {effectiveExpanded && displayIds.filter(did => !fundsWithData.has(did)).map(did => {
          const color = getColor(did);
          return (
            <span
              key={did}
              title={locale === "zh" ? "尚未参与进化" : "Not yet evolved"}
              className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded cursor-default opacity-30"
              style={{
                color,
                background: `${color}10`,
                border: `1px solid ${color}18`,
              }}
            >
              <span>{getLabel(did)}</span>
              <span className="ml-0.5 text-[9px]">—</span>
            </span>
          );
        })}

        {isMobile && (
          <span className="text-[9px] text-[var(--r-text-muted)] self-center ml-1">
            {t("fitnessExpand")}
          </span>
        )}
      </div>
    </div>
  );
}
