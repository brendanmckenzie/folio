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
Worker that needs them goes live.** Every landed migration up to `0010` is
additive (`create table` / `alter table add column`), so applying one ahead of the
deploy that uses it is safe — the old code never looks at the new column. The
reverse is not: a new Worker reading a column that does not exist yet is a 500 on
every request until the migration lands. `0011` is the first that is not purely
additive, and [its section](#0011-roles-move-to-site_roles-2026-09-29) says what
that costs between the two steps.

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
| `0009` | **Permanently absent.** Nothing will ever take it: a migration numbered below `0010` cannot alter the tables `0010` creates on a fresh database, so the number is unusable. | — |
| `0010_forms.sql` | Forms and responses | Nothing required. Add a `form()` field to a block to embed one, and a `submitted` hook to forward responses. |
| `0011_sites.sql` | The site registry, a site column on stories, redirects, assets, folders, tags, forms, responses and shares, roles as grants in `site_roles`, preview grants; every global unique index re-keyed with the site leading | **Apply it, then deploy, within minutes, with no role changes or invitations in between**, then run the post-deploy grant statement. Read [the 0011 section](#0011-roles-move-to-site_roles-2026-09-29) first: it changes what a rollback can do. |

Next free number is `0012`, which is claimed: `0012_users_role_contract.sql` drops the two `users` columns `0011` retires, in the release after `0011`'s. After it, `0013`.

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

### 0011: roles move to `site_roles` (2026-09-29)

`0011_sites.sql` gives every row a site (`default`, on a deployment that
configures no `sites`) and moves each person's role off `users` into a grant in
`site_roles` on the scope `*`. The migration backfills one `*` grant per user from
`users.role` and `users.role_from`. **From this release on, Folio reads and writes
roles only in `site_roles`.** `users.role` and `users.role_from` stay in place,
unread, until `0012` drops them. With no `sites` configured nothing you can see
changes: one site, one role per person, the same URLs and cache tags.

**Apply `0011`, then deploy, within minutes, and change no roles and invite nobody
in between.** Until the new Worker is serving, the old one is still reading and
writing `users.role`: a role changed or a person invited through it in that window
lands only in the old column and is not carried over. The old code also **cannot
create an asset tag or a form** in the window: its `on conflict (slug)` and
`on conflict (name)` no longer match a unique index, so both fail. Nothing closes the window
for you, deliberately — a trigger mirroring the old column would collide with the
seeds' own grant insert and, on a rollback, mint grants from every old-code edit.

**When the deploy finishes, run this once.** It is idempotent. It gives anyone who
signed in for the first time during the window (a provider that creates accounts
cannot be told to wait) the `*` grant their row says, and touches nobody else:

```sql
insert into site_roles (user_id, scope_id, role, role_from, created_at)
  select id, '*', role, role_from, created_at from users
  where id not in (select user_id from site_roles);
```

Then check that it left nobody out, which should answer `0`:

```sql
select count(*) from users where id not in (select user_id from site_roles);
```

**Seeds and bootstrap SQL change shape.** A user is two inserts now, and neither
names `users.role`, so the same statement works before and after `0012`:

```sql
insert into users (id, email, name, created_at) values ('usr_admin', 'admin@example.com', 'Admin', 0);
insert into site_roles (user_id, scope_id, role, created_at) values ('usr_admin', '*', 'admin', 0);
```

A script of your own that inserts `users (…, role, …)` still runs against `0011`,
but the role it names is ignored: the person signs in as `viewer` until they have
a grant. Change it to the shape above.

**Rolling back to a build before `0011`** works on a deployment that never turned
`sites` on, with two costs. The old code reads `users.role`, which is each
person's role as of the migration, so first restore the column from the grants,
which are all `*` grants on such a deployment:

```sql
update users set
  role = coalesce(
    (select role from site_roles where site_roles.user_id = users.id and scope_id = '*'),
    'viewer'),
  role_from =
    (select role_from from site_roles where site_roles.user_id = users.id and scope_id = '*');
```

And the old code **cannot create an asset tag or a form** against `0011`: its
`on conflict (slug)` and `on conflict (name)` no longer match a unique index, so
both inserts fail until you roll forward again. Everything else works.

**Rolling forward again** after a rollback: the grants are as they were when you
rolled back, and the old code wrote only to `users.role`, so a role it changed is
stale in `site_roles` — a person it demoted would get their old role back. Deploy,
then resync every `*` grant from the column once (instead of the post-deploy
statement above, which fills only missing grants):

```sql
insert into site_roles (user_id, scope_id, role, role_from, created_at)
  select id, '*', role, role_from, created_at from users where true
  on conflict (user_id, scope_id) do update
    set role = excluded.role, role_from = excluded.role_from;
```

**Turning `sites` on is the point of no return.** Once a deployment has a second
site, code with no site dimension would serve every site's rows as one site, so
there is no rolling back past this release from there. Roll forward instead.

**`0012` comes in the release after, never in the same step.** It drops
`users.role` and `users.role_from`. Applied together with `0011` from a build
before `0011`, it removes the column the still-running old Worker signs people in
with, and takes sign-in down until the deploy finishes. Deploy the release that
carries `0011` everywhere it will go, then take `0012` with the next one.

### A title-only patch no longer moves the page (2026-09-06)

**Two bugs, one upgrade, and both were silent.** Read this one even if you skip
the rest.

`PATCH /documents/:id` with a `title` and no `slug` re-derived the slug from the
new title, so **renaming a page changed its URL**, recorded a redirect and fired
`pathsChanged` — while the handbook had documented the opposite all along ("a
title-only patch … fires no `pathsChanged`, by design"). Creating a document
still derives its slug from its title, which is right; updating one no longer
does. Pass `slug` when you mean to move a page.

**Check your content.** Anything that patched a title through the API or the
admin may have moved. Renamed pages are still reachable — a redirect was
recorded — but their URLs are slugified titles rather than the slugs somebody
chose. Look for auto redirects whose target is a long slugified title:

```sql
select from_path, to_path from redirects where source = 'auto' order by created_at desc;
```

Fix one by patching the slug back (`PATCH /documents/:id {"slug":"safari"}`) and
republishing; the redirect from the accidental path stays, which is harmless.

And `FolioMiss.to` is now **rooted** — `/guides/new`, not `guides/new`. It is the
one path-shaped value in the API that leaves as a `Location` header, where a bare
path is a *relative* URL: the browser resolves it against the page it is already
on, so `/guides/safari` redirecting to `guides/new` landed on
`/guides/safari/guides/new` and 404'd. Every rename redirect was broken in that
shape on any host that wrote `redirect(miss.to)` — which is what `AGENTS.md` and
`README.md` both showed, and both are corrected. If you copied the careful
spelling from the handbook or either example (`new URL(miss.to, url.origin)`),
nothing changes for you: that answers the same URL either way. An absolute
off-site target is untouched.

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

**The read shrank too, not just the response.** A query without `withDoc` no
longer selects `published_doc` at all: SQLite projects the root block out of it
(`json_extract(published_doc, '$.bloks."' || … || '"')`) and ships that instead.
On one production database that is 27 kB against 542 kB across 32 published
pages. Nothing to do on your side — `item.data` is identical either way, and a
test asserts exactly that by running the same query both ways and comparing.

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
applied. Every landed migration up to `0010` is additive, so an older Worker
against a newer schema works: it ignores the columns and tables it does not know
about. **`0011` is the exception**: rolling back past it needs one statement first
and loses two writes, and is impossible once `sites` is on — see
[its section](#0011-roles-move-to-site_roles-2026-09-29).

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
