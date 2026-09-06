import { useEffect, useMemo, useState } from 'react'
import type { Doc } from '../../core/doc'
import type { ResolvedForm } from '../../core/forms'
import { formIds } from '../../core/refs'
import type { SchemaIndex } from '../../core/schema'

/**
 * The compiled descriptors for the `form` fields the open document contains —
 * `Resolution['forms']`, fetched for the editor's own copy of the resolution
 * (`../../../docs/specs/content-model/forms.md` decision 4).
 *
 * **This exists because the bridge frame overwrites the server render.** The
 * preview iframe is rendered server-side with a complete `Resolution`, forms and
 * all, and then `usePreviewBridge` posts the admin's own resolution over it on
 * the first change. Every key the admin does not assemble is a key the preview
 * loses — so before this hook a form embedded in a page rendered as `null` in
 * the editor pane and correctly everywhere else, which is exactly the shape of
 * bug nobody looks for in `useEditor`.
 *
 * `useCollections`' pattern, one route call rather than one per id: the whole
 * point is that nothing here fetches per render. The dependency is the *set* of
 * form ids plus the two things that shape a descriptor — the locale and the
 * page's URL — so typing into a field next to a form changes nothing and asks
 * for nothing.
 *
 * The admin cannot compile a descriptor of its own: `compileForm` clamps
 * `maxBytes` against the media library's ceiling and derives `open` from the
 * clock, so `GET {base}/api/forms/resolved` is the one honest source.
 */

/** Stable identity for "nothing to show", so a document with no form field
 *  re-renders nothing when the effect settles. */
const NO_FORMS: Readonly<Record<string, ResolvedForm>> = {}

/**
 * The form ids the document embeds, sorted and joined — so an unchanged set is
 * an unchanged effect dependency however the document was edited around it.
 *
 * `formIds` walks stored values across every locale the way the server's own
 * resolve does, so a form only a translation points at is still fetched.
 */
export function wantedFormIds(doc: Doc | null, schema: SchemaIndex): string {
  return doc ? formIds(doc, schema).sort().join(',') : ''
}

/** The request one set of ids makes, as a path relative to the admin's JSON
 *  base. Pure and exported so the query string is pinned by a Node test rather
 *  than by reading a network tab. */
export function formsRequest(ids: readonly string[], locale?: string, page?: string): string {
  const params = new URLSearchParams({ ids: ids.join(',') })
  // Only when they are actually known: the route defaults both, and a `page=`
  // with nothing after it would put an empty `_folio_page` on the descriptor
  // where the server render puts no hidden input at all.
  if (locale) params.set('locale', locale)
  if (page) params.set('page', page)
  return `/forms/resolved?${params.toString()}`
}

/**
 * Fetches the descriptors for `ids`.
 *
 * **Never rejects, and answers `null` for "no answer at all"** — a transport
 * failure or a refusal. The caller keeps what it had for that case, because a
 * form that resolved a moment ago and cannot be re-read now is better drawn
 * from the copy in hand than blanked out of the preview. An id the server
 * answers *without* is a different fact — the form was deleted — and comes back
 * as an absent key, which is what makes it disappear.
 */
export async function loadResolvedForms(
  apiBase: string,
  ids: readonly string[],
  locale?: string,
  page?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, ResolvedForm> | null> {
  let res: Response
  try {
    res = await fetchImpl(`${apiBase}${formsRequest(ids, locale, page)}`)
  } catch {
    return null
  }
  if (!res.ok) return null
  const body = (await res.json().catch(() => null)) as Record<string, ResolvedForm> | null
  return body && typeof body === 'object' ? body : null
}

/**
 * The descriptors for the open document, refetched when the id set, the locale
 * or the page's URL changes and at no other time.
 *
 * `locale` is the *code* rather than the whole `LocaleContext`: the fallback
 * chain is the server's to rebuild (`rt.localeOf`), and sending it would be a
 * client asserting a configuration it merely holds a copy of.
 */
export function useResolvedForms(
  apiBase: string,
  doc: Doc | null,
  schema: SchemaIndex,
  locale?: string,
  page?: string,
): Readonly<Record<string, ResolvedForm>> {
  const [forms, setForms] = useState<Readonly<Record<string, ResolvedForm>>>(NO_FORMS)

  const wanted = useMemo(() => wantedFormIds(doc, schema), [doc, schema])

  useEffect(() => {
    const ids = wanted ? wanted.split(',') : []
    // The constant, not a fresh `{}`: React bails out of a re-render for an
    // identical value, and this branch runs for every document that has no form
    // field at all — which is most of them.
    if (ids.length === 0) {
      setForms(NO_FORMS)
      return
    }
    let live = true
    void loadResolvedForms(apiBase, ids, locale, page).then((answer) => {
      if (live && answer) setForms(answer)
    })
    return () => {
      live = false
    }
  }, [apiBase, wanted, locale, page])

  return forms
}
