import type { CSSProperties } from 'react'
import { defineBlock, blocks, number, text, textarea } from 'folio/core'

export const features = defineBlock({
  name: 'features',
  label: 'Feature grid',
  summary: 'heading',
  fields: {
    heading: text({ label: 'Heading' }),
    columns: number({ label: 'Columns', min: 2, max: 4 }),
    items: blocks({ label: 'Features', allow: ['feature'] }),
  },
  render: ({ heading, columns, items }) => (
    <section className="features">
      {heading ? <h2 className="features__heading">{heading}</h2> : null}
      <div className="features__grid" style={{ '--cols': Math.min(Math.max(columns || 3, 1), 4) } as CSSProperties}>
        {items}
      </div>
    </section>
  ),
})

export const feature = defineBlock({
  name: 'feature',
  label: 'Feature',
  summary: 'title',
  fields: {
    icon: text({ label: 'Icon', help: 'Any emoji or short glyph' }),
    title: text({ label: 'Title', required: true }),
    body: textarea({ label: 'Body', rows: 3 }),
  },
  render: ({ icon, title, body }) => (
    <article className="feature">
      {icon ? <div className="feature__icon">{icon}</div> : null}
      <h3 className="feature__title">{title || 'Untitled'}</h3>
      {body ? <p className="feature__body">{body}</p> : null}
    </article>
  ),
})
