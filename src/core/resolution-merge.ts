import type { Doc } from "./doc";
import type { Resolution } from "./resolve";

/**
 * The resolution a **record preview** renders the host page with
 * (`DocumentType.previewPath` on a `record`), and the one function both ends build it
 * with: the server (`previewPage`) to render the markup, and the preview client
 * (`mountPreview`) to hydrate it and to re-render per keystroke. Two assemblies of one
 * value would be a hydration mismatch waiting for a field to be added to one of them,
 * which React reports and then silently answers by discarding the server markup.
 *
 * - `page` is the host page's own resolution: its links, collections, globals, forms,
 *   locale and site. It is the base, and **nothing the record's resolution carries
 *   replaces it**, so no frame can wipe the page's own content.
 * - `overlay` is the record's own resolution (the server's `brand.resolve` over its
 *   draft; on the client, whatever the admin last posted). Its `stories`, `docs`,
 *   `forms` and `collections` are unioned in under the page's, which is what lets a
 *   link or a reference the editor has just added to the record resolve.
 * - The record itself is the exception in both directions: `docs[id]` is always `doc`,
 *   the live draft (the preview applies the editor's mutations to it per keystroke),
 *   and `stories[id]` is the overlay's, because that is where a rename lands first.
 *
 * Pure, and it returns a new object each time without mutating either input.
 */
export function recordResolution(
  page: Resolution,
  overlay: Resolution | undefined,
  id: string,
  doc: Doc,
): Resolution {
  const stories = { ...overlay?.stories, ...page.stories };
  const own = overlay?.stories[id] ?? page.stories[id];
  if (own) stories[id] = own;
  const docs = { ...overlay?.docs, ...page.docs, [id]: doc };
  const forms = { ...overlay?.forms, ...page.forms };
  const collections = { ...overlay?.collections, ...page.collections };
  return {
    ...page,
    stories,
    docs,
    // Absent rather than `{}` when neither side has any, the bootstrap-identical rule
    // `Resolution.forms` states, so a page with none renders as it always did.
    ...(Object.keys(forms).length > 0 ? { forms } : {}),
    ...(Object.keys(collections).length > 0 ? { collections } : {}),
    record: id,
  };
}
