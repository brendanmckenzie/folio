import { defineBlock, multilink, select, text } from 'folio/core'

export const button = defineBlock({
  name: 'button',
  label: 'Button',
  summary: 'label',
  fields: {
    label: text({ label: 'Label', required: true }),
    // Arrives resolved: `href` is already the target's current path, so renaming
    // the page this points at updates the button without touching the document.
    href: multilink({ label: 'Link' }),
    variant: select({
      label: 'Variant',
      options: [
        { label: 'Primary', value: 'primary' },
        { label: 'Ghost', value: 'ghost' },
      ],
    }),
  },
  render: ({ label, href, variant }) => (
    <a
      className={`btn btn--${variant}`}
      href={href?.href ?? '#'}
      target={href?.target}
      rel={href?.rel}
      data-broken={href?.broken ? 'true' : undefined}
    >
      {label || 'Button'}
    </a>
  ),
})
