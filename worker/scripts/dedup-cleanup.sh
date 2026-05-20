#!/bin/bash
# [HISTORICAL ARCHIVE — 2026-05-16 one-shot cleanup, kept for audit trail]
# PETRI_API env var name retained for backward compat; see ADR-280 for full context.
#
# Dedup cleanup driver — wraps POST /admin/dedup-trades with dry-run preview,
# interactive confirmation, execute, and post-cleanup verification.
#
# Background: 2026-05-16 isDuplicate cooldown bug allowed the cron pipeline
# (risk→settle→monitor→trader) to re-open positions immediately after closing
# them. ~542 duplicate closed trades were inserted across 15 funds.
#
# This script invalidates duplicates (keeping the earliest opened_at per
# fund×market×day) and verifies the new system return rate.
#
# Usage:
#   ADMIN_SECRET=<your-secret> ./worker/scripts/dedup-cleanup.sh
#
# Auth: ADMIN_SECRET MUST come from the caller's shell env. The script never
# stores or echoes the secret value.

set -euo pipefail

if [ -z "${ADMIN_SECRET:-}" ]; then
  echo "ERROR: ADMIN_SECRET is not set."
  echo "Run with:  ADMIN_SECRET=<your-secret> $0"
  exit 1
fi

API="${PETRI_API:-https://api.rotifer.xyz}"

echo "════════════════════════════════════════════════════════════════"
echo " Step 1 — Dry-run preview (no DB writes)"
echo "════════════════════════════════════════════════════════════════"
DRY=$(curl -s -X POST "$API/admin/dedup-trades" \
  -H "Authorization: Bearer $ADMIN_SECRET")
echo "$DRY" | python3 -m json.tool

WOULD=$(echo "$DRY" | python3 -c "import json,sys;print(json.load(sys.stdin).get('would_invalidate',0))")
DROP=$(echo "$DRY"  | python3 -c "import json,sys;print(json.load(sys.stdin).get('total_pnl_drop',0))")

if [ "$WOULD" = "0" ]; then
  echo
  echo "Nothing to invalidate. Exiting."
  exit 0
fi

echo
echo "────────────────────────────────────────────────────────────────"
echo " Will invalidate: $WOULD trades"
echo " Total PnL drop:  \$$DROP"
echo " Expected target: 542 trades, ~\$-241,401  (Python sim baseline)"
echo "────────────────────────────────────────────────────────────────"
read -r -p "Proceed with execute? [y/N] " ok
if [ "${ok:-}" != "y" ] && [ "${ok:-}" != "Y" ]; then
  echo "Aborted by user."
  exit 0
fi

echo
echo "════════════════════════════════════════════════════════════════"
echo " Step 2 — Executing cleanup"
echo "════════════════════════════════════════════════════════════════"
EXEC=$(curl -s -X POST "$API/admin/dedup-trades?execute=1" \
  -H "Authorization: Bearer $ADMIN_SECRET")
echo "$EXEC" | python3 -m json.tool

echo
echo "════════════════════════════════════════════════════════════════"
echo " Step 3 — Verifying new system return rate"
echo "════════════════════════════════════════════════════════════════"
sleep 2

curl -s -A "rotifer-alpha-audit/1.0" "$API/api/funds" | python3 -c "
import json, sys
d = json.load(sys.stdin)
funds = d.get('funds', d) if isinstance(d, dict) else d
print(f\"{'fund':<14} {'totalVal':>12} {'return%':>9}\")
print('-' * 38)
T_init = T_val = 0.0
for f in sorted(funds, key=lambda x: -((x.get('totalValue',0)-x.get('initialBalance',0))/max(x.get('initialBalance',1),1))):
    ib = float(f.get('initialBalance',0)); tv = float(f.get('totalValue',0))
    ret = (tv-ib)/ib*100 if ib else 0
    print(f\"{f.get('id','?'):<14} {tv:>12,.0f} {ret:>+8.2f}%\")
    T_init += ib; T_val += tv
print('-' * 38)
sys_ret = (T_val-T_init)/T_init*100 if T_init else 0
print(f\"{'SYSTEM':<14} {T_val:>12,.0f} {sys_ret:>+8.2f}%\")
print()
print(f\"Was:      +13.52%\")
print(f\"Expected: +9.17%\")
print(f\"Got:      {sys_ret:+.2f}%\")
diff = abs(sys_ret - 9.17)
if diff < 0.10:
    print(f'✓ Within 0.10pp of expected — cleanup verified.')
else:
    print(f'⚠️  Differs from expected by {diff:.2f}pp — investigate.')
"

echo
echo "Done."
