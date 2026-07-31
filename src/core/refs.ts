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
 *
 * `assetKeys` is the third walk and the odd one out: its edges are not ids
 * `resolve()` has to load — an asset needs no lookup, its value is stored inline —
 * so it exists purely for `content_refs`, which is what lets the Assets screen say
 * where a file is used before somebody deletes it.
 */
import type { Blok, Doc, Json } from './doc'
import type { Field } from './fields'
import type { SchemaIndex } from './schema'
import { asRichtext, type RichtextNode } from './richtext'
import { asAsset, asAssets, asLink, asStoryIds, type LinkValue } from './values'

/**
 * An outbound edge of a document, as `content_refs` stores it.
 *
 * **`to` is a story id for `link` and `reference`, and an R2 object key for
 * `asset`** — the column is `to_id` and holds whatever `kind` says it holds
 * (`migrations/0002_asset_refs.sql`). A stored `AssetValue` carries no asset id,
 * only its key, and this walk is pure so it cannot look one up; the key is
 * `not null unique` on `assets`, so it is as total an identity as the id.
 */
export interface OutboundRef {
  to: string
  kind: 'link' | 'reference' | 'asset'
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

/**
 * Every Folio-native link mark inside one richtext value.
 *
 * One walk with a visitor rather than one per edge kind: story links and asset
 * links live in the same marks, and two recursive walkers over the same tree is
 * two places to forget `node.content`.
 */
function richtextLinks(value: Json, visit: (link: LinkValue) => void): void {
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
        if (link) visit(link)
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
        for (const value of storedValues(blok, name)) {
          richtextLinks(value, (link) => {
            if (link.kind === 'story') out.add(link.id)
          })
        }
      }
    }
  }
  return [...out]
}

/**
 * Story ids a document *references*: `reference` and `references` fields, across
 * every locale.
 *
 * `referencedIds` in resolve.ts is the public, source-locale-only form that
 * predates this file and is what `useReferencedDocs` keys off. This is the same
 * walk widened to `i18n`, for the two callers that must not miss a translated
 * target: the narrowed resolution, and `content_refs`.
 *
 * Both kinds, because both are ids a render needs loaded and both are usages the
 * "used by N published documents" warning is about
 * (`../../../docs/specs/content-model/data-documents.md` decision 4). A
 * `references()` field holding six people contributes six `reference` rows, so
 * deleting one of them warns about every page whose hand-picked list names it.
 */
export function referencedIdsAllLocales(doc: Doc, schema: SchemaIndex): string[] {
  const out = new Set<string>()
  for (const blok of Object.values(doc.bloks)) {
    const fields: Record<string, Field> | undefined = schema[blok.type]?.fields
    if (!fields) continue
    for (const [name, field] of Object.entries(fields)) {
      if (field.kind === 'reference') {
        for (const value of storedValues(blok, name)) {
          if (typeof value === 'string' && value) out.add(value)
        }
        continue
      }
      if (field.kind === 'references') {
        for (const value of storedValues(blok, name)) {
          for (const id of asStoryIds(value)) out.add(id)
        }
      }
    }
  }
  return [...out]
}

/**
 * The R2 keys of every asset a document uses, across every locale — what the
 * Assets screen's "where it is used" panel and its delete confirmation read
 * (`docs/ui-architecture.md` dependency 4).
 *
 * **Four field shapes reach an asset, not two.** `asset()` and `multiasset()` are
 * the obvious pair. The other two are the same trap `linkedIds` exists for: a
 * `multilink` and a richtext link mark can both hold `{ kind: 'asset', asset }`
 * (`core/values.ts`'s `LinkValue`), which is how a "Download the brochure" button
 * and a PDF link inside prose are stored. Deleting that asset breaks the download
 * exactly as surely as deleting one embedded in an image field, so both count as
 * usage. Walking only the two asset field kinds would tell an editor a file is
 * unused while three pages link to it — a wrong answer given confidently, which
 * is worse than no answer.
 *
 * **Keys only.** An `AssetValue` whose only location is a `url` is hosted
 * somewhere else and has no library row, so there is nothing for a usage panel to
 * be about and nothing a delete could break here.
 */
export function assetKeys(doc: Doc, schema: SchemaIndex): string[] {
  const out = new Set<string>()
  const add = (asset: { key?: string } | null): void => {
    if (asset?.key) out.add(asset.key)
  }

  for (const blok of Object.values(doc.bloks)) {
    const fields: Record<string, Field> | undefined = schema[blok.type]?.fields
    if (!fields) continue
    for (const [name, field] of Object.entries(fields)) {
      switch (field.kind) {
        case 'asset':
          for (const value of storedValues(blok, name)) add(asAsset(value))
          break
        case 'multiasset':
          for (const value of storedValues(blok, name)) {
            for (const asset of asAssets(value)) add(asset)
          }
          break
        case 'multilink':
          for (const value of storedValues(blok, name)) {
            const link = asLink(value)
            if (link?.kind === 'asset') add(link.asset)
          }
          break
        case 'richtext':
          for (const value of storedValues(blok, name)) {
            richtextLinks(value, (link) => {
              if (link.kind === 'asset') add(link.asset)
            })
          }
          break
        default:
          break
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
 *
 * Asset edges come last and get no self-edge check — a story id and an R2 key
 * are values from different namespaces and can never be equal. They are **one
 * kind, not two**, even though a document can reach an asset by embedding it and
 * by linking to it: `kind` is part of the primary key, so splitting them would
 * make a page that does both count twice in a warning whose whole job is to say
 * how many *documents* are affected. **Rejected: an `asset-link` kind** beside
 * `asset` — nothing would read the difference, and "used by 4 pages" is the
 * sentence being written.
 */
export function outboundRefs(doc: Doc, schema: SchemaIndex, from: string): OutboundRef[] {
  const out: OutboundRef[] = []
  for (const to of linkedIds(doc, schema)) {
    if (to !== from) out.push({ to, kind: 'link' })
  }
  for (const to of referencedIdsAllLocales(doc, schema)) {
    if (to !== from) out.push({ to, kind: 'reference' })
  }
  for (const to of assetKeys(doc, schema)) out.push({ to, kind: 'asset' })
  return out
}
