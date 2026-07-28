import { defineBlock, richtext, select, text } from 'folio/core'

export const prose = defineBlock({
  name: 'prose',
  label: 'Prose',
  summary: 'heading',
  fields: {
    heading: text({ label: 'Heading' }),
    // Arrives already rendered, so there is no way to reach the page without
    // going through sanitising and link resolution.
    body: richtext({
      label: 'Body',
      headingLevels: [2, 3],
      help: 'Links to other pages follow them when those pages are renamed.',
    }),
    width: select({
      label: 'Measure',
      options: [
        { label: 'Narrow', value: 'narrow' },
        { label: 'Wide', value: 'wide' },
      ],
    }),
  },
  render: ({ heading, body, width }) => (
    <section className={`prose prose--${width}`}>
      {heading ? <h2 className="prose__heading">{heading}</h2> : null}
      <div className="prose__body">{body}</div>
    </section>
  ),
})

/**
 * A deliberately constrained field: bold, italic and links only, with no block
 * structure beyond a paragraph. The toolbar shrinks to match, and pasted HTML is
 * stripped down on the way in because the editor's schema has nowhere to put it.
 */
export const pullquote = defineBlock({
  name: 'pullquote',
  label: 'Pull quote',
  summary: 'attribution',
  fields: {
    quote: richtext({ label: 'Quote', marks: ['bold', 'italic', 'link'], nodes: ['paragraph'] }),
    attribution: text({ label: 'Attribution' }),
  },
  render: ({ quote, attribution }) => (
    <figure className="pullquote">
      <blockquote className="pullquote__body">{quote}</blockquote>
      {attribution ? <figcaption className="pullquote__by">{attribution}</figcaption> : null}
    </figure>
  ),
})
