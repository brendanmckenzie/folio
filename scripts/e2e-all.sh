#!/bin/zsh
#
# Run EVERY end-to-end script, each against its own fresh server and database,
# several at a time.
#
#   ./scripts/e2e-all.sh                        # all 26
#   ./scripts/e2e-all.sh scripts/sync-test.mjs scripts/space-test.mjs   # a subset
#   FOLIO_E2E_JOBS=2 ./scripts/e2e-all.sh       # two at a time (default: half the CPUs, 2 to 6)
#
# A reset-then-run per script, not one server for all of them. The scripts mutate
# content and are not idempotent — that is the whole reason `e2e.sh` gives each one
# a new database and Durable Object state — so sharing a database across the set
# produces failures that look exactly like real bugs. Every script gets its own
# state directory and its own port, which is what lets them run concurrently: the
# pool is `scripts/lib/e2e-sweep.mjs`, and what each script does is `e2e.sh`. Setup
# that is the same for all of them (the library build, migrate and seed) runs once
# and is copied, so the sweep is bounded by its slowest script and the CPU count
# rather than by 26 times a 20 second setup.
#
# Exits non-zero if any script did, and names each with its output and server-log
# paths; a passing run removes its temp files, a failing one keeps them.
#
# `scripts/cache-probe.mjs` is deliberately not in the glob: it takes a deployment
# URL because Workers Caching does not exist locally, so it is a tool rather than a
# test and cannot gate anything.
set -u

ROOT=${0:a:h:h}
cd "$ROOT"
exec node scripts/lib/e2e-sweep.mjs "$@"
