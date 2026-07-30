/**
 * The rebuilt admin's HTML, at every path its router owns.
 *
 * # Why it is mounted at `{base}/ui` and not at `{base}`
 *
 * `docs/ui-architecture.md` gives the screens the bare paths — `{base}/content`,
 * `{base}/assets`, `{base}/documents/:type`, `{base}/redirects`. **Four of those
 * are JSON routes today**, and one of them (`GET {base}/content`) is the content
 * index query the published site itself uses. A screen cannot take a path a
 * fetch is already answering on, and the collision is total rather than
 * incidental: the screens and the API are named after the same resources, because
 * they are about the same resources.
 *
 * So the shell is mounted under a prefix while the prototype is being judged, and
 * the fix is a decision for the URL-and-shell spec rather than something to
 * improvise here. The shape it should take, recorded so the reasoning is not
 * re-derived:
 *
 * **The admin's internal JSON moves; the screens keep the pretty paths.** The
 * screens are what a person sees, links and bookmarks, so they win. `app.ts`
 * already says the internal routes are "free to change with" the admin, which is
 * exactly the licence needed — and every one of the admin's own fetches goes
 * through `boot.apiBase`, so most of the client follows by changing one string.
 * The cost is real but mechanical: ~265 literal paths across `test/` and
 * `scripts/`, which is why it is a sequenced piece of work and not a drive-by.
 *
 * Rejected: **content negotiation on one path** — HTML for `Accept: text/html`,
 * JSON otherwise. Cheap, and the kind of cleverness that fails silently the first
 * time something sends the wrong header. Rejected: **the screens under a prefix
 * permanently**; `/folio/admin/content` spends a segment on the fact that the CMS
 * is a CMS.
 *
 * Until then the prefix costs nothing but a segment, because the router is
 * relative to its mount by necessity — `basePath` is host-configurable — so
 * moving it is one constant in `route.ts` and one in this file.
 */
import { Hono } from 'hono'
import { READ_DRAFT } from '../auth/roles'
import { requireHtmlAccess } from '../middleware'
import { shellPage } from '../pages'
import type { FolioRuntime } from '../runtime'
import type { FolioEnv } from '../types'

/** The one segment. Exported so a test and the client's own boot value cannot
 * drift from it. */
export const SHELL_PREFIX = 'ui'

export function shellRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()
  const mount = `${rt.base}/${SHELL_PREFIX}`

  /**
   * Gated exactly like the editor page (`READ_DRAFT`), and for the same reason:
   * every screen behind here shows unpublished content, and an HTML route owes a
   * sign-in redirect rather than a JSON envelope.
   *
   * A wildcard, deliberately: an unknown path answers the shell, which renders
   * its own "not found" screen with the nav still around it. A 404 from the
   * server would be correct and useless — the person mistyped a URL inside an
   * application they are signed in to, and the recovery is one click away in a
   * sidebar the server cannot draw.
   */
  app.get(`/${SHELL_PREFIX}`, requireHtmlAccess<Env>(rt, READ_DRAFT), () => shellPage(rt, mount))
  app.get(`/${SHELL_PREFIX}/*`, requireHtmlAccess<Env>(rt, READ_DRAFT), () => shellPage(rt, mount))

  return app
}
