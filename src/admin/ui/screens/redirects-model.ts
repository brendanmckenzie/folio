/**
 * The Redirects screen's arithmetic: how a path reads, what a `source` means, what
 * the server will refuse before you ask it, and how the screen's state gets into
 * and out of a URL.
 *
 * Pure functions over plain data, for the admin's testing convention — no admin
 * test mounts a component (`vitest.config.ts` runs the unit project under
 * `environment: 'node'`), so a screen's *logic* has to live somewhere a Node test
 * can reach it. `content-model.ts` and `documents-model.ts` are the pattern.
 *
 * **It imports the path rules from the server** — `normalisePath`,
 * `normaliseTarget` and `isAbsoluteTarget` — rather than restating them, which is
 * the one import here worth defending. Every client-side refusal below is a claim
 * about what the server is going to do, and all three are ordinary string functions
 * with no binding of their own (`server/redirects.ts`). A second copy in the admin
 * would be a second answer to "are these the same path", and the failure mode is a
 * dialog that accepts what the route then refuses — or worse, refuses what it would
 * have accepted. `admin/Access.tsx` already imports `server/auth/roles` for the
 * same reason.
 */
import { isSafeHref } from '../../../core/values'
import {
  isAbsoluteTarget,
  normalisePath,
  normaliseTarget,
  type Redirect,
} from '../../../server/redirects'
import { when } from './content-rows'

/* -------------------------------------------------------------------- rows --- */

export type RedirectSource = Redirect['source']
export type RedirectStatus = Redirect['status']

/** The row `GET {base}/api/redirects` answers with, unchanged. There is no
 * projection to keep in step here: the reader already returns exactly the five
 * columns the table shows plus the `storyId` it does not. */
export type RedirectRow = Redirect

/**
 * A path as it is shown: rooted, so `services/strategy` reads as
 * `/services/strategy` and the stored form's missing leading slash is not
 * something a person has to know about. `''` is the root.
 *
 * The same `pathLabel` `MoveDialog.tsx` carries, and the reason both exist is
 * `design-system.md`'s third commitment: a path is content set in mono, not debug
 * output to be abbreviated.
 */
export function pathLabel(path: string): string {
  return path === '' ? '/' : `/${path}`
}

/**
 * Does this target leave the site?
 *
 * The server's own predicate, under the name this screen thinks in. Two copies of
 * a scheme pattern already exist (`core/values.ts`, `server/redirects.ts`) and a
 * third in the admin is how a screen ends up rooting an off-site URL at `/`. The
 * first version of this function tried to *derive* the answer, by asking whether
 * `normaliseTarget` and `normalisePath` disagreed — which is wrong for the ordinary
 * case, since a lowercase URL with no trailing slash survives both unchanged.
 */
export const isExternal = isAbsoluteTarget

/**
 * A target as it is shown. An absolute URL stays whole — the domain is the whole
 * point of it, and `/https://example.com/x` would be a lie about where the browser
 * lands.
 */
export function targetLabel(to: string): string {
  return isExternal(to) ? to : pathLabel(to)
}

/* ------------------------------------------------------------------ source --- */

/**
 * What `source` is *for*, which is more than a label.
 *
 * `redirects.md` decision 4 puts automatic and manual rows in one table because
 * the lookup and the safety check are identical for both. They are not identical
 * to a person deciding whether a row is safe to delete, and that is the only
 * decision this screen exists to support:
 *
 * - **Automatic** rows were written by a rename, a move, or a delete with the
 *   redirect option left checked (decision 1). Something out there — an index, a
 *   newsletter, a partner site — still points at the old path, which is why the row
 *   is here. Deleting it makes that path 404 again, and nothing will bring the row
 *   back unless the page moves a second time.
 * - **By hand** rows were typed by an editor for a URL that may never have existed
 *   in Folio: a print campaign, a QR code, a legacy CMS. Nothing else knows about
 *   them, so nothing else will recreate them.
 *
 * Both are `neutral` badges, and that is the state palette rather than an
 * oversight: `design-system.md` reserves every hue for a state to act on, and a
 * row's provenance is a fact about the row. The distinction is carried by the word
 * and by the sentence beside it, not by colour.
 */
export function sourceLabel(source: RedirectSource): string {
  return source === 'auto' ? 'Automatic' : 'By hand'
}

/** One line for the badge's `title`. The long version is `deleteWarning`. */
export function sourceHint(source: RedirectSource): string {
  return source === 'auto'
    ? 'Folio wrote this when a page was renamed, moved or deleted.'
    : 'An editor typed this. Nothing else knows about it.'
}

/**
 * What deleting this row actually does, for the confirmation. Two sentences,
 * because a confirmation that says "this cannot be undone" and nothing else is
 * asking somebody to guess.
 */
export function deleteWarning(row: Pick<RedirectRow, 'from' | 'source'>): string {
  const path = pathLabel(row.from)
  return row.source === 'auto'
    ? `Folio wrote this when a page moved away from ${path}. Remove it and ${path} goes back to answering 404 — nothing recreates it unless that page moves again.`
    : `Nobody but an editor knows about this one, so nothing will recreate it. Remove it and ${path} goes back to answering 404.`
}

/**
 * What a status code means, for the cell's `title`. `301` is jargon a table of
 * redirects cannot avoid showing — it is the number the host puts on the response —
 * but it can avoid being the *only* thing shown.
 */
export function statusLabel(status: RedirectStatus): string {
  switch (status) {
    case 301:
      return 'Permanent'
    case 302:
      return 'Temporary'
    case 307:
      return 'Temporary, and the request method is kept'
    case 308:
      return 'Permanent, and the request method is kept'
  }
}

/** The status choices, in the order the create form offers them. 301 first
 * because it is the default a rename writes and the right answer for a page that
 * has genuinely moved. */
export const STATUSES: readonly { value: RedirectStatus; label: string }[] = [
  { value: 301, label: '301 — permanent' },
  { value: 302, label: '302 — temporary' },
  { value: 307, label: '307 — temporary, method kept' },
  { value: 308, label: '308 — permanent, method kept' },
]

/* --------------------------------------------------------------------- URL --- */

/** The source filter's "no filter" value. A chip needs a value for "All", and
 * `undefined` cannot be one. Same shape as Documents' `StateFilter`. */
export type SourceFilter = 'all' | RedirectSource

export const SOURCES: readonly { value: SourceFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'auto', label: 'Automatic' },
  { value: 'manual', label: 'By hand' },
]

export interface RedirectsUrl {
  source: SourceFilter
  /** Substring, matched against both paths server-side. */
  q: string
}

export function parseRedirectsUrl(query: Readonly<Record<string, string>>): RedirectsUrl {
  return {
    source: isSourceFilter(query.source) ? query.source : 'all',
    q: query.q ?? '',
  }
}

/**
 * The inverse, as the query object `href` takes. Defaults are written as
 * `undefined` so they leave the URL rather than sitting in it: `?source=all` says
 * exactly what the bare path says.
 */
export function redirectsQuery(url: RedirectsUrl): Record<string, string | undefined> {
  return {
    source: url.source === 'all' ? undefined : url.source,
    q: url.q || undefined,
  }
}

/**
 * Telling "no redirects yet" from "nothing matches", which are different empty
 * states — offering *clear filters* under the first is offering to clear nothing.
 */
export function isNarrowed(url: RedirectsUrl): boolean {
  return url.source !== 'all' || url.q.trim() !== ''
}

/**
 * The request `GET {base}/api/redirects` gets for a screen state.
 *
 * One function so the URL the screen shows and the request it makes cannot
 * disagree — the same rule `documents-model.ts`'s `documentsParams` follows. There
 * is no `sort`: this route has one ordering and `listRedirects` says why.
 */
export function redirectsParams(
  url: RedirectsUrl,
  opts: { limit: number; cursor?: string | null; count?: boolean },
): URLSearchParams {
  const params = new URLSearchParams({ limit: String(opts.limit) })
  if (url.source !== 'all') params.set('source', url.source)
  if (url.q.trim()) params.set('q', url.q.trim())
  if (opts.count) params.set('count', '1')
  if (opts.cursor) params.set('cursor', opts.cursor)
  return params
}

/**
 * The path a `DELETE` goes to.
 *
 * Encoded **per segment**, not whole. The route is `:from{.+}`, which exists so a
 * multi-segment path arrives intact, so the slashes have to survive — but
 * everything else in a stored path (a `%`, a space, a non-ASCII character in a
 * slug) still has to be escaped or the request means a different path than the row
 * does. The old admin's hook interpolated `from` raw and got the slashes right by
 * accident and the rest wrong for the same reason.
 */
export function deletePath(from: string): string {
  return from.split('/').map(encodeURIComponent).join('/')
}

/* -------------------------------------------------------------------- form --- */

export interface RedirectDraft {
  from: string
  to: string
  status: RedirectStatus
}

export const BLANK_DRAFT: RedirectDraft = { from: '', to: '', status: 301 }

export interface Refusal {
  /** Which control the message belongs under, so `Field`'s `error` can carry it
   * rather than a banner naming a field the reader has to find. */
  field: 'from' | 'to'
  message: string
}

/**
 * The client-side refusal, and it goes exactly as far as being *useful*.
 *
 * **The server is the authority** and its messages are ones a route wrote
 * deliberately: `"About" already lives at /about. Rename or move it first.` and
 * `That target already redirects back to /x; adding this row would loop.` Neither
 * is answerable here — one needs the story table and one needs the redirect table —
 * so this function does not try, and the dialog shows what the route said
 * (`messageOf`).
 *
 * What it does catch is the four things that are wrong without asking anybody, all
 * of which would otherwise cost a round trip to be told:
 *
 * 1. A blank field.
 * 2. `from` written as a full URL. `normalisePath` would turn `https://x/a` into
 *    the nonsense path `https:/x/a` and store it, and no request would ever match
 *    it. The route accepts this today, which makes the check here the only thing
 *    standing between a typo and a dead row.
 * 3. `to` that cannot go in an `href` — `javascript:` and friends. `lookupRedirect`
 *    re-checks `isSafeHref` on read and refuses the row *silently* to the host, so
 *    without this the row is written, listed, and never fires.
 * 4. `from` and `to` the same path, which a browser follows until it gives up. The
 *    POST route refuses this too, as of the same change that wrote this screen;
 *    saying it here first is what makes the dialog useful rather than a form that
 *    posts to find out.
 */
export function draftRefusal(draft: RedirectDraft): Refusal | null {
  const from = draft.from.trim()
  const to = draft.to.trim()

  if (!from) return { field: 'from', message: 'Type the path this should redirect from.' }
  if (isExternal(from)) {
    return {
      field: 'from',
      message: 'This has to be a path on this site, not a full URL — try /old-page.',
    }
  }
  if (normalisePath(from) === '') {
    return {
      field: 'from',
      message: 'The site root always has a page on it, so it cannot redirect.',
    }
  }

  if (!to) return { field: 'to', message: 'Type where it should go.' }
  if (!isSafeHref(to)) {
    return { field: 'to', message: 'That target cannot be used as a link.' }
  }
  if (normalisePath(from) === normaliseTarget(to)) {
    return {
      field: 'to',
      message: 'A path cannot redirect to itself; a browser would follow it forever.',
    }
  }
  return null
}

/* ------------------------------------------------------------------ footer --- */

/**
 * `Showing n of N`, which is the owner's answer to the paging control
 * (`ui-architecture.md` Resolved 5): next / previous plus an exact count, never
 * "page 3 of 7".
 *
 * `total` is absent until the route is asked for it (`?count=1`) and while a
 * search is still settling, so "n shown" is the honest fallback rather than a zero
 * or a guess.
 */
export function showing(shown: number, total: number | undefined): string {
  if (total === undefined) return `${shown} shown`
  return `${shown} of ${total} ${total === 1 ? 'redirect' : 'redirects'}`
}

/**
 * When the row was written, relative and coarse — the same formatter every other
 * list in the admin uses.
 *
 * `when` takes a story's two timestamps and prefers the draft watermark; a
 * redirect has one timestamp and no drafts, so `draftUpdatedAt: null` is not a
 * placeholder but the true answer, and `when` degrades to plain `createdAt`. The
 * alternative was a second relative-time formatter in this file, which is how two
 * lists end up disagreeing about what "3 days ago" rounds from.
 */
export function createdLabel(row: Pick<RedirectRow, 'createdAt'>, now?: number): string {
  return when({ updatedAt: row.createdAt, draftUpdatedAt: null }, now)
}

function isSourceFilter(raw: string | undefined): raw is SourceFilter {
  return raw === 'all' || raw === 'auto' || raw === 'manual'
}
