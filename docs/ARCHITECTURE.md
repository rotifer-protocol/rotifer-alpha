# Petri Architecture

> A research experiment in population-based AI trading on Polymarket prediction markets.  
> Part of the [Rotifer Protocol](https://rotifer.dev) — open-source AI agent evolution framework.

---

## System Overview

Petri runs 15 AI trading funds simultaneously. Each fund has a unique strategy "DNA" — a phenotype parameter set governing risk tolerance, position sizing, and market selection. Funds evolve over time via Population-Based Training (PBT), selecting better-performing strategies.

```
┌──────────────────────────────────────────────────────────────┐
│  Cloudflare Worker (cron: every 5 minutes)                   │
│                                                              │
│  L1 Scanner Gene ──→  L2 Trader Gene ──→  L3 Execution      │
│  (Polymarket API)      (15 funds, PBT)     (shadow / live)   │
│         │                    │                               │
│  L2 Monitor Gene      L2 Settler Gene                        │
│  (stop-loss / TP)    (market resolution)                     │
│         │                    │                               │
│  L4 Portfolio Coordinator  L4 Circuit Breaker                │
│  (cross-fund concentration)  (per-fund epoch loss)           │
└──────────────────────────────────────────────────────────────┘
```

---

## Four-Layer Architecture (ALPHA-001)

### L1 · Market Data Layer
**Gene**: `polymarket-scanner`  
Fetches Polymarket prediction markets via Gamma API. Filters by liquidity, volume, and end date. Scores arbitrage signals (MISPRICING, MULTI_OUTCOME_ARB, SPREAD).

### L2 · Fund Decision Layer
**Genes**: `polymarket-trader`, `polymarket-settler`, `polymarket-monitor`, `polymarket-risk`, `polymarket-evolver`  
Each of the 15 funds independently evaluates signals against its phenotype parameters. Position sizing via Kelly criterion with drawdown adjustment.

### L3 · Execution Venue Layer
**Genes**: `polymarket-order-lifecycle` (pure decision logic)  
**Infrastructure**: `PolymarketVenue` (orderbook walk + fee modeling)  

| Sub-component | Gene? | Notes |
|---|---|---|
| Quote logic (slippage, depth) | ✅ | Pure function, evolvable |
| Risk check (maxSlippageBps) | ✅ | Pure function, evolvable |
| Order signing (EIP-712) | ❌ | Private key — Worker Secret only |
| HTTP submission (CLOB V2) | ❌ | Side-effecting I/O |

### L4 · Portfolio Layer
**Genes**: `polymarket-portfolio-coordinator`, `polymarket-circuit-breaker`  

| Component | Gene? | Notes |
|---|---|---|
| Portfolio Coordinator | ✅ | Pure function, cross-fund guard |
| Circuit Breaker | ✅ | Pure decision logic, hard floor |
| D1 read/write | ❌ | Storage infrastructure |

---

## Gene Registry

All pipeline stages are registered in `GENE_REGISTRY` (worker/src/gene-interface.ts). Each Gene has:
- Typed Input/Output schema
- `fidelity`: `native` (pure) | `hybrid` (external I/O) | `wrapped` (API wrapper)
- `phenotype.json` in `worker/src/phenotypes/`
- Tests in `worker/tests/`

| Gene ID | Fidelity | Layer | Description |
|---|---|---|---|
| `polymarket-scanner` | hybrid | L1 | Signal discovery (Gamma API) |
| `polymarket-trader` | native | L2 | Paper trade execution |
| `polymarket-settler` | native | L2 | Market settlement |
| `polymarket-monitor` | hybrid | L2 | Active position monitoring |
| `polymarket-risk` | native | L2 | Portfolio risk limits |
| `polymarket-evolver` | native | L2 | PBT evolution |
| `polymarket-order-lifecycle` | hybrid | L3 | GTC order decisions |
| `polymarket-circuit-breaker` | native | L4 | Epoch loss safety floor |
| `polymarket-portfolio-coordinator` | native | L4 | Cross-fund concentration |

---

## Trading Phases

| Phase | Mode | Description | Status |
|---|---|---|---|
| Phase 0 | Paper | Paper trading, simulated prices | ✅ Complete |
| Phase 1 | Shadow | Paper trades + real CLOB quotes | 🔄 Active (10/14 days) |
| Phase 2 | Live Small | Real orders, $100/fund cap | ⏳ Pending Phase 1 exit |
| Phase 3 | Live Full | Community deployment | 📅 Post-v1.0 |

### Phase 1 Exit Conditions
- Shadow fill rate ≥ 85% for 14 consecutive days
- Shadow price deviation ≤ 5% (median) for 14 consecutive days

Monitor: `GET /api/shadow-metrics`

---

## Database Schema (D1: `polymarket-signals`)

| Table | Purpose |
|---|---|
| `paper_trades` | All paper + future live trades |
| `shadow_orders` | Phase 1 CLOB orderbook estimates |
| `live_orders` | Phase 2 real CLOB order lifecycle |
| `circuit_breaker_state` | Per-fund epoch loss tracking |
| `fund_balances` | Current balance per fund |
| `portfolio_snapshots` | Daily equity snapshots |
| `gene_variants` | PBT variant parameters |
| `evolution_log` | Epoch evolution history |
| `system_config` | Kill switch, execution mode |

---

## Tech Stack

| Component | Technology |
|---|---|
| Worker | TypeScript, Cloudflare Workers |
| Database | Cloudflare D1 (SQLite) |
| Real-time state | Cloudflare Durable Objects |
| Cache | Cloudflare KV (cooldown) |
| Frontend | React + Vite (Cloudflare Pages) |
| Prediction markets | Polymarket CLOB V2 API |

---

## Running Locally

```bash
cd worker
npm install
npm test          # Run all unit tests
npx wrangler dev  # Local dev server (requires D1 local DB)
```

## Deploying

```bash
cd worker
npx wrangler deploy
```

See `SECURITY.md` for pre-deployment security checklist.

---

## Contributing

Genes are the primary unit of contribution. To add a new Gene:

1. Implement the logic in `worker/src/your-gene.ts`
2. Add Input/Output interfaces to `worker/src/gene-interface.ts`
3. Register in `GENE_REGISTRY`
4. Create `worker/src/phenotypes/your-gene.phenotype.json`
5. Write tests in `worker/tests/your-gene.test.ts`
6. Open a PR with test coverage

See the [Rotifer Protocol Spec](https://github.com/rotifer-protocol/rotifer-spec) for Gene design principles.
