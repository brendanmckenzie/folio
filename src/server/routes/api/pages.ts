/**
 * `GET {base}/~<site>/api/v1/pages/{path}` — a page, as `reader.page()` answers it,
 * over HTTP (`../../../../docs/specs/foundation/multi-site.md` decision 16).
 *
 * **Why this exists.** A headless front end could rebuild a page from
 * `GET /documents/by-path/…` and the rest of `/api/v1`, and would then hold a second
 * implementation of the fallback walk, fork shadowing, layered globals and the
 * visitor gate: fallback, shadowing and layering are Folio's rules, and a second
 * implementation would drift. This is the first implementation, unchanged, reached
 * from another process.
 *
 * ```
 * { story, document, resolution, draft, access }
 * folio-cache-tags: story:sty_…,site:alpha,path:alpha:about,…
 * ```
 *
 * The tags are `page.headers['cache-tag']`, the very string a host's own page route
 * would put in `Cache-Tag`, so the front end tags the entry it caches under them and
 * is told what to purge by the hook payloads' `purge` (decision 16). **Absent for a
 * draft and for a page the visitor gate did not call public**, which `page()` already
 * answers `no-store`: a draft or a members-only page has no purge path because it
 * must not be cached at all.
 *
 * **It applies the status gate** (`servedSite`): the caller names the surface it is
 * serving, and a site that surface would not serve is a `404` unless the caller may
 * read the site's drafts. `?status=draft` is the draft of the page the walk would
 * *edit* (`pickEditing`), and needs that same authority.
 *
 * Mounted only on a deployment with `sites`. A single-site host calls the reader in
 * its own Worker, and its `/api/v1` surface is what it always was.
 */
import type { Context } from 'hono'
import { Hono } from 'hono'
import { READ } from '../../auth/roles'
import { FolioError } from '../../errors'
import { requestSite, requireAccess } from '../../middleware'
import type { FolioRuntime } from '../../runtime'
import type { FolioEnv, GatedReaderFactory } from '../../types'
import { localeQuery, storyPathParam } from '../../validate'
import { servedSite } from './served'

export function pageRoutes<Env>(
  rt: FolioRuntime,
  readerFor: GatedReaderFactory<Env> | undefined,
): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()
  if (!rt.sites) return app

  const handler = async (c: Context<FolioEnv<Env>>) => {
    // Only a `createApp` built without `createFolio` (a test walking the mounted routes)
    // has no reader to hand; the route is mounted all the same, so such a walk sees it.
    if (!readerFor) throw new FolioError('unsupported', 'This app was built without a reader')
    // Site first: a group, `shared` or a site the surface would not serve is not a page
    // anybody reads here, and says so before it says anything about the path.
    const served = await servedSite(c, rt)
    if (!served) throw new FolioError('not_found', 'Pages are read on a site')

    const wantDraft = c.req.query('status') === 'draft'
    if (wantDraft && !served.drafts) {
      throw new FolioError(
        'forbidden',
        'Reading a draft needs content:read:draft on this site, or a preview grant for it.',
      )
    }

    const raw = c.req.query('locale')
    const locale = raw === undefined ? undefined : localeQuery(raw)
    if (locale !== undefined && !rt.locales?.available.some((l) => l.code === locale)) {
      throw new FolioError('unsupported', `Unknown locale: ${locale}`)
    }

    const path = storyPathParam(c.req.param('path'))
    const reader = readerFor(c.env, {
      gated: served.site,
      // A draft is a preview render whatever surface the caller said it serves.
      surface: wantDraft ? 'preview' : served.surface,
      request: c.req.raw,
      draft: wantDraft,
    })
    const page = await reader.page(path, locale === undefined ? undefined : { locale })
    if (!page) throw new FolioError('not_found', 'No page at that path')

    const site = await requestSite(c, rt)
    const tags = page.headers['cache-tag']
    return c.json(
      {
        story: rt.urlsFor(site)(page.story),
        document: page.doc,
        resolution: page.resolution,
        draft: page.draft,
        access: page.access,
      },
      200,
      {
        // This response is an API answer on the admin origin and is never cached; the
        // entry the front end caches is its own, under these tags.
        'cache-control': 'no-store',
        ...(tags ? { 'folio-cache-tags': tags } : {}),
      },
    )
  }
  app.get('/pages', requireAccess<Env>(rt, READ), handler)
  app.get('/pages/:path{.*}', requireAccess<Env>(rt, READ), handler)

  return app
}
