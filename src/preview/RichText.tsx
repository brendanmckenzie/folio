import { Fragment, type ReactNode } from 'react'
import { EMPTY_RESOLUTION, resolveLink, type Resolution } from '../core/resolve'
import type { RichtextDoc, RichtextMark, RichtextNode } from '../core/richtext'
import type { Json } from '../core/doc'

/**
 * Renders stored richtext as plain React.
 *
 * Deliberately imports no TipTap. The editor is an admin-bundle concern; a
 * published page walks this JSON on the server and ships no JavaScript at all.
 * Importing an editor here would quietly undo the entire value proposition, which
 * is why `scripts/sync-test.mjs` asserts a published page has no `<script>` tag.
 */
export function RichText({
  doc,
  resolution = EMPTY_RESOLUTION,
}: {
  doc: RichtextDoc
  resolution?: Resolution
}): ReactNode {
  if (!doc?.content) return null
  return <>{renderNodes(doc.content, resolution, 'r')}</>
}

function renderNodes(nodes: readonly RichtextNode[], res: Resolution, path: string): ReactNode[] {
  return nodes.map((node, i) => renderNode(node, res, `${path}.${i}`))
}

function renderNode(node: RichtextNode, res: Resolution, key: string): ReactNode {
  if (node.type === 'text') return renderText(node, res, key)

  const kids = node.content ? renderNodes(node.content, res, key) : null

  switch (node.type) {
    case 'paragraph':
      return <p key={key}>{kids}</p>
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 2)))
      const Tag = `h${level}` as 'h1'
      return <Tag key={key}>{kids}</Tag>
    }
    case 'bulletList':
      return <ul key={key}>{kids}</ul>
    case 'orderedList': {
      const start = Number(node.attrs?.start ?? 1)
      return (
        <ol key={key} start={start !== 1 ? start : undefined}>
          {kids}
        </ol>
      )
    }
    case 'listItem':
      return <li key={key}>{kids}</li>
    case 'blockquote':
      return <blockquote key={key}>{kids}</blockquote>
    case 'codeBlock': {
      const language = node.attrs?.language
      return (
        <pre key={key}>
          <code className={typeof language === 'string' && language ? `language-${language}` : undefined}>
            {kids}
          </code>
        </pre>
      )
    }
    case 'horizontalRule':
      return <hr key={key} />
    case 'hardBreak':
      return <br key={key} />
    default:
      // An unrecognised wrapper keeps its children rather than swallowing them.
      // Content can arrive from an importer that knew about nodes we do not.
      return kids ? <Fragment key={key}>{kids}</Fragment> : null
  }
}

/**
 * Marks are applied in a fixed order so the same document always produces the
 * same HTML, and so a link ends up outermost — `<a><strong>x</strong></a>` rather
 * than a link fragmented across several elements.
 */
const MARK_ORDER: readonly string[] = [
  'code',
  'subscript',
  'superscript',
  'strike',
  'underline',
  'italic',
  'bold',
  'link',
]

function renderText(node: RichtextNode, res: Resolution, key: string): ReactNode {
  let out: ReactNode = node.text ?? ''
  // A Fragment rather than a span: text needs a key inside an array but must not
  // add an element, or every run of prose picks up a stray wrapper.
  if (node.marks?.length) {
    const ordered = [...node.marks].sort((a, b) => indexOfMark(a.type) - indexOfMark(b.type))
    for (const mark of ordered) out = wrap(mark, out, res)
  }
  return <Fragment key={key}>{out}</Fragment>
}

const indexOfMark = (type: string) => {
  const i = MARK_ORDER.indexOf(type)
  return i === -1 ? MARK_ORDER.length : i
}

function wrap(mark: RichtextMark, inner: ReactNode, res: Resolution): ReactNode {
  switch (mark.type) {
    case 'bold':
      return <strong>{inner}</strong>
    case 'italic':
      return <em>{inner}</em>
    case 'underline':
      return <u>{inner}</u>
    case 'strike':
      return <s>{inner}</s>
    case 'code':
      return <code>{inner}</code>
    case 'subscript':
      return <sub>{inner}</sub>
    case 'superscript':
      return <sup>{inner}</sup>
    case 'link': {
      const link = linkOf(mark, res)
      if (!link) return inner
      return (
        <a href={link.href} target={link.target} rel={link.rel} data-broken={link.broken ? 'true' : undefined}>
          {inner}
        </a>
      )
    }
    default:
      return inner
  }
}

/**
 * A link mark stores a `LinkValue`, so an internal link inside prose survives a
 * page being renamed exactly like a `multilink` field does.
 *
 * A bare `href` is also accepted: that is the shape a Storyblok import produces,
 * and the shape TipTap's own Link extension would write.
 */
function linkOf(mark: RichtextMark, res: Resolution) {
  const attrs = mark.attrs ?? {}
  if (attrs.link) return resolveLink(attrs.link as Json, res)
  if (typeof attrs.href === 'string' && attrs.href) {
    return resolveLink(
      {
        kind: 'url',
        url: attrs.href,
        ...(attrs.target === '_blank' ? { target: '_blank' } : {}),
      } as Json,
      res,
    )
  }
  return null
}
