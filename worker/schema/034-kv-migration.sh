#!/usr/bin/env bash
# 034-kv-migration: Rename cooldown:honeyBadger* KV keys to cooldown:honey_badger*
set -euo pipefail

DRY_RUN="${DRY_RUN:-1}"
KV_BINDING="${KV_BINDING:-COOLDOWN_KV}"
WRANGLER="${WRANGLER:-npx wrangler}"

echo "=== 034 KV Migration: honeyBadger → honey_badger ==="
echo "DRY_RUN=$DRY_RUN (set DRY_RUN=0 to execute)"
echo ""

# List honeyBadger keys. Output TSV: key<TAB>expiration_epoch_or_empty.
keys_json=$(env -u CLOUDFLARE_API_TOKEN $WRANGLER kv key list --binding="$KV_BINDING" --remote --prefix="cooldown:honeyBadger" 2>/dev/null || true)
honeybadger_keys=$(printf '%s\n' "$keys_json" | node -e '
    const input = require("fs").readFileSync(0, "utf8");
    const start = input.indexOf("[");
    if (start < 0) process.exit(0);
    const keys = JSON.parse(input.slice(start));
    for (const k of keys) {
      if (typeof k.name === "string") {
        process.stdout.write(`${k.name}\t${k.expiration ?? ""}\n`);
      }
    }
  ')

if [ -z "$honeybadger_keys" ]; then
  echo "No cooldown:honeyBadger* keys found. Nothing to migrate."
  exit 0
fi

count=$(echo "$honeybadger_keys" | wc -l | tr -d ' ')
echo "Found $count key(s) to migrate:"
echo "$honeybadger_keys" | while IFS=$'\t' read -r k expiration; do echo "  $k"; done
echo ""

if [ "$DRY_RUN" = "1" ]; then
  echo "[DRY RUN] Would rename above keys. Run with DRY_RUN=0 to execute."
  exit 0
fi

migrated=0
failed=0

while IFS=$'\t' read -r old_key expiration; do
  [ -z "$old_key" ] && continue
  new_key=$(echo "$old_key" | sed 's/cooldown:honeyBadger/cooldown:honey_badger/')

  old_value=$(env -u CLOUDFLARE_API_TOKEN $WRANGLER kv key get --binding="$KV_BINDING" --remote "$old_key" 2>/dev/null | tail -n 1 || echo "")
  if [ -z "$old_value" ]; then
    echo "  ⚠️  $old_key — empty value, skipping"
    continue
  fi

  now=$(date +%s)
  ttl_remaining=14400
  if [ -n "${expiration:-}" ] && [ "$expiration" -gt "$now" ] 2>/dev/null; then
    ttl_remaining=$((expiration - now))
  fi

  if env -u CLOUDFLARE_API_TOKEN $WRANGLER kv key put --binding="$KV_BINDING" --remote "$new_key" "$old_value" --ttl "$ttl_remaining" >/dev/null 2>&1; then
    if env -u CLOUDFLARE_API_TOKEN $WRANGLER kv key delete --binding="$KV_BINDING" --remote "$old_key" >/dev/null 2>&1; then
      echo "  ✅ $old_key → $new_key (ttl=${ttl_remaining}s)"
      migrated=$((migrated + 1))
    else
      echo "  ⚠️  $old_key — put OK but delete failed (new key exists, old key orphaned)"
      failed=$((failed + 1))
    fi
  else
    echo "  ❌ $old_key — put failed"
    failed=$((failed + 1))
  fi
done <<EOF
$honeybadger_keys
EOF

echo ""
echo "Migration complete. Migrated: $migrated, Failed: $failed"
