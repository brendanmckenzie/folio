# Upgrading Folio

Folio is installed from a git SHA, so an upgrade is deliberate: nothing changes
under you until you move the pin. What follows is the procedure, then the
per-migration ledger of what each schema change needs, then the things that are
silent when you skip them.

**Backwards compatibility is not a design constraint here.** There are a handful
of consumers, each pinned to a SHA, and each upgrades on purpose. A wrong design
gets replaced rather than deprecated, and the breaking change lands as a line in
your upgrade commit. Read [the ledger](#the-schema-ledger) before you bump, not
after.

---

## The procedure

```bash
# 1. Find the SHA you want. A full 40 characters — never a branch, never a short SHA.
git ls-remote https://github.com/brendanmckenzie/folio main

# 2. Read what changed between your pin and it.
#    (Commit subjects here are statements of what is now true, so this reads well.)
git log --oneline <your-current-sha>..<new-sha>

# 3. Bump the pin, and delete the installed copy FIRST. See the trap below.
rm -rf node_modules/folio
npm install github:brendanmckenzie/folio#<new-sha>

# 4. Apply any new D1 migrations — local first, then staging, then production.
wrangler d1 migrations list  folio --local
wrangler d1 migrations apply folio --local

# 5. Typecheck. This is where a breaking API change surfaces.
npm run typecheck

# 6. Run it locally and click through the editor.
npm run dev

# 7. Deploy, then apply the same migrations remotely.
wrangler d1 migrations apply folio --remote
npm run deploy
```

Steps 4 and 7 are in that order on purpose: **apply migrations before the
Worker that needs them goes live.** Every landed migration is additive
(`create table` / `alter table add column`), so applying one ahead of the deploy
that uses it is safe — the old code never looks at the new column. The reverse is
not: a new Worker reading a column that does not exist yet is a 500 on every
request until the migration lands.

### The trap that catches everybody

> **`rm -rf node_modules/folio` before reinstalling.**

npm skips a git package's `prepare` build when the directory is already there,
so you end up with the new source and **no `dist/`**. The symptom is imports
failing from a stack that names nothing you wrote. A clean install has never had
this problem, which is exactly why it survives so long unnoticed.

If you use pnpm, `pnpm store prune` is not enough either — remove the directory.

---

## The schema ledger

D1 migrations live in the **package**, and your `wrangler.jsonc` points
`migrations_dir` at `./node_modules/folio/migrations`, so bumping the pin is
what puts new files in front of `wrangler d1 migrations apply`. It records what
it has run, so it never re-runs one and never drops a table.

`wrangler d1 migrations list folio --remote` is the authoritative answer to
"what does this database still need". The table below is what each one is for,
and whether it needs anything from you beyond applying it.

| | Adds | Anything else to do |
| --- | --- | --- |
| `0001_init.sql` | The whole base schema | Nothing. See the note below about applying it over an existing database. |
| `0002_asset_refs.sql` | Asset edges in `content_refs`, so the media library can answer "used by N" | **Republish or reindex** — existing published documents have no asset edges until something writes them. |
| `0003_schedules.sql` | Scheduled publish and unpublish | Add `"triggers": { "crons": ["* * * * *"] }` and a `scheduled()` handler that calls `folio.runSchedules`. Without them the routes work and nothing ever fires. |
| `0004_shares.sql` | Draft share links | Nothing required. Set `draftMode: true` and render through `reader.page()` if you want reviewers to land on real URLs. |
| `0005_content_fts.sql` | `content_text` + an FTS5 index over it | **Reindex** — the index is written at publish, so existing content is invisible to search until you rebuild it. |
| `0006_auth.sql` | `sessions.provider`, a role-decided column, `auth_events` | Wire `folio.sweepAuth(env)` into your cron. Nothing breaks without it; the table just grows forever. |
| `0007_passkeys.sql` | The WebAuthn credential store | Add `passkeys()` to `auth.providers`. Listing it is the whole opt-in. |
| `0008_asset_organisation.sql` | Asset folders, tags, and six columns on `assets` | Nothing. Existing assets land at the root with no tags. |
| `0009` | **Deliberately absent.** It is a claim held by a spec still in draft, left as a gap so nobody renumbers a migration somebody is working against. | — |
| `0010_forms.sql` | Forms and responses | Nothing required. Add a `form()` field to a block to embed one, and a `submitted` hook to forward responses. |

Next free number is `0011`.

**A note on `0001_init.sql`:** it is plain `create table`, not
`create table if not exists`. Applying it over a database that already has those
tables **fails loudly** rather than adopting it, which is deliberate — a silent
adoption would leave an older schema in place under a ledger claiming otherwise.
If you hit this locally, delete `.wrangler/state` and start again.

### Reindexing

Two migrations above say "reindex". So does any schema change of your own that
marks an existing field `indexed: true` or `searchable: true` — publish writes
those rows, so nothing existing has them.

```bash
curl -X POST https://your-site/folio/api/reindex \
  -H "authorization: Bearer $FOLIO_TOKEN"
```

Or `folio.reindex(env)` from a deploy step. It is batched and resumable — re-call
with the previous answer's `continueFrom` until it is null — and idempotent, so
racing a publish is harmless.

---

## Two ledgers with confusingly similar names

They are unrelated and both are called "migrations".

| | **D1 migrations** | **Content migrations** |
| --- | --- | --- |
| What | Folio's database schema | *Your* documents, when *your* block schemas change |
| Where | `node_modules/folio/migrations/*.sql` | `src/migrations.ts` in your project |
| Written by | Folio | You |
| Run by | `wrangler d1 migrations apply` | `folio.migrate(env)`, or `POST {base}/api/migrate` |
| When | On upgrade | When you rename a field or a block type |

You need a **content** migration when you change a block's schema in a way that
strands stored data, which happens quietly:

- Rename a field and every stored document keeps writing to the old key. The
  value is still sitting in `blok.data`, invisible, and the field the admin now
  draws is empty.
- Rename a block *type* and every existing instance renders "Unknown block type"
  in the editor and nothing at all on the live page.
- Add a field with a `default` and existing documents have no such key at all —
  `Field.default` is read at *creation* only.

Both failures are quiet by construction, because the renderer iterates the
schema's fields and a key the schema no longer declares is never read again.

```ts
// src/migrations.ts
import { defineMigration, field } from 'folio/engine'

export const migrations = [
  defineMigration({
    id: '0001-hero-heading-to-title',
    description: 'Hero: heading → title',
    up: (_doc, ctx) => ctx.each('hero', (blok) => field.rename(blok, 'heading', 'title')),
  }),
]
```

Then `migrations` in `createFolio`, and run it from a deploy step:

```bash
curl -X POST https://your-site/folio/api/migrate -H "authorization: Bearer $FOLIO_TOKEN"
```

**Nothing runs automatically**, deliberately: a migration that ran itself on the
first request after a deploy would run inside a request whose CPU limit it can
exceed, on a cold Worker, with nobody watching.

The ids must **sort in run order** — `stories.schema_id` records how far a
document has come and compares lexicographically — and `createFolio` throws at
construction if the declared order and the sort order disagree.

Applying a migration to an already-migrated document produces **zero**
mutations, which is what makes the runner re-runnable after a partial failure
and makes "did that actually work" answerable by running it again and watching
nothing happen.

### The drift audit

The audit tells you which schema changes have already stranded data, so you can
find out before an editor does:

```bash
curl https://your-site/folio/api/audit -H "authorization: Bearer $FOLIO_TOKEN"
```

Or `folio.audit(env)`. It is also the Model screen in the admin.

---

## Things that need an eye on upgrade

### The wire version

`PROTOCOL_VERSION` (`src/core/protocol.ts`, currently **4**) is carried by every
socket frame and every admin↔preview message. A mismatch is refused rather than
guessed at.

**This is not a compatibility mechanism and needs nothing from you.** Both ends
ship in the same deploy, so it is a guard against a stale browser tab, not
against a version skew you have to manage. The user-visible symptom of a bump is
that an editor who left a tab open across your deploy has to reload. Bumps are
cheap and are made freely.

### Collection items no longer carry each document (2026-09-06)

`item.doc` on a `collection` field and on a `folio.query` result is now
**absent unless the query asks for it**. `item.data` — the root block's fields,
which is what a card renders from — is unchanged and still on every item.

Ask for the body where a block genuinely inlines one:

```ts
list: collection({ type: 'guide', withDoc: true })
// or, over the API and in a host's own query:
await folio.query(env, { type: 'guide', withDoc: true })
// GET {base}/content?type=guide&doc=1
```

**Why, and what it is worth.** An item carried a full `Doc` on every query, so a
list paid for every body whether or not anything rendered one. Measured on a live
site: an eleven-item guides rail put **250 kB** of unrendered prose into the SSR
payload of the home page and of all thirteen guide pages — 68% of a 367 kB
response, and 92% of the hydration payload once gzipped. The D1 read is unchanged
(`published_doc` is still read, because `item.data` comes out of it); the bytes
come off the response.

**What to check when you bump.** `tsc` finds the render sites for you — `doc` is
now `Doc | undefined`. Anything that reads `item.doc` without declaring
`withDoc` is a page that was rendering an inlined document and will now render
nothing, so it fails to compile rather than silently emptying. Two other surfaces
change shape for the same reason, both additively reversible with `doc=1`:
`GET {base}/content` and `GET {base}/api/v1/documents`.

`queryKey` is unchanged for a field that does not declare `withDoc`, so
`Resolution.collections` keys are byte for byte what they were.

### Durable Object migration tags

If you are upgrading from a pin old enough to predate `SpaceDO`, you need both
the binding and a **second** migration tag:

```jsonc
"durable_objects": { "bindings": [
  { "name": "STORY", "class_name": "StoryDO" },
  { "name": "SPACE", "class_name": "SpaceDO" }
]},
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["StoryDO"] },
  { "tag": "v2", "new_classes": ["SpaceDO"] }
]
```

`new_classes`, not `new_sqlite_classes`: `SpaceDO` holds no storage at all —
presence lives in socket attachments and nothing it knows outlives them. That
distinction **cannot be changed for an already-deployed class**, which is why
each gets its own tag rather than sharing one.

Without the binding, Folio degrades cleanly: per-story presence, and a tree you
refresh yourself. No error, no retry loop.

### Your agent instructions

`AGENTS.md` ships a paste block delimited by `<!-- folio:begin -->` /
`<!-- folio:end -->` for your own `AGENTS.md` or `CLAUDE.md`. The markers exist
so an upgrade can replace it wholesale without disturbing what surrounds it:

```bash
npx github:brendanmckenzie/folio#<new-sha> agents
```

Or copy it by hand out of `node_modules/folio/AGENTS.md`.

---

## Rolling back

Move the pin back and redeploy. A SHA keeps resolving as long as it is reachable
from a pushed ref, so an older pin is always installable.

**The database does not roll back.** Content migrations have no `down`, and D1
migrations are not reverted by pointing `migrations_dir` at an older package —
`wrangler` will simply report fewer pending files than the database has already
applied. Every landed migration is additive, so an older Worker against a newer
schema works: it ignores the columns and tables it does not know about.

The exception is content. A content migration that rewrote documents has already
rewritten them, through the mutation log — so the recovery is the History tab
(restore a version) rather than a schema operation.

---

## If something is wrong after an upgrade

| What you see | What it is |
| --- | --- |
| Imports fail; `node_modules/folio/dist` is missing | npm skipped `prepare` because the directory already existed. `rm -rf node_modules/folio` and install again. |
| `no such column` / `no such table` on every request | The Worker deployed ahead of its migrations. `wrangler d1 migrations apply folio --remote`. |
| Editors get "reload to continue" once, then it is fine | `PROTOCOL_VERSION` was bumped and their tab predates the deploy. Working as intended. |
| Search returns nothing for content that exists | The FTS index has no rows for documents published before `0005`. Reindex. |
| "Used by N" says 0 for an asset that is plainly in use | Asset edges are written at publish. Reindex, or republish. |
| Editor loads but shows no other cursors and the tree never updates | The `space` binding is absent, or its migration tag was never added. |
| Typecheck reports two incompatible `Plugin` types | Folio got installed by directory path or symlink instead of a SHA. It resolves `vite` from Folio's own tree. |
| Scheduled publishes stopped firing | The cron trigger, or the `scheduled()` handler, did not survive the merge. |

More of these, including the ones that are not upgrade-specific, are in
[`AGENTS.md`](AGENTS.md) under "When something breaks".

---

## See also

- [`README.md`](README.md) — what Folio is, and the quick start.
- [`docs/configuration.md`](docs/configuration.md) — every config key, with its
  default and its failure mode.
- [`docs/handbook.md`](docs/handbook.md) — "Content migrations" has the full
  argument, including why the same function has to reach three copies of a
  document.
- [`docs/specs/README.md`](docs/specs/README.md) — the record of what every
  migration added, per feature.
