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
import type { SchemaIndex } from './schema'
import type { StoryMeta } from './story'
import {
  asAsset,
  asAssets,
  asLink,
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
 * Story ids a document points at through `reference` fields.
 *
 * The caller loads exactly these and nothing else, so a page with no references
 * costs no extra reads at all.
 */
export function referencedIds(doc: Doc, schema: SchemaIndex): string[] {
  const out = new Set<string>()
  for (const blok of Object.values(doc.bloks)) {
    const fields = schema[blok.type]?.fields
    if (!fields) continue
    for (const [name, field] of Object.entries(fields)) {
      if (field.kind !== 'reference') continue
      const id = blok.data[name]
      if (typeof id === 'string' && id) out.add(id)
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
  return {
    id: value,
    title: story.title,
    path: story.path,
    url: story.url,
    data: doc.bloks[doc.root]?.data ?? {},
    doc,
  }
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
