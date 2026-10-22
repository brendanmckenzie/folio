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
 *   and `stories[id]` is the overlay's, because that is where a rename lands first:
 *   the admin overlays the open story's row (`useEditor`'s `resolution`) on what it
 *   posts, since the server's own resolution carries no ref for an unrouted record.
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

/**
 * The resolution a **global's** preview (`?as=<global>`) renders with once the admin
 * posts the global's own: the posted one in place, except that the **page's
 * `params`** (its blocks' `previewParams`, which the server bootstrapped) stay. The
 * posted resolution is built from the global's document alone, so without this a
 * global block reading a key only the host page declared would flip to empty after
 * first paint. The page's keys win, as the first declaration of a key does everywhere.
 *
 * Pure, and returns the posted resolution itself when the page held none.
 */
export function globalResolution(initial: Resolution, posted: Resolution): Resolution {
  if (!initial.params) return posted;
  return { ...posted, params: { ...posted.params, ...initial.params } };
}
