import { Link } from "react-router-dom";
import { FUND_ICONS } from "./icons/FundIcons";
import { useI18n } from "../i18n/context";
import {
  FUND_COLORS, FUND_GRADIENTS, FUND_BORDER_COLORS,
  FUND_NAME_KEYS, FUND_MOTTO_KEYS,
  fundDisplayName, fundTierLabel, groupByTier,
} from "../lib/fundMeta";

// Re-export for backward compat (FundDetail imports FUND_COLORS from here)
export { FUND_COLORS };

interface Fund {
  id: string;
  name: string;
  emoji: string;
  motto: string;
  initialBalance: number;
  totalValue: number;
  returnPct: number;
  winRate: number;
  openPositions: number;
  monthlyTarget: number;
  frozen: boolean;
}

const RANK_STYLES = [
  "bg-yellow-500/20 text-yellow-400 border-yellow-500/40",
  "bg-gray-400/20 text-gray-300 border-gray-400/40",
  "bg-amber-600/20 text-amber-500 border-amber-600/40",
  "bg-[var(--r-surface)] text-[var(--r-text-muted)] border-[var(--r-border)]",
  "bg-[var(--r-surface)] text-[var(--r-text-muted)] border-[var(--r-border)]",
];

// Tier section header label → translation key
const TIER_HEADER_KEYS = {
  S: "tierSmall",
  M: "tierMedium",
  L: "tierLarge",
} as const;

function MiniSparkline({ data, positive }: { data: number[]; positive: boolean }) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const w = 64;
  const h = 28;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return `${x},${y}`;
  }).join(" ");

  const color = positive ? "var(--r-accent)" : "var(--r-red)";

  return (
    <svg width={w} height={h} className="shrink-0 hidden sm:block">
      <polyline fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" points={points} />
    </svg>
  );
}

function FundCard({ fund, rank, sparklines }: { fund: Fund; rank: number; sparklines?: Record<string, number[]> }) {
  const { t } = useI18n();
  const pnlClass = fund.returnPct >= 0 ? "pnl-positive" : "pnl-negative";
  const sign = fund.returnPct >= 0 ? "+" : "";
  const Icon = FUND_ICONS[fund.id];
  const color = FUND_COLORS[fund.id] || "text-[var(--r-text-muted)]";
  const nameKey = FUND_NAME_KEYS[fund.id];
  const mottoKey = FUND_MOTTO_KEYS[fund.id];
  const gradient = FUND_GRADIENTS[fund.id] || "";
  const borderAccent = FUND_BORDER_COLORS[fund.id] || "";
  const tierBadge = fundTierLabel(fund.id);

  return (
    <Link
      to={`/fund/${fund.id}`}
      className={`glass-card p-5 flex items-center gap-4 transition-all duration-300 cursor-pointer hover:border-[var(--r-accent)] hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/20 no-underline text-inherit border-l-3 ${borderAccent} bg-gradient-to-r ${gradient} ${
        fund.frozen ? "opacity-60" : ""
      }`}
      style={{ animationDelay: `${rank * 60}ms` }}
    >
      <span
        className={`w-8 h-8 flex items-center justify-center rounded-lg text-xs font-bold border shrink-0 ${RANK_STYLES[rank] || RANK_STYLES[4]}`}
      >
        {rank + 1}
      </span>

      {Icon ? (
        <span className={`shrink-0 ${color}`}>
          <Icon size={32} />
        </span>
      ) : (
        <span className="text-3xl shrink-0">{fund.emoji}</span>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span className="font-bold text-lg">{fundDisplayName(fund.id, t)}</span>
          {nameKey && (
            <span className="text-[10px] font-mono px-1 py-px rounded bg-[var(--r-surface)] text-[var(--r-text-muted)] border border-[var(--r-border)] shrink-0">
              {tierBadge}
            </span>
          )}
          <span
            className="text-[10px] text-[var(--r-text-faint)] font-normal tracking-wide opacity-70 shrink-0"
            title={t("evolvableStrategyBody")}
          >
            · {t("evolvableStrategyBody")}
          </span>
          {fund.frozen && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30">
              {t("frozen")}
            </span>
          )}
        </div>
        <p className="text-sm text-[var(--r-text-muted)] truncate">
          {mottoKey ? t(mottoKey) : fund.motto}
        </p>
      </div>

      {sparklines?.[fund.id] && <MiniSparkline data={sparklines[fund.id]} positive={fund.returnPct >= 0} />}

      <div className="text-right shrink-0">
        <p className="text-xl font-bold font-mono">${fund.totalValue.toLocaleString()}</p>
        <p className={`text-sm font-mono font-medium ${pnlClass}`}>
          {sign}{fund.returnPct.toFixed(2)}%
        </p>
      </div>

      <div className="text-right shrink-0 hidden sm:block">
        <p className="text-sm text-[var(--r-text-muted)]">{t("wr")} {Math.round(fund.winRate * 100)}%</p>
        <p className="text-sm text-[var(--r-text-muted)]">{fund.openPositions} {t("open")}</p>
      </div>
      <div className="text-right shrink-0 sm:hidden">
        <p className="text-xs text-[var(--r-text-muted)]">{t("wr")} {Math.round(fund.winRate * 100)}%</p>
      </div>
    </Link>
  );
}

export function FundRanking({ funds, sparklines }: { funds: Fund[]; sparklines?: Record<string, number[]> }) {
  const { t } = useI18n();

  // If only small-tier funds, render flat list (backward compat for initial phase)
  const fundIds = funds.map(f => f.id);
  const tierGroups = groupByTier(fundIds);
  const isMultiTier = tierGroups.length > 1;

  if (!isMultiTier) {
    return (
      <div className="space-y-3">
        {funds.map((fund, i) => (
          <FundCard key={fund.id} fund={fund} rank={i} sparklines={sparklines} />
        ))}
      </div>
    );
  }

  // Multi-tier: render with tier section headers (S → M → L)
  return (
    <div className="space-y-6">
      {tierGroups.map(group => {
        const tierFunds = group.funds
          .map(id => funds.find(f => f.id === id))
          .filter(Boolean) as Fund[];
        // Sort within tier by totalValue descending (as proxy for performance)
        const sorted = [...tierFunds].sort((a, b) => b.totalValue - a.totalValue);
        const headerKey = TIER_HEADER_KEYS[group.label];

        return (
          <div key={group.tier}>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-[var(--r-surface)] text-[var(--r-text-muted)] border border-[var(--r-border)] uppercase tracking-widest">
                {t(headerKey)}
              </span>
              <div className="flex-1 h-px bg-[var(--r-border)] opacity-40" />
            </div>
            <div className="space-y-2">
              {sorted.map((fund, i) => (
                <FundCard key={fund.id} fund={fund} rank={i} sparklines={sparklines} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
