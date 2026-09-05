/**
 * Visitor access, the pure half (`../../docs/specs/platform/visitor-access.md`).
 *
 * A site whose membership lives outside Folio — the host's own accounts, Auth0,
 * Memberstack — has pages only members may read. Folio never learns who a
 * visitor is: the host answers that, and everything here is a function of the
 * document alone, so the three rules that decide what a stranger sees are
 * testable without a request, a binding or a membership provider.
 *
 * Three rules, and each is a place the design could fail in the disclosure
 * direction:
 *
 *   - **`gateValue` reads `data`, never `i18n`.** Decision 2, and the one
 *     deliberate exception to the repo-wide "read fields through `fieldValue`"
 *     rule. See the read itself.
 *   - **`isUngated` is strict equality.** One named value means "no gate";
 *     anything else — including no value at all — reaches the host's `allows`.
 *     Fail closed on a missing key (checkpoint 2).
 *   - **`redactDoc` drops the prose, keeps the metadata.** What a denied
 *     visitor is handed is a teaser, and a teaser is exactly the set of values
 *     a `collection` card already renders from.
 */
import type { Blok, Doc, Json } from './doc'
import type { SchemaIndex } from './schema'

/**
 * What `reader.page()` decided about this render.
 *
 * `'public'` is the un-gated case *and* the case of a host with no `gate`
 * configured at all, so a host that branches on `access` sees a meaningful value
 * on every deployment rather than `undefined` on most of them. `'granted'` and
 * `'denied'` both mean the answer varied by visitor, which is why both are
 * `private, no-store` (decision 5) — a cached teaser would be served from the
 * edge to a member who signed in a second later.
 */
export type PageAccess = 'public' | 'granted' | 'denied'

/**
 * The gate field's stored value on a document's root block, or `undefined` when
 * the document has no such key.
 *
 * **Read from `data`, never through `fieldValue` or `dataOf`, and that is not an
 * oversight** (`visitor-access.md` decision 2). Everywhere else in Folio an
 * `i18n` value wins over `data` unconditionally, because un-marking a field
 * `translatable` must not hide content somebody already translated. Applied to a
 * gate, that same rule is a hole: a French translation of "members" that reads
 * "public" would open the English page to anyone who asks in French. So the gate
 * reads the source value and only the source value, `validateGate` refuses a
 * `translatable` gate field at construction, and a locale value an importer put
 * there anyway is ignored here and reported by `/folio/audit`.
 */
export function gateValue(doc: Doc, field: string): Json | undefined {
  return doc.bloks[doc.root]?.data[field]
}

/**
 * Is this document's gate value the one that means "no gate".
 *
 * Strict equality, deliberately: `0`, `false` and `''` are three different
 * values, and an absent field is none of them. A gate that treated them as
 * interchangeable would make `public: 0` open every page whose field is empty.
 */
export function isUngated(
  value: Json | undefined,
  publicValue: string | number | boolean,
): boolean {
  return value === publicValue
}

/**
 * The document a denied visitor is handed: the root block, minus its prose.
 *
 * Every child blok is dropped — so every `blocks` slot is empty by construction,
 * whichever slot the children were in — and every `richtext` field the root
 * itself declares is nulled, in `data` and in every locale of `i18n`. What
 * survives is the root's scalars, assets, links and references, which is page
 * metadata by the sanctioned model (`README.md`'s "page metadata lives on the
 * root block") and the same set a `collection` item draws a card from.
 *
 * The host renders `<Page doc={page.doc}>` unchanged and puts its paywall where
 * the body was: `RenderBlok` hands a nulled richtext through `asRichtext`, which
 * answers `null`, and draws an empty `blocks` slot as nothing outside edit mode.
 *
 * **Rejected: hand back the whole document and let the host promise not to
 * render the body.** That is the `cacheHeaders`/`noStore` trap again — two
 * shapes that look interchangeable, one of which leaks, and the leaking one
 * being the default.
 */
export function redactDoc(doc: Doc, schema: SchemaIndex): Doc {
  const root = doc.bloks[doc.root]
  // A document whose root blok is missing has no metadata to show either. Answer
  // the same empty shape rather than `doc`, so a corrupt document cannot be the
  // one input that hands a stranger the body.
  if (!root) return { root: doc.root, bloks: {} }

  const prose = Object.entries(schema[root.type]?.fields ?? {})
    .filter(([, field]) => field.kind === 'richtext')
    .map(([name]) => name)

  const data = { ...root.data }
  for (const name of prose) data[name] = null

  let i18n = root.i18n
  if (i18n && prose.length > 0) {
    const nulled: Record<string, Record<string, Json>> = {}
    for (const [code, map] of Object.entries(i18n)) {
      const next = { ...map }
      for (const name of prose) next[name] = null
      nulled[code] = next
    }
    i18n = nulled
  }

  const redacted: Blok = { ...root, data, ...(i18n ? { i18n } : {}) }
  return { root: doc.root, bloks: { [doc.root]: redacted } }
}
