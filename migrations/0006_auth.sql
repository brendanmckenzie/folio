-- Auth providers, part 2 (docs/specs/foundation/auth-providers.md): who decided a
-- role, which provider minted a session, and a record of sign-ins.
--
-- Two `alter table add column`s and one `create table`, in the plain shape 0002-0005
-- established. Both new columns go at the end of their tables, so the exact column
-- lists `test/workers/migrations.test.ts` asserts grow by one entry each.

-- Who decided this user's role: null for Folio — an admin invited or edited them —
-- or the id of the provider whose claims set it at their last sign-in. When set,
-- `PATCH {base}/api/users/:id` refuses to change `role` (409): the remedy for a
-- group change is in the identity provider, and letting an admin edit a role the
-- next sign-in will overwrite is the "it quietly changed" failure this schema
-- refuses elsewhere. `DELETE` is always Folio's; removing someone is not a role.
alter table users add column role_from text;

-- Which provider minted this session. Read by `POST {base}/api/logout` to decide
-- where the browser goes next — a redirect or trusted provider may have its own
-- sign-out URL — and shown beside each browser on the account screen
-- (foundation/passkeys.md). Nothing gates on it.
alter table sessions add column provider text;

-- Sign-ins, refusals, sign-outs, role changes, invitations, removals. One row per
-- event, appended in the same batch as the session or the change it describes, so
-- an event cannot exist without the thing it records or vice versa.
--
-- **`kind` has no CHECK constraint, deliberately** — the reasoning `content_refs.kind`
-- (0002) and `schedules.action` (0003) record: SQLite cannot widen a CHECK without
-- rebuilding the table, and the passkeys spec adds kinds. Unknown kinds are screened
-- on read, exactly as `api_tokens.scopes` are.
--
-- **A refused identity is recorded with no `user_id`**, and that is on purpose: an
-- OIDC or trusted refusal is an address the identity provider vouched for, so "this
-- person tried and is not invited" is the admin's cue rather than a stranger's input.
-- A magic-link request for an unknown address never reaches this table — no
-- challenge is created for it (routes/auth.ts) — because that *is* a stranger's input.
create table auth_events (
  -- evt_<12 hex>, minted server-side. A synthetic key for the reason every paged
  -- table here has one: the keyset tiebreak over `(at, id)` must be unique on its own.
  id       text primary key,
  -- Epoch milliseconds, UTC, like every other timestamp Folio stores.
  at       integer not null,
  -- sign_in | sign_in_refused | sign_out | role_changed | user_invited | user_removed
  kind     text not null,
  -- The account the event is about. Null for a refused identity Folio has no row
  -- for. Informational rather than a foreign key, matching every cross-table
  -- reference in this schema except `sessions.user_id`: a removed user's events stay
  -- readable, which is what makes the table a record.
  user_id  text,
  -- Who caused it: the user's own id for a sign-in, an admin's `users.id` for an
  -- invitation or an edit, `token:<name>` for a script, or `provider:<id>` when an
  -- identity provider's claims changed a role with nobody clicking — which is the
  -- case this table exists to record.
  actor    text,
  -- The provider involved, when one was: 'magic', 'oidc', 'cloudflare-access', a
  -- host's own id, 'passkey'.
  provider text,
  -- JSON, shaped by `kind`: `{ from, to }` for role_changed, `{ email, reason }` for
  -- sign_in_refused, `{}` otherwise. Text rather than columns because the shape is
  -- per kind and the passkeys spec adds kinds.
  detail   text
);

-- `GET {base}/api/auth-events?user=` and `GET {base}/api/me/events`: one user's
-- history, newest first.
create index auth_events_user on auth_events (user_id, at desc);

-- `GET {base}/api/auth-events` with no `?user=`, and the 90-day sweep in
-- `folio.sweepAuth`, both walk this.
create index auth_events_at on auth_events (at desc);

-- **Deliberately no index on `kind` or `provider`.** Neither is a filter any route
-- takes; adding one later is a deliberate act with a measurement behind it, which is
-- the rule `stories_draft_updated`'s removal established.
