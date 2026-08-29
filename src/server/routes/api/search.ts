/**
 * `GET /folio/api/v1/search` — a twin of the admin's `GET /folio/api/search`
 * (`../stories.ts:304`), answering the v1 projection (`ApiDocumentMeta`)
 * instead of the admin's `StoryMeta`.
 *
 * **Why this exists at all** (`../../../../docs/specs/platform/mcp-server.md`
 * decision 4): `queryFromParams` (`../content.ts:116`) ends `status: 'published'`,
 * hardcoded — shared verbatim by `GET /documents` and the admin's `/api/content`
 * — so no other v1 read can enumerate a document that has never been published.
 * `searchStories` reads straight off `stories`, with no publication gate, which
 * is what makes "find the page about X" answerable on a site mid-build.
 *
 * **Keyset-paged, not page-numbered — a deliberate departure from
 * `foundation/pagination.md` decision 1's letter, not its reason.** That
 * decision keeps `/api/v1` on page numbers because a listing over *published*
 * content does not move between requests the way a draft tree does. This route
 * lists the live draft tree instead, where offset paging silently skips and
 * repeats rows exactly the way decision 1 invented keyset paging to avoid on
 * the admin's own live lists. So this route follows the *reason*, not the
 * *letter*, and answers `Page<T>` (`../../../core/pagination.ts:24`), not
 * `ContentPage` — the two are already different types on purpose.
 */
import { Hono } from 'hono'
import type { Page } from '../../../core/pagination'
import type { StoryMeta } from '../../../core/story'
import { READ } from '../../auth/roles'
import { requireAccess } from '../../middleware'
import type { FolioRuntime } from '../../runtime'
import { searchStories } from '../../stories'
import type { FolioEnv } from '../../types'
import {
  limitParam,
  parentIdQuery,
  requireCursor,
  routedQuery,
  storyFilterQuery,
} from '../../validate'
import { type ApiDocumentMeta, toApiDocumentMeta } from './documents'

export function searchRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  /**
   * `parentId` and `routed` are read here rather than by extending
   * `storyFilterQuery`, which deliberately excludes both (`../../validate.ts`,
   * `storyFilterQuery`'s own doc comment) because it is shared with the admin's
   * screens, where each list route states its own scope positionally instead.
   * This route has no positional scope to lean on — it is one search over
   * everything — so the two keys are parsed by hand and layered onto
   * `storyFilterQuery`'s output, exactly as the admin's own `/api/search`
   * layers `types` on top of it for `?kind=` (`../stories.ts:304`).
   *
   * No `?kind=`/`?sort=` here: neither is in this route's documented query
   * surface, and `searchStories`' own default ordering (title, ascending) is
   * what a caller with no opinion about order wants.
   */
  app.get('/search', requireAccess<Env>(rt, READ), async (c) => {
    const cursor = c.req.query('cursor')
    requireCursor(cursor)

    const page: Page<StoryMeta> = await searchStories(c.var.bindings().db, {
      limit: limitParam(c.req.query('limit'), 20, 100),
      cursor,
      filter: {
        ...storyFilterQuery(c.req),
        parentId: parentIdQuery(c.req.query('parentId')),
        routed: routedQuery(c.req.query('routed')),
      },
      count: c.req.query('count') === '1',
    })

    const result: Page<ApiDocumentMeta> = {
      ...page,
      rows: page.rows.map((row) => toApiDocumentMeta(rt, row)),
    }
    return c.json(result)
  })

  return app
}
