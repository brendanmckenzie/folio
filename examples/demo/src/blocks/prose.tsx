import { defineBlock, richtext, select, text } from 'folio/core'

export const prose = defineBlock({
  name: 'prose',
  label: 'Prose',
  summary: 'heading',
  fields: {
    heading: text({ label: 'Heading', translatable: true }),
    // Arrives already rendered, so there is no way to reach the page without
    // going through sanitising and link resolution.
    // Translatable, so two whole ProseMirror trees can live in one blok — one per
    // locale (`content-model/localisation.md`). Last-write-wins per locale, as it
    // already is per field.
    body: richtext({
      label: 'Body',
      headingLevels: [2, 3],
      help: 'Links to other pages follow them when those pages are renamed.',
      translatable: true,
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
  summary: 'credit',
  fields: {
    quote: richtext({
      label: 'Quote',
      marks: ['bold', 'italic', 'link'],
      nodes: ['paragraph'],
      translatable: true,
    }),
    /**
     * Renamed from `attribution` (`src/migrations.ts`, `0001`). The old key is
     * still sitting in every document written before the rename, which is
     * exactly the problem `docs/specs/foundation/schema-migrations.md` exists
     * to solve: nothing reads it, nothing renders it, and the field the admin
     * now draws is empty.
     */
    credit: text({ label: 'Credit', translatable: true }),
    /**
     * Added after the block already existed, so documents written before it
     * have no `tone` key at all — `Field.default` is read at *creation* only.
     * `0002` fills the gap retroactively with `field.default`.
     */
    tone: select({
      label: 'Tone',
      options: [
        { label: 'Quiet', value: 'quiet' },
        { label: 'Loud', value: 'loud' },
      ],
      default: 'quiet',
    }),
  },
  render: ({ quote, credit, tone }) => (
    <figure className="pullquote" data-tone={tone || 'quiet'}>
      <blockquote className="pullquote__body">{quote}</blockquote>
      {credit ? <figcaption className="pullquote__by">{credit}</figcaption> : null}
    </figure>
  ),
})
