# Rotifer Alpha

> *Formerly Petri — repository renamed 2026-05-20.*

AI agent quantitative fund experiment platform — a research experiment by the [Rotifer Protocol](https://github.com/rotifer-protocol) team.

Paper trading on [Polymarket](https://polymarket.com) prediction markets with population-based training (PBT) evolution.

**Latest updates** → [Changelog](./CHANGELOG.md) · [中文](./CHANGELOG.zh.md)

> **Status — Phase 1 Shadow Live active. Phase 2 Live Small pending (est. 4 days).**
>
> All nine pipeline stages are implemented as Rotifer Protocol Genes with typed Phenotype Schemas (RotiferGeneSpec § 4.2). A Genome orchestrator manages variant dispatch via Population-Based Training evolution.
>
> **Alpha Score boundary**: the "Alpha Score" used by this repository (formerly "Petri Score", briefly renamed "PBT Rank Score" on 2026-05-20 before settling on "Alpha Score") is a local PBT evaluation metric, strictly distinct from the Rotifer Protocol's F(g) fitness function. Alpha Score ≠ F(g).

---

> ⚠️ **Live Trading Warning**
>
> Rotifer Alpha supports real on-chain trading via Polymarket CLOB V2. **Live mode involves real financial risk.**
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

Rotifer Alpha runs multiple AI trading agents ("funds"), each with a unique strategy DNA — parameter sets governing risk tolerance, position sizing, and market scanning behavior. Every day:

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

**[GNU Affero General Public License v3.0](LICENSE)** (AGPL-3.0-or-later) — 自 2026-05-20 起。

> **历史**：在 2026-05-20 之前，本仓库代码以 MIT 许可证发布。该日期之前已 fork、再分发或衍生的版本继续受 MIT 保护；自该日期起的新提交及版本受 AGPL 3.0 约束。

### 衍生作品边界

AGPL 3.0 的"网络服务"条款（Section 13）适用于本项目：

- ❌ **构成衍生作品**（必须开源或购买商业许可）：fork 本仓库代码 + 部署为公开服务（包括对外提供 API、Web UI、SaaS 等任何网络可达形式）
- ❌ **构成衍生作品**：修改 Worker / Site 代码并嵌入其他产品
- ✅ **不构成衍生作品**：通过本项目提供的 HTTP API（行情查询、持仓查询、Polymarket signals 等）作为客户端调用——API 调用方与本代码是独立分发
- ✅ **不构成衍生作品**：阅读本项目代码学习实现思路（不引入到自身代码库）

### 商业许可

如需在不公开衍生作品源代码的条件下使用 rotifer-alpha，请联系 **dev@rotifer.dev** 获取商业许可。
