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
# Two pieces of state have to be fresh, not one. D1 holds the rows; the Durable
# Objects hold the drafts. Wiping only D1 leaves objects whose documents disagree
# with the tree that now exists, so a "fresh" database still lies. A new state
# directory covers both, and that is what this makes.
#
# One script per invocation, deliberately. Chaining them shares a database again
# and puts you back where you started. `scripts/e2e-all.sh` runs the whole set,
# several of these at once, which is safe because **nothing here is shared**: each
# run takes its own port and its own state directory and never touches a process
# it did not start.
#
# Knobs, all optional (`scripts/e2e-all.sh` sets them per script):
#
#   FOLIO_E2E_PORT       the dev server's port. Default: a free one, picked here. Never
#                        a fixed 5199, which another dev server may hold.
#   FOLIO_E2E_STATE      the wrangler state directory (D1 + Durable Objects). Default: a
#                        fresh temp directory, removed on success and kept on failure.
#                        It never defaults to `examples/demo/.wrangler/state`, so a run
#                        cannot wipe the database of a dev server you are using.
#   FOLIO_E2E_TEMPLATE   a state directory that is already migrated and seeded; copied
#                        in instead of running migrate and seed (about 5s a run).
#   FOLIO_E2E_SKIP_BUILD set to skip `build:js`, which the sweep runs once up front.
#   FOLIO_E2E_OUT, FOLIO_E2E_DEV_LOG   where the script's output and the server's log go.
set -u

ROOT=${0:a:h:h}
SCRIPT="${1:-}"

if [[ -z "$SCRIPT" ]]; then
  echo "usage: ./scripts/e2e.sh scripts/<name>-test.mjs" >&2
  echo "available:" >&2
  ls "$ROOT"/scripts/*-test.mjs | sed "s|$ROOT/|  |" >&2
  exit 2
fi

cd "$ROOT"

NAME=${${SCRIPT:t}%.mjs}
OUT=${FOLIO_E2E_OUT:-/tmp/folio-e2e-out.txt}
DEV_LOG=${FOLIO_E2E_DEV_LOG:-/tmp/folio-e2e-dev.log}

PORT=${FOLIO_E2E_PORT:-$(node scripts/lib/free-port.mjs)}
OWN_STATE=0
if [[ -z "${FOLIO_E2E_STATE:-}" ]]; then
  FOLIO_E2E_STATE=$(mktemp -d "${TMPDIR:-/tmp}/folio-e2e-state.XXXXXX")
  OWN_STATE=1
fi
STATE=$FOLIO_E2E_STATE

# Only the server this run started is ever signalled. `pkill -f vite/bin/vite.js` was
# here once and is what made a parallel sweep impossible: it killed every other run's
# server, and any unrelated vite the machine happened to be running.
DEV_PID=""
setopt monitor 2>/dev/null   # a background job gets its own process group, workerd included
cleanup() {
  if [[ -n "$DEV_PID" ]]; then
    kill -TERM -- -$DEV_PID 2>/dev/null || kill -TERM $DEV_PID 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 $DEV_PID 2>/dev/null || break; sleep 0.2; done
    kill -KILL -- -$DEV_PID 2>/dev/null
  fi
}
trap cleanup EXIT

if [[ -z "${FOLIO_E2E_SKIP_BUILD:-}" ]]; then
  pnpm --filter folio build:js > "$DEV_LOG" 2>&1 || { echo "e2e: build:js failed (log: $DEV_LOG)" >&2; exit 1; }
fi

if [[ -n "${FOLIO_E2E_TEMPLATE:-}" ]]; then
  rm -rf "$STATE"
  mkdir -p "$STATE"
  cp -R "$FOLIO_E2E_TEMPLATE"/. "$STATE"/
else
  rm -rf "$STATE"/v3
  (
    cd examples/demo
    ./node_modules/.bin/wrangler d1 migrations apply folio --local --persist-to "$STATE" > /dev/null 2>&1
    # Seeds the pages, the three users and the API token. A CMS with accounts
    # cannot bootstrap its first admin over HTTP, so this is how a login works
    # locally at all — skip it and every route answers 401.
    ./node_modules/.bin/wrangler d1 execute folio --local --persist-to "$STATE" --file=./seed.sql > /dev/null 2>&1
  ) || { echo "e2e: migrate or seed failed" >&2; exit 1; }
fi

(
  cd examples/demo
  FOLIO_E2E_PORT=$PORT FOLIO_E2E_STATE=$STATE exec ./node_modules/.bin/vite
) > "$DEV_LOG" 2>&1 &
DEV_PID=$!

# Ready means the Worker answered a real route, not that the port opened.
READY=0
for i in $(seq 1 240); do
  kill -0 $DEV_PID 2>/dev/null || break
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/folio/login" 2>/dev/null)
  if [[ "$CODE" -ge 200 && "$CODE" -lt 500 ]]; then READY=1; break; fi
  sleep 0.25
done
if (( ! READY )); then
  echo "e2e: the dev server never came up on port $PORT (log: $DEV_LOG)" >&2
  exit 1
fi

# The script's own status is the whole point of this wrapper, and it used to be
# thrown away: `node "$SCRIPT" ... || true` swallowed it, so `e2e.sh` exited 0
# whatever happened. `|| STATUS=$?` and not `|| true; STATUS=$?`: `$?` after a `||`
# reads the status of the whole construct, which is always 0.
STATUS=0
FOLIO_E2E_BASE="http://localhost:$PORT" FOLIO_E2E_STATE=$STATE node "$SCRIPT" > "$OUT" 2>&1 || STATUS=$?
# Failures and the tally. Full output stays in $OUT, and the server's own log in
# $DEV_LOG — worth reading when a check fails for no visible reason.
grep -iE '^FAIL|passed$|Error' "$OUT" | tail -25
echo "(full output: $OUT — dev server log: $DEV_LOG — state: $STATE — port $PORT)"

cleanup
DEV_PID=""
if (( OWN_STATE && STATUS == 0 )); then rm -rf "$STATE"; fi

exit $STATUS
