# Petri

AI agent quantitative fund experiment platform — a research experiment by the [Rotifer Protocol](https://github.com/rotifer-protocol) team.

Paper trading on [Polymarket](https://polymarket.com) prediction markets with population-based training (PBT) evolution.

> **Status — Phase 1 Shadow Live active. Phase 2 Live Small pending (est. 4 days).**
>
> All nine pipeline stages are implemented as Rotifer Protocol Genes with typed Phenotype Schemas (RotiferGeneSpec § 4.2). A Genome orchestrator manages variant dispatch via Population-Based Training evolution.
>
> **Petri Score boundary**: the "Petri Score" used by this repository is a local PBT evaluation metric, strictly distinct from the Rotifer Protocol's F(g) fitness function. Petri Score ≠ F(g).

---

> ⚠️ **Live Trading Warning**
>
> Petri supports real on-chain trading via Polymarket CLOB V2. **Live mode involves real financial risk.**
> Before enabling `EXECUTION_MODE=live`:
> - Read [SECURITY.md](./SECURITY.md) in full
> - Set `OWNER_PRIVATE_KEY` with a **dedicated** EOA wallet
> - Fund the wallet with ≤$100 USDC for initial testing
> - Confirm you understand circuit breaker and kill switch operations
>
> The Rotifer Protocol team provides no warranties on trading performance or loss prevention.

## Live

- **Dashboard**: [rotifer.xyz](https://rotifer.xyz)
- **API**: [api.rotifer.xyz](https://api.rotifer.xyz/api/health)

## Structure

```
rotifer-alpha/
├── site/     — React SPA frontend (Cloudflare Pages)
└── worker/   — Cloudflare Worker backend (D1 + Durable Objects)
```

## How it works

Petri runs multiple AI trading agents ("funds"), each with a unique strategy DNA — parameter sets governing risk tolerance, position sizing, and market scanning behavior. Every day:

1. **Scan** — agents scan Polymarket for arbitrage and mispricing signals
2. **Trade** — qualifying signals become paper trades with risk limits
3. **Monitor** — active positions are watched for take-profit, trailing-stop, and reversal exits
4. **Evolve** — population-based training selects the fittest strategies and mutates underperformers

Over time, this creates a live evolutionary laboratory where trading strategies compete, adapt, and improve — all transparently visible on the dashboard.

## Gene Architecture

Each pipeline stage is implemented as a protocol-compatible Gene with a typed Phenotype Schema:

| Gene | ID | Fidelity | Strategy variants |
|------|-----|----------|------------------|
| Scanner | `polymarket-scanner` | HYBRID | `baseline`, `trend-following`, LLM-generated `gN` |
| Monitor | `polymarket-monitor` | HYBRID | `baseline`, `adaptive`, LLM-generated `gN` |
| Risk | `polymarket-risk` | NATIVE | `baseline`, `conservative`, LLM-generated `gN` |
| Settler | `polymarket-settler` | NATIVE | `baseline` (excluded from LLM evolution — deterministic settlement) |
| Trader | `polymarket-trader` | NATIVE | `baseline`, `high-edge`, LLM-generated `gN` |
| Micro-Evolver | `polymarket-micro-evolver` | NATIVE | `baseline`, `aggressive`, LLM-generated `gN` |

The Genome orchestrator (`worker/src/genome.ts`) composes these into a `Seq { risk → scanner → settler → monitor → trader → micro-evolver }` pipeline, loading the best-performing variant from the database for each step.

**Enabling the Genome pipeline:**

```bash
# In worker/wrangler.toml, change:
ENABLE_GENOME_PIPELINE = "true"   # was "false"
# Then deploy
npx wrangler deploy
```

**Rolling back:**

```bash
ENABLE_GENOME_PIPELINE = "false"  # no code change needed
npx wrangler deploy
```

## Development

### Worker

```bash
cd worker
npm install
npm test          # run unit tests
npx wrangler dev  # start local dev server
```

### Site

```bash
cd site
npm install
npm run dev       # start Vite dev server
npm run build     # production build
```

### Environment variables (site)

For local development, create `site/.env.local`:

```env
VITE_API_URL=http://localhost:8787
VITE_WS_URL=ws://localhost:8787/ws
```

## License

[MIT](LICENSE)
