/**
 * Turning stored ids into things a block can render.
 *
 * A document is deliberately self-contained and portable: it stores a story's
 * `id`, not its URL. That leaves the renderer needing a little context from
 * outside the document, and this is it.
 *
 * The awkward constraint is the preview client, which re-renders on every
 * keystroke with no network in the loop. So resolution can never be a per-render
 * fetch. Instead a `Resolution` is built once from data both sides already have
 * — D1 on the server, the story tree the admin has already loaded — and pushed
 * alongside the document. It is refreshed when *structure* changes, which is
 * rare and already an event both sides handle.
 */
import type { ReactNode } from 'react'
import type { Doc, Json } from './doc'
import { defaultValue, type Field } from './fields'
import { dataOf, type LocaleContext } from './locales'
import {
  type CollectionField,
  collectionQuery,
  emptyContentPage,
  maxPerPageOf,
  queryKey,
  type ResolvedCollection,
} from './query'
import type { SchemaIndex } from './schema'
import type { StoryMeta } from './story'
import {
  asAsset,
  asAssets,
  asLink,
  asStoryIds,
  isImageAsset,
  isSafeHref,
  type AssetValue,
  type LinkKind,
  type LinkValue,
} from './values'

/** What a story id resolves to. Derived, never stored inside a document. */
export interface StoryRef {
  id: string
  /** `''` for an unrouted document, which has no place in the URL namespace. */
  path: string
  /**
   * `''` for an unrouted document rather than `null`: this is a published type
   * host code reads, and widening `string` to `string | null` would be a
   * breaking change forced on every consumer for a value they should not be
   * reading anyway (`document-types.md` architecture decision 6). `routable`
   * below is the field to test; `resolveLink` refuses to emit an href from a
   * ref that fails it.
   */
  url: string
  title: string
  /** The document type's name, for `reference`/`multilink` type filtering. */
  type: string
  routable: boolean
}

export interface Resolution {
  stories: Record<string, StoryRef>
  /**
   * Where the asset route is mounted. Held here rather than baked into stored
   * values so remounting Folio under a different base path does not invalidate
   * every asset reference in the database.
   */
  assetBase: string
  /**
   * Documents pulled in by `reference` fields, keyed by story id. Populated only
   * for the ids a document actually points at, and only one level deep — the same
   * bound Storyblok's `resolve_relations` has, and what stops a story that
   * references itself from rendering forever.
   */
  docs?: Record<string, Doc>
  /**
   * A site's singletons — headers, footers, settings — keyed by *type name*
   * rather than story id, because a caller says `'header'` and should not have
   * to know the `sng_<type>` id convention (`../../../docs/specs/content-model/
   * globals.md`). Populated by the same query `docs` is, from `FolioConfig.globals`.
   *
   * Deliberately a separate field rather than merged into `docs`: `RenderBlok`
   * empties `docs` one level down so a story referencing itself renders once,
   * but a global rendered inside a referenced document still needs its own
   * content, so `globals` has to survive that emptying.
   */
  globals?: Record<string, Doc>
  /**
   * Which language this render is in (`../../../docs/specs/content-model/
   * localisation.md` architecture decision 5).
   *
   * The locale rides here rather than being a second argument to `render`,
   * because "which language" then lives in exactly one place — the same place
   * `assetBase` and the story map already live, built once and pushed alongside
   * the document. `published()` hands back the same document whatever the
   * locale; this is what makes it read as French.
   *
   * **Absent means the source locale**, including on a site that has locales
   * configured and is looking at its default. So a default-locale render takes
   * the identical path it did before localisation existed, rather than a
   * fallback chain that happens to land in the same place.
   */
  locale?: LocaleContext
  /**
   * Answers to the `collection` queries this document contains, keyed by
   * `queryKey` (`../../../docs/specs/content-model/collections.md` decision 5).
   *
   * The same treatment `docs` gets, one level up: the queries are collected from
   * the document, run once each, and their answers pushed alongside it — so a page
   * with no collection field costs no extra reads, two blocks with the same
   * configuration cost one read between them, and the preview client re-renders
   * per keystroke against data it already holds.
   */
  collections?: Record<string, ResolvedCollection>
  /**
   * Which page every collection field in this document is showing (1-based).
   *
   * Rides on the resolution rather than being a second argument to `render` for
   * exactly the reason `locale` does: it is part of the key `resolveValue` has to
   * compute to find its answer, so it has to be somewhere both the code that ran
   * the queries and the code that reads them can see. A host reads `?page=` and
   * passes it to `folio.resolve`. A page with two *independently* paginated lists
   * is out of scope — `?page` is one number.
   */
  page?: number
}

export const DEFAULT_ASSET_BASE = '/folio/asset'

export const EMPTY_RESOLUTION: Resolution = { stories: {}, assetBase: DEFAULT_ASSET_BASE }

/**
 * Every story gets a ref, unrouted ones included: a `reference` to a record
 * needs its title even though it has no URL (`document-types.md` architecture
 * decision 6). What an unrouted ref does *not* get is a usable `url`, which is
 * what `resolveLink` checks before emitting an href.
 */
export function buildResolution(
  stories: readonly StoryMeta[],
  assetBase: string = DEFAULT_ASSET_BASE,
): Resolution {
  const out: Record<string, StoryRef> = {}
  for (const s of stories) {
    const routable = s.path !== null
    out[s.id] = {
      id: s.id,
      path: s.path ?? '',
      url: routable ? (s.url ?? `/${s.path}`) : '',
      title: s.title,
      type: s.type,
      routable,
    }
  }
  return { stories: out, assetBase }
}

/** What a `multilink` field hands to `render`. Null when nothing is set. */
export interface ResolvedLink {
  kind: LinkKind
  href: string
  target?: '_blank'
  rel?: string
  /** The link points at a story that has since been deleted. */
  broken?: boolean
  /** Title of the linked story, handy as a default label. */
  title?: string
}

/**
 * `types`, when given, is the field's own `multilink({ types })` — re-checked
 * here as well as narrowed in the admin's picker, because content can also
 * arrive from an importer or over the API.
 */
export function resolveLink(
  value: Json | undefined,
  resolution: Resolution,
  types?: readonly string[],
): ResolvedLink | null {
  const link = asLink(value)
  if (!link) return null

  switch (link.kind) {
    case 'story': {
      const story = resolution.stories[link.id]
      // A deleted story leaves the link in place rather than dropping it, so an
      // editor can see what broke instead of the link quietly vanishing.
      if (!story) return { kind: 'story', href: '#', broken: true, ...windowing(link) }
      // The same treatment for a target that has no URL to offer, or one the
      // field's own `types` does not permit: "there is no URL for this" and
      // "this URL is gone" are the same problem for an editor
      // (`document-types.md` architecture decision 5).
      if (!story.routable || (types && !types.includes(story.type))) {
        return { kind: 'story', href: '#', broken: true, title: story.title, ...windowing(link) }
      }
      return {
        kind: 'story',
        href: `${story.url}${hash(link.anchor)}`,
        title: story.title,
        ...windowing(link),
      }
    }
    // Both hrefs below come from a stored string. `asLink` already applied the
    // allow-list to `url`; re-checking here makes it true of everything this
    // function emits, whoever hands it a value.
    case 'url':
      return isSafeHref(link.url) ? { kind: 'url', href: link.url, ...windowing(link) } : null
    case 'email': {
      const query = link.subject ? `?subject=${encodeURIComponent(link.subject)}` : ''
      return { kind: 'email', href: `mailto:${link.email}${query}` }
    }
    case 'anchor':
      return { kind: 'anchor', href: hash(link.anchor) }
    case 'asset': {
      const href = decorateAsset(link.asset, resolution).src
      return isSafeHref(href) ? { kind: 'asset', href, ...windowing(link) } : null
    }
  }
}

export interface AssetTransform {
  width?: number
  height?: number
  fit?: 'cover' | 'contain' | 'scale-down'
  format?: 'webp' | 'avif' | 'jpeg' | 'png'
  /** 1..100. */
  quality?: number
}

/** What an `asset` field hands to `render`. */
export interface ResolvedAsset extends AssetValue {
  /** The original, unresized. */
  src: string
  /** `object-position` for the focal point, or `50% 50%` when none is set. */
  objectPosition: string
  isImage: boolean
  /**
   * URL for a resized variant. Assets we do not host come back untouched — Folio
   * will not proxy a third party's image.
   */
  srcFor: (transform: AssetTransform) => string
}

export function resolveAsset(
  value: Json | undefined,
  resolution: Resolution,
): ResolvedAsset | null {
  const asset = asAsset(value)
  return asset ? decorateAsset(asset, resolution) : null
}

export function resolveAssets(value: Json | undefined, resolution: Resolution): ResolvedAsset[] {
  return asAssets(value).map((a) => decorateAsset(a, resolution))
}

/**
 * R2 keys are free-form: a space, a `#` or a `?` in one truncates or breaks the
 * URL it is pasted into. Each path segment is encoded, `/` left alone, so the
 * route still sees the key's shape.
 */
const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/')

function decorateAsset(asset: AssetValue, resolution: Resolution): ResolvedAsset {
  const src = asset.key ? `${resolution.assetBase}/${encodeKey(asset.key)}` : asset.url!
  const focal = asset.focal

  return {
    ...asset,
    src,
    isImage: isImageAsset(asset),
    objectPosition: focal ? `${pct(focal.x)} ${pct(focal.y)}` : '50% 50%',
    srcFor: (t) => {
      if (!asset.key) return src
      const p = new URLSearchParams()
      if (t.width) p.set('w', String(Math.round(t.width)))
      if (t.height) p.set('h', String(Math.round(t.height)))
      if (t.fit) p.set('fit', t.fit)
      if (t.format) p.set('f', t.format)
      if (t.quality) p.set('q', String(Math.round(t.quality)))
      // Cropping to a new aspect ratio has to know what to keep in frame.
      if (focal && (t.width || t.height)) p.set('fp', `${round(focal.x)},${round(focal.y)}`)
      const query = p.toString()
      return query ? `${src}?${query}` : src
    },
  }
}

const pct = (n: number) => `${Math.round(n * 1000) / 10}%`
const round = (n: number) => Math.round(n * 1000) / 1000

/**
 * Story ids a document points at through `reference` and `references` fields.
 *
 * The caller loads exactly these and nothing else, so a page with no references
 * costs no extra reads at all — and a `references()` field naming six people
 * costs one document read per distinct target, batched with everything else
 * (`data-documents.md` decision 3).
 */
export function referencedIds(doc: Doc, schema: SchemaIndex): string[] {
  const out = new Set<string>()
  for (const blok of Object.values(doc.bloks)) {
    const fields = schema[blok.type]?.fields
    if (!fields) continue
    for (const [name, field] of Object.entries(fields)) {
      if (field.kind === 'reference') {
        const id = blok.data[name]
        if (typeof id === 'string' && id) out.add(id)
        continue
      }
      if (field.kind === 'references') {
        for (const id of asStoryIds(blok.data[name])) out.add(id)
      }
    }
  }
  return [...out]
}

/** The metadata half of a resolved reference. The renderer adds the rendered content. */
export interface ReferenceTarget {
  id: string
  title: string
  path: string
  url: string
  /** Root block data of the referenced document, for reading its fields directly. */
  data: Record<string, Json>
  doc: Doc
}

/**
 * What a `reference` field hands to `render`. Either read `data` and build your
 * own UI from it, or drop `content` in to inline the referenced page wholesale.
 */
export interface ResolvedReference extends ReferenceTarget {
  content: ReactNode
}

/**
 * `types` is the field's own `reference({ types })`. A target of the wrong type
 * resolves to `null`, exactly like a deleted one, so the block renders its
 * empty state — the visible failure a value written by an importer needs
 * (`document-types.md` architecture decision 5).
 */
export function resolveReference(
  value: Json | undefined,
  resolution: Resolution,
  types?: readonly string[],
): ReferenceTarget | null {
  if (typeof value !== 'string' || !value) return null
  const story = resolution.stories[value]
  const doc = resolution.docs?.[value]
  // Unresolvable either because the story is gone or because nothing loaded its
  // document. Both are the caller's cue to render nothing.
  if (!story || !doc) return null
  if (types && !types.includes(story.type)) return null
  const root = doc.bloks[doc.root]
  return {
    id: value,
    title: story.title,
    path: story.path,
    url: story.url,
    // Read in the resolution's own locale (`localisation.md`): a referenced
    // person card inlined into a French page shows the French bio, and a block
    // author reading `data` directly gets the same answer `content` renders.
    data: root ? dataOf(root, resolution.locale) : {},
    doc,
  }
}

/**
 * What a `references` field hands to `render`, before the renderer adds each
 * entry's `content`: the targets that resolved, **in the stored order**.
 *
 * Unresolvable entries are **dropped rather than left as holes**
 * (`data-documents.md` decision 3): a deleted person should not render an empty
 * card, and a block author iterating the list must not have to guard every item.
 * The admin's input shows the same entry as "missing (deleted)" so the editor can
 * see why the list got shorter — the renderer hides the damage, the editor
 * surfaces it, which is the same split `multilink`'s `broken` flag makes.
 *
 * `types` is the field's own `references({ types })`, re-checked here as well as
 * narrowed in the picker, for the reason `resolveReference` re-checks its own:
 * content also arrives from an importer and over the API.
 */
export function resolveReferences(
  value: Json | undefined,
  resolution: Resolution,
  types?: readonly string[],
): ReferenceTarget[] {
  const out: ReferenceTarget[] = []
  for (const id of asStoryIds(value)) {
    const target = resolveReference(id, resolution, types)
    if (target) out.push(target)
  }
  return out
}

/**
 * What a `collection` field hands to `render`: the answer the resolution already
 * holds for this field's query, or an empty page.
 *
 * An empty page rather than null (and never a throw) because the miss is
 * ordinary: a host that renders a document without running its queries, a preview
 * frame that arrived before the fetch settled, or a collection whose document type
 * has been removed from the config. A block iterating `items` renders its own
 * empty state in every one of those cases, which is the right answer for all of
 * them.
 */
export function resolveCollection(
  field: CollectionField,
  value: Json | undefined,
  resolution: Resolution,
): ResolvedCollection {
  const q = collectionQuery(field, value, resolution.page)
  const key = queryKey(q, maxPerPageOf(field))
  return resolution.collections?.[key] ?? emptyContentPage(q.page, q.perPage)
}

/**
 * A stored field value as `render` should receive it, per `ValueOf<Field>`: an
 * absent value resolves to its kind's empty value, not to `''` for everything.
 *
 * The dispatch is exhaustive on purpose. A new field kind should fail to compile
 * here rather than fall through and hand a block author the wrong type.
 *
 * `richtext` and `blocks` resolve to `ReactNode`, which needs the registry: the
 * renderer builds those itself and never asks for them here.
 */
export function resolveValue(
  field: Field,
  value: Json | undefined,
  resolution: Resolution,
): unknown {
  switch (field.kind) {
    case 'multilink':
      return resolveLink(value, resolution, field.types)
    case 'asset':
      return resolveAsset(value, resolution)
    case 'multiasset':
      return resolveAssets(value, resolution)
    case 'reference':
      return resolveReference(value, resolution, field.types)
    case 'references':
      return resolveReferences(value, resolution, field.types)
    case 'collection':
      return resolveCollection(field, value, resolution)
    case 'number':
      // Deliberately `defaultValue(field)`, never `field.default`: this runs on
      // every render, and a schema edit must not retroactively change what an
      // already-published page says (`field-defaults-and-presets.md`, decision
      // 4). `field.default` is consulted only at creation, in `blankSubtree`.
      return typeof value === 'number' ? value : defaultValue(field)
    case 'boolean':
      return typeof value === 'boolean' ? value : false
    case 'richtext':
    case 'blocks':
      return null
    case 'text':
    case 'textarea':
    case 'select':
      return value ?? ''
    default: {
      const unhandled: never = field
      throw new Error(`Unhandled field kind: ${(unhandled as Field).kind}`)
    }
  }
}

function hash(anchor: string | undefined): string {
  if (!anchor) return ''
  return anchor.startsWith('#') ? anchor : `#${anchor}`
}

/**
 * `rel` is defaulted rather than left to each block author: a new-window link
 * without `noopener` hands the opener a live `window` reference, and that is not
 * a mistake a CMS should let a block make.
 */
function windowing(link: LinkValue): { target?: '_blank'; rel?: string } {
  if (!('target' in link) || link.target !== '_blank') {
    return 'rel' in link && link.rel ? { rel: link.rel } : {}
  }
  const rel = ('rel' in link && link.rel) || 'noopener noreferrer'
  return { target: '_blank', rel }
}
