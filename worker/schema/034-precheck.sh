#!/usr/bin/env bash
# 034-precheck: Count honeyBadger entries across 10 tables before migration.
set -euo pipefail

DB="${DB:-polymarket-signals}"
WRANGLER="${WRANGLER:-npx wrangler}"

echo "=== 034 Precheck: honeyBadger → honey_badger ==="
echo ""

run_one() {
  local tbl="$1"
  local col="$2"
  local output
  local result
  output=$(env -u CLOUDFLARE_API_TOKEN $WRANGLER d1 execute "$DB" --remote --command \
    "SELECT COUNT(*) AS n FROM $tbl WHERE $col IN ('honeyBadger','honeyBadger_m','honeyBadger_l')" 2>/dev/null)
  result=$(printf '%s\n' "$output" | node -e '
    const input = require("fs").readFileSync(0, "utf8");
    const start = input.indexOf("[");
    if (start < 0) process.exit(1);
    const payload = JSON.parse(input.slice(start));
    const n = payload?.[0]?.results?.[0]?.n;
    if (typeof n !== "number") process.exit(1);
    process.stdout.write(String(n));
  ')
  printf "  %-30s : %s\n" "$tbl" "${result:-?}"
}

run_one fund_configs              id
run_one paper_trades              fund_id
run_one portfolio_snapshots       fund_id
run_one evolution_log             fund_id
run_one circuit_breaker_state     fund_id
run_one fund_wallets              fund_id
run_one gene_variant_adjustments  fund_id
run_one gene_variant_outcomes     fund_id
run_one live_orders               fund_id
run_one shadow_orders             fund_id

echo ""
echo "Done. Verify counts match expectations before running 034 migration."
