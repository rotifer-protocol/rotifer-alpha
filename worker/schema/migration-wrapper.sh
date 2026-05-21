#!/usr/bin/env bash
# migration-wrapper.sh — 防御 D1 大型 migration 的安全执行壳
#
# 起源: 2026-05-21 P9-A 034 灾难——`wrangler d1 execute --file --remote`
# 没有原子性保证；网络中断时留下"一半新一半旧"状态，重跑时 UNIQUE
# 冲突，应急 DELETE 造成永久数据损失。
#
# 本 wrapper 做的事:
#   1. 把 migration.sql 按 `;` 拆成单语句
#   2. 每条语句独立 `wrangler d1 execute --command` 执行
#   3. 解析 meta.changes，比对 expected (从语句前 `-- expect: N` 注释提取)
#   4. 任何 mismatch 立即停止，若提供 rollback 则自动跑
#   5. 进度写 .migration-state，中断后可恢复
#
# Usage:
#   DB=polymarket-signals ./migration-wrapper.sh 034-rename-honeybadger-to-snake-case.sql \
#       --rollback 034-rollback.sql
#
# Dry-run (不执行，只打印):
#   DRY_RUN=1 ./migration-wrapper.sh 034-rename-honeybadger-to-snake-case.sql
#
# Migration SQL 期望计数注释 (在 UPDATE 语句前一行):
#   -- expect: 246
#   UPDATE paper_trades SET fund_id = ...
#
# 没有 -- expect: 注释的语句不 verify changes（仅 PRAGMA / 设置类语句）

set -euo pipefail

MIGRATION_FILE=""
ROLLBACK_FILE=""
DRY_RUN="${DRY_RUN:-0}"
DB="${DB:-polymarket-signals}"
WRANGLER="${WRANGLER:-npx wrangler}"
STATE_FILE=""

usage() {
  cat <<'EOF'
Usage: migration-wrapper.sh <migration.sql> [--rollback <rollback.sql>]

Environment:
  DB        D1 database name (default: polymarket-signals)
  DRY_RUN   Set to 1 to print steps without executing (default: 0)
  WRANGLER  wrangler binary (default: npx wrangler)

Migration SQL contract:
  UPDATE/DELETE/INSERT statements that need verification MUST have a
  `-- expect: N` comment on the preceding line. PRAGMA and other setup
  statements run without verification.
EOF
  exit 1
}

# ─── Arg parsing ──────────────────────────────────────────────────────────────

while [ $# -gt 0 ]; do
  case "$1" in
    --rollback)
      ROLLBACK_FILE="${2:-}"; shift 2 ;;
    --rollback=*)
      ROLLBACK_FILE="${1#--rollback=}"; shift ;;
    -h|--help)
      usage ;;
    *)
      if [ -z "$MIGRATION_FILE" ]; then
        MIGRATION_FILE="$1"; shift
      else
        echo "Unknown arg: $1" >&2; usage
      fi ;;
  esac
done

if [ -z "$MIGRATION_FILE" ] || [ ! -f "$MIGRATION_FILE" ]; then
  echo "ERROR: migration file not found: $MIGRATION_FILE" >&2; usage
fi

STATE_FILE="${MIGRATION_FILE}.state"

echo "=== migration-wrapper.sh ==="
echo "  Migration:  $MIGRATION_FILE"
echo "  Rollback:   ${ROLLBACK_FILE:-<none>}"
echo "  Database:   $DB"
echo "  Dry-run:    $DRY_RUN"
echo "  State file: $STATE_FILE"
echo ""

# ─── Parse migration SQL ──────────────────────────────────────────────────────
# Produces TSV stream to stdin of the next step:
#   <step_index>\t<expect_count>\t<sql>
# expect_count = "" when no `-- expect: N` precedes the statement.

steps_tsv=$(node -e '
  const fs = require("fs");
  const src = fs.readFileSync(process.argv[1], "utf8");

  // Strip block comments only between statements (keep -- line comments to scan for expect)
  // Split on `;` at end of line (D1 statement separator)
  const lines = src.split(/\r?\n/);
  const steps = [];
  let buffer = [];
  let pendingExpect = "";
  let inFunction = false;

  function flush() {
    const sqlRaw = buffer.join("\n").trim();
    if (!sqlRaw) { buffer = []; return; }
    // Strip leading comments + expect annotations from the executable text
    const sql = sqlRaw.split("\n")
      .filter(l => !/^\s*--/.test(l))
      .join("\n")
      .trim();
    if (sql) {
      steps.push({ expect: pendingExpect, sql });
    }
    buffer = [];
    pendingExpect = "";
  }

  for (const line of lines) {
    const expectMatch = line.match(/^\s*--\s*expect:\s*(-?\d+)\s*$/i);
    if (expectMatch && buffer.length === 0) {
      pendingExpect = expectMatch[1];
      continue;
    }
    buffer.push(line);
    if (/;\s*(--.*)?$/.test(line)) flush();
  }
  flush();

  steps.forEach((s, i) => {
    const escaped = s.sql.replace(/\t/g, " ").replace(/\n/g, " ");
    // Use "-" as expect placeholder so bash IFS=tab read does not collapse
    // consecutive tabs (which would shift sql into the expect field).
    const expect = s.expect === "" ? "-" : s.expect;
    process.stdout.write(`${i}\t${expect}\t${escaped}\n`);
  });
' "$MIGRATION_FILE")

total=$(printf '%s\n' "$steps_tsv" | wc -l | tr -d ' ')
echo "Parsed $total statement(s)"
echo ""

# ─── Resume support ───────────────────────────────────────────────────────────

resume_from=0
if [ -f "$STATE_FILE" ]; then
  last=$(cat "$STATE_FILE" 2>/dev/null || echo "")
  if [[ "$last" =~ ^[0-9]+$ ]]; then
    resume_from=$((last + 1))
    echo "ℹ️  Resuming from step $resume_from (state file present)"
    echo ""
  fi
fi

# ─── Execute each step ────────────────────────────────────────────────────────

failed_step=-1

while IFS=$'\t' read -r idx expect sql; do
  [ -z "$idx" ] && continue
  if [ "$idx" -lt "$resume_from" ]; then
    echo "  [$idx] skip (already done)"
    continue
  fi

  short_sql=$(echo "$sql" | cut -c1-80)
  echo "  [$idx] $short_sql"

  if [ "$DRY_RUN" = "1" ]; then
    [ "$expect" != "-" ] && echo "         (would verify changes=$expect)"
    continue
  fi

  # Execute via wrangler
  output=$(env -u CLOUDFLARE_API_TOKEN $WRANGLER d1 execute "$DB" --remote --json --command "$sql" 2>&1) || {
    echo "    ❌ wrangler error:"
    echo "$output" | head -20 | sed 's/^/       /'
    failed_step=$idx
    break
  }

  changes=$(printf '%s\n' "$output" | node -e '
    const input = require("fs").readFileSync(0, "utf8");
    const start = input.indexOf("[");
    if (start < 0) { process.stdout.write("?"); process.exit(0); }
    try {
      const payload = JSON.parse(input.slice(start));
      const c = payload?.[0]?.meta?.changes;
      process.stdout.write(typeof c === "number" ? String(c) : "?");
    } catch (e) { process.stdout.write("?"); }
  ')

  if [ "$expect" != "-" ]; then
    if [ "$changes" = "$expect" ]; then
      echo "    ✅ changes=$changes (expected $expect)"
    else
      echo "    ❌ changes=$changes BUT expected $expect — MISMATCH"
      failed_step=$idx
      break
    fi
  else
    echo "    ✓  changes=$changes (no expect annotation)"
  fi

  echo "$idx" > "$STATE_FILE"
done <<< "$steps_tsv"

# ─── Outcome ──────────────────────────────────────────────────────────────────

if [ "$failed_step" -ge 0 ]; then
  echo ""
  echo "Migration FAILED at step $failed_step"
  echo "State preserved in $STATE_FILE for resume after fix."

  if [ -n "$ROLLBACK_FILE" ] && [ -f "$ROLLBACK_FILE" ]; then
    echo ""
    read -p "Run rollback ($ROLLBACK_FILE)? [y/N] " ans
    if [[ "$ans" =~ ^[yY]$ ]]; then
      echo "Running rollback…"
      env -u CLOUDFLARE_API_TOKEN $WRANGLER d1 execute "$DB" --remote --file "$ROLLBACK_FILE"
      echo "Rollback executed. Verify state manually."
    else
      echo "Rollback skipped. Manual recovery required."
    fi
  else
    echo "No rollback file provided. Manual recovery required."
  fi
  exit 1
fi

# Clean up state file on success
[ -f "$STATE_FILE" ] && rm "$STATE_FILE"

echo ""
echo "✅ Migration complete ($total statement(s))."
