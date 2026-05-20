# Security Guide

> **For community operators deploying Petri for live trading.**  
> Read this document in full before enabling `EXECUTION_MODE=live`.

---

## ⚠️ Risk Disclaimer

Petri is experimental software. Live trading involves real financial risk. The Rotifer Protocol team provides no warranties on trading performance, uptime, or loss prevention. **You are solely responsible for any funds you deploy.**

---

## Private Key Management

### OWNER_PRIVATE_KEY

The `OWNER_PRIVATE_KEY` Worker secret controls the Deposit Wallet — the on-chain account that holds funds for live trading. This key must be treated with maximum security.

**Where does the key go?**

`OWNER_PRIVATE_KEY` is stored in **your own Cloudflare account's Secret Store** — not on Rotifer Protocol's servers. When you run `wrangler secret put`, Cloudflare encrypts and stores the value under your account. The Rotifer Protocol team has no access to your secrets.

**Storage**:
```bash
# Set via Wrangler (stored encrypted in your Cloudflare Secret Store)
npx wrangler secret put OWNER_PRIVATE_KEY
# Paste the hex private key when prompted. It will NOT be stored in wrangler.toml.
```

**Constraints**:
- **Never commit** `OWNER_PRIVATE_KEY` to any file or environment variable
- **Never log** this value; Cloudflare Worker logs are not private
- Use a **dedicated EOA** — create a new wallet specifically for Petri, do not reuse any wallet used elsewhere
- Fund the wallet with only the amount you are willing to lose in full
- Rotate the key if you suspect exposure

**Minimum balance**: Start with ≤$50 USDC for Phase 2 Small testing.

**Phase 3 upgrade path**: For production deployments handling larger amounts, we plan to support migration to a **Gnosis Safe** setup, where the Worker holds only a low-privilege "signer" EOA and the Safe contract holds actual funds with multi-signature protection. See `internal/products/rotifer-alpha/prd/ALPHA-PRD-001-live-trading.md` §3.3 for the technical roadmap.

---

## API Authentication

All write endpoints (`/api/circuit-breaker` POST, `/api/system` writes, `/admin/*`) require the `Authorization: Bearer <API_TOKEN>` header.

```bash
# Set your API token
npx wrangler secret put API_TOKEN
```

The API token is distinct from the Owner private key. Use a randomly generated 32-byte token:
```bash
openssl rand -hex 32
```

---

## Kill Switch

To immediately halt all trading activity:

```bash
# Via D1 console (Cloudflare Dashboard → D1 → polymarket-signals → Query)
UPDATE system_config SET value = 'true', updated_at = datetime('now') WHERE key = 'KILL_SWITCH';
```

Or via API (authenticated):
```bash
curl -X POST https://api.rotifer.xyz/api/system \
  -H "Authorization: Bearer <API_TOKEN>" \
  -d '{"key":"KILL_SWITCH","value":"true"}'
```

The kill switch blocks all new trade opens within 5 minutes (next cron cycle). Existing open positions are NOT automatically closed — they will expire or be stopped by the risk monitor.

---

## Circuit Breaker

The circuit breaker automatically stops a fund from opening new trades if it loses ≥20% of its epoch-start capital in a 24-hour period. This is a hard safety floor — it cannot be disabled via configuration.

**View status**:
```bash
curl https://api.rotifer.xyz/api/circuit-breaker \
  -H "Authorization: Bearer <API_TOKEN>"
```

**Manual reset** (operator override — use with caution):
```bash
curl -X POST https://api.rotifer.xyz/api/circuit-breaker \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"fundId":"honey-badger-s"}'
```

The circuit breaker resets automatically for all funds at 01:00 UTC daily.

---

## Deposit Wallet Isolation

Each fund operates a separate Deposit Wallet. Wallets are isolated by design:
- Fund A's wallet cannot access Fund B's funds
- Portfolio-level concentration limits (Portfolio Coordinator) apply across wallets
- Wallet balances are reconciled against D1 `paper_trades` after each epoch

**Do not** deposit more USDC than the fund's `initialBalance` parameter. Excess funds are not tracked and could be lost.

---

## D1 Database Security

The D1 database `polymarket-signals` is:
- Accessible only from authenticated Cloudflare Worker requests
- Not directly exposed to the public internet
- Protected by Cloudflare's network-level access controls

**Sensitive data in D1**: trade history, fund balances, circuit breaker state. Do not export this data publicly.

---

## Cloudflare Secrets Checklist

Before going live, verify all secrets are set:

```bash
npx wrangler secret list
```

Required secrets:
| Secret | Purpose | Required for |
|---|---|---|
| `OWNER_PRIVATE_KEY` | Deposit Wallet signing key | Phase 2 Live only |
| `API_TOKEN` | API endpoint authentication | All phases |
| `TELEGRAM_BOT_TOKEN` | Trade notifications | Optional |
| `TELEGRAM_CHAT_ID` | Telegram channel ID | Optional |

---

## Reporting Vulnerabilities

To report a security vulnerability, open a [GitHub Security Advisory](https://github.com/rotifer-protocol/rotifer-alpha/security/advisories) or email the Rotifer Protocol team directly. Do not post vulnerabilities in public issues.

---

## Audit Log

All trades are recorded immutably in D1 `paper_trades` (Phase 1) and `live_orders` (Phase 2). The audit log includes:
- Fund ID, market ID, direction, entry/exit price, PnL
- Shadow order fill estimates vs actual prices
- Circuit breaker trip events
- Kill switch activations

Retain this data for at least 90 days for reconciliation purposes.
