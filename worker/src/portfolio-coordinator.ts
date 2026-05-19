/**
 * Portfolio Coordinator — cross-fund event family concentration guard.
 *
 * Context (ALPHA-001 §8):
 *   Per-fund `maxSameEventPositions` and `maxPerEvent` prevent a single fund
 *   from over-concentrating in one event. But 15 funds each opening $100 in
 *   the same event → $1 500 total portfolio exposure — no per-fund gate catches
 *   that. This module is the only guard at the portfolio level.
 *
 * Root cause it prevents: James Bond fan-out across multiple funds simultaneously
 *   opening positions in correlated "Next James Bond actor" markets.
 *
 * Design principles:
 *   - `getPortfolioEventExposureMap`: one DB read per cron invocation (not per fund)
 *   - `checkPortfolioConcentration`: pure function, zero DB access, safe for hot loop
 *   - PORTFOLIO_MAX_EVENT_USDC is NOT an evolvable gene parameter — it is a hard
 *     safety floor that must not be self-tuned by funds chasing fitness scores.
 */
import { eventFamilyKey } from "./event-family";

/**
 * Maximum total portfolio exposure (USDC) to any single event family,
 * summed across ALL funds.
 *
 * Initial value: $200 (Phase 2 Live Small conservative ceiling).
 * Adjust in future phases via config / env var, not by evolving.
 */
export const PORTFOLIO_MAX_EVENT_USDC = 200;

interface OpenPositionRow {
  slug: string | null;
  question: string | null;
  amount: number;
}

/**
 * Loads total open exposure per event family across ALL funds from D1.
 *
 * Call ONCE per cron invocation, outside the fund loop. The caller is
 * responsible for updating the returned map in-memory as new positions are
 * opened within the same invocation (see trade.ts usage).
 *
 * @returns Map<eventFamilyKey, totalOpenUsdc>
 */
export async function getPortfolioEventExposureMap(
  db: D1Database,
): Promise<Map<string, number>> {
  const r = await db
    .prepare("SELECT slug, question, amount FROM paper_trades WHERE status = 'OPEN'")
    .all<OpenPositionRow>();

  const exposure = new Map<string, number>();
  for (const row of r.results ?? []) {
    const key = eventFamilyKey(row.slug, row.question);
    exposure.set(key, (exposure.get(key) ?? 0) + Number(row.amount ?? 0));
  }
  return exposure;
}

export interface PortfolioConcentrationResult {
  allowed: boolean;
  portfolioExposure: number;
  wouldBeExposure: number;
  limit: number;
}

/**
 * Pure gate: would adding `additionalAmount` to `familyKey` exceed the limit?
 *
 * Kept pure (no DB access) so it can be called in a tight signal loop without
 * extra round-trips. The caller maintains and updates the exposure map.
 *
 * @param portfolioExposure Current cross-fund exposure for this event family (USDC)
 * @param additionalAmount  Proposed new position size (USDC)
 * @param limit             Max allowed total exposure (defaults to PORTFOLIO_MAX_EVENT_USDC)
 */
export function checkPortfolioConcentration(
  portfolioExposure: number,
  additionalAmount: number,
  limit: number = PORTFOLIO_MAX_EVENT_USDC,
): PortfolioConcentrationResult {
  // NaN or negative amounts pass through — upstream `amount < 50` should catch
  // invalid sizes. The portfolio gate only rejects valid positive amounts that
  // would exceed the limit; NaN <= Infinity = false (IEEE 754) would incorrectly
  // block valid trades if we didn't guard here.
  if (!Number.isFinite(additionalAmount) || additionalAmount < 0) {
    return { allowed: true, portfolioExposure, wouldBeExposure: portfolioExposure, limit };
  }
  const wouldBeExposure = portfolioExposure + additionalAmount;
  return {
    allowed: wouldBeExposure <= limit,
    portfolioExposure,
    wouldBeExposure,
    limit,
  };
}
