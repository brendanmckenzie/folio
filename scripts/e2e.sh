#!/bin/zsh
#
# Run ONE end-to-end script against a guaranteed-fresh dev server and database.
#
#   ./scripts/e2e.sh scripts/sync-test.mjs
#
# Why this exists rather than "just run the script": the e2e scripts mutate
# content and are **not idempotent**. Running two of them against the same
# database, or the same one twice, produces failures that look exactly like real
# bugs — a check asserting a title finds the previous run's title. Every one of
# them assumes a freshly seeded site.
#
# Two pieces of state have to go, not one. D1 holds the rows; the Durable Objects
# hold the drafts. Wiping only D1 leaves objects whose documents disagree with the
# tree that now exists, so a "fresh" database still lies. `.wrangler/state/v3`
# covers both.
#
# One script per invocation, deliberately. Chaining them shares a database again
# and puts you back where you started.
set -e

ROOT=${0:a:h:h}
SCRIPT="$1"

if [[ -z "$SCRIPT" ]]; then
  echo "usage: ./scripts/e2e.sh scripts/<name>-test.mjs" >&2
  echo "available:" >&2
  ls "$ROOT"/scripts/*-test.mjs | sed "s|$ROOT/|  |" >&2
  exit 2
fi

cd "$ROOT"

# Both default to the documented single-run paths. `scripts/e2e-all.sh` overrides
# them per script so that a 22-script sweep does not leave one log for the last
# one to have run — the failures it reports are the ones you need to read.
OUT=${FOLIO_E2E_OUT:-/tmp/folio-e2e-out.txt}
DEV_LOG=${FOLIO_E2E_DEV_LOG:-/tmp/folio-e2e-dev.log}

# Any dev server holds the local state files open.
#
# `vite/bin/vite.js` and not `vite`: the loose pattern **also matches `vitest`**, so
# running an e2e script killed a unit-test run in the same checkout. Found while six
# agents were working in this tree at once, which is the only condition under which it
# ever mattered — and it cost two aborted runs before anybody noticed the two commands
# share a prefix.
pkill -f 'vite/bin/vite.js' 2>/dev/null || true
sleep 2

rm -rf examples/demo/.wrangler/state/v3
(
  cd examples/demo
  pnpm exec wrangler d1 migrations apply folio --local > /dev/null 2>&1
  # Seeds the pages, the three users and the API token. A CMS with accounts
  # cannot bootstrap its first admin over HTTP, so this is how a login works
  # locally at all — skip it and every route answers 401.
  pnpm exec wrangler d1 execute folio --local --file=./seed.sql > /dev/null 2>&1
)

pnpm dev > "$DEV_LOG" 2>&1 &
for i in $(seq 1 40); do
  curl -s -o /dev/null http://localhost:5199/__debug 2>/dev/null && break
  sleep 1
done
sleep 3

# The script's own status is the whole point of this wrapper, and it used to be
# thrown away: `node "$SCRIPT" ... || true` swallowed it, and the trailing `pkill
# ... || true` was the last statement, so `e2e.sh` exited 0 whatever happened.
# Every one of the 22 scripts signals failure correctly; nothing could read it.
#
# `|| STATUS=$?` and not `|| true; STATUS=$?`: under `set -e` the node line needs
# *something* on its right-hand side or a failing script aborts the wrapper before
# the grep and the cleanup pkill, but `$?` after a `||` reads the status of the
# whole construct, which is always 0. That is the same trap as `cmd | tail; echo $?`.
STATUS=0
node "$SCRIPT" > "$OUT" 2>&1 || STATUS=$?
# Failures and the tally. Full output stays in $OUT, and the server's own log in
# $DEV_LOG — worth reading when a check fails for no visible reason.
grep -iE '^FAIL|passed$|Error' "$OUT" | tail -25
echo "(full output: $OUT — dev server log: $DEV_LOG)"

pkill -f 'vite/bin/vite.js' 2>/dev/null || true

exit $STATUS
