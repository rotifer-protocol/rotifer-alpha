#!/usr/bin/env bash
# register-deposit-wallet.sh
# ALPHA-001 Phase 2 setup: register Owner EOA as Deposit Wallet for all active funds.
#
# Usage:
#   ./worker/scripts/register-deposit-wallet.sh <WALLET_ADDRESS> [--env local|production]
#
# What this does:
#   1. Validates wallet address format (0x + 40 hex chars)
#   2. Reads active fund IDs from fund_configs (or falls back to DEFAULT_FUNDS list)
#   3. Inserts/replaces fund_wallets rows for every fund
#   4. Prints a verification checklist
#
# SECURITY: This script NEVER asks for or handles OWNER_PRIVATE_KEY.
#   Private key setup is a separate step:
#     npx wrangler secret put OWNER_PRIVATE_KEY
#
# After running this script, verify with:
#   npx wrangler d1 execute petri-db [--remote] --command \
#     "SELECT fund_id, wallet_address, registered_at FROM fund_wallets ORDER BY fund_id"

set -euo pipefail

# ─── Args ─────────────────────────────────────────────────────────────────────

WALLET_ADDRESS="${1:-}"
ENV_FLAG="${2:---local}"  # --local | --remote

if [[ -z "$WALLET_ADDRESS" ]]; then
  echo "Usage: $0 <WALLET_ADDRESS> [--local|--remote]"
  echo ""
  echo "  WALLET_ADDRESS  Owner EOA address (0x + 40 hex chars)"
  echo "  --local         Write to local D1 dev database (default)"
  echo "  --remote        Write to production D1 database"
  exit 1
fi

# ─── Validate address format ──────────────────────────────────────────────────

if ! [[ "$WALLET_ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "❌ Invalid wallet address: '$WALLET_ADDRESS'"
  echo "   Expected format: 0x followed by 40 hex characters"
  echo "   Example: 0xabc123...def456"
  exit 1
fi

WALLET_LOWER=$(echo "$WALLET_ADDRESS" | tr '[:upper:]' '[:lower:]')
echo "✅ Wallet address validated: $WALLET_LOWER"

# ─── Confirm before writing to production ─────────────────────────────────────

if [[ "$ENV_FLAG" == "--remote" ]]; then
  echo ""
  echo "⚠️  You are about to write to the PRODUCTION D1 database."
  echo "   Wallet: $WALLET_LOWER"
  echo ""
  read -r -p "Type 'yes' to confirm: " CONFIRM
  if [[ "$CONFIRM" != "yes" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# ─── Default fund IDs (matches DEFAULT_FUNDS in types.ts) ─────────────────────
# These are the 15 funds (5 personalities × 3 sizes).
# If fund_configs is populated in D1, the actual IDs may differ — but this
# covers the default deployment. Update this list if you've added custom funds.

FUND_IDS=(
  "OCTOPUS_SMALL"
  "OCTOPUS_MEDIUM"
  "OCTOPUS_LARGE"
  "SALMON_SMALL"
  "SALMON_MEDIUM"
  "SALMON_LARGE"
  "PELICAN_SMALL"
  "PELICAN_MEDIUM"
  "PELICAN_LARGE"
  "SHARK_SMALL"
  "SHARK_MEDIUM"
  "SHARK_LARGE"
  "DOLPHIN_SMALL"
  "DOLPHIN_MEDIUM"
  "DOLPHIN_LARGE"
)

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ─── Build SQL batch ──────────────────────────────────────────────────────────

SQL="BEGIN TRANSACTION;"
for FUND_ID in "${FUND_IDS[@]}"; do
  SQL+="
INSERT OR REPLACE INTO fund_wallets
  (fund_id, wallet_address, wallet_type, initial_balance_usdc, registered_at, notes)
VALUES
  ('${FUND_ID}', '${WALLET_LOWER}', 'eoa', 0, '${NOW}',
   'Phase 2 Owner EOA — registered by register-deposit-wallet.sh');"
done
SQL="
COMMIT;"

# ─── Execute ──────────────────────────────────────────────────────────────────

echo ""
echo "📝 Registering wallet for ${#FUND_IDS[@]} funds..."

# Write SQL to a temp file (wrangler d1 execute accepts --file)
TMPFILE=$(mktemp /tmp/register-wallet-XXXXXX.sql)
printf '%s' "$SQL" > "$TMPFILE"
trap 'rm -f "$TMPFILE"' EXIT

npx wrangler d1 execute petri-db "$ENV_FLAG" --file="$TMPFILE"

echo ""
echo "✅ Registration complete."
echo ""
echo "─── Verification ────────────────────────────────────────────────────────"
echo "Run the following to confirm all rows were written:"
echo ""
echo "  npx wrangler d1 execute petri-db $ENV_FLAG --command \\"
echo "    \"SELECT fund_id, wallet_address, registered_at FROM fund_wallets ORDER BY fund_id\""
echo ""
echo "─── Next steps (Phase 2 checklist) ─────────────────────────────────────"
echo "  [ ] P2.4 ✅  Wallet registered (this step)"
echo "  [ ] P2.4b    Store private key: npx wrangler secret put OWNER_PRIVATE_KEY"
echo "  [ ] P2.5     Implement PolymarketVenue(mode='live') EIP-712 signing"
echo "  [ ] P2.6     Implement live_orders reconcile logic"
echo "  [ ] P2.7     Phase 2 monitoring Dashboard"
echo "  [ ] Phase 2  All P1 exit conditions met → flip EXECUTION_MODE to 'live'"
