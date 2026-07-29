import { asset, defineBlock, multiasset, select, text } from 'folio/core'
import type { ResolvedAsset } from 'folio/core'

/**
 * The widths a responsive image offers. Resizing happens behind Folio's own
 * asset route, so these URLs work identically on a zone, on workers.dev and in
 * `wrangler dev`.
 */
const WIDTHS = [480, 960, 1440, 1920]

function srcSet(image: ResolvedAsset, fit: 'cover' | 'scale-down' = 'scale-down') {
  return WIDTHS.map((w) => `${image.srcFor({ width: w, fit, format: 'webp' })} ${w}w`).join(', ')
}

export const image = defineBlock({
  name: 'image',
  label: 'Image',
  summary: 'caption',
  fields: {
    file: asset({ label: 'Image', accept: 'image/*', required: true }),
    caption: text({ label: 'Caption', translatable: true }),
    ratio: select({
      label: 'Crop',
      options: [
        { label: 'Original proportions', value: 'natural' },
        { label: 'Wide (16:9)', value: 'wide' },
        { label: 'Square', value: 'square' },
      ],
    }),
  },
  render: ({ file, caption, ratio }) => {
    if (!file) return <figure className="image image--empty">No image chosen</figure>

    const cropped = ratio !== 'natural'
    return (
      <figure className={`image image--${ratio}`}>
        <img
          src={file.srcFor({ width: 1440, ...(cropped ? { fit: 'cover' } : {}) })}
          srcSet={srcSet(file, cropped ? 'cover' : 'scale-down')}
          sizes="(min-width: 900px) 880px, 100vw"
          // Known dimensions let the browser reserve space, so the page does not
          // reflow when the image arrives.
          width={file.width}
          height={file.height}
          alt={file.alt}
          loading="lazy"
          decoding="async"
          // Only matters once the box has its own aspect ratio and the image has
          // to be cropped into it.
          style={cropped ? { objectPosition: file.objectPosition } : undefined}
        />
        {caption ? <figcaption>{caption}</figcaption> : null}
      </figure>
    )
  },
})

export const gallery = defineBlock({
  name: 'gallery',
  label: 'Gallery',
  summary: 'heading',
  fields: {
    heading: text({ label: 'Heading', translatable: true }),
    images: multiasset({ label: 'Images', accept: 'image/*', max: 12 }),
  },
  render: ({ heading, images }) => (
    <section className="gallery">
      {heading ? <h2 className="gallery__heading">{heading}</h2> : null}
      <div className="gallery__grid">
        {images.map((img) => (
          <img
            key={img.key ?? img.url}
            src={img.srcFor({ width: 640, height: 640, fit: 'cover' })}
            alt={img.alt}
            loading="lazy"
            decoding="async"
            style={{ objectPosition: img.objectPosition }}
          />
        ))}
      </div>
      {images.length === 0 ? <p className="gallery__empty">No images yet.</p> : null}
    </section>
  ),
})
