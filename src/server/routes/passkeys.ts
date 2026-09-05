/**
 * Enrolling, naming and removing a passkey; the browsers a person is signed in
 * on; and the one admin action that takes somebody's credentials away.
 *
 * `../../../docs/specs/foundation/passkeys.md`. Everything here is a *signed-in*
 * surface, which is what separates it from the two routes in `auth.ts`: a
 * passkey is enrolled by somebody who already got in through another door, and
 * the first sign-in is never a passkey.
 *
 * **Three gates, and they are not the same gate.** `/me/passkeys*` needs auth
 * configured, the passkey provider listed, and a *user* actor — a token has no
 * passkeys, and the enrolment ceremony is a browser gesture no script can make.
 * `/me/sessions*` needs only auth configured and a user actor: the list of
 * browsers you are signed in on is useful on a deployment that has never heard
 * of passkeys, and hiding it behind the provider would make an account screen
 * that is empty for most hosts. `DELETE /users/:id/passkeys` needs `admin` and
 * deliberately *not* `requirePasskeys`, so a host that takes the provider back
 * out can still clear the rows it left behind.
 *
 * The challenge cookie and its codec are `auth/cookie.ts`'s; the verification is
 * `auth/webauthn.ts`'s; the SQL is `auth/passkeys.ts`'s. What is left here is
 * what a route is for: reading the request, choosing the gate, and turning an
 * answer into a `Response`.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import {
  challengeBytes,
  clearWebauthnCookies,
  decodeChallenge,
  encodeChallenge,
  readWebauthnCookie,
  serialiseCookie,
  WEBAUTHN_COOKIE_TTL_S,
  webauthnCookieName,
} from '../auth/cookie'
import { recordEventStatement } from '../auth/events'
import { base64url } from '../auth/jwt'
import {
  createPasskey,
  deletePasskey,
  deleteUserPasskeys,
  listPasskeys,
  MAX_PASSKEYS_PER_USER,
  type PasskeyRow,
  renamePasskey,
} from '../auth/passkeys'
import { ADMIN, type UserActor } from '../auth/roles'
import { mintSecret } from '../auth/secrets'
import { listUserSessions, revokeOtherSessions } from '../auth/session'
import { domainOf, type SessionAuth } from '../auth/sign-in'
import { userById } from '../auth/users'
import { creationOptions, verifyRegistration } from '../auth/webauthn'
import { envelope, FolioError } from '../errors'
import { requireAccess, requireAuthConfigured, requirePasskeys } from '../middleware'
import type { FolioRuntime } from '../runtime'
import type { FolioEnv } from '../types'
import { idParam, parseBody, PasskeyPatchBody, PasskeyRegisterBody } from '../validate'

/**
 * The one message every refusal of `POST {base}/login/passkey` carries, and the
 * only string that route ever puts in an error body.
 *
 * Exported because the route lives in `auth.ts` — where "reachable without a
 * credential" is a property of the whole file — and a second copy of this
 * literal is a second thing to keep byte-identical. The discipline is
 * `POST /login/email`'s `SENT`: an attacker holding a credential id must not be
 * able to tell "no such credential" from "wrong signature" from "that account is
 * behind SSO", because each of those is a fact about somebody's account.
 */
export const PASSKEY_REFUSED = 'That passkey was not accepted.'

/** The refusal body, built through `envelope` so its shape and key order cannot
 * drift from every other error this server answers with. */
export function passkeyRefusalBody(): ReturnType<typeof envelope> {
  return envelope(new FolioError('unauthorized', PASSKEY_REFUSED))
}

/**
 * The relying-party id: **the request host, never configuration**
 * (decision 5). So `localhost` under `wrangler dev`, a `workers.dev` preview and
 * the production domain each bind passkeys to themselves, with no key to
 * misconfigure and no way to enrol a credential that silently does not work.
 */
export function rpIdOf(url: URL): string {
  return url.hostname
}

/**
 * A fresh challenge, the value the browser will echo in `clientDataJSON`, and
 * the cookie that carries it between the two requests.
 *
 * Minted with `mintSecret()` — the same 32 bytes of entropy behind every other
 * credential here — rather than a bespoke random, so there is one answer to
 * "how much entropy is that" in this codebase.
 */
export function mintChallenge(
  url: URL,
  ceremony: 'create' | 'get',
  userId?: string,
): { challenge: Uint8Array<ArrayBuffer>; expected: string; cookie: string } {
  const hex = mintSecret()
  const bytes = challengeBytes(hex)
  const payload =
    userId === undefined ? { c: hex, k: ceremony } : { c: hex, k: ceremony, u: userId }
  return {
    challenge: bytes,
    // What `clientDataJSON.challenge` has to equal: the browser base64urls the
    // bytes it was handed, so the comparison is a string one and the encoding
    // rule lives in exactly one place.
    expected: base64url(bytes),
    cookie: serialiseCookie(url, webauthnCookieName(url), encodeChallenge(payload), {
      maxAge: WEBAUTHN_COOKIE_TTL_S,
    }),
  }
}

/**
 * Why this person may not enrol a passkey, or null.
 *
 * Only one reason exists today and it is spec 28's: an **enforced domain** is
 * exactly one door, so a passkey for an address at that domain would be a second
 * one — and the point of enforcement is that the client's directory controls
 * revocation. `completeSignIn` would refuse the assertion anyway; this is what
 * lets the account screen say so *before* somebody enrols a credential that
 * could never be used.
 *
 * Exported for `GET {base}/api/me`, which answers the same sentence in its
 * `passkeys` block so the screen and the route cannot disagree about the reason.
 */
export function passkeyEnrolmentRefusal(auth: SessionAuth, email: string): string | null {
  const domain = domainOf(email)
  const enforced = auth.domains.get(domain)
  if (enforced === undefined || enforced === 'passkey') return null
  return `Signing in for ${domain} goes through ${enforced}, so a passkey cannot be a second door.`
}

/** A `PasskeyRow` as every route answers it. Named field by field rather than
 * spread, the rule `authPolicy()` states: `public_key` and `counter` are not on
 * `PasskeyRow` at all, and `userId` is not the client's business. */
function toJson(row: PasskeyRow) {
  return {
    id: row.id,
    name: row.name,
    alg: row.alg,
    transports: row.transports,
    aaguid: row.aaguid,
    backedUp: row.backedUp,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  }
}

/**
 * How many characters of the session hash a person is shown.
 *
 * Twelve: enough to tell two rows apart in a list that is never longer than a
 * handful, and short enough that what ships is an identifier rather than the
 * whole stored value. The hash is not a credential — it cannot be presented as
 * the cookie — but the smallest thing that does the job is the one that cannot
 * become a problem later.
 */
const SESSION_ID_CHARS = 12

export function passkeyRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  /** The session arm, for the domain map and the provider. Every route below is
   * behind `requireAuthConfigured`, so this branch is unreachable. */
  const sessionAuth = (): SessionAuth => {
    if (rt.auth.mode !== 'session') throw new FolioError('not_found', 'Auth is not configured')
    return rt.auth
  }

  /**
   * The actor, refused for a token.
   *
   * **403, not 404**, and it is the one place in this file that is not a "there
   * is no such thing here": the credential is perfectly good, it is simply the
   * wrong *kind* of credential, and retrying with it can never help. A script
   * cannot hold a passkey — enrolment is a gesture at a device — and it has no
   * browser sessions to list either.
   */
  const person = (c: Context<FolioEnv<Env>>, noun: string): UserActor => {
    const actor = c.var.actor
    if (!actor) throw new FolioError('unauthorized', 'Sign in to continue.')
    if (actor.kind !== 'user') throw new FolioError('forbidden', `A token has no ${noun}.`)
    return actor
  }

  /**
   * A response that also clears the challenge cookie, under both names.
   *
   * Every answer the enrolment verify route can give goes through this,
   * including its refusals: the challenge is single-use whether or not it
   * verified, and a cookie left behind after a failure is a value a second
   * attempt could replay.
   */
  const cleared = (url: URL, body: unknown, status: ContentfulStatusCode): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: [
        ['content-type', 'application/json'],
        ...clearWebauthnCookies(url).map((value) => ['set-cookie', value] as [string, string]),
      ],
    })

  // Auth configured, the provider listed, and a person rather than a token. The
  // order matters for the same reason `access.ts` states: "there is no such
  // thing here" comes before "you may not".
  app.use('/me/passkeys', requireAuthConfigured<Env>(rt), requirePasskeys<Env>(rt))
  app.use('/me/passkeys/*', requireAuthConfigured<Env>(rt), requirePasskeys<Env>(rt))
  // Sessions are **not** behind `requirePasskeys`: knowing which browsers you are
  // signed in on is worth having on a deployment with no passkeys at all, and the
  // account screen would otherwise be blank for most hosts.
  app.use('/me/sessions', requireAuthConfigured<Env>(rt))
  app.use('/me/sessions/*', requireAuthConfigured<Env>(rt))

  /* --------------------------------------------------------- enrolment --- */

  /**
   * The creation options, and the `k: 'create'` challenge cookie bound to whoever
   * asked for it.
   *
   * **`u` is the binding, and it is not bookkeeping.** Without it a challenge
   * minted while one person was signed in could be presented by a second browser
   * to hang a credential off *that* account; the verify route below refuses when
   * `u` is not who is signed in now.
   *
   * The two refusals here answer **before** a cookie is set, which is the point
   * of both: an enforced domain means this person can never enrol, and the cap
   * means they cannot enrol another — in each case a challenge would be a value
   * the browser carries around for ten minutes for nothing.
   */
  app.post('/me/passkeys/options', async (c) => {
    const auth = sessionAuth()
    const actor = person(c, 'passkeys')
    const db = c.var.bindings().db
    const user = await userById(db, actor.id)
    // The session resolved a moment ago, so the row is there; a removal between
    // the two is the 401 the *next* request gets, not a 500 for this one.
    if (!user) throw new FolioError('unauthorized', 'Sign in to continue.')

    const refusal = passkeyEnrolmentRefusal(auth, user.email)
    if (refusal) throw new FolioError('forbidden', refusal)

    const existing = await listPasskeys(db, user.id)
    if (existing.length >= MAX_PASSKEYS_PER_USER) {
      throw new FolioError(
        'conflict',
        `That account already has ${MAX_PASSKEYS_PER_USER} passkeys. Remove one before adding another.`,
      )
    }

    const url = new URL(c.req.url)
    const minted = mintChallenge(url, 'create', user.id)
    const options = creationOptions({
      rpId: rpIdOf(url),
      // The host, unless the deployment named itself. This is the string the
      // browser puts in its own prompt, and it is the only configurable thing in
      // either ceremony.
      rpName: auth.passkey?.rpName ?? rpIdOf(url),
      challenge: minted.challenge,
      user: { id: user.id, name: user.email, displayName: user.name },
      // The browser refuses to re-enrol an authenticator already in this list and
      // shows its own message, so a duplicate is usually caught before the server
      // sees it. `createPasskey`'s 409 is what covers the browsers that do not.
      exclude: existing.map((p) => ({ id: p.id, transports: p.transports })),
    })
    return new Response(JSON.stringify({ publicKey: options }), {
      status: 200,
      headers: [
        ['content-type', 'application/json'],
        ['set-cookie', minted.cookie],
      ],
    })
  })

  /**
   * The credential, verified and stored.
   *
   * **One generic 400 for every verification failure**, and unlike the login
   * route that is a convenience rather than a security property: this caller is
   * signed in and already knows whose account it is. It is generic because the
   * distinctions — wrong challenge, foreign origin, unsupported algorithm — are
   * things a browser got wrong, not things a person can act on.
   *
   * The `409` is the exception, because it *is* actionable: that credential is
   * already enrolled, here or on somebody else's account.
   */
  app.post('/me/passkeys', async (c) => {
    const url = new URL(c.req.url)
    try {
      const actor = person(c, 'passkeys')
      const db = c.var.bindings().db

      const challenge = decodeChallenge(readWebauthnCookie(c.req.header('cookie')))
      // `k` and `u` together: a `get` challenge is the login ceremony's and a
      // challenge minted for somebody else is the attack `u` exists to stop.
      if (challenge?.k !== 'create' || challenge.u !== actor.id) {
        throw new FolioError('bad_request', 'That passkey could not be added. Try again.')
      }

      const body = await parseBody(c.req, PasskeyRegisterBody)
      let registered: Awaited<ReturnType<typeof verifyRegistration>>
      try {
        registered = await verifyRegistration({
          credential: body.credential,
          expected: {
            challenge: base64url(challengeBytes(challenge.c)),
            origin: url.origin,
            rpId: rpIdOf(url),
          },
        })
      } catch {
        throw new FolioError('bad_request', 'That passkey could not be added. Try again.')
      }

      // `Passkey · <host>` by default, so a row enrolled on a preview says so —
      // which is the only hint anybody gets when a credential made on one host
      // silently does not work on another (decision 5's own edge case).
      const name = body.name?.trim() || `Passkey · ${rpIdOf(url)}`
      const row = await createPasskey(db, actor.id, registered, name)
      if (!row) {
        throw new FolioError('conflict', 'That passkey is already enrolled.')
      }
      return cleared(url, { passkey: toJson(row) }, 201)
    } catch (err) {
      // Cleared on the way out too: see `cleared`.
      if (err instanceof FolioError) return cleared(url, envelope(err), err.status)
      throw err
    }
  })

  app.get('/me/passkeys', async (c) => {
    const actor = person(c, 'passkeys')
    const rows = await listPasskeys(c.var.bindings().db, actor.id)
    return c.json({ passkeys: rows.map(toJson) })
  })

  /** Renaming is the only edit. `user_id` is in the `where`, so another
   * person's id is a 404 rather than a 403: an id that is not yours must be
   * indistinguishable from one that does not exist. */
  app.patch('/me/passkeys/:id', async (c) => {
    const actor = person(c, 'passkeys')
    const id = idParam('id', c.req.param('id'))
    const body = await parseBody(c.req, PasskeyPatchBody)
    const row = await renamePasskey(c.var.bindings().db, actor.id, id, body.name)
    if (!row) throw new FolioError('not_found', 'Unknown passkey')
    return c.json({ passkey: toJson(row) })
  })

  app.delete('/me/passkeys/:id', async (c) => {
    const actor = person(c, 'passkeys')
    const id = idParam('id', c.req.param('id'))
    const db = c.var.bindings().db
    if (!(await deletePasskey(db, actor.id, id))) {
      throw new FolioError('not_found', 'Unknown passkey')
    }
    await db.batch([
      recordEventStatement(db, {
        kind: 'passkey_removed',
        userId: actor.id,
        actor: actor.id,
        provider: 'passkey',
        detail: { passkey: id },
      }),
    ])
    return c.json({ deleted: true })
  })

  /* ---------------------------------------------------------- sessions --- */

  /**
   * Every browser this person is signed in on.
   *
   * `current` is decided by comparing the *whole* stored hash to the actor's own
   * `session`, and only then is the id truncated for the wire: a screen that
   * badged "this browser" off a 12-character prefix would be one collision away
   * from signing you out of the wrong one.
   *
   * There is no "last active" column, and its absence is deliberate:
   * `users.last_seen_at` is per person, not per session, so the honest per-browser
   * answer is "signed in at" and "expires".
   */
  app.get('/me/sessions', async (c) => {
    const actor = person(c, 'sessions')
    const rows = await listUserSessions(c.var.bindings().db, actor.id)
    return c.json({
      sessions: rows.map((row) => ({
        id: row.id.slice(0, SESSION_ID_CHARS),
        current: row.id === actor.session,
        provider: row.provider,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        userAgent: row.userAgent,
      })),
    })
  })

  /**
   * Signs out everything except the browser asking.
   *
   * Not `revokeUserSessions`: a person clicking this in the admin must not be
   * signed out by their own click, which is the difference between "a device I
   * lent is not still me" and "I have locked myself out".
   */
  app.delete('/me/sessions/others', async (c) => {
    const actor = person(c, 'sessions')
    const db = c.var.bindings().db
    const revoked = await revokeOtherSessions(db, actor.id, actor.session)
    // Only when something happened. A no-op is not an event, which is the rule
    // `completeSignIn` states for the two rows of its interaction table that
    // write nothing.
    if (revoked > 0) {
      await db.batch([
        recordEventStatement(db, {
          kind: 'sessions_revoked',
          userId: actor.id,
          actor: actor.id,
          detail: { revoked },
        }),
      ])
    }
    return c.json({ revoked })
  })

  /* ------------------------------------------------------- the admin's --- */

  /**
   * Remove **all** of somebody's passkeys: checkpoint 4's one action, for the
   * one incident it exists for — a lost or stolen device.
   *
   * There is deliberately no per-passkey admin management and no "require
   * passkeys" policy: magic link or SSO stays the way back in, which is the
   * whole reason this is safe to do without asking the person first.
   *
   * Not behind `requirePasskeys`, so a host that has since taken the provider
   * out can still clear what it left behind.
   */
  app.delete(
    '/users/:id/passkeys',
    requireAuthConfigured<Env>(rt),
    requireAccess<Env>(rt, ADMIN),
    async (c) => {
      const id = idParam('id', c.req.param('id'))
      const db = c.var.bindings().db
      const target = await userById(db, id)
      if (!target) throw new FolioError('not_found', 'Unknown user')
      const removed = await deleteUserPasskeys(db, id)
      const self = c.var.actor
      await db.batch([
        recordEventStatement(db, {
          kind: 'passkeys_removed',
          userId: id,
          // The admin, not the subject: this is the one passkey event somebody
          // else caused, and "who did this to my account" is the question the
          // table exists to answer.
          actor: self?.kind === 'user' ? self.id : self ? `token:${self.name}` : null,
          provider: 'passkey',
          detail: { removed },
        }),
      ])
      return c.json({ removed })
    },
  )

  return app
}
