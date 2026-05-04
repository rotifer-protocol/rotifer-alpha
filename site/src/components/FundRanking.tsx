import { Link } from "react-router-dom";
import { FUND_ICONS } from "./icons/FundIcons";
import { useI18n } from "../i18n/context";
import type { TranslationKey } from "../i18n/translations";

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

const FUND_NAMES: Record<string, TranslationKey> = {
  cheetah: "fundCheetah",
  octopus: "fundOctopus",
  turtle: "fundTurtle",
  shark: "fundShark",
  gambler: "fundGambler",
  beluga: "fundBeluga",
  leviathan: "fundLeviathan",
};

const FUND_MOTTOS: Record<string, TranslationKey> = {
  cheetah: "mottoCheetah",
  octopus: "mottoOctopus",
  turtle: "mottoTurtle",
  shark: "mottoShark",
  gambler: "mottoGambler",
  beluga: "mottoBeluga",
  leviathan: "mottoLeviathan",
};

export const FUND_COLORS: Record<string, string> = {
  cheetah: "text-yellow-400",
  octopus: "text-blue-400",
  turtle: "text-green-400",
  shark: "text-red-400",
  gambler: "text-pink-400",
  beluga: "text-cyan-400",
  leviathan: "text-purple-400",
};

const FUND_GRADIENTS: Record<string, string> = {
  cheetah: "from-yellow-500/6 to-transparent",
  octopus: "from-blue-500/6 to-transparent",
  turtle:  "from-green-500/6 to-transparent",
  shark:   "from-red-500/6 to-transparent",
  gambler: "from-pink-500/6 to-transparent",
  beluga:  "from-cyan-500/6 to-transparent",
  leviathan: "from-purple-500/6 to-transparent",
};

const FUND_BORDER_COLORS: Record<string, string> = {
  cheetah: "border-l-yellow-500/50",
  octopus: "border-l-blue-500/50",
  turtle:  "border-l-green-500/50",
  shark:   "border-l-red-500/50",
  gambler: "border-l-pink-500/50",
  beluga:  "border-l-cyan-500/50",
  leviathan: "border-l-purple-500/50",
};

const RANK_STYLES = [
  "bg-yellow-500/20 text-yellow-400 border-yellow-500/40",
  "bg-gray-400/20 text-gray-300 border-gray-400/40",
  "bg-amber-600/20 text-amber-500 border-amber-600/40",
  "bg-[var(--r-surface)] text-[var(--r-text-muted)] border-[var(--r-border)]",
  "bg-[var(--r-surface)] text-[var(--r-text-muted)] border-[var(--r-border)]",
];

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

export function FundRanking({ funds, sparklines }: { funds: Fund[]; sparklines?: Record<string, number[]> }) {
  const { t } = useI18n();

  return (
    <div className="space-y-3">
      {funds.map((fund, i) => {
        const pnlClass = fund.returnPct >= 0 ? "pnl-positive" : "pnl-negative";
        const sign = fund.returnPct >= 0 ? "+" : "";
        const Icon = FUND_ICONS[fund.id];
        const color = FUND_COLORS[fund.id] || "text-[var(--r-text-muted)]";
        const nameKey = FUND_NAMES[fund.id];
        const mottoKey = FUND_MOTTOS[fund.id];

        const gradient = FUND_GRADIENTS[fund.id] || "";
        const borderAccent = FUND_BORDER_COLORS[fund.id] || "";

        return (
          <Link
            key={fund.id}
            to={`/fund/${fund.id}`}
            className={`glass-card p-5 flex items-center gap-4 transition-all duration-300 cursor-pointer hover:border-[var(--r-accent)] hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/20 no-underline text-inherit border-l-3 ${borderAccent} bg-gradient-to-r ${gradient} ${
              fund.frozen ? "opacity-60" : ""
            }`}
            style={{ animationDelay: `${i * 80}ms` }}
          >
            <span
              className={`w-8 h-8 flex items-center justify-center rounded-lg text-xs font-bold border shrink-0 ${RANK_STYLES[i] || RANK_STYLES[4]}`}
            >
              {i + 1}
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
                <span className="font-bold text-lg">{nameKey ? t(nameKey) : fund.name}</span>
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
      })}
    </div>
  );
}
