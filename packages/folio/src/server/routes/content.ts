/**
 * Querying published content over HTTP, and rebuilding the index that makes it
 * possible (`../../../../docs/specs/content-model/collections.md`).
 *
 * `GET /folio/content` is a `ContentQuery` spelled as query parameters, because
 * that is what a link, a `fetch` from the admin and a `curl` all have in common.
 * The shape of the answer is `ContentPage`, unwrapped — the same JSON
 * `folio.query(env, q)` returns, so a host reading one and a client reading the
 * other are reading the same thing.
 */
import { Hono } from 'hono'
import type { ContentQuery, ContentWhere, TextOp } from '../../core/query'
import { isRangeOp, isTextOp, MAX_PER_PAGE, WHERE_OPS } from '../../core/query'
import { ADMIN, READ } from '../auth/roles'
import { FolioError } from '../errors'
import { requireAccess } from '../middleware'
import { reindex } from '../reindex'
import type { FolioRuntime } from '../runtime'
import type { FolioEnv } from '../types'
import { parseOptionalBody, ReindexBody, typeNameQuery } from '../validate'

/** How many `where=` clauses one request may carry. Each is an index seek; a
 * hundred of them is not a query anybody meant to write. */
const MAX_WHERE = 8

/**
 * `field:op:value`, the one spelling of a filter.
 *
 * Split on the first two colons only, so a value may contain them — which an ISO
 * timestamp does (`published:gte:2026-01-01T09:00:00Z`). An `in` takes a
 * comma-separated list, which is why a comma is not available as a separator here.
 */
function parseWhere(raw: string): ContentWhere {
  const first = raw.indexOf(':')
  const second = raw.indexOf(':', first + 1)
  if (first <= 0 || second <= first) {
    throw new FolioError('bad_request', `where must be 'field:op:value', not '${clip(raw)}'`)
  }
  const field = raw.slice(0, first)
  const op = raw.slice(first + 1, second)
  const value = raw.slice(second + 1)
  if (!WHERE_OPS.includes(op)) {
    throw new FolioError('bad_request', `where op must be one of ${WHERE_OPS.join(', ')}`)
  }
  if (isRangeOp(op)) {
    // A bound that is a plain number compares `num_value`; anything else (an ISO
    // date, a string) compares `text_value`. Deciding it here rather than in SQL
    // keeps `contentSql` free of parsing.
    const numeric = Number(value)
    return { field, op, value: value !== '' && Number.isFinite(numeric) ? numeric : value }
  }
  if (op === 'in') return { field, op, value: value.split(',').filter(Boolean) }
  return { field, op: op as TextOp, value }
}

const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 60)}…` : s)

/** `published:desc`, or a bare built-in like `publishedAt`. */
function parseOrder(raw: string): ContentQuery['order'] {
  const [field, dir] = raw.split(':')
  if (!field) throw new FolioError('bad_request', "order must be 'field' or 'field:asc|desc'")
  if (dir === undefined) return field as 'publishedAt' | 'ord' | 'title'
  if (dir !== 'asc' && dir !== 'desc') {
    throw new FolioError('bad_request', "order direction must be 'asc' or 'desc'")
  }
  return { field, dir }
}

const positive = (raw: string | undefined, label: string): number | undefined => {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) {
    throw new FolioError('bad_request', `${label} must be a positive whole number`)
  }
  return Math.trunc(n)
}

/**
 * A `ContentQuery` off the query string.
 *
 * Field names are *not* checked here — `contentSql` refuses one the schema does
 * not declare `indexed`, naming it, and that check has to be next to the set it
 * checks against. This function's job is shape and bounds.
 */
export function queryFromParams(params: URLSearchParams): ContentQuery {
  const where = params.getAll('where').map(parseWhere)
  if (where.length > MAX_WHERE) {
    throw new FolioError('bad_request', `at most ${MAX_WHERE} where clauses`)
  }
  for (const w of where) {
    if (isTextOp(w.op) && Array.isArray(w.value) && w.value.length > MAX_PER_PAGE) {
      throw new FolioError('bad_request', `an 'in' filter takes at most ${MAX_PER_PAGE} values`)
    }
  }

  const type = params.getAll('type').flatMap((raw) => raw.split(',').filter(Boolean))
  const order = params.get('order')
  // `parent` present-and-empty means the top level (`parent_id is null`), which
  // is a real filter and cannot be spelled by omitting the parameter — omitting
  // it means "anywhere".
  const parent = params.get('parent')
  const locale = params.get('locale')

  return {
    ...(type.length > 0 ? { type: type.map(typeNameQuery) } : {}),
    ...(parent !== null ? { parent: parent === '' ? null : parent } : {}),
    ...(locale ? { locale } : {}),
    ...(where.length > 0 ? { where } : {}),
    ...(order ? { order: parseOrder(order) } : {}),
    ...(positive(params.get('page') ?? undefined, 'page') !== undefined
      ? { page: positive(params.get('page') ?? undefined, 'page') }
      : {}),
    ...(positive(params.get('perPage') ?? undefined, 'perPage') !== undefined
      ? { perPage: positive(params.get('perPage') ?? undefined, 'perPage') }
      : {}),
    status: 'published',
  }
}

export function contentRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>()

  /**
   * `READ`, and `../platform/content-api.md` — which owns this route's auth —
   * **decided to leave it there**. Three reasons, in the order they mattered:
   *
   *   1. This route is *internal*. It is what the admin's collection input fetches,
   *      and it is free to change shape whenever the editor needs it to. The
   *      public, documented, versioned equivalent is `GET /folio/api/v1/documents`
   *      (content-api.md decision 2), which is the same `queryFromParams` over the
   *      same `rt.query`. Declaring this one public as well would freeze it as a
   *      second contract nobody asked for.
   *   2. `content:read` is the weakest scope a token can hold, so "let a script read
   *      published content" is one token away — and that is the door, rather than an
   *      unauthenticated one.
   *   3. `content_index` holds every indexed field value across the whole site, so
   *      an open query route is a bulk-extraction primitive whatever the rows say
   *      about themselves. Opening it later costs nothing; un-leaking does not.
   *
   * A published **page** is unaffected either way, and always was: its collections
   * resolve server-side inside `resolve()`, with no HTTP in the loop. A host that
   * wants an open read surface writes one, the way the demo's `/archive` route
   * already does over `folio.query`.
   */
  app.get('/content', requireAccess<Env>(rt, READ), async (c) => {
    const url = new URL(c.req.url)
    const q = queryFromParams(url.searchParams)
    return c.json(await rt.query(c.var.bindings(), q))
  })

  /**
   * Rebuild both tables from `published_doc`.
   *
   * The one case publish-time writing cannot cover: a schema change that marks an
   * existing field `indexed`. Nothing republishes, so nothing would ever write the
   * new rows. Batched and resumable for the same reason `POST /folio/migrate` is —
   * it walks every published document inside a request that has a CPU limit.
   *
   * `ADMIN`: it rewrites a derived table across the whole site.
   */
  app.post('/reindex', requireAccess<Env>(rt, ADMIN), async (c) => {
    const body = await parseOptionalBody(c.req, ReindexBody)
    return c.json(
      await reindex(
        {
          db: c.var.bindings().db,
          schema: rt.schema,
          typeOf: rt.typeOf,
          locales: rt.locales,
        },
        body,
      ),
    )
  })

  return app
}
