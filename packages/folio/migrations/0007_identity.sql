-- Identity and access (docs/specs/foundation/identity-and-access.md).
--
-- Four new tables and nothing else: `stories` is untouched, so unlike 0006 this
-- is a plain additive migration. Anything this spec had wanted on `stories`
-- would have been an `alter table` here rather than a second rebuild.
--
-- Scope is CMS auth: who may *edit*. Reading a published page needs no account
-- and site-visitor auth is deliberately a separate problem, so there is no
-- `access_level` column anywhere below.

-- Editors. Not site visitors.
create table if not exists users (
  -- usr_<12 hex>, minted server-side.
  id            text primary key,
  -- Lowercased on write, which is what makes the unique index mean "one
  -- account per address" rather than "one per spelling of an address".
  email         text not null unique,
  name          text not null,
  -- Presence colour. Null is normal: `fallbackColour(id)` (core/protocol.ts)
  -- derives a stable one, so a user row never has to carry one, and the
  -- deterministic derivation means every peer that recomputes it agrees.
  colour        text,
  -- Global, not per-space (checkpoint 3): Folio has no concept of a space, so
  -- per-space roles would model something that does not exist. A multi-site
  -- deployment revisits this before it is useful.
  role          text not null default 'editor'
                  check (role in ('viewer', 'editor', 'publisher', 'admin')),
  -- How they last signed in: 'magic', 'oidc', or null for an invited user who
  -- never has. Diagnostic; nothing gates on it.
  provider      text,
  created_at    integer not null,
  last_seen_at  integer
);

-- One row per signed-in browser. `id` is the SHA-256 of the token in the
-- cookie, so a leaked database yields no usable cookies (architecture decision
-- 1). Revocation is a delete; there is no secret in the environment to rotate.
create table if not exists sessions (
  id          text primary key,
  user_id     text not null references users(id) on delete cascade,
  created_at  integer not null,
  expires_at  integer not null,
  -- Diagnostics only, never trusted for anything and never compared against
  -- the request's own: pinning a session to a user-agent string breaks on
  -- every browser update and stops nothing.
  user_agent  text
);

create index if not exists sessions_user on sessions (user_id);
create index if not exists sessions_expiry on sessions (expires_at);

-- Single-use sign-in challenges, hashed by the same rule as sessions: the
-- emailed token exists only in the mail, never in the database.
create table if not exists login_challenges (
  id          text primary key,
  email       text not null,
  created_at  integer not null,
  expires_at  integer not null,
  consumed_at integer
);

-- Rate limiting reads "challenges created for this address in the last hour"
-- off this index (see the edge case in the spec: a partial answer, with the IP
-- dimension left to a zone rule, not a pretended-complete one).
create index if not exists login_challenges_email on login_challenges (email, created_at desc);

-- Programmatic access. Scopes rather than a role, because a token is not a
-- person: `content:read` is a shape of access no human account ever has on its
-- own. Used by ../platform/content-api.md; defined here because it shares the
-- hashing rule, the middleware and the actor plumbing with sessions.
create table if not exists api_tokens (
  -- SHA-256 of the presented `folio_<hex>` token, same as sessions.
  id           text primary key,
  name         text not null,
  -- JSON array of scope strings. Read back through a filter that drops
  -- anything not currently a declared scope, so removing a scope from the code
  -- narrows every token that held it rather than crashing on it.
  scopes       text not null,
  created_by   text references users(id) on delete set null,
  created_at   integer not null,
  expires_at   integer,
  last_used_at integer,
  revoked_at   integer
);

create index if not exists api_tokens_created on api_tokens (created_at desc);
