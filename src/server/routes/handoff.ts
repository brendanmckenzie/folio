/**
 * The preview handoff (`../../../docs/specs/foundation/multi-site.md` decision
 * 13): how a person signed in on `sites.admin` comes to see drafts on a site's own
 * preview origin, which shares no cookie with the admin and, for fifty registrable
 * domains, never could.
 *
 * Three hops, in the order the spec's trace fixes, and each is tested on its own
 * (`test/workers/handoff.test.ts`):
 *
 * 1. **`GET {base}/~<site>/site/start?next=`, on the admin origin.** The one
 *    `reach: 'preview'` route (`middleware.ts`' `PREVIEW_REACH`): `withActor` lets a
 *    caller with no role on the site through, and this route checks preview
 *    eligibility itself — `READ_DRAFT` on any scope of the chain — so a shared-only
 *    or group-only editor is not refused at the start of a preview. Screens `next`,
 *    mints a sixty-second code on the caller's session, 302s to the preview origin.
 * 2. **`GET {base}/site/enter?code=&next=`, on the preview origin.** Consumes the
 *    code in one statement, sets the partitioned grant cookie, and 302s to itself
 *    with `check=1` — never straight to `next`, because a browser that refused the
 *    cookie would then render the published page as though it were the draft.
 * 3. **`GET {base}/site/enter?check=1&next=`.** The cookie came back: 302 to `next`.
 *    It did not: the page that says so, and in an iframe tells the admin.
 *
 * `next` is screened by `safeNext` on **every** hop, not only the first: the second
 * and third hops are URLs anybody can write, on an origin that is about to hold a
 * credential, so an open redirect there is one behind an authenticated act.
 *
 * Mounts nothing on a deployment with no `sites`: there is no preview origin to
 * hand anything to, and the single-site preview keeps the session it always used.
 */
import { Hono } from 'hono'
import { NO_STORE } from '../../core/cache-tags'
import { ALL_SCOPES, chain } from '../../core/sites'
import { readGrantCookie, serialiseGrantCookie } from '../auth/cookie'
import { consumeGrantCode, mintGrantCode } from '../auth/grants'
import { previewEligible } from '../auth/roles'
import { FolioError } from '../errors'
import { requireAuthConfigured } from '../middleware'
import { expiredLinkPage, grantBlockedPage } from '../pages'
import type { FolioRuntime } from '../runtime'
import type { FolioEnv } from '../types'
import { safeNext } from '../validate'

/** Where a `next` that fails `safeNext` lands: the preview origin's own root. */
const FALLBACK = '/'

/**
 * Headers every hop answers with. `no-store` because each carries or sets a
 * credential; **`Referrer-Policy: no-referrer`** because `site/enter`'s URL holds the
 * code, and neither a redirect nor the page it lands on may repeat it to anybody.
 */
function hopHeaders(location?: string): Headers {
  const headers = new Headers({ 'cache-control': NO_STORE, 'referrer-policy': 'no-referrer' })
  if (location) headers.set('location', location)
  return headers
}

/** A response of Folio's own with the hop headers added, whatever built it. */
async function withHopHeaders(res: Promise<Response>): Promise<Response> {
  const out = await res
  out.headers.set('referrer-policy', 'no-referrer')
  return out
}

export function handoffRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()
  const sites = rt.sites
  if (!sites) return app

  /**
   * Step 1, on the admin origin (decision 13). `handle()` stripped `~<site>` into
   * the scope header and answered this from the admin origin, so `c.var.site` is
   * null here; on a site's own host it is not, and this is not a route there.
   */
  app.get('/site/start', async (c) => {
    if (c.var.site !== null) throw new FolioError('not_found', 'No such route')
    const scope = c.var.scope
    if (scope === null) {
      throw new FolioError('bad_request', `Name the site: ${rt.base}/~<site>/site/start`)
    }
    const registry = await sites.registry(c.env)
    const site = registry.sites.find((s) => s.id === scope)
    // A group or `shared` has no pages of its own to serve and no preview origin:
    // a shared page is previewed *on* a site (`/me`'s `previewable`).
    if (!site) throw new FolioError('not_found', `'${scope}' is not a site`)
    const next = safeNext(c.req.query('next'), FALLBACK)
    // After the eligibility check below, so a caller who may not preview the site
    // learns nothing about how it is set up.
    const previewOrigin = (): string => {
      if (site.preview) return site.preview
      throw new FolioError(
        'conflict',
        `${site.name} has no preview origin yet, so its drafts cannot be shown anywhere. A platform admin sets one on the Sites screen.`,
      )
    }

    // `auth: 'open'`: every preview origin shows drafts to anyone (the spec's edge
    // cases), and there is no session to hang a grant on.
    if (rt.auth.mode !== 'session') {
      return new Response(null, { status: 302, headers: hopHeaders(`${previewOrigin()}${next}`) })
    }

    const actor = c.var.actor
    if (!actor) {
      // A browser navigation, so a sign-in page rather than a JSON 401, and back
      // here afterwards — with the scope segment `handle()` took off the path.
      const back = `${rt.base}/~${scope}/site/start?next=${encodeURIComponent(next)}`
      return c.redirect(`${rt.base}/login?next=${encodeURIComponent(back)}`)
    }
    if (actor.kind !== 'user') {
      throw new FolioError('forbidden', 'Previewing a site needs a signed-in browser.')
    }
    // The route's own check, because `withActor` deliberately made none (decision
    // 10's `reach: 'preview'`). Worded without the site's id in quotes: this is not
    // the scope 403 every other route answers, and the partition walk tells them
    // apart by exactly that.
    if (!previewEligible(actor.grants ?? { [ALL_SCOPES]: actor.role }, chain(registry, site.id))) {
      throw new FolioError(
        'forbidden',
        `Previewing ${site.name} needs a role on it, its group, or shared content.`,
      )
    }

    const origin = previewOrigin()
    const minted = await mintGrantCode(c.var.bindings().db, { sessionId: actor.session }, site.id)
    const target = new URL(`${origin}${rt.base}/site/enter`)
    target.searchParams.set('code', minted.code)
    target.searchParams.set('next', next)
    return new Response(null, { status: 302, headers: hopHeaders(target.toString()) })
  })

  /**
   * Steps 2 and 3, on the preview origin. The status gate admits this path in
   * every status (decision 4's table): the code is its credential, and without it
   * nobody could ever preview a site that is not yet public.
   */
  // `requireAuthConfigured`: with `auth: 'open'` there are no grants to redeem, and
  // every preview origin already shows drafts.
  app.get('/site/enter', requireAuthConfigured<Env>(rt), async (c) => {
    const here = c.var.site
    if (here?.surface !== 'preview') throw new FolioError('not_found', 'No such route')
    const next = safeNext(c.req.query('next'), FALLBACK)

    if (c.req.query('check') === '1') {
      // Presence, not validity: this asks whether the browser kept the cookie, and
      // what the grant is worth is `readGrant`'s, on the page itself.
      if (readGrantCookie(c.req.header('cookie'))) {
        return new Response(null, { status: 302, headers: hopHeaders(next) })
      }
      return withHopHeaders(grantBlockedPage(sites.admin))
    }

    const code = c.req.query('code')
    if (!code) return c.notFound()
    const grant = await consumeGrantCode(c.var.bindings().db, code, here.id)
    // Spent, expired, unknown, or another site's: the lapsed page, the same one a
    // dead share link gets, and the same reasoning — the reader's next move is to
    // go back to the editor, whichever it was.
    if (!grant) return withHopHeaders(expiredLinkPage())

    const url = new URL(c.req.url)
    const self = new URL(`${url.origin}${rt.base}/site/enter`)
    self.searchParams.set('check', '1')
    self.searchParams.set('next', next)
    const headers = hopHeaders(self.toString())
    headers.set(
      'set-cookie',
      serialiseGrantCookie(url, grant.token, (grant.expiresAt - Date.now()) / 1000),
    )
    return new Response(null, { status: 302, headers })
  })

  return app
}
