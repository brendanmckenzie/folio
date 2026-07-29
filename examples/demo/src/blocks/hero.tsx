import { defineBlock, asset, blocks, select, text, textarea } from 'folio/core'

export const hero = defineBlock({
  name: 'hero',
  label: 'Hero',
  summary: 'heading',
  fields: {
    eyebrow: text({
      label: 'Eyebrow',
      placeholder: 'Small label above the heading',
      translatable: true,
    }),
    heading: text({ label: 'Heading', required: true, translatable: true }),
    body: textarea({ label: 'Body', rows: 3, translatable: true }),
    image: asset({ label: 'Background image', accept: 'image/*' }),
    align: select({
      label: 'Alignment',
      options: [
        { label: 'Left', value: 'left' },
        { label: 'Centre', value: 'center' },
      ],
    }),
    actions: blocks({ label: 'Actions', allow: ['button'], max: 2 }),
  },
  // A background image is decorative, so it goes through CSS and the focal point
  // becomes `background-position` rather than `object-position`.
  render: ({ eyebrow, heading, body, image, align, actions }) => (
    <section
      className={`hero hero--${align}`}
      style={
        image
          ? {
              backgroundImage: `linear-gradient(rgba(12,14,20,.55),rgba(12,14,20,.75)), url(${image.srcFor({ width: 1800, fit: 'cover', format: 'webp' })})`,
              backgroundPosition: image.objectPosition,
            }
          : undefined
      }
      data-has-image={image ? 'true' : 'false'}
    >
      <div className="hero__inner">
        {eyebrow ? <p className="hero__eyebrow">{eyebrow}</p> : null}
        <h1 className="hero__heading">{heading || 'Untitled'}</h1>
        {body ? <p className="hero__body">{body}</p> : null}
        <div className="hero__actions">{actions}</div>
      </div>
    </section>
  ),
})
