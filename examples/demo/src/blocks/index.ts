import { button } from './button'
import { cta } from './cta'
import { embed, section } from './embed'
import { feature, features } from './features'
import { hero } from './hero'
import { insightPage } from './insight'
import { gallery, image } from './media'
import { page } from './page'
import { personCard, personRecord } from './person'
import { prose, pullquote } from './prose'
import { settingsRoot } from './settings'

/**
 * The only thing this project hands to Folio. The Worker renders with it, the
 * Vite plugin feeds it to the preview bundle, and the admin learns about it
 * over HTTP as plain schema.
 */
export const blocks = [
  // Document roots, one per type declared in src/index.tsx
  // (docs/specs/foundation/document-types.md). Ordinary blocks in every other
  // respect: the only thing that makes one a root is a type naming it.
  page,
  insightPage,
  personRecord,
  settingsRoot,
  // Content blocks.
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
  personCard,
]
