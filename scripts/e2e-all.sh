#!/bin/zsh
#
# Run EVERY end-to-end script, each against its own fresh server and database.
#
#   ./scripts/e2e-all.sh                        # all 22
#   ./scripts/e2e-all.sh scripts/sync-test.mjs scripts/space-test.mjs   # a subset
#
# A loop of reset-then-run, not one server for all of them. The scripts mutate
# content and are not idempotent — that is the whole reason `e2e.sh` wipes D1 and
# the Durable Object state before each one — so sharing a database across the set
# produces failures that look exactly like real bugs. The cost is a full reset,
# migration, seed and dev-server start per script, which makes this slow by
# construction: minutes, not seconds. That is acceptable for the one thing it
# gates, a tagged release, and unacceptable for a push. See `scripts/release.mjs`.
#
# Exits non-zero if any script did, and names them. `e2e.sh` propagates its
# script's status now; before that this file could not have existed usefully.
#
# `scripts/cache-probe.mjs` is deliberately not in the glob: it takes a deployment
# URL because Workers Caching does not exist locally, so it is a tool rather than a
# test and cannot gate anything.
set -u

ROOT=${0:a:h:h}
cd "$ROOT"

if (( $# > 0 )); then
  SCRIPTS=("$@")
else
  SCRIPTS=(scripts/*-test.mjs)
fi

TOTAL=${#SCRIPTS[@]}
FAILED=()
PASSED=()
STARTED=$(date +%s)

echo "Running $TOTAL end-to-end script(s), one fresh database each."
echo

for SCRIPT in $SCRIPTS; do
  NAME=${${SCRIPT:t}%-test.mjs}
  echo "── $NAME ────────────────────────────────────────────"
  STATUS=0
  FOLIO_E2E_OUT="/tmp/folio-e2e-$NAME.txt" \
  FOLIO_E2E_DEV_LOG="/tmp/folio-e2e-$NAME-dev.log" \
    ./scripts/e2e.sh "$SCRIPT" || STATUS=$?
  if (( STATUS == 0 )); then
    PASSED+=("$NAME")
    echo "  ✓ $NAME"
  else
    FAILED+=("$NAME (exit $STATUS)")
    echo "  ✗ $NAME — exit $STATUS"
  fi
  echo
done

ELAPSED=$(( $(date +%s) - STARTED ))
echo "═════════════════════════════════════════════════════"
printf '%d/%d passed in %dm%02ds\n' ${#PASSED[@]} "$TOTAL" $((ELAPSED / 60)) $((ELAPSED % 60))

if (( ${#FAILED[@]} > 0 )); then
  echo
  echo "Failed:"
  for F in $FAILED; do echo "  ✗ $F"; done
  echo
  echo "Per-script output is in /tmp/folio-e2e-<name>.txt, server logs in /tmp/folio-e2e-<name>-dev.log."
  exit 1
fi
