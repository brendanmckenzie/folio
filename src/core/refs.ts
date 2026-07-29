/**
 * The story ids a document points at — the set `resolve()` loads and the set
 * `content_refs` records (`../../../docs/specs/content-model/collections.md`
 * architecture decisions 3 and 6).
 *
 * `referencedIds` (resolve.ts) already answered this for `reference` fields.
 * This file is the other half, and it exists because of one specific bug that
 * has already been fixed once in this codebase:
 *
 * **A story link inside richtext has no href.** A Folio-native link mark stores a
 * structured `attrs.link` (`{ kind: 'story', id }`); the href is derived from the
 * resolution at render time, which is what lets an internal link inside prose
 * survive the linked page being renamed. So the ids inside richtext link marks
 * are part of "the ids the document actually needs" — narrowing `resolve()` to
 * `multilink` and `reference` fields alone would render every internal prose link
 * as unstyled text with no `<a>` around it, and neither the richtext sanitiser
 * tests nor a link-field test would catch it.
 *
 * Everything here also walks `Blok.i18n`, not only `Blok.data`: a French
 * paragraph can link somewhere the English one does not, and the resolution is
 * built once for a render whose locale it must not have to know.
 */
import type { Blok, Doc, Json } from './doc'
import type { Field } from './fields'
import type { SchemaIndex } from './schema'
import { asRichtext, type RichtextNode } from './richtext'
import { asLink } from './values'

/** An outbound edge of a document, as `content_refs` stores it. */
export interface OutboundRef {
  to: string
  kind: 'link' | 'reference'
}

/**
 * Every stored value of one field on one blok: the source value, then each
 * locale's override.
 *
 * The union rather than the *active* locale's value, because these walks feed a
 * resolution built once per render and reused across every field read. A locale
 * whose translation links elsewhere must not have its target missing from the
 * story map.
 */
function storedValues(blok: Blok, name: string): Json[] {
  const out: Json[] = []
  const source = blok.data[name]
  if (source !== undefined && source !== null) out.push(source)
  for (const map of Object.values(blok.i18n ?? {})) {
    const value = map[name]
    if (value !== undefined && value !== null) out.push(value)
  }
  return out
}

/** Story ids inside one richtext value's link marks. */
function richtextStoryIds(value: Json, into: Set<string>): void {
  const walk = (nodes: readonly RichtextNode[] | undefined): void => {
    if (!Array.isArray(nodes)) return
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue
      for (const mark of Array.isArray(node.marks) ? node.marks : []) {
        if (!mark || typeof mark !== 'object' || mark.type !== 'link') continue
        // `attrs.href` is the imported/TipTap shape and carries no story id.
        // `attrs.link` is the Folio-native one, and is the whole reason this
        // walk exists.
        const link = asLink(mark.attrs?.link)
        if (link?.kind === 'story') into.add(link.id)
      }
      walk(node.content)
    }
  }
  walk(asRichtext(value)?.content)
}

/**
 * Story ids a document *links* to: `multilink` fields, and link marks inside
 * every `richtext` field.
 *
 * Separate from `referencedIds` because the two mean different things to
 * `content_refs` — a link is an href, a reference pulls content in — but both
 * are ids `resolve()` has to load or the render is wrong.
 */
export function linkedIds(doc: Doc, schema: SchemaIndex): string[] {
  const out = new Set<string>()
  for (const blok of Object.values(doc.bloks)) {
    const fields: Record<string, Field> | undefined = schema[blok.type]?.fields
    if (!fields) continue
    for (const [name, field] of Object.entries(fields)) {
      if (field.kind === 'multilink') {
        for (const value of storedValues(blok, name)) {
          const link = asLink(value)
          if (link?.kind === 'story') out.add(link.id)
        }
        continue
      }
      if (field.kind === 'richtext') {
        for (const value of storedValues(blok, name)) richtextStoryIds(value, out)
      }
    }
  }
  return [...out]
}

/**
 * Story ids a document *references*: `reference` fields, across every locale.
 *
 * `referencedIds` in resolve.ts is the public, source-locale-only form that
 * predates this file and is what `useReferencedDocs` keys off. This is the same
 * walk widened to `i18n`, for the two callers that must not miss a translated
 * target: the narrowed resolution, and `content_refs`.
 */
export function referencedIdsAllLocales(doc: Doc, schema: SchemaIndex): string[] {
  const out = new Set<string>()
  for (const blok of Object.values(doc.bloks)) {
    const fields: Record<string, Field> | undefined = schema[blok.type]?.fields
    if (!fields) continue
    for (const [name, field] of Object.entries(fields)) {
      if (field.kind !== 'reference') continue
      for (const value of storedValues(blok, name)) {
        if (typeof value === 'string' && value) out.add(value)
      }
    }
  }
  return [...out]
}

/**
 * The whole outbound edge set of a document, for `content_refs`.
 *
 * Publish is the only moment this is in hand — the document, its schema and the
 * fact that it is now the published copy, all at once — which is why the rows are
 * written there rather than derived on demand.
 *
 * A story that both links to and references the same target produces two rows:
 * `kind` is part of the primary key, and "used by" wants to be able to say which.
 * Self-edges are dropped: a page linking to itself is not a usage another
 * document has to be warned about before deleting.
 */
export function outboundRefs(doc: Doc, schema: SchemaIndex, from: string): OutboundRef[] {
  const out: OutboundRef[] = []
  for (const to of linkedIds(doc, schema)) {
    if (to !== from) out.push({ to, kind: 'link' })
  }
  for (const to of referencedIdsAllLocales(doc, schema)) {
    if (to !== from) out.push({ to, kind: 'reference' })
  }
  return out
}
