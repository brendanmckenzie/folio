-- Forms and their responses (docs/specs/content-model/forms.md).
--
-- Two tables and no foreign keys, following every migration since 0002: D1 has
-- foreign keys off by default, and the two delete paths that matter here are
-- explicit batches rather than cascades (decision 17 of the spec, and the
-- delete dialog that names both counts before either runs).
--
-- No CHECK constraint anywhere, following 0002/0003/0004: SQLite cannot widen
-- one without rebuilding the table, and `versions.kind` is the standing reminder
-- of what that costs. Every enum-shaped value here -- a field's `kind`, a file's
-- `accept` -- lives inside the JSON columns and is screened on read the way
-- `parseScopes` screens `api_tokens.scopes`.

create table forms (
  -- 'frm_<12 hex>'. Immutable, and it is what the action URL in published HTML
  -- names -- so renaming a form must never touch it (decision 3).
  id              text primary key,
  -- Slug. The admin's handle and what rides back on a redirect as
  -- `folio_form=<name>`, so a page with two forms can tell which one answered.
  -- Never part of an action URL.
  name            text not null,
  label           text not null,
  -- JSON array of FormField. Validated by core/forms.ts `validateFormFields` on
  -- every write, and screened on read: a kind this build does not know is
  -- dropped rather than thrown on. Bounded at MAX_FORM_FIELDS (60).
  fields          text not null default '[]',
  -- Bumped when the SHAPE changes -- a field added, removed, renamed, retyped,
  -- made required, or its option values changed. NOT bumped by a label, help,
  -- placeholder or translation edit. `shapeOf` is the pure function that decides
  -- (decision 7), and every response stores the version it answered.
  version         integer not null default 1,
  -- The editor's switch. `closes_at` is the clock's half: the EFFECTIVE state is
  -- `open = 1 and (closes_at is null or closes_at > now)`, computed in the where
  -- clause. There is deliberately no stored "closed" flag for a cron to flip and
  -- for the clock to disagree with -- 0004_shares.sql's live/lapsed rule.
  open            integer not null default 1,
  closes_at       integer,
  closed_message  text not null default '',
  success_message text not null default '',
  submit_label    text not null default 'Submit',
  -- Where a successful native POST lands. Null means "back to the page it came
  -- from", which is the ordinary case and needs no thank-you page to exist.
  redirect_to     text,
  created_at      integer not null,
  -- The optimistic-concurrency token. PATCH carries the value it read and gets a
  -- 409 if it has moved (decision 18) -- this table is outside the mutation log,
  -- so this is the whole of its concurrency story.
  updated_at      integer not null
);

-- The slug's uniqueness, and the lookup behind it.
create unique index forms_name on forms (name);
-- The list screen's only ordering: most recently changed first.
create index forms_updated on forms (updated_at desc, id);

create table form_responses (
  -- 'res_<12 hex>'.
  id         text primary key,
  form_id    text not null,
  -- The forms.version this was validated against -- server-authoritative, never
  -- what the page claimed (decision 7). A cached page showing an older shape
  -- submits against the live form; the formChanged purge is what keeps that fair.
  version    integer not null,
  created_at integer not null,
  -- JSON object keyed by field name. Declared fields only: everything else the
  -- browser sent is dropped (decision 13).
  data       text not null default '{}',
  -- Which language the page was rendered in. '' for a single-locale site, the
  -- same convention content_index uses for its source-locale rows.
  locale     text not null default '',
  -- The path the host's own hidden input said this came from, or '' when it set
  -- none. Host-supplied rather than sniffed from Referer, which is stripped or
  -- forged often enough to be a lie.
  page       text not null default '',
  -- sha256(ip : form_id : floor(now / 1h)). The raw address is NEVER stored, and
  -- the hour bucket means this stops being computable from an IP once that hour
  -- passes -- it expires by construction rather than by a sweep (decision 10).
  -- Null when the request carried no client IP (a local dev run).
  ip_hash    text,
  -- sha256 of the canonical answers plus each file's (name, size, content hash).
  -- Hashing the bytes is what lets the 60-second duplicate check run BEFORE
  -- anything is put to R2 (decision 14).
  body_hash  text not null,
  -- JSON array of { field, key, filename, size, contentType }. `key` is an R2
  -- key under the `sub_` prefix, which the public asset route cannot serve
  -- because ASSET_KEY is anchored to `ast_` (decision 15).
  files      text not null default '[]'
);

-- The responses table's keyset: newest first, per form.
create index form_responses_form on form_responses (form_id, created_at desc, id);
-- The duplicate collapse's reader, run once per submission.
create index form_responses_dupe on form_responses (form_id, body_hash, created_at desc);
-- The rate limit's reader. Partial, the shape 0003_schedules.sql established:
-- the index holds only the rows the query wants, and a row with no client IP is
-- not one of them.
create index form_responses_throttle
  on form_responses (ip_hash, created_at desc) where ip_hash is not null;

-- Deliberately absent, each asserted in test/workers/migrations.test.ts so
-- adding one is a deliberate act with a measurement behind it:
--
--   * a `form_fields` table -- fields are one JSON column (decision 2), and a
--     projection table would be a second write path into one fact;
--   * an index on forms.label -- nothing sorts by it, and forms_name already
--     serves lookup on a table bounded by what a person will build;
--   * an index on form_responses.data -- the responses search is a substring
--     scan by decision 16's sibling reasoning, and no index serves a leading
--     wildcard LIKE anyway;
--   * a "closed" or "status" column on forms -- the effective state is computed
--     from `open` and `closes_at` against the clock (0004_shares.sql's rule).
--
-- `content_refs` gains a fourth `kind` ('form') with NO DDL: 0002_asset_refs.sql
-- records that `kind` carries no CHECK and that `to_id` holds whatever `kind`
-- says it holds. A row is (from_story = the page, to_id = a form id).
