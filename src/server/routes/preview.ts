/**
 * Draft preview sharing over HTTP
 * (`../../../docs/specs/platform/draft-sharing.md`).
 *
 * Four routes in two groups, and the split is the same one `access.ts` makes for
 * the same reason: three of them require the strongest gate this feature has, and
 * one of them is reachable with **no credential at all** by definition, because its
 * whole purpose is to be clicked by somebody who has no account. Keeping the
 * unauthenticated route in its own exported app means that fact is a property of
 * where it is mounted rather than something to re-check per handler.
 *
 * ## What the entry route does, and what it deliberately does not
 *
 * `GET {base}/share?t=…` exchanges the token in the URL for a cookie and a 302 to
 * the document's **own** draft URL — `rt.withUrls(story).draftUrl`, which is the
 * host's `route()` function's answer with `?_folio=draft` on it. Nothing here
 * invents a URL, and nothing here renders a document: the redirect target is
 * answered by the same branch of `handle()` and rendered by the same `previewPage`
 * a signed-in editor's iframe reaches. There is no second renderer to drift.
 *
 * **The mode is `draft`, not `preview`, and that changed** (`../../../docs/specs/
 * platform/mcp-server.md` decision 5): the reviewer is reading the page, not
 * editing it, so they get the page — no editing body class, no hydration, no
 * bridge, and every link on it live.
 *
 * The exchange exists to get the secret **out of the URL** — decision 2. A query
 * parameter is what a link can carry; a cookie is what a browser can hold without
 * writing it into a `Referer`, an address bar, a bookmark or an analytics event.
 *
 * ## Why `PUBLISH` on all three management routes
 *
 * Creating a link makes an unpublished document readable by somebody outside the
 * organisation. That is a disclosure decision of exactly the shape publishing is,
 * and it is why the gate matches `POST /story/:id/publish` rather than `EDIT`. The
 * *list* and the *revoke* carry the same gate rather than the weaker `READ` that
 * `GET /schedules` uses, and the difference is what the row is: a schedule is a fact
 * about a document, whereas a share is a live credential against it — so the set who
 * can see which credentials are outstanding should not be wider than the set who can
 * issue them. `ADMIN` loses in the other direction: this is a routine step in a
 * review, and putting it behind the role that manages accounts would make the
 * feature unusable by the people who need it.
 */
import { Hono } from 'hono'
import { NO_STORE } from '../../core/cache-tags'
import { serialiseCookie, shareCookieName, withShareToken } from '../auth/cookie'
import { actorString, PUBLISH } from '../auth/roles'
import {
  createShare,
  DEFAULT_SHARE_DAYS,
  listShares,
  readShareByToken,
  revokeShare,
  shareExpiry,
} from '../auth/shares'
import { FolioError } from '../errors'
import { loadStory, requireAccess, requireAuthConfigured } from '../middleware'
import { expiredLinkPage } from '../pages'
import type { FolioRuntime } from '../runtime'
import { storyById } from '../stories'
import type { FolioEnv } from '../types'
import {
  idParam,
  limitParam,
  parseOptionalBody,
  requireCursor,
  ShareCreateBody,
  shareStateQuery,
} from '../validate'

/** A minted share token, as `mintSecret()` produces it. Screened before it reaches
 * `hashToken` or a D1 bind, the same rule `shareCookieTokens` follows for the
 * cookie's parts. */
const SHARE_TOKEN = /^[0-9a-f]{64}$/

/**
 * The absolute URL an editor sends. On the request's own origin, matching
 * `MagicLinkMail.url`'s rule and for the identical reason: it is going into an
 * email, so a path would be useless.
 */
function shareUrl(rt: FolioRuntime, requestUrl: string, token: string): string {
  const url = new URL(requestUrl)
  url.pathname = `${rt.base}/share`
  url.search = ''
  url.hash = ''
  url.searchParams.set('t', token)
  return url.toString()
}

/* ------------------------------------------------ managing links (JSON) --- */

export function shareRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  /**
   * Mint a link for one document.
   *
   * `loadStory` first, so an unknown id 404s before a credential is written — and
   * because the row is what answers the one refusal below.
   *
   * **An unrouted document is refused.** A `record` or a `singleton` has
   * `path === null` and therefore no public URL (`document-types.md` decision 2), so
   * there is no page to redirect a reviewer to and nothing to share. Rejected
   * alternative: redirecting to `{base}/preview/global/:name`, Folio's own bare
   * preview for a singleton. That route is gated on `READ_DRAFT` and renders inside
   * the admin's own URL space, so honouring a share there would mean a second
   * entry point into a second rendering path — exactly the fork this design is
   * built to avoid. Sharing a record is named in the spec's *Out of scope*.
   */
  app.post(
    '/story/:id/share',
    requireAuthConfigured<Env>(rt),
    requireAccess<Env>(rt, PUBLISH),
    loadStory<Env>(),
    async (c) => {
      const story = c.var.story
      if (story.path === null) {
        throw new FolioError(
          'bad_request',
          `“${story.title}” is not a page, so it has no URL to preview. Only routed documents can be shared.`,
        )
      }
      const body = await parseOptionalBody(c.req, ShareCreateBody)
      const minted = await createShare(c.var.bindings().db, {
        storyId: story.id,
        // The default lives at the route, so the one place a link's terms are
        // chosen is the surface that enforces the bound. `shareExpiry` refuses
        // anything past `MAX_SHARE_DAYS` whatever the schema let through.
        expiresAt: shareExpiry(body.expiresInDays ?? DEFAULT_SHARE_DAYS),
        // Off the session, never the body: see `ShareCreateBody`.
        createdBy: actorString(c.var.actor),
        note: body.note ?? null,
      })
      /**
       * **The only response in this feature that contains the token**, and there is
       * no way to read it back — only its SHA-256 is stored. Same rule and same
       * comment as `POST {base}/api/tokens`.
       */
      return c.json({ url: shareUrl(rt, c.req.url, minted.token), share: minted.row }, 201, {
        'cache-control': NO_STORE,
      })
    },
  )

  /**
   * Which links exist: newest first, paged, filterable by document and by whether
   * they still work.
   *
   * **A link nobody can list is a link nobody can revoke.** The same argument
   * `GET {base}/api/schedules` makes for itself, one notch sharper: a schedule that
   * is forgotten fires once, and a share link that is forgotten stays readable.
   *
   * Rows carry **no token and no hash** (`ShareRow`), and no title or path either —
   * resolving a batch of story ids to rows is `GET {base}/api/stories?ids=`'s job
   * (`pagination.md` decision 7), and a screen drawing a share is drawing a document
   * it can already name.
   */
  app.get('/shares', requireAuthConfigured<Env>(rt), requireAccess<Env>(rt, PUBLISH), async (c) => {
    const cursor = c.req.query('cursor')
    requireCursor(cursor)
    const story = c.req.query('story')
    const state = shareStateQuery(c.req.query('state'))
    // Spread rather than assigned, so an absent filter is an absent key rather than
    // `undefined` — `listShares` reads presence, the discipline `listSchedules` follows.
    const page = await listShares(c.var.bindings().db, {
      limit: limitParam(c.req.query('limit'), 50, 200),
      cursor,
      ...(story ? { storyId: idParam('story', story) } : {}),
      ...(state ? { state } : {}),
      count: c.req.query('count') === '1',
    })
    // Named `shares` rather than `rows`, the same way `/users` and `/tokens` name
    // their own collection: a screen reads it by name.
    return c.json({ shares: page.rows, cursor: page.cursor, total: page.total })
  })

  /**
   * Turn a link off now.
   *
   * Revoked, not deleted: the row stays in the list so "which link was that, and
   * when did we stop it" is answerable, and the hash can never be minted again by
   * chance. A 404 for an id that does not exist *or* was already revoked, matching
   * `DELETE {base}/api/tokens/:id` exactly — the second revoke changed nothing, and
   * reporting success would say otherwise.
   */
  app.delete(
    '/shares/:id',
    requireAuthConfigured<Env>(rt),
    requireAccess<Env>(rt, PUBLISH),
    async (c) => {
      const id = idParam('id', c.req.param('id'))
      if (!(await revokeShare(c.var.bindings().db, id))) {
        throw new FolioError('not_found', 'Unknown or already-revoked preview link')
      }
      return c.json({ revoked: true })
    },
  )

  return app
}

/* --------------------------------------------- using a link (HTML, open) --- */

/**
 * The one route in the server that answers a stranger holding a credential.
 *
 * Mounted on the bare path rather than under `{base}/api`
 * (`pagination.md` decision 3): it is a URL a person is navigated to from an email,
 * not JSON the admin fetches. It must precede `shellRoutes`' wildcard in `app.ts`,
 * which would otherwise catch it and redirect to the login page — the exact wrong
 * answer for somebody who has no account.
 */
export function sharePageRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  /**
   * Exchange a token for a cookie and a 302 to the document's own preview URL.
   *
   * `requireAuthConfigured` and no actor gate at all. The first is what makes the
   * whole surface **404 under `auth: 'open'`**, following `/users` and `/tokens`:
   * on a deployment with no accounts anyone can already append `?_folio=preview` to
   * any URL, so a sharing mechanism there would be ceremony around a door that is
   * open. The second is the point of the feature.
   *
   * Four different failures answer the identical page, and that is deliberate — see
   * `expiredLinkPage`. A malformed token, an unknown one, an expired one and a
   * revoked one are indistinguishable to the person reading, whose next action is the
   * same in all four cases.
   *
   * The fifth failure is the interesting one: a link for a document that has since
   * been **deleted**. Nothing prunes `shares` on a story delete
   * (`migrations/0004_shares.sql` says why), so this is where such a link lands, and
   * the lapsed page is the honest answer — the id `crypto.randomUUID` minted can
   * never be re-issued, so no future document inherits the grant.
   */
  app.get('/share', requireAuthConfigured<Env>(rt), async (c) => {
    const token = c.req.query('t')
    // No token at all is not a link anybody was given, so it is not a link anybody
    // needs an explanation about: the plain 404 an unknown path gets.
    if (!token) return c.notFound()
    if (!SHARE_TOKEN.test(token)) return expiredLinkPage()

    const bindings = c.var.bindings()
    const grant = await readShareByToken(bindings.db, token)
    if (!grant) return expiredLinkPage()

    const story = await storyById(bindings.db, grant.storyId)
    if (!story || story.path === null) return expiredLinkPage()

    /**
     * The host's own `route()`, with the draft flag on it. Never assembled here:
     * only the host knows its URL shape, and both this and the admin's iframe come
     * out of `runtime.ts`'s `previewUrlFor`.
     *
     * **`draftUrl`, not `previewUrl`, and that is a fix to shipped behaviour**
     * (`../../../docs/specs/platform/mcp-server.md` decision 5). A reviewer landing
     * on the `preview` mode got the *editor's* view of the page: a dashed blue
     * rectangle following their cursor, and `preventDefault()` on every click
     * inside a marked block, so no link on the page navigated. Nobody decided that
     * — it is what having one draft render cost. The admin's own iframe keeps
     * `previewUrl`, because for it the chrome is the feature.
     */
    /**
     * **Where `draftMode` changes what a reviewer sees**
     * (`../../../docs/specs/platform/draft-mode.md` decision 4). With it the host
     * has promised its own `fetch` calls `draftAt`, so the reviewer is sent to the
     * page's *real* URL and gets the draft inside the host's layout. Without it
     * they get `draftUrl`, which Folio answers itself — the document's content on
     * the host's block CSS, with globals stacked above it rather than placed.
     *
     * The cookie is identical either way, and so is the grant: this decides a
     * destination, not an authority.
     */
    const urls = rt.withUrls(story)
    const target = rt.draftMode ? urls.url : urls.draftUrl
    if (!target) return expiredLinkPage()

    /**
     * `Max-Age` is the link's remaining life, so the cookie dies with the grant
     * rather than going on presenting a dead credential forever. The server checks
     * the row on every render regardless — the expiry is enforced in SQL, not by the
     * browser — so this is hygiene, not the control.
     *
     * `SameSite=Lax`, matching the session cookie: the reviewer arrives here by
     * top-level navigation from a mail client, and `Strict` would withhold the
     * cookie the next time they opened the preview URL straight from that email,
     * silently showing them the published page instead.
     *
     * The value is a *list* — see `MAX_SHARE_COOKIE_TOKENS` — so clicking a second
     * link does not unseat the first.
     */
    const value = withShareToken(c.req.header('cookie'), token)
    const maxAge = Math.max(1, Math.floor((grant.expiresAt - Date.now()) / 1000))
    c.header(
      'set-cookie',
      serialiseCookie(c.req.url, shareCookieName(c.req.url), value, { maxAge, sameSite: 'Lax' }),
    )
    // A 302 carrying a `Set-Cookie` must never be stored, and the URL it is answered
    // at carries a secret. Both reasons point the same way.
    c.header('cache-control', NO_STORE)
    return c.redirect(target, 302)
  })

  return app
}
