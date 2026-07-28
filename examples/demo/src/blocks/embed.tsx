import { blocks, defineBlock, reference, select, text } from 'folio/core'

/**
 * Mirrors the reference project's `Form Selection.form`: pick another story and
 * pull its content in at render time, rather than copying it.
 *
 * Storyblok needs `resolve_relations: 'Form Selection.form'` at the fetch call to
 * make this work. Folio derives the same thing from the schema, so there is no
 * per-call configuration to forget.
 */
export const embed = defineBlock({
  name: 'embed',
  label: 'Embedded page',
  summary: 'heading',
  fields: {
    heading: text({ label: 'Heading' }),
    source: reference({ label: 'Page to embed', help: 'Its content is pulled in at render time.' }),
    mode: select({
      label: 'Show',
      options: [
        { label: 'Its content', value: 'content' },
        { label: 'Just a summary', value: 'summary' },
      ],
    }),
  },
  render: ({ heading, source, mode }) => {
    if (!source) {
      return <section className="embed embed--empty">Nothing selected to embed.</section>
    }
    return (
      <section className="embed">
        <h2 className="embed__heading">{heading || source.title}</h2>
        {mode === 'summary' ? (
          <p className="embed__summary">
            {/* Reading the referenced document's own fields directly. */}
            {String(source.data.description ?? '')}{' '}
            <a href={source.url}>{source.title}</a>
          </p>
        ) : (
          // Inlining it wholesale. Rendered without edit markers, because this
          // content belongs to another story.
          <div className="embed__content">{source.content}</div>
        )}
      </section>
    )
  },
})

/**
 * A container that exists only to prove references nest inside ordinary blocks
 * without special handling.
 */
export const section = defineBlock({
  name: 'section',
  label: 'Section',
  summary: 'heading',
  fields: {
    heading: text({ label: 'Heading' }),
    body: blocks({ label: 'Body', allow: ['embed', 'prose', 'image'] }),
  },
  render: ({ heading, body }) => (
    <section className="section">
      {heading ? <h2 className="section__heading">{heading}</h2> : null}
      {body}
    </section>
  ),
})
