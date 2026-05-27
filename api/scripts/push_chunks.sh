#!/usr/bin/env bash
# Push SQL chunks under api/processed/chunks/ to D1.
#
# Targets:
#   (default)   push to remote D1 (BILLABLE — full reload is millions of rows)
#   --local     push to the local .wrangler D1 (free; for dev iteration)
#
# Scoping (skip the global wipe, only touch listed tables):
#   --tables=t1,t2   only push chunks for these tables, and replace
#                    000_clear.sql with a scoped DELETE for the same set.
#
# Resume support:
#   START=020   skip chunks lexically smaller than this 3-digit prefix.
#
# Examples:
#   ./push_chunks.sh                              # full remote reload
#   ./push_chunks.sh --local                      # full local reload
#   ./push_chunks.sh --tables=hardiness_zones,hardiness_zones_by_zip,hardiness_zones_by_county
#   ./push_chunks.sh --local --tables=plants
set -uo pipefail

CHUNK_DIR="/Users/cjscrofani/Desktop/Dev/rootfast/api/processed/chunks"
WRANGLER="/opt/homebrew/bin/npx wrangler"
START="${START:-000}"
MAX_TRIES=4
TARGET_FLAG="--remote"
TABLES=""

while (( $# )); do
  case "$1" in
    --local)    TARGET_FLAG="--local"; shift ;;
    --remote)   TARGET_FLAG="--remote"; shift ;;
    --tables=*) TABLES="${1#--tables=}"; shift ;;
    --tables)   TABLES="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

declare -a TABLE_LIST=()
if [[ -n "$TABLES" ]]; then
  IFS=',' read -r -a TABLE_LIST <<< "$TABLES"
fi

# Strip "NNN_" prefix and trailing "_NNN" part suffix to get the table name.
# "000_clear"                          -> "clear"
# "001_seed_small"                     -> "seed_small"
# "120_hardiness_zones_000"            -> "hardiness_zones"
# "014_plant_county_distribution_000"  -> "plant_county_distribution"
chunk_table() {
  local rest="${1#*_}"
  if [[ "$rest" =~ ^(.+)_[0-9]{3}$ ]]; then
    echo "${BASH_REMATCH[1]}"
  else
    echo "$rest"
  fi
}

# seed_small bundles regions+states+counties — include it if any are listed.
want_chunk() {
  local table="$1"
  (( ${#TABLE_LIST[@]} == 0 )) && return 0
  if [[ "$table" == "seed_small" ]]; then
    for t in "${TABLE_LIST[@]}"; do
      [[ "$t" == "regions" || "$t" == "states" || "$t" == "counties" ]] && return 0
    done
    return 1
  fi
  for t in "${TABLE_LIST[@]}"; do
    [[ "$t" == "$table" ]] && return 0
  done
  return 1
}

execute_sql_file() {
  local file="$1" label="$2" try=1 out rc sleep_for
  while (( try <= MAX_TRIES )); do
    out=$($WRANGLER d1 execute rootfast "$TARGET_FLAG" --file="$file" --yes 2>&1)
    rc=$?
    if (( rc == 0 )); then
      echo "$out" | tail -n 6
      return 0
    fi
    echo "$out" | tail -n 4
    if (( try == MAX_TRIES )); then
      echo "FAILED on $label after $try tries"
      return 1
    fi
    sleep_for=$((try * 5))
    echo "  retry $try/$MAX_TRIES after ${sleep_for}s…"
    sleep $sleep_for
    try=$((try + 1))
  done
}

# Build a scoped DELETE script by filtering 000_clear.sql's lines so we
# inherit its reverse-FK ordering without duplicating the table list here.
scoped_clear_sql() {
  local global_clear="$CHUNK_DIR/000_clear.sql" line t want
  [[ -f "$global_clear" ]] || { echo "missing $global_clear" >&2; return 1; }
  while IFS= read -r line; do
    if [[ "$line" =~ ^DELETE\ FROM\ ([a-zA-Z_]+)\; ]]; then
      t="${BASH_REMATCH[1]}"
      for want in "${TABLE_LIST[@]}"; do
        if [[ "$want" == "$t" ]]; then
          printf '%s\n' "$line"
          break
        fi
      done
    fi
  done < "$global_clear"
}

echo "Target: $TARGET_FLAG"
if (( ${#TABLE_LIST[@]} )); then
  echo "Tables: ${TABLE_LIST[*]}"
fi

count=0
for chunk in "$CHUNK_DIR"/*.sql; do
  name=$(basename "$chunk" .sql)
  num="${name%%_*}"
  table=$(chunk_table "$name")

  if [[ "$num" < "$START" ]]; then
    echo "SKIP $name (before START=$START)"
    continue
  fi

  if [[ "$name" == "000_clear" ]]; then
    if (( ${#TABLE_LIST[@]} == 0 )); then
      count=$((count + 1))
      echo "=== [$count] PUSH $name (full clear) ==="
      execute_sql_file "$chunk" "$name" || exit 1
    else
      sql=$(scoped_clear_sql) || exit 1
      if [[ -z "$sql" ]]; then
        echo "SKIP scoped clear — none of ${TABLE_LIST[*]} matched 000_clear.sql"
      else
        count=$((count + 1))
        echo "=== [$count] PUSH scoped clear for: ${TABLE_LIST[*]} ==="
        tmp=$(mktemp /tmp/push_chunks_clear_XXXXXX.sql)
        printf '%s\n' "$sql" > "$tmp"
        execute_sql_file "$tmp" "scoped clear"
        rc=$?
        rm -f "$tmp"
        (( rc == 0 )) || exit 1
      fi
    fi
    continue
  fi

  want_chunk "$table" || continue

  count=$((count + 1))
  size=$(/usr/bin/stat -f '%z' "$chunk")
  size_mb=$(awk "BEGIN { printf \"%.1f\", $size / (1024*1024) }")
  echo "=== [$count] PUSH $name ($size_mb MB) ==="
  execute_sql_file "$chunk" "$name" || exit 1
done

echo "All chunks pushed. ($count file(s), target=$TARGET_FLAG)"
