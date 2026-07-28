import { button } from './button'
import { cta } from './cta'
import { embed, section } from './embed'
import { feature, features } from './features'
import { hero } from './hero'
import { gallery, image } from './media'
import { page } from './page'
import { prose, pullquote } from './prose'

/**
 * The only thing this project hands to Folio. The Worker renders with it, the
 * Vite plugin feeds it to the preview bundle, and the admin learns about it
 * over HTTP as plain schema.
 */
export const blocks = [
  page,
  hero,
  prose,
  pullquote,
  image,
  gallery,
  features,
  feature,
  cta,
  button,
  embed,
  section,
]
