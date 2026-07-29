/**
 * Paths a request should be redirected away from — see migrations/0004_redirects.sql
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
 *   just because they happened to share a `to_path`. The two checks a caller
 *   (the POST route) must run first — a live story occupying `from`, a target
 *   that already redirects back to `from` — are what keep a manual add from
 *   creating a trap, not a rewrite of rows nobody asked to touch.
 */
import { isSafeHref } from '../core/values'

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
 */
function normaliseTarget(input: string): string {
  const trimmed = input.trim()
  if (SCHEME.test(trimmed)) return trimmed.split('?')[0] ?? trimmed
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
export function redirectStatements(db: D1Database, input: RedirectWrite): D1PreparedStatement[] {
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
export function clearRedirectAtStatement(db: D1Database, path: string): D1PreparedStatement {
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
  db: D1Database,
  path: string,
): Promise<{ to: string; status: number } | null> {
  const from = normalisePath(path)
  const row = await db
    .prepare('select to_path as "to", status from redirects where from_path = ?')
    .bind(from)
    .first<{ to: string; status: number }>()
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
  /** Opaque cursor from a previous page's `RedirectPage.cursor`. */
  cursor?: string
}

export interface RedirectPage {
  rows: Redirect[]
  /** Pass as `cursor` to fetch the next page; null once this is the last one. */
  cursor: string | null
}

/** `created_at`+`from_path` packed into one opaque string, so a page boundary
 * that lands on two rows sharing a millisecond still resumes exactly. */
function encodeCursor(createdAt: number, from: string): string {
  return `${createdAt}_${from}`
}

function decodeCursor(raw: string): { createdAt: number; from: string } | null {
  const i = raw.indexOf('_')
  if (i < 0) return null
  const createdAt = Number(raw.slice(0, i))
  if (!Number.isFinite(createdAt)) return null
  return { createdAt, from: raw.slice(i + 1) }
}

/** Newest first, paginated. `source` filters to only the automatic or only the
 * manual rows; omitted, both. */
export async function listRedirects(
  db: D1Database,
  opts: ListRedirectsOptions = {},
): Promise<RedirectPage> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200))
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null

  const clauses: string[] = []
  const params: unknown[] = []
  if (opts.source) {
    clauses.push('source = ?')
    params.push(opts.source)
  }
  if (cursor) {
    clauses.push('(created_at < ? or (created_at = ? and from_path < ?))')
    params.push(cursor.createdAt, cursor.createdAt, cursor.from)
  }
  const where = clauses.length ? `where ${clauses.join(' and ')}` : ''

  const { results } = await db
    .prepare(
      `select ${COLS} from redirects ${where} order by created_at desc, from_path desc limit ?`,
    )
    .bind(...params, limit + 1)
    .all<Redirect>()

  const hasMore = results.length > limit
  const rows = hasMore ? results.slice(0, limit) : results
  const last = rows.at(-1)
  return { rows, cursor: hasMore && last ? encodeCursor(last.createdAt, last.from) : null }
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
export async function upsertRedirect(
  db: D1Database,
  input: UpsertRedirectInput,
): Promise<Redirect> {
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
export async function deleteRedirect(db: D1Database, from: string): Promise<boolean> {
  const result = await db
    .prepare('delete from redirects where from_path = ?')
    .bind(normalisePath(from))
    .run()
  return (result.meta.changes ?? 0) > 0
}
