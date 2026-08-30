/**
 * `{base}/draft/enter` and `{base}/draft/exit` — the switch an editor flips to
 * browse the real site from its drafts (`../../../docs/specs/platform/draft-mode.md`
 * decision 2).
 *
 * The cookie these set is a **flag, not a credential**: it says an editor wants
 * draft mode applied, and grants nothing on its own. The authority is the session
 * cookie and its role, re-checked by `folio.draftAt` on every single render. So a
 * browser that keeps this cookie after its session dies simply stops seeing
 * drafts, with no stale grant to expire and nothing to revoke.
 *
 * Both are `GET`s that redirect, because both are reached by a person clicking a
 * link — from the admin, or from a banner on the site — rather than by script.
 */
import { Hono } from 'hono'
import { clearDraftCookies, draftCookieName, serialiseCookie } from '../auth/cookie'
import { READ_DRAFT } from '../auth/roles'
import { requireHtmlAccess } from '../middleware'
import type { FolioRuntime } from '../runtime'
import type { FolioEnv } from '../types'
import { safeNext } from '../validate'

/**
 * A week. Long enough that an editor checking a site over a few days is not
 * signed out of draft mode between sessions, short enough that a forgotten cookie
 * on a shared machine stops mattering by itself.
 *
 * It is hygiene rather than the control either way: the role is what grants the
 * draft and it is checked per render, so an expired flag costs a click and a
 * revoked role costs everything.
 */
const DRAFT_COOKIE_DAYS = 7

export function draftRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  /**
   * `requireHtmlAccess`, not `requireAccess`: this is a browser navigation, so an
   * editor whose session has lapsed should arrive at the login page and come back
   * here — not read a JSON 401 in their address bar. Under `auth: 'open'` it
   * passes through, matching `handle()`'s preview branch, which grants the same
   * site the same thing for the same reason.
   */
  app.get('/draft/enter', requireHtmlAccess<Env>(rt, READ_DRAFT), (c) => {
    const url = new URL(c.req.url)
    // `next` is attacker-controllable — it is in a link anyone can write — and
    // this route sets a cookie, so an open redirect here would be one behind an
    // authenticated action. The same screen the login route uses, for the same
    // reason; `//evil.example` is the case a naive `startsWith('/')` misses.
    const next = safeNext(c.req.query('next'), '/')
    return new Response(null, {
      status: 302,
      headers: {
        location: next,
        'set-cookie': serialiseCookie(url, draftCookieName(url), '1', {
          maxAge: DRAFT_COOKIE_DAYS * 24 * 60 * 60,
        }),
      },
    })
  })

  /**
   * **Deliberately ungated.** A reviewer whose grant has expired, or an editor
   * whose session has, must still be able to get out of draft mode — gating the
   * exit on the credential that got you in means the only way out of a broken
   * state is clearing cookies by hand. Clearing a flag that grants nothing is
   * safe for anyone to do, including someone with no session at all.
   */
  app.get('/draft/exit', (c) => {
    const url = new URL(c.req.url)
    const next = safeNext(c.req.query('next'), '/')
    // Both names, always — a browser that moved between localhost and a deployed
    // worker may hold the plain one, and a half-cleared flag is a draft mode that
    // will not switch off.
    const headers = new Headers()
    for (const cookie of clearDraftCookies(url)) headers.append('set-cookie', cookie)
    headers.set('location', next)
    return new Response(null, { status: 302, headers })
  })

  return app
}
