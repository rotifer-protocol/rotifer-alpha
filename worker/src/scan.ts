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
import type { MarketSnapshot, ArbSignal } from "./types";

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
const PAGE_SIZE = 100;
const PAGE_OFFSETS = [0, 100, 200, 300, 400];

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

async function fetchBatch(limit: number, offset: number): Promise<any[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
  try {
    const url = `${GAMMA_API}?limit=${limit}&offset=${offset}&active=true&closed=false`;
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
  // 计算需要多少页：limit / PAGE_SIZE，上限不超过 PAGE_OFFSETS.length
  const pagesNeeded = Math.min(PAGE_OFFSETS.length, Math.ceil(limit / PAGE_SIZE));
  const offsets = PAGE_OFFSETS.slice(0, pagesNeeded);
  const batches = await Promise.all(offsets.map(off => fetchBatch(PAGE_SIZE, off)));

  const seen = new Set<string>();
  const markets: MarketSnapshot[] = [];
  let totalFetched = 0;

  for (const batch of batches) {
    totalFetched += batch.length;
    for (const m of batch) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      markets.push(parseMarket(m));
    }
  }

  return { markets, totalFetched };
}

let sigCtr = 0;
function sid(): string {
  return `SIG-${Date.now().toString(36)}-${(++sigCtr).toString(36).padStart(4, "0")}`;
}

export function analyze(markets: MarketSnapshot[], ts: string): ArbSignal[] {
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
    sigs.push({
      signalId: sid(), type: "MISPRICING", marketId: m.id, slug: m.eventSlug || m.slug, question: m.question,
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

    sigs.push({
      signalId: sid(), type: "MULTI_OUTCOME_ARB",
      marketId: g[0].eventSlug, slug: g[0].eventSlug, question: g[0].eventTitle || g[0].eventSlug,
      resolvedMarketId: selected.id,
      description: over
        ? `事件「${g[0].eventTitle}」：${g.length} 个结果 Yes 价格总和 = ${ySum.toFixed(4)}，整体高估。`
        : `事件「${g[0].eventTitle}」：${g.length} 个结果 Yes 价格总和 = ${ySum.toFixed(4)}，整体低估。`,
      edge: Math.round(dev * 10000) / 100,
      confidence: Math.round(conf * 100) / 100,
      direction: over ? "SELL_WEAKEST" : "BUY_STRONGEST",
      prices,
      groupItemTitle: selected.groupItemTitle || undefined,
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
    sigs.push({
      signalId: sid(), type: "SPREAD", marketId: m.id, slug: m.eventSlug || m.slug, question: m.question,
      description: `买卖价差 = ${(sp * 100).toFixed(1)}%（买: ${m.bestBid}，卖: ${m.bestAsk}）`,
      edge: Math.round(sp * 10000) / 100,
      confidence: Math.round(conf * 100) / 100,
      direction: "PROVIDE_LIQUIDITY",
      prices: { bestBid: m.bestBid, bestAsk: m.bestAsk, spread: sp, midpoint: mid, volume24hr: m.volume24hr, liquidity: m.liquidity },
      groupItemTitle: m.groupItemTitle || undefined,
      timestamp: ts,
    });
  }

  sigs.sort((a, b) => b.edge - a.edge);
  return sigs;
}
