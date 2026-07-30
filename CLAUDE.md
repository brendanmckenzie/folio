# Working in this repo

Folio is a Cloudflare-native block CMS with a live visual editor: a library, mounted by
a host Worker that owns its own routes. `README.md` describes what it does and why;
this file is how to work on it without rediscovering things the hard way.

## Commands, and how to tell whether they passed

From the repo root:

```
pnpm typecheck          # tsc across packages/folio and examples/demo
pnpm exec biome ci .    # lint + format, exactly what CI runs
pnpm test               # vitest: unit (Node) + workers (real workerd)
pnpm build              # demo vite build
```

**Gate on exit codes, not on output.** `biome ci` prints a reassuring
`Lint: No issues found` even when its *format* check failed further up, so a piped
`| tail` can hide a red gate.

- Use `pnpm exec biome ci .`, **not** `pnpm lint`, if a shell hook on your machine
  rewrites `pnpm lint` into something else.
- To auto-format, `./node_modules/.bin/biome format --write .` is reliable;
  `pnpm exec biome check --write` can be intercepted and silently do nothing.

CI (`.github/workflows/ci.yml`) runs exactly those four.

## End-to-end scripts

`scripts/*-test.mjs` drive a live dev server on port **5199** over plain
`fetch`/`WebSocket` — no browser. Run one with:

```
./scripts/e2e.sh scripts/sync-test.mjs
```

**Never run them without resetting first**, and never two in one database. They mutate
content and are not idempotent, so a stale database produces failures that look like
real bugs. The helper wipes `examples/demo/.wrangler/state/v3` — D1 **and** Durable
Object state, because drafts live in the objects and wiping only D1 leaves objects that
disagree with the tree — reapplies migrations, seeds, and runs one script.

When writing a new one, follow two conventions that already exist:

- **Stamp the wire version on every frame, not just `hello`:**
  `send: (m) => ws.send(JSON.stringify({ ...m, v: PROTOCOL_VERSION }))`. The Durable
  Object refuses a frame that omits it, and a refused frame looks like a hang rather
  than an error. Import the constant from source so a version bump carries the script.
- **Sign in.** Every route needs a session. `scripts/lib/auth.mjs` exports
  `signInGlobally()`, which makes the process's `fetch` and `WebSocket` carry the
  cookie the way a browser does.
- `import './lib/ts-resolve.mjs'` first if you import library source; it resolves the
  extensionless relative specifiers the library uses.

`scripts/cache-probe.mjs` is **not** one of these and `e2e.sh` does not glob it: it
takes a deployment URL, because Workers Cache does not exist locally. A tool, not a
test, and it cannot gate CI.

## Local login

The demo configures the magic-link provider with a `send` that **logs the link**
rather than emailing it — there is no mail binding. Seeded accounts live in
`examples/demo/seed.sql`: `demo@example.com` (admin), `editor@example.com`,
`viewer@example.com`.

1. `pnpm --filter demo db:local && pnpm --filter demo db:seed` (an empty `users` table
   is the usual cause of "nothing happens": the login route answers 200 identically
   whether or not an address is known, so it cannot be used to enumerate accounts, and
   an unknown email therefore looks exactly like a successful one)
2. Submit an address at `/folio/login`
3. `curl -s localhost:5199/dev/last-signin` → the link. Open it.

`/dev/last-signin` is a demo-only stand-in for a mailbox and 404s off localhost. It is
not a Folio route and should not be copied into a real host.

## The two ledgers

**D1 migrations** (`packages/folio/migrations/`) are shared by every consuming project.
`0001`–`0010` exist. A new one is the next number and is normally a plain
`alter table`. **Do not rebuild `stories`** — `0006` already did, to make `path`
nullable, and a rebuild has to carry every column and recreate every index or it is
silent data loss. `test/workers/migrations.test.ts` pins the current shape.

**`PROTOCOL_VERSION`** (`packages/folio/src/core/protocol.ts`) is carried by every
socket frame and every admin↔preview postMessage frame; a mismatch is refused, not
guessed at. It is at **4**. Both ends ship in the same deploy, so a version is a guard
against a stale tab, not a compatibility mechanism — bumping is cheap.

**The thing that is not cheap:** the mutation log outlives every deploy. So every wire
change must be **additive to a logged mutation**, and an old entry must replay under
its old meaning *forever*. Live examples: a `set` with no `locale` is a source-locale
write, permanently; `invert` omits the key rather than writing `undefined` so a fresh
source inverse serialises byte-identically to a pre-v3 one.

## Invariants that are easy to break by accident

- **The pre-hello quarantine is `joined`, not "has an attachment".** A socket's
  attachment now exists from upgrade time, so the old
  `if (!socket.deserializeAttachment())` guard would be true for every socket.
  `broadcast` / `peers` / `departed` all gate on `joined`. Guarded by
  `keeps deltas away from a socket that has not said hello` in `story-do.test.ts`.
- **Build presence frames with `presenceOf()`. Never spread the attachment** — it
  carries `role`, `session` and `expiresAt`, and leaking a session id onto a broadcast
  is a security bug.
- **Read fields with `fieldValue(blok, name, locale)` / `dataOf(blok, locale)`**
  (`core/locales.ts`), never `blok.data[name]`. Translations live in `i18n`, a sibling
  of `data` on `Blok`.
- **`resolveValue`'s switch over field kinds is exhaustive.** A new kind must be
  handled there.
- **`resolve()` loads only the ids a document needs** — links, references, ancestors,
  globals — not every story. **The ids inside richtext link marks are part of that
  set**: a Folio-native link mark stores a structured `attrs.link` and has no `href`,
  because the href is derived at render. Narrowing the walk without them makes every
  internal prose link render as unstyled text. See `core/refs.ts`'s header.
- **A host's own routes win at any path.** `folio.handle()` returns `null` for anything
  it does not own. Folio never intercepts, which is why `folio.redirect()` and
  `folio.status()` are things a host calls in its own miss branch.
- **Writes go through the mutation log.** `StoryDO.commit` for programmatic writes,
  `tx` for keystrokes. Writing `published_doc` or the object's `doc` row directly is
  faster and breaks sync, undo, presence and the activity trail — visible only to
  whoever had the page open.
- `deleteStoryStatement` returns four things now, including `indexStatements`, which a
  caller must batch. Those statements clear `content_refs` in **both** directions on a
  delete; **unpublish deliberately clears only the outbound half**, because the story
  still exists and "used by N" is still a true warning about it. Two builders
  (`clearIndexStatements`, `clearInboundRefStatements`) rather than one with a flag,
  and `records.test.ts` pins the difference against a later tidy-up that merges them.
- **One focus trap, in `admin/hooks/useFocusTrap.ts`.** All six admin dialogs use it:
  focus in on open, back to the opener on close, Tab cycle, Escape. Do not hand-roll a
  seventh — and note `autoFocus` fights it, because React applies it during commit,
  before the trap reads `activeElement` to remember the opener. The admin's toast is a
  permanently mounted `role="status"` live region; making it conditional again breaks
  announcement, which is why the unconditional render carries a comment.

## Where things live

`core/schema.ts` holds `BlockSchema`, `Manifest`, `SchemaIndex`, `blankBlok`,
`summarise`, `slotsOf`, `allocateSubtree`, `DocumentType`. `core/block.ts` holds
`defineBlock`, `toRegistry`, `toSchemaIndex`, `toManifest` and imports the types from
`schema.ts`. Several older comments point at `block.ts` for the former; they are wrong.

Exports are deliberate: `folio/core` is the whole contract for defining blocks and
rendering resolved pages; `folio/engine` is document tooling for bulk imports and
migrations (`apply()` outside a transaction bypasses sync, undo and multiplayer).

## Specs

`docs/specs/` is one spec per feature, in `_TEMPLATE.md`'s format. The load-bearing
sections are **Ground truth** (verified `file:line` facts, so a plan is not built on a
guess) and **Architecture decisions** (each naming the alternative it beat — a decision
with no rejected alternative is a description).

Specs 1–17 are **done** and restamped in place with an `## Implementation notes`
section recording what actually landed, where the spec was wrong, and what was
deferred. Read the notes, not just the plan: several specs' Ground truth was accurate
when written and stale by the time it was built.

Four things from 17 (`platform/caching.md`) are worth knowing before touching
anything cache-shaped, because all four are wrong in ways that look right:

- The purge set **cannot** be computed from `content_refs`. Globals, collections
  and ancestors leave no edge, a title change fires no event, and it truncates at
  400 rows. Tags are computed at *render*, from the `Resolution`.
- **`caches.default.delete()` is per-colo**, so "purge the cache in a publish hook"
  invalidates one data centre and no others.
- **`cloudflare:workers`' `cache` export is request-scoped.** At module scope its
  `purge` is not a function, so a held reference is a permanent no-op that never
  purges, never errors and passes every test. Dereference it inside the hook.
- **`max-age` is 0 on purpose** in `cacheHeaders`. A purge cannot reach a browser
  cache; raising it buys a stale copy nothing can evict.

Workers Cache is not simulated by miniflare, so no test here can observe a hit or a
purge — which is why everything computable is a pure function and
`scripts/cache-probe.mjs` (a tool, never CI) covers the rest against a deployment.

Deferred work is in `ROADMAP.md`, under `## Next`, `## Uncovered from the reference
project` and `## Known smaller issues`. `docs/feedback.md` records what the owner
asked for, in their words — **do not edit it**, and never write in the owner's voice.

## Commit messages

The subject is a statement of what is now true, not a changelog line: *"Real D1
migrations; the drop-and-reseed schema is gone"*, *"Unpublish clears the liveness
switch; three tree states are real now"*. No `feat:`/`fix:` prefixes, no trailing
period. The body argues the decision and names the alternative it beat, and says
plainly when there is a sanctioned behaviour change. Prose and em-dashes are welcome —
this is internal output. Read `git log` before writing one.
