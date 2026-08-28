# Working in this repo

Folio is a Cloudflare-native block CMS with a live visual editor: a library, mounted by
a host Worker that owns its own routes. `README.md` describes what it does and why;
this file is how to work on it without rediscovering things the hard way.

## Commands, and how to tell whether they passed

From the repo root:

```
pnpm typecheck          # tsc across packages/folio and examples/demo
pnpm exec biome ci .    # lint + format, one of the release gates
pnpm test               # vitest: unit (Node) + workers (real workerd)
pnpm build              # demo vite build
```

**Gate on exit codes, not on output.** `biome ci` prints a reassuring
`Lint: No issues found` even when its *format* check failed further up, so a piped
`| tail` can hide a red gate.

- **Run `./node_modules/.bin/biome ci .` — the direct binary.** `pnpm exec biome ci .`
  is the documented form, but on a machine with a shell hook it can be rewritten into
  something that prints a plausible summary and never runs biome at all. It has
  reported `Lint: No issues found` over four real errors. `pnpm lint` is worse.
- `echo "EXIT=$?"` **after a pipe reads the last command's status, not biome's**.
  `cmd | tail; echo $?` is `tail`'s exit code, which is always 0 — that plus the
  rewrite above is how a red gate reads as green twice over.
- To auto-format, `./node_modules/.bin/biome format --write .` is reliable;
  `pnpm exec biome check --write` can be intercepted and silently do nothing.
- A **`biome-ignore` naming a rule that does not exist is itself an error**
  (`suppressions/parse`), and the rule it was meant to suppress stays reported. The
  group matters: `noImportantStyles` is `lint/complexity/`, not `lint/style/`.

`scripts/release.mjs` runs the first three before it will publish, then smoke-tests
the split. There is no GitHub Actions workflow — see "Releasing" below for why.

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
test, and it cannot gate a release.

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

## This is greenfield, and that is a licence

**Zero users. No remote. Nothing deployed.** The owner's standing position, and it
overrides every instinct toward compatibility you will find in this repo's history:

- **Backwards compatibility is not a constraint.** Not for the wire, not for the
  schema, not for stored documents or logs. There is no old data to be kind to.
- **The migrations were rolled into one, and that was fine.** Ten became
  `0001_init.sql` in July 2026. They were not a ledger anybody depended on, and the
  next one to be in the way can go the same way.
- **A thing existing is not an argument for keeping it.** If a design is wrong,
  replace it; do not extend it to avoid a rewrite.
- **Pivots are allowed.** Nothing here is set in stone.

Documents written before this was stated argue at length for additive change and
byte-identical serialisation — `docs/sync-design.md` invariant 10 is the clearest
case, and it says so in place. Read those arguments as *history*, not as rules.
The engineering in them is often still good; the reason given for it is not.

What still applies, for ordinary reasons rather than compatibility ones: a change
should leave the tree green, and a schema change should be one obvious file rather
than a scatter.

## The two ledgers

**D1 migrations** (`packages/folio/migrations/`). **There is one:
`0001_init.sql`**, holding the whole schema — the ten that preceded it were
collapsed into it (`docs/specs/README.md` keeps the record of what each added). A
new one is the next number and normally a plain `alter table`, but rebuilding a
table — `stories` included — is fair game when the shape is wrong. A rebuild has to
carry every column and recreate every index, which is a correctness chore, not a
reason to avoid it.

`0001_init.sql` uses plain `create table`, not `if not exists`: applying it over an
existing database should fail loudly, and the fix is to reset. Two things it does
that are easy to undo by accident, and both are pinned by
`test/workers/migrations.test.ts`:

- **`stories_edited` is an expression index** over
  `coalesce(draft_updated_at, updated_at)`. `draft_updated_at` is null until a
  document's first debounced write and SQLite sorts nulls last under `desc`, so
  ordering by the bare column puts a page created minutes ago *below* one edited
  years ago. Every reader of "last edited" wants the coalesce.
- **`stories_draft_updated` is deliberately absent.** It existed for ten migrations
  and nothing ever ordered by it. Do not restore it by copying an old file; the test
  asserts the absence.

**`PROTOCOL_VERSION`** (`packages/folio/src/core/protocol.ts`) is carried by every
socket frame and every admin↔preview postMessage frame; a mismatch is refused, not
guessed at. It is at **4**. Both ends ship in the same deploy, so a version is a
guard against a stale tab, not a compatibility mechanism — bumping is cheap, and so
is redesigning what the frames contain.

**The mutation log is not sacred.** It is per-Durable-Object state on a system with
no users, and `scripts/e2e.sh` wipes it on every run. A wire change may reinterpret
what older frames meant, and it may drop them: the fallback for an unreadable log is
to reset local state, which costs nothing today. Two shims exist purely for the old
rule — a `set` with no `locale` meaning a source-locale write, and `invert` omitting
the key so a fresh inverse serialises byte-identically to a pre-v3 one — and both
are free to go the next time that code is touched.

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
- `deleteStoryStatement` returns **five** things now, including `indexStatements` and
  `scheduleStatements`, all of which a caller must batch — and there is now exactly
  **one** caller that does: `deleteDocument` in `server/documents.ts`. Four places used
  to batch those arrays and the fifth was added by forgetting one of them, which is
  what `documents.ts` exists to stop. Those statements clear `content_refs` in **both** directions on a
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
- **`tokens.css`'s global layer is opt-in, and a subtree that forgets it looks like a
  padding bug.** Everything in that file outside `:root` is scoped under
  `.folio-ui` — deliberately, because the admin mounts into a *host's* document and
  must not restyle it. Apply it with `scoped()` from `admin/ui/scope.ts`, never a
  string literal. Without it a subtree silently loses `box-sizing: border-box`, so
  **every `width: 100%` control is its own padding-plus-border wider than its parent
  and is clipped at the parent's edge** — plus the one focus treatment, the UI font
  and the reduced-motion override.

  This shipped. For the whole eight-phase port the class was on `Kitchen.tsx` and
  nowhere else — the design system was reviewed on the kitchen-sink page, the one
  page that had it — so in the real admin every inspector input and every record
  field was 18px too wide. It was reported as "the right panel has no padding",
  three components away from the omission.

  **A portal must re-declare it**: `createPortal` moves a subtree to `document.body`,
  outside the shell, and CSS scoping does not follow. Four surfaces portal today and
  each carries it. `test/unit/admin/ui-scope.test.ts` asserts that, and that
  `color-scheme` is the only real property allowed outside the scope (the user agent
  reads it for the scrollbar; a subtree cannot reach that).
- **A hover-only control must not hold layout, and a `.ticked`-style edge must not be
  an inset `box-shadow`.** An inset shadow is clipped by the border radius, so a 2px
  left edge on a rounded row draws a curved bracket `(`, not a bar. `List.module.css`
  uses a `::before`. Both of these are UI-review findings that no test could catch.

## Releasing, and the split you will otherwise be confused by

**`brendanmckenzie/folio` on GitHub is not this repository.** It holds a
`git subtree split --prefix=packages/folio` of it — the package hoisted to the
root, so `github:brendanmckenzie/folio#<sha>` finds a `package.json` where npm
expects one. npm cannot install from a subdirectory of a git dependency, and that
is the only reason the split exists.

The consequences are worth holding in mind, because none of them are obvious from
a clone:

- **The two histories are unrelated.** No common ancestor, parallel commits with
  the same messages and dates. `git log main..folio-package-only` is meaningless;
  the counts differ because the split drops every commit that never touched
  `packages/folio`.
- **The public repo is the *package*, not the project.** `docs/`, `examples/`,
  `prompts/`, `scripts/` and `README.md`/`ROADMAP.md`/this file are all dropped by
  the split. **The gates are local by design.** There is no GitHub Actions
  workflow and there is nothing for one to run against: the split carries the
  package, not the workspace, and `main` — the only branch a workflow could
  check — is never pushed. `release.mjs` is the gate, and it refuses to publish
  if any of them fails.
- **This repository is therefore the only copy of everything except the package.**

Release with:

```
node scripts/release.mjs           # gate, split, print the push command
node scripts/release.mjs --push    # …and push
```

It refuses a dirty tree or a branch other than `main`, runs the three gates by
exit code, and refuses a non-fast-forward — which for a deterministic split means
`main` was rewritten, and pushing would orphan every SHA a consumer has pinned.

Then, once there is actually something to push, it **installs the split the way a
consumer does** — `git+file:` against this repo, so it runs before the push — and
checks that every `exports` subpath resolves. That is the only check that
exercises the package's own `prepare` build; the three gates above run against
the workspace, and nobody installs the workspace.

**Splitting is deterministic**, so re-splitting an unchanged history reproduces
the published SHAs rather than orphaning anything. That is what makes a pin
durable, and why a rewrite of `main` is the one thing the script will not push
through.

Consumers pin a full SHA (`github:brendanmckenzie/folio#<sha>`). Today that is
`consumer-site-a` and `consumer-site-b`. A pinned SHA keeps resolving as long as
it stays reachable from a pushed ref, so a release is additive for everyone who
has not bumped.

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

**18 (`foundation/pagination.md`) is the current one and is `draft`.** It carries the
API-prefix move with it — the admin's internal JSON goes to `{base}/api/` so screens
can own the bare paths — so it touches every list route and ~265 literal paths in
`test/` and `scripts/`. Nothing else should reshape a list route until it lands.

One rule from it is worth knowing before adding any route: **a version segment is a
promise.** `{base}/api/v1/*` is a contract with somebody's script; `{base}/api/*`
with no version is internal to the admin and may change shape in any commit. A
workers test pins the partition, so adding `{base}/api/v1/stories` by reflex fails
`pnpm test`.

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
