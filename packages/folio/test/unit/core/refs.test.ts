import { describe, expect, it } from 'vitest'
import type { Blok, Doc, Json } from '../../../src/core/doc'
import { asset, multiasset, multilink, reference, richtext, text } from '../../../src/core/fields'
import { assetKeys, linkedIds, outboundRefs, referencedIdsAllLocales } from '../../../src/core/refs'
import type { SchemaIndex } from '../../../src/core/schema'

/**
 * The outbound edge walk (`collections.md` decisions 3 and 6).
 *
 * The reason this file exists in one sentence: **a story link inside richtext has
 * no href.** A Folio-native link mark stores a structured `attrs.link`
 * (`{ kind: 'story', id }`) and the href is derived from the resolution at render
 * time, which is what lets an internal prose link survive the linked page being
 * renamed. Narrowing `resolve()` to `multilink` and `reference` fields alone would
 * render every one of those as unstyled text with no `<a>` — a bug this codebase
 * has already had once, from the other direction (the sanitiser stripped the mark).
 * The sanitiser's own tests cannot catch it, because they test the sanitiser.
 */

const schema: SchemaIndex = {
  prose: {
    name: 'prose',
    label: 'Prose',
    fields: { body: richtext({ translatable: true }), heading: text() },
  },
  cta: {
    name: 'cta',
    label: 'CTA',
    fields: { link: multilink(), label: text() },
  },
  card: {
    name: 'card',
    label: 'Card',
    fields: { who: reference({ types: ['person'] }) },
  },
  hero: {
    name: 'hero',
    label: 'Hero',
    fields: { image: asset({ translatable: true }), gallery: multiasset() },
  },
}

/** An `AssetValue` as a field stores one: a key, and the metadata copied in when
 * it was picked. */
const assetValue = (key: string): Json =>
  ({
    key,
    filename: key.split('-').slice(1).join('-'),
    contentType: 'image/png',
    size: 9,
    alt: '',
  }) as Json

/** A ProseMirror doc whose only asset is inside a link mark — how "download the
 * brochure" is stored inside prose. */
const proseLinkingToAsset = (key: string): Json =>
  ({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'the brochure',
            marks: [{ type: 'link', attrs: { link: { kind: 'asset', asset: assetValue(key) } } }],
          },
        ],
      },
    ],
  }) as unknown as Json

function blok(uid: string, type: string, data: Record<string, Json>, i18n?: Blok['i18n']): Blok {
  return { uid, type, parent: null, slot: null, order: 'a0', data, ...(i18n ? { i18n } : {}) }
}

const docOf = (...bloks: Blok[]): Doc => ({
  root: bloks[0]!.uid,
  bloks: Object.fromEntries(bloks.map((b) => [b.uid, b])),
})

/** A ProseMirror doc whose only story reference is inside a link mark. */
const proseLinkingTo = (id: string): Json =>
  ({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'see ' },
          {
            type: 'text',
            text: 'the policy',
            marks: [{ type: 'link', attrs: { link: { kind: 'story', id } } }],
          },
        ],
      },
    ],
  }) as unknown as Json

describe('linkedIds', () => {
  it('finds a story id reachable ONLY from a richtext link mark', () => {
    const ids = linkedIds(
      docOf(blok('r0', 'prose', { body: proseLinkingTo('sty_policy') })),
      schema,
    )
    expect(ids).toEqual(['sty_policy'])
  })

  it('finds one inside a TRANSLATED richtext value the source does not link to', () => {
    const ids = linkedIds(
      docOf(
        blok(
          'r0',
          'prose',
          { body: proseLinkingTo('sty_en') },
          { fr: { body: proseLinkingTo('sty_fr') } },
        ),
      ),
      schema,
    )
    expect(ids.sort()).toEqual(['sty_en', 'sty_fr'])
  })

  it('finds multilink story targets, and ignores every other link kind', () => {
    const ids = linkedIds(
      docOf(
        blok('r0', 'cta', { link: { kind: 'story', id: 'sty_about' } }),
        blok('k1', 'cta', { link: { kind: 'url', url: 'https://example.com' } }),
        blok('k2', 'cta', { link: { kind: 'email', email: 'a@b.co' } }),
        blok('k3', 'cta', { link: null }),
      ),
      schema,
    )
    expect(ids).toEqual(['sty_about'])
  })

  it('ignores a bare-href link mark, which carries no story id at all', () => {
    const imported = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: '/about' } }] },
          ],
        },
      ],
    } as unknown as Json
    expect(linkedIds(docOf(blok('r0', 'prose', { body: imported })), schema)).toEqual([])
  })

  it('is total over junk: a richtext value that is not a document, marks that are not objects', () => {
    const junk = { type: 'doc', content: [null, 7, { type: 'paragraph', marks: 'nope' }] }
    expect(linkedIds(docOf(blok('r0', 'prose', { body: junk as never })), schema)).toEqual([])
    expect(linkedIds(docOf(blok('r0', 'prose', { body: 42 })), schema)).toEqual([])
  })

  it('says nothing about a block type the schema does not know', () => {
    expect(
      linkedIds(docOf(blok('r0', 'mystery', { link: { kind: 'story', id: 'x' } })), schema),
    ).toEqual([])
  })

  it('de-duplicates two links to the same story', () => {
    const ids = linkedIds(
      docOf(
        blok('r0', 'prose', { body: proseLinkingTo('sty_one') }),
        blok('k1', 'cta', { link: { kind: 'story', id: 'sty_one' } }),
      ),
      schema,
    )
    expect(ids).toEqual(['sty_one'])
  })
})

describe('referencedIdsAllLocales', () => {
  it('includes a target only a translation points at', () => {
    const ids = referencedIdsAllLocales(
      docOf(blok('r0', 'card', { who: 'per_en' }, { fr: { who: 'per_fr' } })),
      schema,
    )
    expect(ids.sort()).toEqual(['per_en', 'per_fr'])
  })
})

/**
 * `assetKeys`, and the reason it walks four field shapes rather than two.
 *
 * `asset()` and `multiasset()` are the obvious pair. A `multilink` and a richtext
 * link mark can each hold `{ kind: 'asset', asset }` too, which is how a download
 * button and a PDF link inside prose are stored — so walking only the two asset
 * field kinds would tell an editor a file is unused while three pages link to it.
 * That is a confidently wrong answer in a delete confirmation, which is the worst
 * place for one.
 */
describe('assetKeys', () => {
  it('finds an `asset` field, including one only a translation sets', () => {
    const keys = assetKeys(
      docOf(
        blok(
          'r0',
          'hero',
          { image: assetValue('ast_en-en.png') },
          { fr: { image: assetValue('ast_fr-fr.png') } },
        ),
      ),
      schema,
    )
    expect(keys.sort()).toEqual(['ast_en-en.png', 'ast_fr-fr.png'])
  })

  it('finds every member of a `multiasset` list', () => {
    const keys = assetKeys(
      docOf(
        blok('r0', 'hero', { gallery: [assetValue('ast_a-a.png'), assetValue('ast_b-b.png')] }),
      ),
      schema,
    )
    expect(keys.sort()).toEqual(['ast_a-a.png', 'ast_b-b.png'])
  })

  it('finds an asset reachable ONLY from a multilink — a download button', () => {
    const keys = assetKeys(
      docOf(blok('r0', 'cta', { link: { kind: 'asset', asset: assetValue('ast_pdf-deck.pdf') } })),
      schema,
    )
    expect(keys).toEqual(['ast_pdf-deck.pdf'])
  })

  it('finds an asset reachable ONLY from a richtext link mark', () => {
    const keys = assetKeys(
      docOf(blok('r0', 'prose', { body: proseLinkingToAsset('ast_bro-brochure.pdf') })),
      schema,
    )
    expect(keys).toEqual(['ast_bro-brochure.pdf'])
  })

  it('ignores an externally hosted asset, which has no library row to be used', () => {
    // A `url`-only `AssetValue` lives in somebody else's bucket, so there is nothing
    // for a usage panel to be about and nothing a delete here could break.
    const external = { url: 'https://cdn.example.com/x.png', filename: 'x.png' } as Json
    expect(
      assetKeys(docOf(blok('r0', 'hero', { image: external, gallery: [external] })), schema),
    ).toEqual([])
    // Same for the legacy bare-string form `asset()` used to store.
    expect(
      assetKeys(docOf(blok('r0', 'hero', { image: 'https://cdn.example.com/y.png' })), schema),
    ).toEqual([])
  })

  it('de-duplicates one asset used four ways in one document', () => {
    const key = 'ast_one-one.png'
    const keys = assetKeys(
      docOf(
        blok('r0', 'hero', { image: assetValue(key), gallery: [assetValue(key)] }),
        blok('k1', 'cta', { link: { kind: 'asset', asset: assetValue(key) } }),
        blok('k2', 'prose', { body: proseLinkingToAsset(key) }),
      ),
      schema,
    )
    expect(keys).toEqual([key])
  })

  it('is total over junk and over a block type the schema does not know', () => {
    expect(assetKeys(docOf(blok('r0', 'hero', { image: 42, gallery: 'nope' })), schema)).toEqual([])
    expect(
      assetKeys(docOf(blok('r0', 'mystery', { image: assetValue('ast_x-x.png') })), schema),
    ).toEqual([])
  })
})

describe('outboundRefs', () => {
  it('labels each edge and keeps both kinds for the same target', () => {
    const doc = docOf(
      blok('r0', 'prose', { body: proseLinkingTo('sty_x') }),
      blok('k1', 'card', { who: 'sty_x' }),
    )
    expect(outboundRefs(doc, schema, 'sty_from')).toEqual([
      { to: 'sty_x', kind: 'link' },
      { to: 'sty_x', kind: 'reference' },
    ])
  })

  it('drops a self-edge: a page linking to itself is not a usage to warn about', () => {
    const doc = docOf(blok('r0', 'prose', { body: proseLinkingTo('sty_me') }))
    expect(outboundRefs(doc, schema, 'sty_me')).toEqual([])
  })

  it('appends asset edges last, as one kind however the asset was reached', () => {
    // A page that embeds a photograph AND links to it is *one* usage: `kind` is part
    // of `content_refs`' primary key, so two kinds would make it count twice in a
    // warning whose whole job is to say how many documents are affected.
    const key = 'ast_logo-logo.svg'
    const doc = docOf(
      blok('r0', 'hero', { image: assetValue(key) }),
      blok('k1', 'cta', { link: { kind: 'asset', asset: assetValue(key) } }),
      blok('k2', 'card', { who: 'sty_ada' }),
    )
    expect(outboundRefs(doc, schema, 'sty_from')).toEqual([
      { to: 'sty_ada', kind: 'reference' },
      { to: key, kind: 'asset' },
    ])
  })
})
