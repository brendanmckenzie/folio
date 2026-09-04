/**
 * Paths a request should be redirected away from — see migrations/0001_init.sql
 * and docs/specs/platform/redirects.md.
 *
 * Two distinct write paths land here, and they stay distinct on purpose:
 *
 * - `redirectStatements` is the three-statement collapse (decision 1 of the spec)
 *   that `updateStory` and `deleteStoryStatement` batch alongside the write that
 *   vacates a path. It exists because a page just started answering somewhere
 *   else, and every row that pointed at where it used to be has to be rewritten
 *   or removed *in the same transaction*, or a crash between the two could leave
 *   a renamed page with no redirect.
 * - `upsertRedirect` is a single `insert or replace` for a redirect an editor adds
 *   by hand. There is no path being vacated here, so the three-statement collapse
 *   does not apply — running it would silently rewrite or delete unrelated rows
 *   just because they happened to share a `to_path`. The three checks a caller
 *   (the POST route) must run first — `from` equal to `to`, a live story
 *   occupying `from`, a target that already redirects back to `from` — are what
 *   keep a manual add from creating a trap, not a rewrite of rows nobody asked
 *   to touch. Note that `redirectStatements` needs only the first of the three,
 *   and gets it for free in its own guard below: the other two cannot arise from
 *   a path that a write has just this moment vacated.
 */
import { clampLimit, decodeCursor, type Page, paginate } from '../core/pagination'
import { isSafeHref } from '../core/values'
import type { FolioDb } from './db'

export interface Redirect {
  from: string
  to: string
  status: 301 | 302 | 307 | 308
  source: 'auto' | 'manual'
  storyId: string | null
  createdAt: number
}

const COLS = `from_path as "from", to_path as "to", status, source, story_id as storyId, created_at as createdAt`

/** A colon that starts a scheme, the same test `isSafeHref` parses off a stored URL. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Is this an absolute URL rather than a path on this site?
 *
 * The one predicate for the question, asked by `normaliseTarget` below and by the
 * admin's Redirects screen — which needs it twice: to render an off-site target
 * whole instead of rooting it at `/`, and to refuse a `from` written as a full URL
 * before the round trip. Deriving it from `normaliseTarget`'s output instead was
 * the first attempt and it is wrong in the ordinary case: a lowercase URL with no
 * trailing slash survives `normalisePath` unchanged, so the two agree and the test
 * says "path".
 */
export function isAbsoluteTarget(input: string): boolean {
  return SCHEME.test(input.trim())
}

/**
 * The same rule `stories.path` follows (server/index.tsx), applied identically
 * to a write and a lookup so trailing-slash and case variants of a path hit the
 * same row: no leading or trailing slash, lowercased, query string stripped.
 * `''` is the root, exactly like `stories.path`.
 */
export function normalisePath(input: string): string {
  const withoutQuery = input.split('?')[0] ?? ''
  return withoutQuery.toLowerCase().replace(/^\/+|\/+$/g, '')
}

/**
 * `to_path` alone can be an absolute URL (a manual redirect off-site), which must
 * not be forced through `normalisePath`'s lowercasing and slash-stripping — a
 * domain and an external path are not `stories.path` and case can matter there.
 * Only the query string is stripped, matching decision 3: the host reattaches
 * `url.search` itself.
 *
 * Exported because the POST route has to compare a typed `to` against a typed
 * `from` to refuse a self-redirect, and comparing the *raw* strings is not the
 * same test: `/Offers/` and `offers` are one row here and two strings anywhere
 * else. A second copy of this rule in the route would be a second answer to
 * "are these the same target".
 */
export function normaliseTarget(input: string): string {
  const trimmed = input.trim()
  if (isAbsoluteTarget(trimmed)) return trimmed.split('?')[0] ?? trimmed
  return normalisePath(trimmed)
}

export interface RedirectWrite {
  /** The path just vacated, already in `stories.path` form. */
  from: string
  /** Where it now resolves to. */
  to: string
  storyId: string | null
  status?: 301 | 302 | 307 | 308
  source?: 'auto' | 'manual'
}

/**
 * The three statements of decision 1, unrun: a caller batches them alongside the
 * write that vacated `from`. **Order matters** — statement 1 must run before
 * statement 2, which is the whole of the loop safety (see the spec's worked
 * example under "Renaming back cannot produce a self-redirect or a loop").
 *
 * Returns no statements when there is nothing to record: `from` and `to` the
 * same path (a title-only edit; the root, which never moves) needs no redirect.
 */
export function redirectStatements(db: FolioDb, input: RedirectWrite): D1PreparedStatement[] {
  const from = normalisePath(input.from)
  const to = normaliseTarget(input.to)
  if (!from || from === to) return []

  const status = input.status ?? 301
  const source = input.source ?? 'auto'
  const createdAt = Date.now()

  return [
    // 1. The page lives at `to` now: any redirect *away* from it is wrong.
    db.prepare('delete from redirects where from_path = ?').bind(to),
    // 2. Collapse every existing chain that pointed at the path just vacated.
    db.prepare('update redirects set to_path = ? where to_path = ?').bind(to, from),
    // 3. The redirect for the path just vacated. `or replace` because the same
    //    path can be vacated more than once over a site's life.
    db
      .prepare(
        `insert or replace into redirects (from_path, to_path, status, source, story_id, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .bind(from, to, status, source, input.storyId, createdAt),
  ]
}

/**
 * Clears any redirect that vacates `path`, unrun: `createStory` batches this
 * alongside its insert so a path a redirect currently claims is reachable again
 * the moment a story is created there (edge case: "a path vacated and
 * reoccupied by a different story").
 */
export function clearRedirectAtStatement(db: FolioDb, path: string): D1PreparedStatement {
  return db.prepare('delete from redirects where from_path = ?').bind(normalisePath(path))
}

/**
 * A redirect for `path`, or null. One indexed read on the primary key.
 *
 * `isSafeHref` is re-checked here, not only on write, so a row written by an
 * older build or a hand-run script cannot put `javascript:` in a `Location`
 * header — the row is refused and logged rather than handed to the host.
 */
export async function lookupRedirect(
  db: FolioDb,
  path: string,
): Promise<{ to: string; status: number } | null> {
  const from = normalisePath(path)
  return redirectOf(from, await redirectAtStatement(db, path).first<RedirectRow>())
}

/** What a redirect lookup selects, before `redirectOf` has screened it. */
export type RedirectRow = { to: string; status: number }

/**
 * The lookup half of `lookupRedirect`, as a statement rather than an answer, so
 * a caller that is already asking the database something else can send both
 * together. `pathMiss` in stories.ts is the one that does.
 */
export function redirectAtStatement(db: FolioDb, path: string): D1PreparedStatement {
  return db
    .prepare('select to_path as "to", status from redirects where from_path = ?')
    .bind(normalisePath(path))
}

/**
 * The screen `lookupRedirect` puts a row through, split out so a batched caller
 * gets the identical refusal rather than a second copy of the rule — which is
 * the rule that keeps a stored `javascript:` target out of a `Location` header.
 */
export function redirectOf(from: string, row: RedirectRow | null | undefined): RedirectRow | null {
  if (!row) return null
  if (!isSafeHref(row.to)) {
    console.error(`folio: redirect ${from} -> ${row.to} refused an unsafe target`)
    return null
  }
  return row
}

export interface ListRedirectsOptions {
  limit?: number
  source?: 'auto' | 'manual'
  /**
   * Substring match over **both** paths, because both are questions a person
   * asks of this table: "what happens to /old-services" is a `from` search and
   * "what still points at /offers" is a `to` search, and a redirect is the one
   * kind of row where the second matters as much as the first. Nothing on the
   * screen distinguishes which side matched, and it does not need to — both
   * columns are on the row.
   */
  q?: string
  /**
   * Adds `total` for the same filter — one extra `count(*)`, only when asked
   * (`../../docs/specs/foundation/pagination.md` decision 5). The Redirects
   * screen's header asks, because `Showing n of N` is the paging control
   * (`ui-architecture.md` Resolved 5); a caller walking the cursor should not.
   */
  count?: boolean
  /** Opaque cursor from a previous page's `RedirectPage.cursor`. */
  cursor?: string
}

/**
 * `Page<Redirect>` by another name, kept as an alias because this route's shape is
 * already public through `folio.redirects()`.
 */
export type RedirectPage = Page<Redirect>

/**
 * Newest first, paginated. `source` filters to only the automatic or only the
 * manual rows; omitted, both.
 *
 * **The first caller of `core/pagination.ts`.** This route hand-rolled the whole
 * pattern — a `${createdAt}_${from}` cursor split on the first underscore, the
 * `limit + 1` over-fetch, and the last-page condition — and was the precedent every
 * other route is now being built to follow
 * (`../../docs/specs/foundation/pagination.md` decision 6). Moving it onto the
 * shared codec is what makes that precedent real rather than aspirational, and it
 * is the reason `listRedirects`'s tests still pass unchanged: the behaviour is
 * identical, the cursor string is not.
 *
 * The cursor's components are `(created_at, from_path)`, in the same order as the
 * `order by` below, which is the correspondence `paginate` cannot check for a
 * caller.
 *
 * **One ordering, and there is no `sort` parameter.** Newest first is the only
 * thing this table is ever read in: the cursor is `(created_at, from_path)` and a
 * second ordering means a second keyset with its own tie-breaking, for a column
 * (`from`, alphabetically) that the screen's search box already answers better —
 * you look for a path, you do not scroll to it.
 */
export async function listRedirects(
  db: FolioDb,
  opts: ListRedirectsOptions = {},
): Promise<RedirectPage> {
  const limit = clampLimit(opts.limit, 50, 200)
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null
  // A malformed cursor is refused by the route (a 400), so reaching here with one
  // means the caller is a method rather than a request. Treating it as "no cursor"
  // is the right answer for that path: `folio.redirects()` passing nonsense is a
  // programming error, and a first page is a better failure than an exception in a
  // host's own handler.

  // `narrow` is the filter and `narrow` alone is what the count counts: a
  // `count(*)` that also carried the cursor clause would answer "how many rows are
  // left" rather than "how many match", and the header reads `n of N` where N is
  // the whole filter. The same split `listStoryLevel` makes, for the same reason.
  const narrow: string[] = []
  const narrowBinds: unknown[] = []
  if (opts.source) {
    narrow.push('source = ?')
    narrowBinds.push(opts.source)
  }
  if (opts.q) {
    // The same unescaped `like` `storyFilters` uses, deliberately: `%` and `_` in
    // a search term are the user's wildcards rather than an injection (the term is
    // a bound parameter), and making them literal here alone would leave the two
    // search boxes in the admin behaving differently.
    const like = `%${opts.q}%`
    narrow.push('(from_path like ? or to_path like ?)')
    narrowBinds.push(like, like)
  }

  const clauses = [...narrow]
  const params = [...narrowBinds]
  if (cursor) {
    const [createdAt, from] = cursor
    clauses.push('(created_at < ? or (created_at = ? and from_path < ?))')
    params.push(createdAt, createdAt, from)
  }
  const whereOf = (parts: readonly string[]) => (parts.length ? `where ${parts.join(' and ')}` : '')

  const [rows, total] = await Promise.all([
    db
      .prepare(
        `select ${COLS} from redirects ${whereOf(clauses)}
         order by created_at desc, from_path desc limit ?`,
      )
      .bind(...params, limit + 1)
      .all<Redirect>(),
    opts.count
      ? db
          .prepare(`select count(*) as n from redirects ${whereOf(narrow)}`)
          .bind(...narrowBinds)
          .first<{ n: number }>()
      : null,
  ])

  const page = paginate(rows.results, limit, (row) => [row.createdAt, row.from])
  return total ? { ...page, total: total.n } : page
}

export interface UpsertRedirectInput {
  from: string
  to: string
  status?: 301 | 302 | 307 | 308
}

/**
 * A manual redirect (decision 4's `source = 'manual'`): a single `insert or
 * replace`, not the three-statement collapse — see the module comment for why.
 */
export async function upsertRedirect(db: FolioDb, input: UpsertRedirectInput): Promise<Redirect> {
  const from = normalisePath(input.from)
  const to = normaliseTarget(input.to)
  const status = input.status ?? 301
  const createdAt = Date.now()

  await db
    .prepare(
      `insert or replace into redirects (from_path, to_path, status, source, story_id, created_at)
       values (?, ?, ?, 'manual', null, ?)`,
    )
    .bind(from, to, status, createdAt)
    .run()

  return { from, to, status, source: 'manual', storyId: null, createdAt }
}

/** True when a row for `from` was actually removed. */
export async function deleteRedirect(db: FolioDb, from: string): Promise<boolean> {
  const result = await db
    .prepare('delete from redirects where from_path = ?')
    .bind(normalisePath(from))
    .run()
  return (result.meta.changes ?? 0) > 0
}
