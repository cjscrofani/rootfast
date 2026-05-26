#!/usr/bin/env bash
# Push every SQL chunk under api/processed/chunks/ to D1 remote in order.
# Retries each chunk up to 4 times with backoff on transient wrangler/D1 errors.
# Skip chunks lexically smaller than START env var (e.g. START=020 to resume).
set -uo pipefail

CHUNK_DIR="/Users/cjscrofani/Desktop/Dev/rootfast/api/processed/chunks"
WRANGLER="/opt/homebrew/bin/npx wrangler"
START="${START:-000}"
MAX_TRIES=4

count=0
for chunk in "$CHUNK_DIR"/*.sql; do
  name=$(basename "$chunk" .sql)
  num="${name%%_*}"
  if [[ "$num" < "$START" ]]; then
    echo "SKIP $name"
    continue
  fi
  count=$((count + 1))
  size=$(/usr/bin/stat -f '%z' "$chunk")
  size_mb=$(awk "BEGIN { printf \"%.1f\", $size / (1024*1024) }")
  echo "=== [$count] PUSH $name ($size_mb MB) ==="

  try=1
  while (( try <= MAX_TRIES )); do
    out=$($WRANGLER d1 execute rootfast --remote --file="$chunk" --yes 2>&1)
    rc=$?
    if (( rc == 0 )); then
      echo "$out" | tail -n 6
      break
    fi
    echo "$out" | tail -n 4
    if (( try == MAX_TRIES )); then
      echo "FAILED on $name after $try tries"
      exit 1
    fi
    sleep_for=$((try * 5))
    echo "  retry $try/$MAX_TRIES after ${sleep_for}s…"
    sleep $sleep_for
    try=$((try + 1))
  done
done

echo "All chunks pushed."
