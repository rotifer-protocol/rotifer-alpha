/**
 * Polymarket Scanner — Code Boundary Map
 *
 * EXTERNAL SIDE EFFECTS:
 *   - scan()        → fetches from gamma-api.polymarket.com
 *   - fetchBatch()  → HTTP request with timeout
 *
 * PURE COMPUTATION:
 *   - analyze()     → signal detection from in-memory market data
 *   - parseMarket() → data normalization
 */
import type { MarketSnapshot, ArbSignal, SignalCategory } from "./types";

function parseJson(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return []; }
  }
  return [];
}

const GAMMA_API = "https://gamma-api.polymarket.com/markets";
const SCAN_TIMEOUT_MS = 15_000;

// 2026-05-06 重构：原 SCAN_TAGS = ["", "politics", "sports", ...] 经实测验证
// Polymarket Gamma API 的 `tag` 参数完全无效——所有 tag 都返回同一份"默认市场列表"
// （按 volume 排序的 top 100），导致 6 个 tag 去重后实际只有 ~33 unique markets。
//
// 新方案：用 `offset` 翻页（已验证有效）。5 页 × 100 = 500 unique markets。
// 实测对比：6 tag → 2 multi-outcome events vs offset×5 → 12 multi-outcome events（+6x）
//
// 单页上限保守取 100（Gamma API 接受更大值，但分批降低单次请求超时风险）。
//
// 2026-05-20 Layer 1 信号源多样化：
// 经 API 验证，默认排序（≈按 event 总 volume 综合排名）与 order=volume24hr 的
// overlap 仅 26%——volume24hr 排序独有 74 个新市场，且 crypto/politics 占比更高
//（crypto 19%、politics 27%，远比默认排序中的 sports 集中度低）。
// 新增 VOLUME_SORT_PAGES：每次 scan 额外并行拉 2 页 volume24hr 市场，与默认排序
// 去重合并，扩充可分析市场池约 +140 unique markets。
const PAGE_SIZE = 100;
const PAGE_OFFSETS = [0, 100, 200, 300, 400];
// volume24hr 排序额外页：始终拉取，不受 SCAN_LIMIT 约束（总开销仅 2 次 HTTP）
const VOLUME_SORT_OFFSETS = [0, 100];

function parseMarket(m: any): MarketSnapshot {
  const ev = Array.isArray(m.events) && m.events.length > 0 ? m.events[0] : null;
  return {
    id: m.id,
    question: m.question ?? "",
    slug: m.slug ?? "",
    outcomes: parseJson(m.outcomes),
    outcomePrices: parseJson(m.outcomePrices).map(Number),
    bestBid: m.bestBid ?? 0,
    bestAsk: m.bestAsk ?? 0,
    spread: m.spread ?? 0,
    volume24hr: m.volume24hr ?? 0,
    liquidity: m.liquidityNum ?? m.liquidity ?? 0,
    endDate: m.endDate ?? "",
    eventSlug: ev?.slug ?? "",
    eventTitle: ev?.title ?? "",
    groupItemTitle: m.groupItemTitle ?? "",
    active: m.active ?? true,
    closed: m.closed ?? false,
  };
}

async function fetchBatch(
  limit: number,
  offset: number,
  orderBy?: string,
  ascending?: boolean,
): Promise<any[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
  try {
    let url = `${GAMMA_API}?limit=${limit}&offset=${offset}&active=true&closed=false`;
    if (orderBy) url += `&order=${orderBy}&ascending=${ascending ? "true" : "false"}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return [];
    return await res.json() as any[];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function scan(limit: number): Promise<{ markets: MarketSnapshot[]; totalFetched: number }> {
  // 默认排序（综合 volume/流动性）翻页
  const pagesNeeded = Math.min(PAGE_OFFSETS.length, Math.ceil(limit / PAGE_SIZE));
  const defaultOffsets = PAGE_OFFSETS.slice(0, pagesNeeded);

  // Layer 1（2026-05-20）：并行拉取 volume24hr 排序页
  // API 验证：volume24hr 排序与默认排序 overlap 仅 26%，独有 crypto/politics 市场 74 个/页
  const defaultBatches = defaultOffsets.map(off => fetchBatch(PAGE_SIZE, off));
  const volumeBatches  = VOLUME_SORT_OFFSETS.map(off => fetchBatch(PAGE_SIZE, off, "volume24hr", false));

  const allBatches = await Promise.all([...defaultBatches, ...volumeBatches]);

  const seen = new Set<string>();
  const markets: MarketSnapshot[] = [];
  let totalFetched = 0;

  for (const batch of allBatches) {
    totalFetched += batch.length;
    for (const m of batch) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      markets.push(parseMarket(m));
    }
  }

  return { markets, totalFetched };
}

// ─── Signal Diversity Layer 2 (2026-05-20) ────────────────────────────────
//
// Root cause of NBA-signal concentration: Gamma API default sort is by volume.
// During sports seasons (NBA playoffs, World Cup, etc.) the top-500 markets
// by volume are dominated by a single event family, generating correlated
// signals that exhaust every fund's event-family cooldown quota in one tick.
//
// Fix: tag each signal with an inferred category, then cap any single category
// at `maxCategoryFraction` of total signal count (default 0.40).  Signals are
// already sorted by edge descending, so only the lowest-edge excess signals in
// the dominant category are dropped — high-quality alpha is never suppressed.
//
// The `maxCategoryFraction` parameter is evolvable (PARAM_BOUNDS_INVARIANT)
// so conservative funds can tighten to 0.20–0.30 and aggressive funds can
// loosen to 0.50–0.60 based on their measured fitness F(g).

const SPORTS_RE =
  /\b(nba|nfl|nhl|mlb|ncaa|ufc|mma|soccer|football|basketball|baseball|hockey|tennis|golf|f1|formula[- ]1|premier league|champions league|world cup|super bowl|championship|playoffs?|semifinals?|finals?|match|tournament|league|team|game|season|vs\.?|versus)\b/i;
const POLITICS_RE =
  /\b(election|president|senate|congress|vote|voter|poll|ballot|democrat|republican|gop|candidate|primary|caucus|inaugur|parliament|minister|chancellor|referendum|trump|harris|biden|obama|modi|macron|zelensky|netanyahu|xi jinping|putin)\b/i;
const CRYPTO_RE =
  /\b(bitcoin|btc|ethereum|eth|solana|sol|crypto|defi|blockchain|altcoin|stablecoin|usdc|usdt|tether|nft|dao|web3|l2|layer.?2|rollup|ordinals|runes|halving|memecoin|doge|shib)\b/i;
const AI_RE =
  /\b(openai|gpt|chatgpt|anthropic|claude|gemini|google deepmind|llm|ai model|artificial intelligence|machine learning|large language|mistral|llama|deepseek|copilot|midjourney|stable diffusion|sora)\b/i;

export function inferCategory(slug: string, question: string): SignalCategory {
  const text = `${slug} ${question}`.toLowerCase();
  if (SPORTS_RE.test(text)) return "sports";
  if (POLITICS_RE.test(text)) return "politics";
  if (CRYPTO_RE.test(text)) return "crypto";
  if (AI_RE.test(text)) return "ai";
  return "other";
}

/**
 * Cap the fraction of total signals any single category may occupy.
 *
 * Traverses signals in existing order (caller ensures edge-descending sort).
 * Only the lowest-edge excess signals of the dominant category are dropped;
 * signals from under-represented categories are always kept.
 *
 * v1.0.5 §4.2 (ALPHA-PRD-003 C-HARDEN1.6): budget parameter accepts either a
 * single fraction (legacy single-cap behavior — same cap for every category)
 * OR a per-category lookup `Partial<Record<SignalCategory, number>>` so each
 * archetype can tune category-by-category exposure (e.g. honey_badger 50%
 * sports / 20% crypto vs turtle 40% sports / 10% crypto).
 *
 * When a category is missing from a per-cat object, the function falls back
 * to the optional `legacyFraction` argument (typically `fund.maxCategoryFraction`
 * for pre-schema-036 funds), or 0.40 if neither is provided.
 *
 * @param signals       Already sorted (edge descending) signal list.
 * @param budget        Single fraction OR per-category lookup. Default 0.40.
 * @param legacyFraction  Fallback fraction for per-cat lookup misses.
 *                        Default = `budget` when budget is a number, else 0.40.
 */
export type CategoryBudget = number | Partial<Record<SignalCategory, number>>;

const ALL_SIGNAL_CATEGORIES: ReadonlyArray<SignalCategory> = [
  "sports", "politics", "crypto", "ai", "other",
];

export function applyCategoryBudget(
  signals: ArbSignal[],
  budget: CategoryBudget = 0.40,
  legacyFraction?: number,
): ArbSignal[] {
  if (signals.length === 0) return signals;

  const isPerCat = typeof budget === "object";
  const fallback = legacyFraction ?? (typeof budget === "number" ? budget : 0.40);

  // Compute max count per category. Categories with fraction ≥ 1 are uncapped.
  const maxPerCat = new Map<SignalCategory, number>();
  let anyUncapped = false;
  for (const cat of ALL_SIGNAL_CATEGORIES) {
    let frac: number;
    if (isPerCat) {
      const perCat = budget as Partial<Record<SignalCategory, number>>;
      frac = perCat[cat] ?? fallback;
    } else {
      frac = budget as number;
    }
    if (frac >= 1) {
      anyUncapped = true;
      continue;  // no cap → don't add to maxPerCat map
    }
    maxPerCat.set(cat, Math.max(1, Math.ceil(signals.length * frac)));
  }

  // Single-cap legacy fast path: if every category has the same cap (legacy
  // number budget or per-cat with all same values), preserve original
  // semantics exactly (single-pass filter).
  if (!isPerCat && (budget as number) >= 1) return signals;

  const catCount = new Map<SignalCategory, number>();
  const result: ArbSignal[] = [];
  for (const sig of signals) {
    const cat = sig.category ?? "other";
    const limit = maxPerCat.get(cat);
    if (limit === undefined && !anyUncapped) {
      // Category has no entry in maxPerCat AND nothing was marked uncapped
      // — fall back to fallback fraction for this signal's category.
      const fallbackLimit = Math.max(1, Math.ceil(signals.length * fallback));
      const n = catCount.get(cat) ?? 0;
      if (n >= fallbackLimit) continue;
      catCount.set(cat, n + 1);
      result.push(sig);
      continue;
    }
    if (limit === undefined) {
      // anyUncapped path: this category was marked as uncapped (frac ≥ 1).
      result.push(sig);
      continue;
    }
    const n = catCount.get(cat) ?? 0;
    if (n >= limit) continue;             // over budget → skip (low edge)
    catCount.set(cat, n + 1);
    result.push(sig);
  }
  return result;
}

let sigCtr = 0;
function sid(): string {
  return `SIG-${Date.now().toString(36)}-${(++sigCtr).toString(36).padStart(4, "0")}`;
}

export function analyze(
  markets: MarketSnapshot[],
  ts: string,
  maxCategoryFraction = 0.40,
): ArbSignal[] {
  sigCtr = 0;
  const sigs: ArbSignal[] = [];
  const TH = 0.015, MS = 0.02, MC = 0.2;
  const MULTI_OUTCOME_MIN_GROUP_SIZE = 3;
  const COMPLETE_OUTCOME_SUM_MIN = 0.85;
  const COMPLETE_OUTCOME_SUM_MAX = 1.15;

  for (const m of markets) {
    if (m.outcomes.length !== 2 || m.outcomePrices.length !== 2) continue;
    const sum = m.outcomePrices[0] + m.outcomePrices[1];
    const dev = Math.abs(sum - 1.0);
    if (dev < TH) continue;
    const over = sum > 1.0;
    const conf = Math.min(1, (dev / TH) * 0.5);
    if (conf < MC) continue;
    const mSlug = m.eventSlug || m.slug;
    sigs.push({
      signalId: sid(), type: "MISPRICING", marketId: m.id, slug: mSlug, question: m.question,
      description: over
        ? `价格总和 = ${sum.toFixed(4)}（>${(1 + TH).toFixed(3)}），双方结果均被高估，可考虑做空双方。`
        : `价格总和 = ${sum.toFixed(4)}（<${(1 - TH).toFixed(3)}），双方结果均被低估，可考虑买入双方。`,
      edge: Math.round(dev * 10000) / 100,
      confidence: Math.round(conf * 100) / 100,
      direction: over ? "SELL_BOTH" : "BUY_BOTH",
      prices: {
        [m.outcomes[0]]: m.outcomePrices[0],
        [m.outcomes[1]]: m.outcomePrices[1],
        sum,
        volume24hr: m.volume24hr,
        liquidity: m.liquidity,
      },
      groupItemTitle: m.groupItemTitle || undefined,
      category: inferCategory(mSlug, m.question),
      timestamp: ts,
    });
  }

  const groups = new Map<string, MarketSnapshot[]>();
  for (const m of markets) {
    if (!m.eventSlug) continue;
    const g = groups.get(m.eventSlug) || [];
    g.push(m);
    groups.set(m.eventSlug, g);
  }

  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const ySum = g.reduce((s, m) => s + (m.outcomePrices[0] ?? 0), 0);
    // Multi-outcome arb is only valid when the scanner has a near-complete view
    // of the mutually-exclusive event. Gamma offset pagination + liquidity filters
    // may expose only a subset of candidates (James Bond 2026-05-18: two visible
    // candidates summed to 0.0715, producing a fake 92.85% edge). Treat extreme
    // yes-sum gaps as incomplete coverage, not alpha.
    if (
      g.length < MULTI_OUTCOME_MIN_GROUP_SIZE
      || ySum < COMPLETE_OUTCOME_SUM_MIN
      || ySum > COMPLETE_OUTCOME_SUM_MAX
    ) continue;
    const dev = Math.abs(ySum - 1.0);
    if (dev < TH) continue;
    const over = ySum > 1.0;
    const conf = Math.min(1, (dev / TH) * 0.4);
    if (conf < MC) continue;
    const prices: Record<string, number> = {};
    for (const m of g) prices[m.question.slice(0, 60)] = m.outcomePrices[0] ?? 0;
    prices["yes_price_sum"] = ySum;
    prices["volume24hr"] = g.reduce((s, m) => s + m.volume24hr, 0);

    const selected = over
      ? g.reduce((min, m) => ((m.outcomePrices[0] ?? 1) < (min.outcomePrices[0] ?? 1) ? m : min))
      : g.reduce((max, m) => ((m.outcomePrices[0] ?? 0) > (max.outcomePrices[0] ?? 0) ? m : max));
    // Use liquidity of the specifically selected market (resolvedMarketId),
    // since that is the single market we will actually trade.
    prices["liquidity"] = selected.liquidity;

    const evSlug = g[0].eventSlug;
    const evTitle = g[0].eventTitle || evSlug;
    sigs.push({
      signalId: sid(), type: "MULTI_OUTCOME_ARB",
      marketId: evSlug, slug: evSlug, question: evTitle,
      resolvedMarketId: selected.id,
      description: over
        ? `事件「${evTitle}」：${g.length} 个结果 Yes 价格总和 = ${ySum.toFixed(4)}，整体高估。`
        : `事件「${evTitle}」：${g.length} 个结果 Yes 价格总和 = ${ySum.toFixed(4)}，整体低估。`,
      edge: Math.round(dev * 10000) / 100,
      confidence: Math.round(conf * 100) / 100,
      direction: over ? "SELL_WEAKEST" : "BUY_STRONGEST",
      prices,
      groupItemTitle: selected.groupItemTitle || undefined,
      category: inferCategory(evSlug, evTitle),
      timestamp: ts,
    });
  }

  for (const m of markets) {
    const sp = m.spread ?? (m.bestAsk - m.bestBid);
    if (sp < MS || m.bestBid <= 0 || m.bestAsk <= 0) continue;
    const mid = (m.bestBid + m.bestAsk) / 2;
    const vf = Math.min(1, m.volume24hr / 50000);
    const conf = Math.min(1, (sp / MS) * 0.3 * vf);
    if (conf < MC) continue;
    const spSlug = m.eventSlug || m.slug;
    sigs.push({
      signalId: sid(), type: "SPREAD", marketId: m.id, slug: spSlug, question: m.question,
      description: `买卖价差 = ${(sp * 100).toFixed(1)}%（买: ${m.bestBid}，卖: ${m.bestAsk}）`,
      edge: Math.round(sp * 10000) / 100,
      confidence: Math.round(conf * 100) / 100,
      direction: "PROVIDE_LIQUIDITY",
      prices: { bestBid: m.bestBid, bestAsk: m.bestAsk, spread: sp, midpoint: mid, volume24hr: m.volume24hr, liquidity: m.liquidity },
      groupItemTitle: m.groupItemTitle || undefined,
      category: inferCategory(spSlug, m.question),
      timestamp: ts,
    });
  }

  sigs.sort((a, b) => b.edge - a.edge);
  // Layer 2 diversity cap: no single category may exceed maxCategoryFraction of
  // total signals. Signals already edge-sorted so only lowest-edge excess is dropped.
  return applyCategoryBudget(sigs, maxCategoryFraction);
}
