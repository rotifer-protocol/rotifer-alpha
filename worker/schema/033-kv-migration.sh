#!/usr/bin/env bash
# 033-kv-migration.sh — KV cooldown key rename: cooldown:gambler* → cooldown:honeyBadger*
#
# Why: D1 migration 不动 KV。worker `genome.ts` 用 `cooldown:{fund_id}:{market_id}`
#      做跨 tick re-entry 防御（TTL 4h）。如果 D1 改完但 KV 仍是旧 key，
#      worker 用新 fund_id="honeyBadger*" 查 KV → 找不到 → cooldown 失效 4h
#      → 任意被冷却的市场被立即重入。这是 P0。
#
# Strategy:
#   1. list KV → filter cooldown:gambler* keys
#   2. 对每个旧 key：read value + TTL → write 新 key (cooldown:honeyBadger*) → delete 旧 key
#   3. 输出迁移报告（数量 + 失败列表）
#
# Order in Step 2 deploy runbook:
#   step 1: 暂停 cron triggers (移除 wrangler.toml `crons = [...]` 行 → redeploy worker)
#   step 2: 跑此脚本（KV migration，约 30s）
#   step 3: 跑 D1 033-rename SQL（schema/033-rename-gambler-to-honey-badger.sql）
#   step 4: 应用层 deploy (types.ts emoji + ID 全改) + redeploy worker
#   step 5: 恢复 cron triggers + redeploy worker

cd "$(dirname "$0")/.."

WRANGLER="env -u CLOUDFLARE_API_TOKEN node_modules/.bin/wrangler"
KV_BINDING="COOLDOWN_KV"
DRY_RUN="${DRY_RUN:-1}"   # 默认 dry-run；用 DRY_RUN=0 跑实际迁移

if [ "$DRY_RUN" = "1" ]; then
  echo "🌀 DRY-RUN mode (set DRY_RUN=0 to actually rename)"
else
  echo "⚠️  REAL migration mode (writing to KV)"
fi

# Step 1: list all gambler keys with their expirations
keys_json=$($WRANGLER kv key list --binding="$KV_BINDING" --remote 2>/dev/null)
gambler_keys=$(echo "$keys_json" | grep -oE '"name":[[:space:]]*"cooldown:gambler[^"]*"' | grep -oE 'cooldown:gambler[^"]*')

if [ -z "$gambler_keys" ]; then
  echo "✅ No cooldown:gambler* keys found in KV. Nothing to migrate."
  exit 0
fi

count=$(echo "$gambler_keys" | wc -l | tr -d ' ')
echo ""
echo "📋 Found $count gambler keys:"
echo "$gambler_keys" | sed 's/^/   - /'
echo ""

if [ "$DRY_RUN" = "1" ]; then
  echo "🌀 DRY-RUN: would rename above keys to cooldown:honeyBadger* and delete originals."
  echo "   Run with DRY_RUN=0 bash $0 to perform actual migration."
  exit 0
fi

# Step 2: for each key, get value + expiration → put new key → delete old
ok=0
fail=0
echo "$gambler_keys" | while read -r old_key; do
  new_key=$(echo "$old_key" | sed 's/cooldown:gambler/cooldown:honeyBadger/')
  expiration=$(echo "$keys_json" | grep -B1 -A2 "\"$old_key\"" | grep -oE '"expiration":[[:space:]]*[0-9]+' | grep -oE '[0-9]+')
  now=$(date +%s)
  ttl_remaining=$((expiration - now))

  if [ "$ttl_remaining" -le 0 ]; then
    echo "  ⏭  Skip (expired): $old_key"
    $WRANGLER kv key delete --binding="$KV_BINDING" --remote "$old_key" >/dev/null 2>&1 || true
    continue
  fi

  # Read old value (always "1" by convention but we don't assume)
  old_value=$($WRANGLER kv key get --binding="$KV_BINDING" --remote "$old_key" 2>/dev/null)
  [ -z "$old_value" ] && old_value="1"

  # Put new key with same TTL remaining
  if $WRANGLER kv key put --binding="$KV_BINDING" --remote "$new_key" "$old_value" --ttl "$ttl_remaining" >/dev/null 2>&1; then
    if $WRANGLER kv key delete --binding="$KV_BINDING" --remote "$old_key" >/dev/null 2>&1; then
      echo "  ✅ $old_key → $new_key (ttl=${ttl_remaining}s)"
      ok=$((ok + 1))
    else
      echo "  ⚠️  Put OK but delete failed: $old_key"
      fail=$((fail + 1))
    fi
  else
    echo "  ❌ Put failed: $old_key → $new_key"
    fail=$((fail + 1))
  fi
done

echo ""
echo "Done."
