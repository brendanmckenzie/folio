import { button, hero } from './hero'
import { page } from './page'
import { prose } from './prose'

/**
 * The only thing this project hands to Folio.
 *
 * The Worker renders with it, the Vite plugin feeds it to the preview bundle,
 * and the admin learns about it over HTTP as plain schema — which is why the
 * editor never needs rebuilding when you add a block.
 *
 * Adding one is two steps: define it in a file here, and list it below. Then
 * name it in some other block's `blocks({ allow: [...] })` slot so an editor
 * can insert it.
 */
export const blocks = [
  // Document roots, one per type declared in src/index.tsx. Ordinary blocks in
  // every other respect — the only thing that makes one a root is a document
  // type naming it.
  page,
  // Content blocks.
  hero,
  prose,
  button,
]
