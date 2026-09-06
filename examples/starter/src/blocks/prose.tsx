import { defineBlock, richtext, select, text } from 'folio/core'

export const prose = defineBlock({
  name: 'prose',
  label: 'Prose',
  summary: 'heading',
  fields: {
    heading: text({ label: 'Heading' }),
    /**
     * Richtext arrives **already rendered**, so there is no way to reach the
     * page without going through sanitising and link resolution — a document
     * cannot smuggle markup onto your site through this field.
     *
     * Constrain it per field. `headingLevels: [2, 3]` shrinks the toolbar to
     * match, and pasted HTML is stripped down on the way in because the
     * editor's schema has nowhere to put the rest.
     */
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
      default: 'narrow',
    }),
  },
  render: ({ heading, body, width }) => (
    <section className={`prose prose--${width}`}>
      {heading ? <h2 className="prose__heading">{heading}</h2> : null}
      <div className="prose__body">{body}</div>
    </section>
  ),
})
