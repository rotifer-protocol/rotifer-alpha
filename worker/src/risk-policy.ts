/**
 * Position-level risk policy: hard guardrails NOT subject to fund evolution.
 *
 * Design philosophy (Founder approval 2026-05-10, Path A):
 *   Risk guardrails optimize for "no catastrophe", evolution optimizes for
 *   "max return". Those goals conflict. Putting guardrails into PARAM_BOUNDS
 *   would let funds gradually loosen their own catastrophe protection in
 *   pursuit of higher short-term fitness — equivalent to letting a gambler
 *   set their own betting limits. So these stay as constants.
 *
 * Background:
 *   gambler_l accumulated $349K unrealized PnL with 89% concentrated in just
 *   two SELL_WEAKEST OTM positions. Single-position concentration with deep
 *   tail risk: 99% of the time these positions earn small amounts, but a
 *   single OTM hit (e.g. an underdog winning the NBA championship) wipes
 *   out months of gains in one settlement.
 *
 * NOT in EVOLVABLE_PARAMS — see param-bounds.ts.
 */

/** Price below which a position is considered "deep OTM" (out-of-the-money).
 *  Empirical reference: Polymarket NBA Champion futures show low-tier teams
 *  trading at 0.005-0.02. 0.05 (=5% implied probability) is a generous upper
 *  bound that captures most asymmetric tail-risk bets. */
export const OTM_PRICE_THRESHOLD = 0.05;

/** Max OTM single-position size as fraction of fund total value (equity).
 *  At 5% per OTM × maxOpenPositions=20 = 100% theoretical exposure ceiling,
 *  forcing diversification across ≥20 OTM bets if a fund wants full OTM
 *  exposure. */
export const MAX_OTM_POSITION_RATIO = 0.05;

/** Detect whether a (price, direction) tuple constitutes a deep-OTM bet.
 *
 *  BUY at low price = long-shot bet (asymmetric upside, 95%+ chance to zero).
 *  SELL at low price = sell-the-tail (asymmetric downside, single hit ruins).
 *  Both share the same tail-risk profile → both gated by single price check.
 *
 *  Direction parameter is reserved for future asymmetric thresholds
 *  (e.g. tighter cap on SELL than BUY).
 */
export function isOTMPosition(price: number, _direction: string): boolean {
  return price > 0 && price < OTM_PRICE_THRESHOLD;
}

/** Compute the maximum dollar amount a single OTM position may consume.
 *  Uses fund equity (initialBalance + realized + unrealized) so the cap
 *  scales with actual capital available, not the cosmetic initial balance. */
export function calcOTMCap(totalValue: number): number {
  return totalValue * MAX_OTM_POSITION_RATIO;
}
