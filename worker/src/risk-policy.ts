/**
 * Position-level risk policy: hard guardrails NOT subject to fund evolution.
 *
 * Design philosophy (Founder approval 2026-05-10, Path A):
 *   Risk guardrails optimize for "no catastrophe", evolution optimizes for
 *   "max return". Those goals conflict. Putting guardrails into PARAM_BOUNDS
 *   would let funds gradually loosen their own catastrophe protection in
 *   pursuit of higher short-term fitness — equivalent to letting a high-risk
 *   fund set its own betting limits. So these stay as constants.
 *
 * NOT in EVOLVABLE_PARAMS — see param-bounds.ts.
 *
 * Layered guardrails (in evaluation order):
 *   1. PRICE_BOUNDARY (trade.ts)         — reject prices outside [0.001, 0.99]
 *   2. LOW_PRICE_REJECT (Track 2, this)  — reject SELL_YES at deep OTM
 *   3. OTM_CAP (P2 Path A, this)         — cap BUY long-shots to 5% equity
 *   4. SANITY_LOSS_GUARD (Track 3, this) — skip on implausible mark price
 */

// ─── OTM single-position cap (P2 Path A, founder approved 2026-05-10) ───
//
// Background: honeyBadger_l (formerly gambler_l) accumulated $349K unrealized PnL with 89%
// concentrated in just two SELL_WEAKEST OTM positions. Single-position
// concentration with deep tail risk: 99% of the time these positions earn
// small amounts, but a single OTM hit (e.g. an underdog winning the NBA
// championship) wipes out months of gains in one settlement.

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

// ─── Track 2: SELL_YES low-entry hard reject (2026-05-10) ──────────
//
// Background: 33 SELL_YES trades at entry 0.0015-0.025 closed with bogus
// exit_price=0.5 (Gamma API placeholder for thin-orderbook multi-outcome
// candidates) producing -$86.28M phantom losses. Mathematical chain:
//
//   shares = amount / entry_price                      // 1666× leverage at entry=0.0015
//   loss   = (mark - entry) × shares                   // mark drift × leverage
//
// Even with size capped to 5% equity ($500 on $10K fund), entry=0.0015
// produces 333,333 shares — a real probability shift to 0.05 would lose
// $16K (3200% of position). The leverage amplifier IS the danger, not size.
//
// D-Lite (CLOB mid-price) eliminates the API entry side; this rule
// eliminates the leverage amplifier. Together they prevent recurrence.

/** Detect SELL_YES at deep-OTM entry. SELL_YES means "shorting an unlikely
 *  YES outcome" — at entry < 0.05, leverage exceeds 20×, making the position
 *  catastrophically sensitive to even small probability shifts (let alone
 *  bad mark prices). BUY at deep OTM is a long-shot bet (asymmetric upside)
 *  and stays subject to OTM_CAP rather than hard reject. */
export function isUnsafeSellEntry(price: number, direction: string): boolean {
  return direction === "SELL_YES" && isOTMPosition(price, direction);
}

// ─── Track 3: sanity guard against implausible mark prices (2026-05-10) ───
//
// D-Lite + Track 2 should prevent recurrence of the 0.5 placeholder bug,
// but defense-in-depth: refuse to act on a mark that implies more than
// SANITY_LOSS_MULTIPLIER × position-size loss. This catches future API
// quirks without false-tripping on legitimate tail losses.
//
// Calibration: at 10× (-1000% loss):
//   - BUY_YES max real loss = -1× amount → never trips
//   - SELL_YES at entry=0.05 max real loss = -19× amount at price=1.0 → never trips
//                  (post-Track 2, this is the worst legitimate case)
//   - Historical 33233% bogus losses → trips immediately
//   - Future Gamma 24h MA drift (~5×) → does not trip

/** Loss multiplier above which a mark price is considered implausible. */
export const SANITY_LOSS_MULTIPLIER = 10;

/** True when computed unrealized PnL exceeds -SANITY_LOSS_MULTIPLIER × amount.
 *  Caller should treat this as a stale/bad mark and skip the decision —
 *  do NOT close the position based on this mark. */
export function isUnreasonableLoss(unrealizedPnl: number, amount: number): boolean {
  if (amount <= 0) return false;
  return unrealizedPnl < -SANITY_LOSS_MULTIPLIER * amount;
}
