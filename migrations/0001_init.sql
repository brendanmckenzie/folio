-- Folio's entire D1 schema, in one file.
--
-- This replaces ten sequential migrations (`0001_initial` … `0010_content_index`).
-- They were sequenced only because they were written in sequence: nothing is
-- deployed, there is no remote, and `scripts/e2e.sh` wipes local state on every
-- run, so the history they recorded had no audience. What each of them added is
-- still recorded — in its own spec's `## Wire & schema changes`, and in the table
-- in `docs/specs/README.md`. This file is the *shape*, which is the thing anybody
-- actually needs to read.
--
-- Two consequences worth knowing:
--
-- 1. **Plain `create table`, not `if not exists`.** The old `0001_initial.sql` was
--    written to adopt a database created by a pre-migrations `schema.sql`; that
--    era is over. Applying this over an existing database should fail loudly, and
--    the fix is to reset — `rm -rf examples/demo/.wrangler/state/v3`, then apply.
--    A silent adoption would leave the old schema in place, which now differs:
--    see the dropped index below.
-- 2. **`stories` is declared once, in its final shape.** `0006_document_types.sql`
--    rebuilt this table to make `path` nullable, and every migration after it was
--    a plain `alter table` for exactly one reason: a second rebuild is a second
--    chance to silently drop a column. That hazard is gone here — there is one
--    declaration and no copy step — but the rule it protected still applies to
--    every *future* migration, which will be `0002` onwards and additive.
--
-- D1 holds story *structure* and published snapshots. Live draft state lives in
-- the per-story Durable Object, named by `stories.id`.

-- ---------------------------------------------------------------- stories ---

-- A record, a page and a singleton are the same row with a different `type`
-- (`docs/specs/foundation/document-types.md` checkpoint 1). There is no second
-- table, because one would fork the story tree, versions, publish, the Durable
-- Object naming rule, the history routes and the admin, all so that two columns
-- could be non-null.
--
-- Page metadata (title, description, social image, noindex) lives in the
-- document's root block, not here, so it inherits sync, undo and versioning.
-- `title` is denormalised into this table purely so the tree renders without
-- loading every Durable Object; the document is the source of truth.
create table stories (
  -- Stable. The Durable Object name, so renaming or moving a page never orphans
  -- its draft or its mutation log. A singleton's id is derived from its type name
  -- instead of minted ('sng_<type>'), which is what makes a second one
  -- unrepresentable without a uniqueness constraint.
  id                text primary key,
  -- Document type name, resolved against the `types` passed to `createFolio`.
  type              text not null default 'page',
  parent_id         text,
  -- Last path segment. Empty string for the root story, which serves '/'. Kept
  -- for an unrouted document too: it needs a stable machine-readable handle for
  -- the content API, unique per type rather than per parent (stories_type_slug).
  slug              text not null,
  -- Null for an unrouted document (a record or a singleton), which leaves the URL
  -- namespace entirely rather than squatting a path: naming a record "Contact"
  -- must not take /contact away from the page that needs it. Derived from the
  -- ancestor chain for everything else, and recomputed on rename and move.
  path              text,
  -- Fractional index among siblings: within the parent for a routed document,
  -- within the type for an unrouted one.
  ord               text not null,
  title             text not null,
  -- The liveness switch. `published_at` is written in lockstep with it by both
  -- `publishStoryStatement` and `unpublishStoryStatement`, so testing either one
  -- gives the same answer (`core/story.ts`'s `storyState`).
  published_doc     text,
  published_at      integer,
  created_at        integer not null default (unixepoch()),
  updated_at        integer not null default (unixepoch()),
  -- Set the moment a live page is taken down, cleared by the next publish. What
  -- distinguishes "taken down" from "never published" — an unpublish is not a
  -- document snapshot, so it gets no `versions` row.
  unpublished_at    integer,
  unpublished_by    text,
  -- The Durable Object's log position, mirrored here by a debounced alarm so the
  -- tree can show unpublished changes without opening every object. Coarser than
  -- a diff on purpose (`docs/specs/editing/unpublished-changes.md`).
  draft_sync_id     integer not null default 0,
  -- Nullable, and it stays that way: null means "never edited since creation".
  -- Every reader of "last edited" therefore wants
  -- `coalesce(draft_updated_at, updated_at)` — see stories_edited below, and
  -- `docs/specs/foundation/pagination.md` decision 2a for what goes wrong
  -- otherwise.
  draft_updated_at  integer,
  -- The log position that was published. Written by publish in the same batch as
  -- `published_doc`, so the two can never disagree about what is live.
  published_sync_id integer not null default 0,
  -- The last content migration applied to this document, or null for "before the
  -- first migration". What makes a partial run resumable and what tells the admin
  -- a document is behind the configured model.
  schema_id         text,
  -- Per-locale title cache for the tree, so a translator's tree is not in
  -- English: { "fr": "À propos" }. Best-effort by definition — `title` is the
  -- source-locale cache and the *document* is the truth for both. A stale entry
  -- costs a wrong label in a tree, never wrong content on a page.
  title_i18n        text
);

create index stories_parent_ord on stories (parent_id, ord);

-- The flat per-type listing `GET {base}/api/documents` runs.
create index stories_type on stories (type, ord);

-- Only routed documents live in the URL namespace. Unrouted rows all carry
-- `path = null`; SQLite would treat each of those NULLs as distinct even in a
-- plain unique index, so the `where` clause here is about intent and index size
-- rather than correctness — unlike stories_parent_slug, where it is load-bearing.
create unique index stories_path on stories (path) where path is not null;

-- The sibling-slug invariant, which is what a racing `createStory` actually
-- violates (`docs/sync-design.md`: story-tree writes in D1 are last-write-wins
-- under concurrency). `errors.ts` maps any UNIQUE violation to a `conflict`
-- envelope, so no server code accompanies this.
--
-- `coalesce(parent_id, '')` rather than `parent_id`: SQLite treats every NULL in
-- a unique index as distinct, so two top-level siblings (both storing
-- `parent_id = null`) sharing a slug would never collide. The coalesce folds them
-- onto one key so root-level siblings compare like any other sibling group.
--
-- `where path is not null` is what keeps a record out of the page namespace: every
-- unrouted row also stores `parent_id = null`, so without it the coalesce would
-- fold records onto the same key as top-level pages and a record slugged
-- 'contact' would collide with the page at /contact.
create unique index stories_parent_slug
  on stories (coalesce(parent_id, ''), slug) where path is not null;

-- The unrouted counterpart: an unrouted document's slug is unique within its
-- type, which is the handle the content API and collections address it by.
create unique index stories_type_slug on stories (type, slug) where path is null;

-- "Last edited", for the Content screen's flat mode and Home's recency block
-- (`docs/specs/foundation/pagination.md` decision 2a).
--
-- An **expression** index, and the expression is the point. `draft_updated_at` is
-- nullable and SQLite sorts NULLs last under `desc`, so ordering by the bare
-- column puts a page created five minutes ago and never opened *below* one last
-- edited three years ago — at the bottom of a list called "last edited". `id` is
-- the tiebreak because that is what a keyset cursor over this order needs.
--
-- This replaces `stories_draft_updated (draft_updated_at desc)`, added by the old
-- `0005` and carried through `0006`'s rebuild, which **nothing ever read**: the
-- only two references to that column in `src/` are a write in `story-do.ts` and a
-- projection in `stories.ts`. It has been costing every story write since it was
-- created. Do not restore it; `test/workers/migrations.test.ts` asserts its
-- absence.
create index stories_edited
  on stories (coalesce(draft_updated_at, updated_at) desc, id desc);

-- Flat mode's `sort=title`. `sort=path` needs nothing: stories_path is already
-- unique over non-null paths, so `path` alone is a total order.
create index stories_title on stories (title, id);

-- --------------------------------------------------------------- versions ---

-- Coarse, meaningful history: one row per publish, plus any checkpoints an editor
-- names. Deliberately *not* the Durable Object's mutation log, which is
-- per-keystroke and far too fine-grained to show anyone.
create table versions (
  id         text primary key,
  story_id   text not null,
  -- SQLite cannot widen a CHECK without rebuilding the table, which is why an
  -- unpublish is not represented here.
  kind       text not null check (kind in ('publish', 'checkpoint')),
  label      text,
  title      text not null,
  actor      text,
  doc        text not null,
  created_at integer not null,
  -- Version rows are never rewritten: `getVersion` applies the migrations a
  -- version is missing on the way out, so history stays byte-true and a restore
  -- across a migration diffs two documents in the same shape.
  schema_id  text
);

create index versions_story on versions (story_id, created_at desc);

-- Deliberately no index on either `schema_id`. The runner's sweep is
-- `where schema_id is null or schema_id < ?` over the whole table ordered by the
-- primary key — a scan either way at the sizes a CMS has — and a version's
-- `schema_id` is only ever read by primary key.

-- ----------------------------------------------------------------- assets ---

-- The media library: one row per uploaded file, so an asset can be reused across
-- pages instead of re-uploaded.
--
-- `alt` here is only a *default*. The copy that gets rendered lives in the field
-- value, because the same photograph needs different alt text depending on what
-- it is illustrating. Same reasoning for the focal point.
create table assets (
  id           text primary key,
  -- R2 object key. Carries the original filename so the URL stays readable.
  key          text not null unique,
  filename     text not null,
  content_type text not null,
  size         integer not null,
  width        integer,
  height       integer,
  alt          text not null default '',
  created_at   integer not null
);

create index assets_created on assets (created_at desc);

-- -------------------------------------------------------------- redirects ---

-- Paths a request should be redirected away from. Written inside the same batch as
-- the rename or move that vacated them, so a path change cannot happen without
-- its redirect. Chains are collapsed on write, so a lookup is always one indexed
-- read and a loop is unrepresentable.
create table redirects (
  -- Normalised exactly like stories.path: no leading or trailing slash,
  -- lowercased, no query string. The primary key, because one source path has one
  -- answer.
  from_path  text primary key,
  -- A path in the same form, or an absolute URL for a manual off-site redirect.
  -- Re-checked with `isSafeHref` on read as well as write.
  to_path    text not null,
  status     integer not null default 301 check (status in (301, 302, 307, 308)),
  source     text not null default 'auto' check (source in ('auto', 'manual')),
  -- Which story vacated the path. Informational, not a foreign key: redirects
  -- deliberately outlive the story that created them.
  story_id   text,
  created_at integer not null
);

-- For chain collapsing (`update … where to_path = ?`), the only query that does
-- not go through the primary key.
create index redirects_to on redirects (to_path);

-- ------------------------------------------------------- identity & access ---

-- Scope is CMS auth: who may *edit*. Reading a published page needs no account,
-- and site-visitor auth is deliberately a separate problem — which is why there
-- is no `access_level` column anywhere below.

-- Editors. Not site visitors.
create table users (
  -- usr_<12 hex>, minted server-side.
  id           text primary key,
  -- Lowercased on write, which is what makes this index mean "one account per
  -- address" rather than "one per spelling of an address".
  email        text not null unique,
  name         text not null,
  -- Presence colour. Null is normal: `fallbackColour(id)` derives a stable one
  -- deterministically, so every peer that recomputes it agrees.
  colour       text,
  -- Global, not per-space: Folio has no concept of a space, so per-space roles
  -- would model something that does not exist.
  role         text not null default 'editor'
                 check (role in ('viewer', 'editor', 'publisher', 'admin')),
  -- How they last signed in: 'magic', 'oidc', or null for an invited user who
  -- never has. Diagnostic; nothing gates on it.
  provider     text,
  created_at   integer not null,
  last_seen_at integer
);

-- `listUsers` (`server/auth/users.ts`) orders by this and had no index for it
-- until the schema was collapsed.
create index users_created on users (created_at);

-- One row per signed-in browser. `id` is the SHA-256 of the token in the cookie,
-- so a leaked database yields no usable cookies. Revocation is a delete; there is
-- no secret in the environment to rotate.
create table sessions (
  id         text primary key,
  user_id    text not null references users(id) on delete cascade,
  created_at integer not null,
  expires_at integer not null,
  -- Diagnostics only, never trusted and never compared against the request's own:
  -- pinning a session to a user-agent string breaks on every browser update and
  -- stops nothing.
  user_agent text
);

create index sessions_user on sessions (user_id);
create index sessions_expiry on sessions (expires_at);

-- Single-use sign-in challenges, hashed by the same rule as sessions: the emailed
-- token exists only in the mail, never in the database.
create table login_challenges (
  id          text primary key,
  email       text not null,
  created_at  integer not null,
  expires_at  integer not null,
  consumed_at integer
);

-- Rate limiting reads "challenges created for this address in the last hour" off
-- this index. A partial answer on purpose: the IP dimension is left to a zone
-- rule rather than pretended-complete here.
create index login_challenges_email on login_challenges (email, created_at desc);

-- Programmatic access. Scopes rather than a role, because a token is not a person:
-- `content:read` is a shape of access no human account ever has on its own.
create table api_tokens (
  -- SHA-256 of the presented `folio_<hex>` token, same as sessions.
  id           text primary key,
  name         text not null,
  -- JSON array of scope strings. Read back through a filter that drops anything
  -- not currently a declared scope, so removing a scope from the code narrows
  -- every token that held it rather than crashing on it.
  scopes       text not null,
  created_by   text references users(id) on delete set null,
  created_at   integer not null,
  expires_at   integer,
  last_used_at integer,
  revoked_at   integer
);

create index api_tokens_created on api_tokens (created_at desc);

-- ----------------------------------------------------- content migrations ---

-- One row per content migration applied to every document: the audit trail, and
-- what the admin's migrations screen calls "already run".
--
-- Correctness does not depend on it — migrations are idempotent, so a missing row
-- costs a re-run that does nothing. "Is this document behind" is answered by
-- `stories.schema_id`, which is per-document and therefore the accurate answer;
-- this table is per-migration and is the record of a run.
create table schema_migrations (
  -- The migration's own id, e.g. '0001-hero-heading-to-title'.
  id              text primary key,
  applied_at      integer not null,
  -- Who ran it: a `users.id`, `token:<name>`, or null under `auth: 'open'`.
  actor           text,
  stories_seen    integer not null default 0,
  stories_changed integer not null default 0,
  mutations       integer not null default 0,
  -- JSON array of { storyId, reason }, null when the sweep was clean. A story
  -- that failed is still behind, so the next run picks it up anyway; this column
  -- exists so an operator can see *why* without re-running.
  failed          text
);

-- ------------------------------------------------------------ content index ---

-- Queryable projection of published documents. Written inside publish()'s batch,
-- so it cannot describe an unpublished document, and rebuildable from
-- `published_doc` with `POST {base}/api/reindex`.
--
-- An index table rather than an expression index over
-- `json_extract(published_doc, …)`: a root field's JSON path contains the root
-- blok's random uid, so the expression is a nested extract, it would need one
-- index per queryable field *per locale*, it could never reach a field on a nested
-- block, and it gives no home for reference edges. Four columns and two indexes do
-- all of it.
--
-- Scalars only: this table filters and sorts. Rendering a result loads the
-- published document for the page of results being returned.
create table content_index (
  story_id   text not null,
  -- '' is the source locale, so a single-locale site has exactly one row per
  -- field and no null handling anywhere. A declared non-source locale gets its own
  -- row holding the value as that locale *renders* it — the translation when there
  -- is one, the fallback when there is not — so filtering a French index page
  -- matches what a French visitor actually reads.
  locale     text not null default '',
  field      text not null,
  text_value text,
  -- Numbers, booleans (0/1) and parsed ISO dates, so ordering and ranges are
  -- numeric rather than lexicographic. A date is stored in both columns: an ISO
  -- 8601 string sorts correctly as text *and* parses to a number, and storing both
  -- costs 8 bytes and removes a class of bug.
  num_value  real,
  primary key (story_id, locale, field)
);

create index content_index_lookup on content_index (field, locale, text_value);
create index content_index_num on content_index (field, locale, num_value);

-- Outbound edges of a published document: story links (a `multilink` field, and a
-- link mark inside richtext) and `reference` fields. Written in the same batch.
-- Powers "used by N documents".
--
-- Note what it cannot do, because it looks like it should: it is **not** the cache
-- purge set. Globals leave no edge (they come from config, not a field), collection
-- membership is a query run at render, and a title-only patch changes every linking
-- page. See `docs/specs/platform/caching.md`.
create table content_refs (
  from_story text not null,
  to_story   text not null,
  -- 'link' | 'reference'
  kind       text not null,
  primary key (from_story, to_story, kind)
);

create index content_refs_to on content_refs (to_story);
