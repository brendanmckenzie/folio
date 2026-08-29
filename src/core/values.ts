/**
 * Stored shapes for the fields whose value is richer than a scalar.
 *
 * Everything here is plain JSON, because it lands in `Blok.data` and travels
 * through the same `set` mutations as a text field. The *resolved* shapes a
 * block author receives live in `resolve.ts`.
 */

/**
 * A point of interest in an image, normalised 0..1 from the top-left, so it
 * survives every resize. Storyblok stores a pixel crop box instead, which only
 * means anything next to the original dimensions.
 */
export interface FocalPoint {
  x: number
  y: number
}

/**
 * An uploaded file as a field records it.
 *
 * `alt` and `focal` live here rather than on the library row on purpose: the
 * same photograph is a portrait in one place and a background texture in
 * another, and it needs different alt text and a different focal point in each.
 * The library row holds a default that gets copied in when the asset is picked.
 */
export interface AssetValue {
  /** R2 object key. Absent when the asset is hosted somewhere else. */
  key?: string
  /** Absolute URL, for an asset that is not in our bucket. */
  url?: string
  filename: string
  contentType: string
  size: number
  width?: number
  height?: number
  alt: string
  focal?: FocalPoint
}

/**
 * Where a link points.
 *
 * A story link stores the story's stable `id` and nothing else. Paths are
 * derived from the ancestor chain and recomputed for the whole subtree on
 * rename or move, so a link that captured a path would silently rot the moment
 * someone reorganised the tree. Turning an id into a URL is the renderer's job.
 */
export type LinkValue =
  | { kind: 'story'; id: string; anchor?: string; target?: '_blank' }
  | { kind: 'url'; url: string; target?: '_blank'; rel?: string }
  | { kind: 'email'; email: string; subject?: string }
  /** Somewhere on the page currently being rendered. */
  | { kind: 'anchor'; anchor: string }
  | { kind: 'asset'; asset: AssetValue; target?: '_blank' }

export type LinkKind = LinkValue['kind']

export const LINK_KINDS: readonly LinkKind[] = ['story', 'url', 'email', 'anchor', 'asset']

const LINK_KIND_SET: ReadonlySet<string> = new Set(LINK_KINDS)

/**
 * Schemes an href may carry. Anything without a scheme — relative,
 * protocol-relative, a bare `#anchor` — is fine; anything that can execute is
 * not, and there is no safe way to escape it once it is in an `href`.
 */
const SAFE_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto', 'tel'])

/**
 * A colon only starts a scheme when everything before it is a scheme token, so
 * `page/a:b` and `#a:b` are relative. Control characters and surrounding
 * whitespace are stripped first because browsers ignore them when reading the
 * scheme — `java\tscript:` and ` javascript:` both execute.
 */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i

/** Control characters and spaces, by code point: a regex class of these is unreadable. */
const ignorable = (ch: string): boolean => {
  const code = ch.charCodeAt(0)
  return code <= 0x20 || code === 0x7f
}

/** Whether a stored string is safe to put in an `href`. The one allow-list. */
export function isSafeHref(url: string): boolean {
  const clean = [...url].filter((ch) => !ignorable(ch)).join('')
  if (!clean) return false
  const scheme = SCHEME.exec(clean)?.[1]
  return !scheme || SAFE_SCHEMES.has(scheme.toLowerCase())
}

/**
 * A stored value is only as trustworthy as the last thing that wrote it: an
 * older document, a half-finished edit, or a Storyblok import can all leave
 * something that is not a `LinkValue`. Everything reading a link goes through
 * here so the renderer never has to guard.
 */
export function asLink(value: unknown): LinkValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (typeof v.kind !== 'string' || !LINK_KIND_SET.has(v.kind)) return null

  switch (v.kind) {
    case 'story':
      return typeof v.id === 'string' && v.id
        ? { kind: 'story', id: v.id, ...str(v, 'anchor'), ...blank(v) }
        : null
    case 'url':
      // The one field whose stored value reaches an `href` untouched.
      return typeof v.url === 'string' && v.url && isSafeHref(v.url)
        ? { kind: 'url', url: v.url, ...str(v, 'rel'), ...blank(v) }
        : null
    case 'email':
      return typeof v.email === 'string' && v.email
        ? { kind: 'email', email: v.email, ...str(v, 'subject') }
        : null
    case 'anchor':
      return typeof v.anchor === 'string' && v.anchor ? { kind: 'anchor', anchor: v.anchor } : null
    case 'asset': {
      const asset = asAsset(v.asset)
      return asset ? { kind: 'asset', asset, ...blank(v) } : null
    }
  }
  return null
}

const IMAGE_EXT = /\.(avif|gif|jpe?g|png|svg|webp)$/i

/**
 * Tolerates the URL string that `asset()` used to store, so documents written
 * before the field grew up keep rendering. Durable Object state outlives a
 * schema change, so this is not hypothetical.
 *
 * `url` goes through the same allow-list as a link's: it reaches an `href` through
 * an asset link and a `src` through `resolveAsset`, and an import or an API write
 * can put anything there. A key-only asset is unaffected — its src is built from
 * `assetBase`. An asset whose only location is refused is not renderable, so it
 * reads as absent, like one with neither key nor url.
 */
export function asAsset(value: unknown): AssetValue | null {
  if (typeof value === 'string') {
    if (!value || !isSafeHref(value)) return null
    const filename = value.split('?')[0]!.split('/').pop() || 'image'
    return { url: value, filename, contentType: guessType(filename), size: 0, alt: '' }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const key = typeof v.key === 'string' && v.key ? v.key : undefined
  const url = typeof v.url === 'string' && v.url && isSafeHref(v.url) ? v.url : undefined
  if (!key && !url) return null

  return {
    ...(key ? { key } : {}),
    ...(url ? { url } : {}),
    filename:
      typeof v.filename === 'string' && v.filename
        ? v.filename
        : (key ?? url ?? '').split('/').pop()!,
    contentType: typeof v.contentType === 'string' ? v.contentType : '',
    size: typeof v.size === 'number' ? v.size : 0,
    ...(typeof v.width === 'number' ? { width: v.width } : {}),
    ...(typeof v.height === 'number' ? { height: v.height } : {}),
    alt: typeof v.alt === 'string' ? v.alt : '',
    ...(focalOf(v.focal) ? { focal: focalOf(v.focal)! } : {}),
  }
}

/** A `multiasset` value, with anything unreadable dropped rather than rendered. */
export function asAssets(value: unknown): AssetValue[] {
  if (!Array.isArray(value)) {
    const one = asAsset(value)
    return one ? [one] : []
  }
  return value.map(asAsset).filter((a): a is AssetValue => a !== null)
}

/**
 * A `references` value (`../../docs/specs/content-model/data-documents.md`):
 * story ids in the editor's chosen order, with anything unreadable dropped.
 *
 * A bare string is tolerated the same way `asAssets` tolerates a single asset —
 * a value from an importer, or a `reference` field widened to `references` by a
 * content migration, reads as a one-element list rather than as nothing.
 *
 * Duplicates are dropped. The same document twice in one hand-picked list has no
 * sensible rendering, and keeping both would make `max` count something the
 * editor cannot see.
 */
export function asStoryIds(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value]
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry || seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out
}

function focalOf(value: unknown): FocalPoint | null {
  if (!value || typeof value !== 'object') return null
  const { x, y } = value as Record<string, unknown>
  if (typeof x !== 'number' || typeof y !== 'number') return null
  return { x: clamp01(x), y: clamp01(y) }
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)

export function isImageAsset(asset: AssetValue): boolean {
  return asset.contentType.startsWith('image/') || IMAGE_EXT.test(asset.filename)
}

function guessType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'svg') return 'image/svg+xml'
  return IMAGE_EXT.test(`.${ext}`) ? `image/${ext}` : ''
}

function str<K extends string>(v: Record<string, unknown>, key: K) {
  const raw = v[key]
  return (typeof raw === 'string' && raw ? { [key]: raw } : {}) as { [P in K]?: string }
}

function blank(v: Record<string, unknown>) {
  return (v.target === '_blank' ? { target: '_blank' } : {}) as { target?: '_blank' }
}

/** Whether a link has enough filled in to be worth rendering. */
export function isLinkEmpty(value: unknown): boolean {
  return asLink(value) === null
}
