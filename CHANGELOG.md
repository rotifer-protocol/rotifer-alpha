# Changelog

Daily progress log for the Rotifer Alpha lab. Empty days are skipped — this is a momentum signal, not an exhaustive engineering report.

For the source-of-truth git history, see [GitHub commits](https://github.com/rotifer-protocol/rotifer-alpha/commits/main).

---

### 2026-05-21
- Risk: drawdown is now anchored to peak equity, not initial capital
- Fund renamed: gambler → **honeyBadger 🦡** (with snake_case identifier rollout)
- Governance: CONTRIBUTING + DCO sign-off workflow added

### 2026-05-20
- Rebrand: **Petri → Rotifer Alpha** (site-wide rename)
- License: MIT → AGPL-3.0-or-later + commercial dual-license
- Scanner: volume-sorted pagination broadens signal source coverage

### 2026-05-19 — Live Day
- **Live mode launched**: EIP-712 V2 signing + Polymarket CLOB FOK execution
- Portfolio-level guard: Portfolio Coordinator + event-family conflict defense
- Economic modeling: fee model + order lifecycle genes shipped

### 2026-05-18
- New Market Impact Gate: order sizing adapts to per-market liquidity
- Same-event position cap: max 2 positions per fund per event
- Cross-tick cooldown cache (KV-backed)

### 2026-05-17
- Epoch progress is now a three-phase state machine: trades → time-gate → ready
- Re-entry dedup overhaul: covers all 6 closure states + 4-hour cooldown

### 2026-05-16
- New **Arena page**: live F(g) standings + race chart + embedded docs

### 2026-05-14
- Three new pages shipped: Analysis / Docs / Share Modal

### 2026-05-13
- Radar tooltip now shows raw parameter values (not normalized %)
- Label disambiguation: gene competition round vs. fund PBT epoch

### 2026-05-12
- ShadowPanel redesigned: fund-readiness matrix + PnL chart + mobile cards
- Performance pass: SWR cache + code splitting + skeleton screens
- InfoPopovers across core metrics: F(g) / Epoch / Best F(g) / Lineage / Mutations

### 2026-05-11 — Heavy Iteration Day
- FundDetail overhaul: trade calendar heatmap, dual-axis equity curve (USD + return %), stats panel
- Evolution log rebuilt: category filtering, sorting, parameter diff bars
- Fund tier suffixes now public (S / M / L) + MarketDriversCard attributes intraday PnL to specific markets

### 2026-05-10
- PnL split into realized / unrealized + today's change + concentration warning
- OTM single-position cap: a hard guardrail outside the evolution loop

### 2026-05-06
- Scanner pagination: dropped inefficient tag-based mode for offset paging
- ParamHeatmap shows all funds (even those without evolution history)

### 2026-05-05 — Evolution Upgrade
- **3×5 fund matrix shipped**: 15 funds = 3 capital tiers × 5 strategy families
- **AI-driven gene mutation**: 5 evolvable genes generate variants via Cloudflare Workers AI
- Genome pipeline hardened: early heartbeat + error recovery

### 2026-05-04
- Parameter bounds become tier-aware: S / M / L differentiation

### 2026-04-19
- Public-surface cleanup: scrubbed residual internal roadmap leakage
- Homepage meta description aligned with honest-disclosure copy

### 2026-04-09
- Slogan re-aligned to project positioning — open-source framework, not a universal solution

### 2026-04-07
- Three-layer stop-loss defense shipped (Strategy / Position / Portfolio)
- Naming: Strategy DNA → **Strategy Gene** (consistent with Rotifer Protocol)

### 2026-04-06
- Full-site i18n closure: all hardcoded strings now route through the translation layer
- Fund descriptions and gene names move into the bilingual data layer

### 2026-04-05 — Platform Launch
- **First public deployment**: fund Agent experiment platform + Hero dashboard with 6-metric layout
- Shadow Trading skeleton connected
- Strategy Gene abstraction + implementation-level evolution
