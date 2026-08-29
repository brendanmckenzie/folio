/**
 * The richtext document model.
 *
 * This is ProseMirror's JSON shape, because TipTap sits on ProseMirror and
 * fighting its document model would mean reimplementing `y-prosemirror`. A whole
 * tree is one field value, which makes concurrent edits to the same field
 * last-write-wins — the same semantics a `text` field already has. Richtext is
 * not special.
 *
 * Nothing in this file may import TipTap. It is shared with the renderer, and the
 * renderer runs in the Worker and in the preview client, where pulling in an
 * editor would be absurd.
 */

import { asLink, isSafeHref } from './values'

/** Node names, matching TipTap's own. */
export type RichtextNodeName =
  | 'paragraph'
  | 'heading'
  | 'bulletList'
  | 'orderedList'
  | 'listItem'
  | 'blockquote'
  | 'codeBlock'
  | 'horizontalRule'
  | 'hardBreak'

export type RichtextMarkName =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'code'
  | 'subscript'
  | 'superscript'
  | 'link'

export const RICHTEXT_NODES: readonly RichtextNodeName[] = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'hardBreak',
]

export const RICHTEXT_MARKS: readonly RichtextMarkName[] = [
  'bold',
  'italic',
  'underline',
  'strike',
  'code',
  'subscript',
  'superscript',
  'link',
]

export interface RichtextMark {
  type: string
  attrs?: Record<string, unknown>
}

export interface RichtextNode {
  type: string
  content?: RichtextNode[]
  marks?: RichtextMark[]
  attrs?: Record<string, unknown>
  text?: string
}

/** The stored value: a ProseMirror doc, or null when the field is empty. */
export type RichtextDoc = { type: 'doc'; content?: RichtextNode[] } | null

export const EMPTY_DOC = { type: 'doc' as const, content: [{ type: 'paragraph' }] }

/**
 * Nodes that always survive, whatever a field permits. `doc` and `text` are
 * structural, and `listItem` is implied by allowing either list — a list whose
 * items were stripped is not a list.
 */
const STRUCTURAL = new Set(['doc', 'text'])

export interface RichtextLimits {
  marks?: readonly RichtextMarkName[]
  nodes?: readonly RichtextNodeName[]
  /** Which levels are offered when `heading` is permitted. */
  headingLevels?: readonly number[]
}

export function asRichtext(value: unknown): RichtextDoc {
  // A plain string is what a `textarea` field stored before this one existed, and
  // what a naive import produces. Blank lines separate paragraphs, matching the
  // convention the placeholder field used, so existing content keeps rendering
  // rather than silently disappearing.
  if (typeof value === 'string') return fromPlainText(value)

  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (v.type !== 'doc') return null
  const content = Array.isArray(v.content) ? (v.content as RichtextNode[]) : undefined
  return content?.length ? { type: 'doc', content } : null
}

export function fromPlainText(text: string): RichtextDoc {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (!paragraphs.length) return null
  return {
    type: 'doc',
    content: paragraphs.map((p) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: p }],
    })),
  }
}

/**
 * Drops nodes and marks the field does not permit.
 *
 * The editor already enforces this — its ProseMirror schema is built from the
 * same limits, so a paste is filtered on the way in. This is the second line:
 * content can also arrive from an import or straight over the API, and a caption
 * field that renders an `<h1>` because something bypassed the editor is exactly
 * the kind of quiet breakage a CMS should not allow.
 *
 * A disallowed node is unwrapped rather than deleted, so its text survives. That
 * matters for paste: dropping a heading should leave the words behind, not a hole.
 *
 * The href scheme pass is not a limit and cannot be configured away: `richtext()`
 * with no arguments is the common field shape, and it is the `limits` the renderer
 * passes, so a fast path keyed on limits alone would exempt exactly the default
 * field from the check.
 */
export function sanitiseRichtext(doc: RichtextDoc, limits: RichtextLimits = {}): RichtextDoc {
  const marks = limits.marks ? new Set<string>(limits.marks) : null
  const nodes = limits.nodes ? new Set<string>(limits.nodes) : null
  const levels = limits.headingLevels ? new Set(limits.headingLevels) : null
  if (!marks && !nodes && !levels && !hasUnsafeHref(doc)) return doc
  if (!doc?.content) return doc

  // Allowing a list implies allowing its items.
  if (nodes && (nodes.has('bulletList') || nodes.has('orderedList'))) nodes.add('listItem')

  // No permitted level leaves no representable heading, so it is unwrapped like
  // any other disallowed node rather than snapped to a level that does not exist.
  const noLevels = levels !== null && levels.size === 0
  const paragraphOk = !nodes || nodes.has('paragraph')

  const walk = (list: unknown): RichtextNode[] =>
    mergeText(
      entries<RichtextNode>(list).flatMap((node): RichtextNode[] => {
        const kids = node.content ? walk(node.content) : undefined

        const unlisted = nodes !== null && !nodes.has(node.type)
        const banned =
          !STRUCTURAL.has(node.type) && (unlisted || (noLevels && node.type === 'heading'))
        if (banned) {
          // Unwrap: keep the words, lose the container. Inline children get a
          // paragraph to live in when one is permitted, matching what the editor
          // does with a pasted heading and avoiding bare text in a block slot.
          if (kids?.length && paragraphOk && kids.every(isInline)) {
            return [{ type: 'paragraph', content: kids }]
          }
          return kids ?? []
        }

        const next: RichtextNode = { ...node }
        if (kids) next.content = kids
        else if (next.content) delete next.content

        if (node.marks) {
          // Scheme filtering applies whatever the mark allow-list says: a link
          // mark's `href` is an href, and `attrs` are as untrusted as the rest.
          const kept = entries<RichtextMark>(node.marks).filter(
            (m) => (!marks || marks.has(m.type)) && safeMark(m),
          )
          if (kept.length) next.marks = kept
          else delete next.marks
        }

        if (levels && node.type === 'heading') {
          const level = Number(node.attrs?.level ?? 2)
          if (!levels.has(level)) {
            // Snap to the nearest permitted level rather than discarding the
            // heading, so document structure survives.
            const nearest = [...levels].sort(
              (a, b) => Math.abs(a - level) - Math.abs(b - level),
            )[0]!
            next.attrs = { ...node.attrs, level: nearest }
          }
        }

        return [next]
      }),
    )

  const content = walk(doc.content)
  return content.length ? { type: 'doc', content } : null
}

/**
 * Walkable entries of a `content` field. Stored documents come from imports, old
 * writers and the API as well as the editor, so `content` may not be an array
 * and its entries may not be nodes. Junk is skipped, never thrown on.
 */
function entries<T>(list: unknown): T[] {
  if (!Array.isArray(list)) return []
  return list.filter((n): n is T => Boolean(n) && typeof n === 'object')
}

/**
 * A link mark survives if it carries something that can become a safe href.
 *
 * Two shapes are legitimate. A Folio-native mark stores a structured `link`
 * (`{ kind: 'story', id }`) and has **no** `href` at all, because the href is
 * derived from the resolution at render time — that is what lets an internal
 * link inside prose survive a page being renamed. A mark from an import or
 * TipTap's own Link extension stores an `href` string instead.
 *
 * Judging only the `href` string stripped every internal link, so prose rendered
 * the text with no anchor around it. `asLink` applies the same scheme filtering
 * to the structured shape (a `url` kind is checked with `isSafeHref` there), so
 * accepting it here does not widen what can reach the page.
 */
function safeMark(mark: RichtextMark): boolean {
  if (mark.type !== 'link') return true
  if (mark.attrs?.link !== undefined) return asLink(mark.attrs.link) !== null
  const href = mark.attrs?.href
  return typeof href === 'string' && isSafeHref(href)
}

/**
 * Whether any mark in the document would be stripped by the href allow-list. This
 * is what the unconfigured fast path tests: with no limits there is nothing else
 * to do, so returning the input document is only correct while every href passes.
 */
function hasUnsafeHref(doc: RichtextDoc): boolean {
  const walk = (nodes: unknown): boolean =>
    entries<RichtextNode>(nodes).some(
      (n) =>
        entries<RichtextMark>(n.marks).some((m) => !safeMark(m)) ||
        (n.content ? walk(n.content) : false),
    )
  return walk(doc?.content)
}

const isInline = (node: RichtextNode) => node.type === 'text' || node.type === 'hardBreak'

/**
 * Folds neighbouring text runs that ended up with the same marks.
 *
 * Stripping a mark leaves `['kept ', 'struck', ' text']` as three separate runs.
 * They render correctly, but React's server output separates adjacent text nodes
 * with `<!-- -->` markers, and the document carries three nodes where one will do.
 */
function mergeText(nodes: RichtextNode[]): RichtextNode[] {
  const out: RichtextNode[] = []
  for (const node of nodes) {
    const prev = out[out.length - 1]
    if (
      node.type === 'text' &&
      prev?.type === 'text' &&
      JSON.stringify(prev.marks ?? null) === JSON.stringify(node.marks ?? null)
    ) {
      out[out.length - 1] = { ...prev, text: `${prev.text ?? ''}${node.text ?? ''}` }
      continue
    }
    out.push(node)
  }
  return out
}

/**
 * Plain text, for excerpts, search indexing and `summary` in the block tree.
 * Block-level nodes are separated by a space so words do not run together.
 */
export function richtextToText(doc: RichtextDoc): string {
  if (!doc?.content) return ''
  const out: string[] = []
  const walk = (nodes: unknown) => {
    for (const node of entries<RichtextNode>(nodes)) {
      if (node.type === 'text' && typeof node.text === 'string') out.push(node.text)
      else if (node.type === 'hardBreak') out.push(' ')
      if (node.content) {
        walk(node.content)
        out.push(' ')
      }
    }
  }
  walk(doc.content)
  return out.join('').replace(/\s+/g, ' ').trim()
}

export function isRichtextEmpty(doc: RichtextDoc): boolean {
  return richtextToText(doc) === '' && !hasNode(doc, ['horizontalRule'])
}

function hasNode(doc: RichtextDoc, types: readonly string[]): boolean {
  if (!doc?.content) return false
  const wanted = new Set(types)
  const walk = (nodes: unknown): boolean =>
    entries<RichtextNode>(nodes).some(
      (n) => wanted.has(n.type) || (n.content ? walk(n.content) : false),
    )
  return walk(doc.content)
}
