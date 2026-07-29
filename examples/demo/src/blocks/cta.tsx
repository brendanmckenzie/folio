import { defineBlock, blocks, text, textarea } from 'folio/core'

export const cta = defineBlock({
  name: 'cta',
  label: 'Call to action',
  summary: 'heading',
  fields: {
    heading: text({ label: 'Heading', required: true, translatable: true }),
    body: textarea({ label: 'Body', rows: 2, translatable: true }),
    actions: blocks({ label: 'Actions', allow: ['button'], max: 2 }),
  },
  render: ({ heading, body, actions }) => (
    <section className="cta">
      <div className="cta__inner">
        <h2 className="cta__heading">{heading || 'Untitled'}</h2>
        {body ? <p className="cta__body">{body}</p> : null}
        <div className="cta__actions">{actions}</div>
      </div>
    </section>
  ),
})
