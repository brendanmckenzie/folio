import { asset, blocks, defineBlock, multilink, select, text, textarea } from 'folio/core'

/**
 * A block is a schema and a renderer in one file. The admin form, the prop
 * types and the HTML all come from this declaration, so they cannot drift.
 */
export const hero = defineBlock({
  name: 'hero',
  label: 'Hero',
  summary: 'heading',
  fields: {
    heading: text({ label: 'Heading', required: true }),
    body: textarea({ label: 'Body', rows: 3 }),
    image: asset({ label: 'Background image', accept: 'image/*' }),
    align: select({
      label: 'Alignment',
      options: [
        { label: 'Left', value: 'left' },
        { label: 'Centre', value: 'center' },
      ],
      // Read at creation only: a new hero starts centred rather than landing on
      // the first option by accident. Adding a `default` later does nothing to
      // documents that already exist — that is what a content migration is for.
      default: 'center',
    }),
    // A nested slot. `allow` lists the block types that may go in it.
    actions: blocks({ label: 'Actions', allow: ['button'], max: 2 }),
  },
  // `align` is typed 'left' | 'center'. `actions` arrives already rendered, and
  // an `asset` arrives as an object that knows how to resize itself.
  render: ({ heading, body, image, align, actions }) => (
    <section
      className={`hero hero--${align}`}
      style={
        image
          ? {
              backgroundImage: `linear-gradient(rgba(12,14,20,.5),rgba(12,14,20,.7)), url(${image.srcFor({ width: 1800, fit: 'cover', format: 'webp' })})`,
              backgroundPosition: image.objectPosition,
            }
          : undefined
      }
      data-has-image={image ? 'true' : 'false'}
    >
      <div className="hero__inner">
        <h1 className="hero__heading">{heading || 'Untitled'}</h1>
        {body ? <p className="hero__body">{body}</p> : null}
        <div className="hero__actions">{actions}</div>
      </div>
    </section>
  ),
})

/**
 * Goes in the hero's `actions` slot.
 *
 * A `multilink` arrives **already resolved**: an internal link stores the target
 * document's *id*, and `href` is that document's current path at render time —
 * so renaming the page this points at fixes the button without anybody touching
 * this document. A stored URL could not do that.
 */
export const button = defineBlock({
  name: 'button',
  label: 'Button',
  summary: 'label',
  fields: {
    label: text({ label: 'Label', required: true }),
    href: multilink({ label: 'Link' }),
    variant: select({
      label: 'Variant',
      options: [
        { label: 'Primary', value: 'primary' },
        { label: 'Ghost', value: 'ghost' },
      ],
      default: 'primary',
    }),
  },
  render: ({ label, href, variant }) => (
    <a
      className={`button button--${variant}`}
      href={href?.href ?? '#'}
      target={href?.target}
      rel={href?.rel}
      // The link's target was deleted. Worth styling rather than hiding.
      data-broken={href?.broken ? 'true' : undefined}
    >
      {label || 'Button'}
    </a>
  ),
})
