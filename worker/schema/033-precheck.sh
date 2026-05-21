#!/usr/bin/env bash
# 033-precheck.sh — 完整 10 表 gambler 行数盘点。
#
# 目的：D1 SQLite compound SELECT 限制 8 terms，10 表无法用单 UNION ALL，
#       且 wrangler --file 拆分 6+4 块仍报错。改用 bash loop 逐表跑 --command。
#       每条 SELECT ~0.4s，10 张约 4s。
#
# 用法：
#   bash schema/033-precheck.sh
#
# 期望输出（2026-05-21 头部统计基线）：
#   fund_configs              : 3
#   paper_trades              : 246+
#   portfolio_snapshots       : 82+
#   evolution_log             : 28+
#   circuit_breaker_state     : 0
#   fund_wallets              : 0
#   gene_variant_adjustments  : 89+
#   gene_variant_outcomes     : 114+
#   live_orders               : 0
#   shadow_orders             : 589+   (cron 持续写新行，每次跑都会增长)

cd "$(dirname "$0")/.."

run_one() {
  local tbl="$1"
  local col="$2"
  local n
  n=$(env -u CLOUDFLARE_API_TOKEN node_modules/.bin/wrangler d1 execute polymarket-signals --remote \
        --command "SELECT COUNT(*) AS n FROM $tbl WHERE $col IN ('gambler','gambler_m','gambler_l');" 2>/dev/null \
        | grep -oE '"n":[[:space:]]*[0-9]+' | head -1 | grep -oE '[0-9]+$')
  printf "  %-26s : %s\n" "$tbl" "${n:-?}"
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
