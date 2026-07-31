-- Draft preview sharing: a link that shows one unpublished document to somebody
-- with no account.
--
-- `docs/specs/platform/draft-sharing.md` is the spec. The groundwork was already
-- laid twice over. `?_folio=preview` on a document's own public URL already renders
-- the live draft through the host's `route()` and Folio's preview shell
-- (`server/index.tsx`'s preview branch), and `auth/secrets.ts` already owns the one
-- way a bearer secret is minted and the one way it is stored. This table is the
-- missing half: a credential that authorises that one URL and nothing else.
--
-- **A share is not an `Actor`, and this table is the reason it cannot become one.**
-- `users` carries a role and `api_tokens` carries scopes, and both resolve through
-- `auth/resolve.ts` into the `Actor` every route gate reads. There is no role and no
-- scope column here, deliberately: `readShareByToken`/`claimShare` answer a
-- `ShareGrant` — an id, a story id, an expiry — which `allows()` cannot be called
-- with, so no route gate anywhere can be satisfied by one. Adding a `scopes` column
-- here would be the change that quietly turns a review link into a credential.
--
-- **`story_id` is one document, not a subtree.** A grant over "this page and its
-- children" is a grant over a set that changes *after* the grant was made: create a
-- page under About tomorrow and yesterday's link discloses it, and the person who
-- issued the link cannot have consented to a document that did not exist. Three
-- pages to review are three rows, each individually revocable, which is also the
-- only shape a list route can report honestly. See the spec's architecture decision 1.
--
-- **A rebuild of nothing.** No column on `stories`, no change to any existing table,
-- and in particular no new return from `deleteStoryStatement` — see `shares_story`'s
-- absence below and the comment on `revoked_at`.

create table shares (
  -- shr_<12 hex>, minted server-side.
  --
  -- **A synthetic key, unlike `api_tokens`, whose primary key *is* the SHA-256 of
  -- the token.** Two reasons, and the second is the one that decided it:
  --
  --   1. The keyset tiebreak has to be unique on its own (`server/keyset.ts`'s
  --      `Keyset`), which the hash also satisfies — this is the `schedules.id`
  --      argument and it is the weaker of the two.
  --   2. `DELETE {base}/api/shares/:id` and every row a list route hands to a screen
  --      then carry **no secret-derived material at all**. The hash cannot be
  --      presented as a credential (lookup hashes what arrives, so presenting the
  --      hash yields a different hash) so this is defence in depth rather than a
  --      fix — but it is defence against the whole family of "the id ended up in a
  --      log, a referrer, or an analytics event", which is precisely the family this
  --      feature exists to keep a *token* out of.
  id            text primary key,
  -- Lowercase-hex SHA-256 of the token in the link. **The database only ever holds
  -- the hash** (`auth/secrets.ts`, and `examples/demo/seed.sql` spells out the
  -- consequence): a leaked database yields no usable links.
  --
  -- The reasoning that makes hashing right for a session cookie applies here with
  -- one addition of its own. A share link is *pasted into an email and a chat*, so
  -- it is archived, indexed and searched by systems nobody administers — which is an
  -- argument for the database not being a second copy, not against it.
  --
  -- Not the primary key, per `id` above; `shares_token` is the unique index, so
  -- lookup is still one indexed probe.
  token_hash    text not null,
  -- The one document this link shows. Informational rather than a foreign key *in
  -- the DDL*, matching every cross-table reference in this schema except
  -- `sessions.user_id`.
  --
  -- **Nothing cleans these up when the document is deleted, and that is the
  -- decision rather than the omission.** A share for a deleted document is already
  -- unreachable: the entry route looks the story up and answers the lapsed page, and
  -- `claimShare` matches on an id `crypto.randomUUID` will never mint twice, so no
  -- future document can inherit the grant. What the row still does is answer "which
  -- links did we send out, for what, and when did they stop working" — the same
  -- reason `api_tokens` revokes rather than deletes, and the same reason
  -- `versions.actor` keeps naming a user who has been removed. Contrast
  -- `schedules.story_id`, which *must* not outlive its story: an instruction to
  -- publish a document that no longer exists is not an instruction, whereas a
  -- receipt for a link that no longer works is still a receipt.
  story_id      text not null,
  -- Who made the link: a `users.id`, `token:<name>`, or null under `auth: 'open'` —
  -- where the whole surface 404s anyway (`requireAuthConfigured`), so in practice a
  -- `users.id`. Not a foreign key for the reason `story_id` gives; a removed editor's
  -- links stay attributable, which is what makes the list a record.
  created_by    text,
  created_at    integer not null,
  -- When the link stops working: epoch **milliseconds, UTC**, like every other
  -- timestamp Folio stores.
  --
  -- **`not null`, unlike `api_tokens.expires_at`.** A token with no expiry is a
  -- legitimate shape — a CI job that runs forever — and a share link with no expiry
  -- is a permanent public URL for unpublished content, which is the single thing this
  -- feature must not become. The default and the ceiling are
  -- `DEFAULT_SHARE_DAYS` / `MAX_SHARE_DAYS` in `server/auth/shares.ts`; the column
  -- only insists that there is one.
  expires_at    integer not null,
  -- Turned off early. Revoked rather than deleted, exactly as `api_tokens` is: the
  -- row keeps the hash so a link that leaked can never be resurrected by chance, and
  -- keeps the name of the document and the date so the list stays a record.
  revoked_at    integer,
  -- The last time the link was actually used to render the document, and how many
  -- times in total. Not diagnostics: "did the client ever open it" is the first
  -- question an editor asks after sending one, and it is answerable nowhere else.
  --
  -- Stamped by `claimShare` in the same D1 batch as the read, so a view costs one
  -- round trip — the discipline `readToken` established for `last_used_at`.
  last_viewed_at integer,
  views         integer not null default 0,
  -- What the editor called it: "for Rachel's Friday review". Optional, and purely
  -- for the list — a link with three outstanding grants needs a way to say which is
  -- which, and "the one made at 14:03" is not it.
  note          text
);

-- The lookup on the hot path: one probe per entry-route hit and one per shared
-- preview render. Unique, because two rows sharing a hash would mean two grants for
-- one secret and the `in (…)` read below would have to pick.
--
-- Declared rather than left to a `unique` column constraint, which SQLite would name
-- `sqlite_autoindex_shares_1` — invisible to `migrations.test.ts`, whose index
-- assertions filter `sqlite_%` out, so the uniqueness of the whole feature's lookup
-- would have been the one property no test could see.
create unique index shares_token on shares (token_hash);

-- Newest first, which is the list's order, paged over `(created_at, id)`.
-- `api_tokens_created` is the precedent and this is the same read: a credential list
-- where the one you just made is the one you are looking for.
create index shares_created on shares (created_at desc);

-- **Deliberately no `shares_story`.** `?story=` is a scan over a table bounded by
-- links somebody typed by hand, which is the identical measurement `schedules_story`
-- refused on and the identical one `assets.filename`/`size` refused on before it.
-- `stories_draft_updated` is the standing example of the other choice: an index
-- created for a query nobody had written, paid for on every write for ten
-- migrations. `test/workers/migrations.test.ts` asserts the absence, so adding one
-- later is a deliberate act with a measurement behind it.
--
-- **And no CHECK on anything.** There is no enum column here to widen, which is the
-- best answer to the lesson `versions.kind` taught: `revoked_at is null and
-- expires_at > now` is the whole state machine, computed in the `where` clause, so
-- the `live`/`lapsed` vocabulary `GET {base}/api/shares?state=` speaks is a
-- projection rather than a stored value that could disagree with the clock.
