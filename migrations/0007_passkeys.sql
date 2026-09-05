-- Passkeys: a WebAuthn credential per row, enrolled by a signed-in person.
--
-- `docs/specs/foundation/passkeys.md` is the spec. The groundwork is spec 28's
-- (`0006_auth.sql`): `completeSignIn` is the one path from a verified identity to a
-- session, and `sessions.provider` is what lets a session say it was minted by a
-- passkey. This table is the credential store that path did not have.
--
-- **Nothing secret is stored.** `public_key` is the authenticator's *public* key; a
-- leaked database lets nobody sign in, which is the property every other credential
-- table here has by hashing and this one has by construction. It is also why spec
-- 10's "a password store is a liability" does not apply: there is no password.
--
-- **`user_id` cascades in the DDL and is deleted explicitly anyway.** `deleteUser`
-- (`server/auth/users.ts`) batches `delete from sessions` beside the user's own
-- delete rather than resting on the cascade pragma, and this table joins that batch
-- for the same reason: whether D1 enforces foreign keys is a property of the
-- database, not the schema.

create table passkeys (
  -- The credential id exactly as the authenticator returned it, base64url. The
  -- primary key because an assertion names it and nothing else: lookup on sign-in
  -- is one probe by this value. Not a hash — it is not a secret, the browser sends
  -- it in the clear on every assertion.
  id            text primary key,
  user_id       text not null references users(id) on delete cascade,
  -- COSE_Key bytes, base64url. Text rather than blob so every column in this schema
  -- stays text or integer and a D1 blob's shape across drivers is nobody's problem;
  -- decoded once per sign-in, which is the only time it is read.
  public_key    text not null,
  -- COSE algorithm: -7 is ES256, -257 is RS256. The two `pubKeyCredParams` the
  -- options ask for, and the two the verifier imports. Stored so the verifier does
  -- not re-derive it from the key on every sign-in.
  alg           integer not null,
  -- The authenticator's signature counter, last seen. Synced passkeys (iCloud
  -- Keychain, Google Password Manager) report 0 forever, so 0 → 0 is not a
  -- regression; anything else going backwards is refused and logged.
  counter       integer not null default 0,
  -- JSON array from `getTransports()` — 'internal', 'hybrid', 'usb' … — or null
  -- when the browser did not say. Handed back as `allowCredentials[].transports` so
  -- a browser can skip prompting for a USB key that was never one.
  transports    text,
  -- 32 hex characters identifying the authenticator model, or null for `fmt: none`
  -- where the authenticator zeroed it. Labels the vendor on the account screen
  -- ("iCloud Keychain", "Windows Hello"); never a security input.
  aaguid        text,
  -- What the person called it: "Work laptop". Bounded at 60 by the route; defaults
  -- to "Passkey · <host>" so a row enrolled on a preview host says so.
  name          text not null,
  -- The BS flag from the last authenticator data: 1 when the credential is synced
  -- to a cloud keychain. Shown as a badge; explains why `counter` is 0.
  backed_up     integer not null default 0,
  created_at    integer not null,
  last_used_at  integer
);

-- The account screen's list, and the `excludeCredentials` read at enrolment: every
-- passkey for one user, oldest first. `MAX_PASSKEYS_PER_USER` bounds the set, so
-- the index is a convenience rather than a rescue.
create index passkeys_user on passkeys (user_id, created_at);

-- **Deliberately no index on `last_used_at`, `aaguid` or `created_at` alone.** No
-- route orders by any of them across users; `test/workers/migrations.test.ts`
-- asserts the index list is exactly the one above, so adding one is a decision with
-- a measurement behind it, as `shares_story`'s absence is.
--
-- **And no CHECK on `alg`.** A third algorithm (Ed25519 is in the WebAuthn
-- registry) is a new `pubKeyCredParams` entry and a new `coseToJwk` branch, and
-- SQLite cannot widen a CHECK without a table rebuild — the lesson `versions.kind`
-- taught and `content_refs.kind` learned.
