/**
 * fundMeta.ts — Shared fund metadata for all 15 funds (3×5 matrix, ADR-274 D7).
 *
 * Single source of truth for fund colors, names, icons, and tier helpers.
 * All components import from here instead of defining locally.
 */

import type { TranslationKey } from "../i18n/translations";

// ─── Tier helpers ──────────────────────────────────────────────────────────

export type FundTier = "small" | "medium" | "large";

/** Extract base personality from fund ID (e.g. "turtle_m" → "turtle"). */
export function fundPersonality(id: string): string {
  return id.replace(/_[ml]$/, "");
}

/** Derive tier from fund ID suffix. */
export function fundTierOf(id: string): FundTier {
  if (id.endsWith("_l")) return "large";
  if (id.endsWith("_m")) return "medium";
  return "small";
}

/** Short tier badge label. */
export function fundTierLabel(id: string): "S" | "M" | "L" {
  if (id.endsWith("_l")) return "L";
  if (id.endsWith("_m")) return "M";
  return "S";
}

/** Fund display name: base personality name + tier suffix for M/L. */
export function fundDisplayName(
  id: string,
  t: (k: TranslationKey) => string,
): string {
  const p = fundPersonality(id);
  const key = FUND_NAME_KEYS[p] as TranslationKey | undefined;
  const baseName = key ? t(key) : id;
  const tl = fundTierLabel(id);
  return tl === "S" ? baseName : `${baseName}·${tl}`;
}

// ─── All 15 fund IDs ────────────────────────────────────────────────────────

export const PERSONALITY_IDS = ["turtle", "cheetah", "octopus", "shark", "gambler"] as const;
export type PersonalityId = typeof PERSONALITY_IDS[number];

export const ALL_FUND_IDS: string[] = [
  ...PERSONALITY_IDS,                                   // small tier
  ...PERSONALITY_IDS.map(p => `${p}_m`),               // medium tier
  ...PERSONALITY_IDS.map(p => `${p}_l`),               // large tier
];

// ─── Translation key lookups (keyed by personality, shared across tiers) ───

const PERSONALITY_NAME_KEYS: Record<string, TranslationKey> = {
  cheetah: "fundCheetah",
  octopus: "fundOctopus",
  turtle:  "fundTurtle",
  shark:   "fundShark",
  gambler: "fundGambler",
};

const PERSONALITY_MOTTO_KEYS: Record<string, TranslationKey> = {
  cheetah: "mottoCheetah",
  octopus: "mottoOctopus",
  turtle:  "mottoTurtle",
  shark:   "mottoShark",
  gambler: "mottoGambler",
};

/** Name translation key for any fund ID (including _m / _l variants). */
export const FUND_NAME_KEYS: Record<string, TranslationKey | undefined> =
  Object.fromEntries(
    ALL_FUND_IDS.map(id => [id, PERSONALITY_NAME_KEYS[fundPersonality(id)]]),
  );

/** Motto translation key for any fund ID (including _m / _l variants). */
export const FUND_MOTTO_KEYS: Record<string, TranslationKey | undefined> =
  Object.fromEntries(
    ALL_FUND_IDS.map(id => [id, PERSONALITY_MOTTO_KEYS[fundPersonality(id)]]),
  );

// ─── Color system (by personality, shared across tiers) ────────────────────

const PERSONALITY_COLORS: Record<string, string> = {
  cheetah: "text-yellow-400",
  octopus: "text-blue-400",
  turtle:  "text-green-400",
  shark:   "text-red-400",
  gambler: "text-pink-400",
};

const PERSONALITY_GRADIENTS: Record<string, string> = {
  cheetah: "from-yellow-500/6 to-transparent",
  octopus: "from-blue-500/6 to-transparent",
  turtle:  "from-green-500/6 to-transparent",
  shark:   "from-red-500/6 to-transparent",
  gambler: "from-pink-500/6 to-transparent",
};

const PERSONALITY_BORDER_COLORS: Record<string, string> = {
  cheetah: "border-l-yellow-500/50",
  octopus: "border-l-blue-500/50",
  turtle:  "border-l-green-500/50",
  shark:   "border-l-red-500/50",
  gambler: "border-l-pink-500/50",
};

const PERSONALITY_HEX_COLORS: Record<string, string> = {
  turtle:  "#22c55e",
  cheetah: "#eab308",
  octopus: "#60a5fa",
  shark:   "#ef4444",
  gambler: "#f472b6",
};

// Tier brightness modifier: M = slightly dimmer, L = slightly more muted
// (visual hint within the same hue family, while keeping personality recognizable)
const TIER_OPACITY: Record<FundTier, string> = {
  small:  "",          // full opacity — e.g. text-yellow-400
  medium: "/80",       // 80% opacity suffix — unused in Tailwind but kept for reference
  large:  "/60",
};

function buildColorMap(base: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    ALL_FUND_IDS.map(id => [id, base[fundPersonality(id)] ?? "text-gray-400"]),
  );
}

/** Tailwind text-color class for any fund ID. Same hue per personality across tiers. */
export const FUND_COLORS: Record<string, string> = buildColorMap(PERSONALITY_COLORS);

/** Tailwind gradient class for card backgrounds. */
export const FUND_GRADIENTS: Record<string, string> = buildColorMap(PERSONALITY_GRADIENTS);

/** Tailwind left-border color for ranking cards. */
export const FUND_BORDER_COLORS: Record<string, string> = buildColorMap(PERSONALITY_BORDER_COLORS);

/** Hex color for charts (recharts, etc.). */
export const FUND_HEX_COLORS: Record<string, string> = Object.fromEntries(
  ALL_FUND_IDS.map(id => [id, PERSONALITY_HEX_COLORS[fundPersonality(id)] ?? "#6b7280"]),
);

// Export TIER_OPACITY for components that want tier-based visual variation
export { TIER_OPACITY };

// ─── Currency formatting helpers ──────────────────────────────────────────
//
// Always use 'en-US' locale to guarantee comma thousand-separators on all
// devices (zh-CN Intl may use thin-space U+202F or Chinese grouping digits
// which causes line-breaks and layout overflow on mobile).

/** Full USD format: $1,223,743.02 */
export function fmtUSD(v: number, decimals = 2): string {
  return `$${v.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

/** Compact USD for mobile: $1.22M / $124K / $99.50 */
export function fmtCompact(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 100_000)   return `$${Math.round(v / 1_000)}K`;
  if (v >= 10_000)    return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ─── Tier grouping helper ──────────────────────────────────────────────────

export type TierGroup = { tier: FundTier; label: "S" | "M" | "L"; funds: string[] };

/** Group a list of fund IDs by tier for tiered display (S → M → L). */
export function groupByTier(fundIds: string[]): TierGroup[] {
  const groups: Record<FundTier, string[]> = { small: [], medium: [], large: [] };
  for (const id of fundIds) {
    groups[fundTierOf(id)].push(id);
  }
  return (["small", "medium", "large"] as const)
    .filter(t => groups[t].length > 0)
    .map(t => ({ tier: t, label: { small: "S", medium: "M", large: "L" }[t] as "S" | "M" | "L", funds: groups[t] }));
}
