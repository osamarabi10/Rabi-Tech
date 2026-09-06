#!/usr/bin/env bash
# Run the full gate sweep and prove it completed.
#
# Every gate writes its summary to a named file under one run directory, and
# verify-gate-sweep.js then asserts each expected file exists and is newer than
# the moment this started. A shell reaped mid-sequence, a gate that never ran,
# a gate that wrote nothing — all three fail here instead of reading as silence.
#
# Usage:  bash scripts/run-gate-sweep.sh [run-dir]
set -u

RUN_DIR="${1:-.gate-runs/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$RUN_DIR"
STARTED=$(date +%s)
BACKEND="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$BACKEND/../.." && pwd)"

echo "sweep -> $RUN_DIR"
echo

# The provisioning worker consumes the same BullMQ queue that
# verify-lazy-provisioning writes to, and it wins the race — building real
# tenant containers for the gate's fixture organizations. Stopped for the
# duration, restarted at the end whatever happens.
( cd "$ROOT" && docker compose stop gateway-worker >/dev/null 2>&1 )
restore_worker() { ( cd "$ROOT" && docker compose start gateway-worker >/dev/null 2>&1 ); }
trap restore_worker EXIT

run() {   # run <name> <command...>
  local name="$1"; shift
  local out="$RUN_DIR/$name.log"
  "$@" > "$out.full" 2>&1
  local code=$?
  # The summary line is what the manifest reads; the full output stays beside it.
  #
  # A gate that passes silently — tsc is the one — would otherwise write an
  # empty summary, and the manifest is right to treat empty as no result. So
  # silence becomes an explicit line rather than an absence.
  # The exit code first, then the last line of output. The manifest reads
  # both: presence proves the gate ran, the code proves what it decided.
  {
    echo "exit=$code"
    if [ -s "$out.full" ]; then tail -1 "$out.full"; else echo "(no output)"; fi
  } > "$out"
  printf '  %-22s exit=%s  %s\n' "$name" "$code" "$(tail -1 "$out" | head -c 60)"
  return $code
}

cd "$BACKEND"
run tsc                 npx tsc --noEmit
run tenancy             node scripts/tenancy-bleed-harness.js
run capabilities        node scripts/verify-capabilities.js
run entitlement-proof   node scripts/c3-entitlement-snapshot.js
run lazy-provisioning   node scripts/verify-lazy-provisioning.js
run session-routing     node scripts/verify-session-routing.js
run secrets             node scripts/verify-secret-scan.js
run dunning             node scripts/verify-dunning.js
run backup-replication  node scripts/verify-backup-replication.js

cd "$ROOT/apps/frontend"
run frontend-tsc        npx tsc --noEmit
run frontend-i18n       npm run check:i18n
run frontend-mojibake   npm run check:mojibake

cd "$BACKEND"
echo
node scripts/verify-gate-sweep.js "$RUN_DIR" "$STARTED"
