import { describe, expect, it } from 'vitest'
import {
  blockCards,
  cacheFacts,
  conditionText,
  fieldRow,
  filterBlocks,
  globalRows,
  hookRows,
  isEmpty,
  localeRows,
  matchesQuery,
  openCards,
  parseSettingsUrl,
  providerRows,
  SECTIONS,
  sessionFacts,
  settingsQuery,
  settingsView,
  shownIn,
  typeRows,
  visibleSections,
} from '../../../src/admin/ui/screens/settings-model'
import { indexManifest, type Manifest } from '../../../src/core/schema'
import type { AuthPolicy } from '../../../src/server/auth/config'
import {
  asset,
  blocks,
  collection,
  number,
  richtext,
  select,
  text,
  textarea,
} from '../../../src/core/fields'

/**
 * The Settings screen's arithmetic — `docs/ui-architecture.md`'s port phase 5.
 *
 * No test here mounts a component, because no admin test does (`vitest.config.ts`
 * runs the unit project under `environment: 'node'`), so what is pinned is what a
 * row *says*. Two of those are worth more than the rest and are the reason the
 * file is longer than the screen's markup:
 *
 *   - **`under`**, because an Insight that will not be created at the top level is
 *     the refusal an editor meets and cannot explain, and the consequence of
 *     declaring `under` — that the top level is now closed — is nowhere in the
 *     declaration.
 *   - **`indexed`**, because it silently does nothing on a block that is no
 *     document type's root, and a collection query naming such a field is refused.
 */

const manifest: Manifest = {
  types: [
    { name: 'page', label: 'Page', kind: 'page', root: 'pageRoot', default: true },
    {
      name: 'insight',
      label: 'Insight',
      kind: 'page',
      root: 'insightRoot',
      under: ['page'],
      titleField: 'heading',
    },
    {
      name: 'person',
      label: 'Person',
      kind: 'record',
      root: 'personRoot',
      titleField: 'fullName',
      group: 'Directory',
    },
    { name: 'header', label: 'Header', kind: 'singleton', root: 'headerRoot', previewPath: '' },
    { name: 'seo', label: 'SEO defaults', kind: 'singleton', root: 'seoRoot' },
  ],
  blocks: [
    {
      name: 'pageRoot',
      label: 'Page',
      summary: 'title',
      fields: {
        title: text({ label: 'Title', required: true, indexed: true, translatable: true }),
        body: blocks({ allow: ['hero', 'prose'], max: 20, label: 'Body' }),
      },
    },
    {
      name: 'insightRoot',
      label: 'Insight',
      fields: {
        heading: text({ indexed: true }),
        topic: select({
          options: [
            { label: 'Policy', value: 'policy' },
            { label: 'Design', value: 'design' },
          ],
          indexed: true,
          default: 'policy',
        }),
        related: collection({ type: 'insight', filterable: ['topic'], maxPerPage: 12 }),
      },
    },
    { name: 'personRoot', label: 'Person', fields: { fullName: text({ indexed: true }) } },
    { name: 'headerRoot', label: 'Header', fields: { tagline: text() } },
    { name: 'seoRoot', label: 'SEO defaults', fields: { description: textarea() } },
    {
      name: 'hero',
      label: 'Hero',
      fields: {
        // `indexed` on a block that is nobody's root. The whole point of the
        // `indexedInert` flag.
        eyebrow: text({ indexed: true }),
        layout: select({
          options: [
            { label: 'Full', value: 'full' },
            { label: 'Split', value: 'split' },
          ],
        }),
        image: asset({ showIf: { field: 'layout', eq: 'split' }, accept: 'image/*' }),
        columns: number({ min: 1, max: 4 }),
      },
      presets: [
        { name: 'default', label: 'Default', data: { layout: 'full' } },
        {
          name: 'split',
          label: 'Split hero',
          data: { layout: 'split' },
          children: [{ slot: 'body', type: 'prose' }],
        },
      ],
      presetsOnly: true,
    },
    { name: 'prose', label: 'Prose', fields: { body: richtext({ marks: ['bold'] }) } },
  ],
  root: 'pageRoot',
  globals: ['header'],
  locales: {
    default: 'en',
    available: [
      { code: 'en', label: 'English' },
      { code: 'fr', label: 'Français' },
      { code: 'de', label: 'Deutsch', fallback: 'fr' },
    ],
  },
  hooks: { declared: ['published', 'pathsChanged'], awaited: ['published'] },
}

/**
 * `Me.policy`, from `GET {base}/api/me` — **not from the manifest**, and it is a
 * separate fixture here for the same reason it is a separate argument to
 * `settingsView`: the screen is fed by a public route and a gated one, and the
 * split is a security boundary. `server/auth/config.ts`'s `AuthPolicy` carries the
 * argument; `test/workers/settings-config.test.ts` pins the wire behaviour.
 */
const policy: AuthPolicy = {
  providers: [
    { id: 'link', label: 'Email me a link', redirect: false, provision: 'refuse' },
    {
      id: 'google',
      label: 'Google',
      redirect: true,
      provision: 'create',
      provisionRole: 'editor',
    },
  ],
  sessionDays: 30,
  linksPerHour: 5,
}

const schema = indexManifest(manifest)
const view = (q = '') => settingsView(manifest, schema, policy, q)

/* ---------------------------------------------------------------------- URL --- */

describe('the filter is the URL', () => {
  it('round-trips, and an empty filter leaves the URL rather than sitting in it', () => {
    expect(parseSettingsUrl({})).toEqual({ q: '' })
    expect(parseSettingsUrl({ q: 'hero' })).toEqual({ q: 'hero' })
    expect(settingsQuery({ q: '' })).toEqual({ q: undefined })
    expect(settingsQuery({ q: 'hero' })).toEqual({ q: 'hero' })
  })
})

describe('matchesQuery', () => {
  it('is substring and case-insensitive, per ui-architecture Resolved 7', () => {
    expect(matchesQuery('team', 'Our team')).toBe(true)
    expect(matchesQuery('TEAM', 'Our team')).toBe(true)
    // Not fuzzy. `teem` is a typo, and a schema filter's user knows the name.
    expect(matchesQuery('teem', 'Our team')).toBe(false)
  })

  it('matches everything when nothing is typed, so an unfiltered screen is whole', () => {
    expect(matchesQuery('', 'anything')).toBe(true)
    expect(matchesQuery('   ', 'anything')).toBe(true)
  })
})

/* ----------------------------------------------------------- document types --- */

describe('under, which is the refusal an editor meets', () => {
  const rows = typeRows(manifest, schema)
  const row = (name: string) => rows.find((r) => r.name === name)!

  it('says what a constrained type may sit under, by label and not by name', () => {
    // By label, because the person reading this screen met the refusal in an
    // editor that calls it "Page", not "page".
    expect(row('insight').where).toBe('Only under Page')
  })

  it('reports the top level closed, which the declaration never says', () => {
    // The consequence `canNest` computes and `DocumentType.under`'s doc comment
    // spells out: declaring `under` at all means this type can never sit at the
    // top level, because the top level has no type to match. It is the single most
    // confusing refusal in the product and it is invisible in the config.
    expect(row('insight').topLevel).toBe(false)
    expect(row('page').topLevel).toBe(true)
  })

  it('leaves the question unanswered rather than answered wrongly for a kind that is not in the tree', () => {
    // `null`, not `false`: a record has no position in the tree to be refused,
    // and "no" would read as a constraint somebody could lift.
    expect(row('person').topLevel).toBeNull()
    expect(row('person').where).toMatch(/Not in the tree/)
    expect(row('seo').where).toMatch(/exactly one/)
  })
})

describe('typeRows', () => {
  const rows = typeRows(manifest, schema)
  const row = (name: string) => rows.find((r) => r.name === name)!

  it('resolves a derived title field and marks it derived', () => {
    // `page` declares no `titleField`; `titleFieldOf` finds the root block's own
    // `title`. A blank cell here would be a lie — documents of this type *are*
    // titled from something.
    expect(row('page').titleField).toBe('title')
    expect(row('page').titleDerived).toBe(true)
    expect(row('insight').titleField).toBe('heading')
    expect(row('insight').titleDerived).toBe(false)
  })

  it('names a singleton preview path and leaves it empty for a kind with a URL of its own', () => {
    expect(row('header').preview).toBe('The site root')
    expect(row('seo').preview).toBe('No host page configured')
    expect(row('page').preview).toBe('')
  })

  it('marks the default type and the ones loaded into every render', () => {
    expect(row('page').isDefault).toBe(true)
    expect(row('header').isGlobal).toBe(true)
    expect(row('seo').isGlobal).toBe(false)
  })
})

/* -------------------------------------------------------------- block types --- */

describe('indexed, which is the collection refusal', () => {
  const cards = blockCards(manifest)
  const card = (name: string) => cards.find((c) => c.name === name)!
  const field = (block: string, name: string) => card(block).fields.find((f) => f.name === name)!

  it('is live on a root block', () => {
    expect(field('pageRoot', 'title').indexed).toBe(true)
    expect(field('pageRoot', 'title').indexedInert).toBe(false)
  })

  it('is inert on a block no document type uses as its root', () => {
    // `collections.md` decision 2: the index is a fixed projection of a document,
    // so a flag on a nested block projects nothing and a `collection` naming the
    // field is a bad_request. The declaration looks identical either way, which is
    // exactly why the row has to say which it is.
    expect(field('hero', 'eyebrow').indexed).toBe(true)
    expect(field('hero', 'eyebrow').indexedInert).toBe(true)
  })

  it('derives inertness from rootFor, so the two can never disagree', () => {
    expect(card('pageRoot').rootFor).toEqual(['Page'])
    expect(card('hero').rootFor).toEqual([])
  })
})

describe('translatable', () => {
  it('is inert on a site that declares no locales', () => {
    const single: Manifest = { ...manifest, locales: undefined }
    const rows = blockCards(single).find((c) => c.name === 'pageRoot')!.fields
    const title = rows.find((f) => f.name === 'title')!
    expect(title.translatable).toBe(true)
    expect(title.translatableInert).toBe(true)
  })

  it('is live once there is a second language for a value to live in', () => {
    const title = blockCards(manifest)
      .find((c) => c.name === 'pageRoot')!
      .fields.find((f) => f.name === 'title')!
    expect(title.translatableInert).toBe(false)
  })
})

describe('blockCards', () => {
  const cards = blockCards(manifest)
  const card = (name: string) => cards.find((c) => c.name === name)!

  it('lists a blocks field once, as a slot, and never as a value field', () => {
    // Children are separate bloks, not a value on the parent. A `body` appearing
    // in both tables would read as two declarations.
    expect(card('pageRoot').fields.map((f) => f.name)).toEqual(['title'])
    expect(card('pageRoot').slots.map((s) => s.name)).toEqual(['body'])
    expect(card('pageRoot').slots[0]).toMatchObject({ allow: ['hero', 'prose'], max: '20' })
  })

  it('says "Unlimited" for a slot with no max, rather than leaving it blank', () => {
    const heroSlot = blockCards({
      ...manifest,
      blocks: [{ name: 'x', label: 'X', fields: { kids: blocks({ allow: ['prose'] }) } }],
    })[0]!.slots[0]!
    expect(heroSlot.max).toBe('Unlimited')
  })

  it('flattens each kind’s own constraints', () => {
    const hero = card('hero')
    expect(hero.fields.find((f) => f.name === 'columns')!.detail).toBe('1–4')
    expect(hero.fields.find((f) => f.name === 'image')!.detail).toBe('image/*')
    expect(hero.fields.find((f) => f.name === 'layout')!.detail).toBe('full, split')
    expect(card('prose').fields[0]!.detail).toBe('marks: bold; every node')
    expect(card('insightRoot').fields.find((f) => f.name === 'related')!.detail).toBe(
      'type: insight; filterable: topic; ≤ 12 per page',
    )
  })

  it('carries presets, what they set and what they plant', () => {
    expect(card('hero').presetsOnly).toBe(true)
    expect(card('hero').presets).toEqual([
      { name: 'default', label: 'Default', sets: ['layout'], children: [] },
      { name: 'split', label: 'Split hero', sets: ['layout'], children: ['body: prose'] },
    ])
  })

  it('prints a field default, and distinguishes “none declared” from a falsy one', () => {
    expect(card('insightRoot').fields.find((f) => f.name === 'topic')!.fieldDefault).toBe('policy')
    expect(card('hero').fields.find((f) => f.name === 'columns')!.fieldDefault).toBe('')
    // `0` and `false` are declared defaults and must not read as absent.
    expect(fieldRow('n', number({ default: 0 }), true, false).fieldDefault).toBe('0')
  })
})

describe('conditionText', () => {
  it('phrases each operator', () => {
    expect(conditionText({ field: 'layout', eq: 'split' })).toBe('layout is split')
    expect(conditionText({ field: 'layout', ne: 'full' })).toBe('layout is not full')
    expect(conditionText({ field: 'layout', in: ['a', 'b'] })).toBe('layout is one of a, b')
    expect(conditionText({ field: 'image', isSet: true })).toBe('image has a value')
    expect(conditionText({ field: 'image', isSet: false })).toBe('image is empty')
  })

  it('composes the combinators', () => {
    expect(
      conditionText({
        all: [{ field: 'a', eq: 1 }, { not: { field: 'b', isSet: true } }],
      }),
    ).toBe('a is 1 and not (b has a value)')
    expect(
      conditionText({
        any: [
          { field: 'a', eq: 1 },
          { field: 'b', eq: 2 },
        ],
      }),
    ).toBe('a is 1 or b is 2')
  })

  it('is total over a shape it does not recognise, rather than throwing', () => {
    // A schema can be newer than the admin bundle reading it. `core/conditions.ts`
    // keeps the same discipline for the same reason: a settings row must not take
    // the screen down over a condition it merely could not phrase.
    expect(conditionText({ field: 'a', gt: 3 } as never)).toBe('an unrecognised condition')
  })
})

/* --------------------------------------------------------- eighty-seven of them --- */

describe('filterBlocks, which is the answer to 87 block types', () => {
  const cards = blockCards(manifest)

  it('keeps a whole card when the block itself matched', () => {
    const hits = filterBlocks(cards, 'hero')
    // `pageRoot` rides along because its `body` slot allows a hero, which is the
    // other true answer to "where is a hero" and is exactly what the slot match
    // below is for.
    expect(hits.map((c) => c.name)).toEqual(['pageRoot', 'hero'])
    const hero = hits.find((c) => c.name === 'hero')!
    expect(hero.fields).toHaveLength(4)
  })

  it('keeps only the matching fields when the block matched through one', () => {
    // Searching a field name across eighty-seven blocks is the case this exists
    // for: the answer is "which blocks have one of these", and carrying every
    // other field of every hit back is the flat dump again.
    const hits = filterBlocks(cards, 'layout')
    expect(hits.map((c) => c.name)).toEqual(['hero'])
    expect(hits[0]!.fields.map((f) => f.name)).toEqual(['layout'])
  })

  it('matches a slot by what it allows, because that is how a block is reached', () => {
    const hits = filterBlocks(cards, 'prose')
    // `prose` itself, plus `pageRoot` whose `body` slot allows it.
    expect(hits.map((c) => c.name).sort()).toEqual(['pageRoot', 'prose'])
  })

  it('matches on kind, so “richtext” finds every prose field on the site', () => {
    expect(filterBlocks(cards, 'richtext').map((c) => c.name)).toEqual(['prose'])
  })

  it('returns everything, unnarrowed, for an empty filter', () => {
    expect(filterBlocks(cards, '')).toHaveLength(cards.length)
    expect(filterBlocks(cards, '  ')[0]!.fields).toHaveLength(1)
  })
})

describe('openCards', () => {
  const cards = blockCards(manifest)
  const filtered = (q: string) => openCards(filterBlocks(cards, q), q)

  it('opens a card whose answer is inside it', () => {
    // `layout` is a field of `hero`, so `hero` is the only hit and its answer is
    // in the fields table. Collapsed, the filter would report a hit and hide it.
    expect([...filtered('layout')]).toEqual(['hero'])
  })

  it('leaves a card shut when the reader asked for the block by name and others matched too', () => {
    // `hero` matches its own name; `pageRoot` matches through a slot that allows
    // it. Two hits, so the name match stays collapsed.
    expect([...filtered('hero')]).toEqual(['pageRoot'])
  })

  it('opens the last card standing, whichever way the query got there', () => {
    // Narrowing eighty-seven blocks to one *is* asking for that block, and a
    // single collapsed row with nothing else on the page is a dead end. This is
    // also what makes the types table's root-block link land on a schema.
    expect([...filtered('insightRoot')]).toEqual(['insightRoot'])
  })

  it('opens nothing at rest', () => {
    expect(openCards(cards, '').size).toBe(0)
  })
})

/* ------------------------------------------------------------------ locales --- */

describe('localeRows', () => {
  it('names the source locale, which is the one Blok.data holds', () => {
    const rows = localeRows(manifest.locales)
    expect(rows.map((r) => r.source)).toEqual([true, false, false])
  })

  it('resolves the whole read order, not just the declared fallback', () => {
    // The two-hop question no single config key answers: with `de → fr`
    // declared, what does a German visitor see on a field nobody translated? It
    // is `en`, because the source is every locale's last resort.
    const de = localeRows(manifest.locales).find((r) => r.code === 'de')!
    expect(de.fallback).toBe('fr')
    expect(de.readOrder).toEqual(['de', 'fr', 'en'])
  })

  it('appends the source for a locale with no declared fallback at all', () => {
    const fr = localeRows(manifest.locales).find((r) => r.code === 'fr')!
    expect(fr.fallback).toBe('')
    expect(fr.readOrder).toEqual(['fr', 'en'])
  })

  it('is empty for a single-locale site, which is a fact and not a failure', () => {
    expect(localeRows(undefined)).toEqual([])
  })
})

/* ---------------------------------------------------- globals, auth, hooks --- */

describe('globalRows', () => {
  it('joins each name back to its type', () => {
    expect(globalRows(manifest)).toEqual([
      { name: 'header', label: 'Header', root: 'headerRoot', preview: 'The site root' },
    ])
  })

  it('drops a name with no type rather than rendering an "unknown" row', () => {
    // `validateGlobals` throws at construction for this, so a row for it would be
    // a row for a state the server refuses to boot in.
    expect(globalRows({ ...manifest, globals: ['nope'] })).toEqual([])
  })
})

describe('providerRows', () => {
  it('says how a person gets through, and what happens to a stranger', () => {
    expect(providerRows(policy)).toEqual([
      {
        id: 'link',
        label: 'Email me a link',
        flow: 'Emailed sign-in link',
        unknownEmail: 'Refused — access is a list someone maintains',
      },
      {
        id: 'google',
        label: 'Google',
        flow: 'Redirect to the provider',
        unknownEmail: 'Creates an editor',
      },
    ])
  })

  it('is empty for every reason there is no policy', () => {
    // Three states collapse to one: `auth: 'open'` has no providers, a `/me` that
    // has not answered yet carries none, and a caller the route refused gets none.
    // All three mean "nothing to show", and the section's own prose is what tells
    // the first apart from the others using `Me.mode`.
    expect(providerRows(undefined)).toEqual([])
    expect(sessionFacts(undefined)).toEqual([])
  })

  it('never sees a field the projection did not name', () => {
    // The guard against the manifest mistake coming back through a different door:
    // whatever a host hung off its provider object, only these five keys exist by
    // the time a row is built. `test/workers/settings-config.test.ts` pins the same
    // property on the wire.
    expect(Object.keys(policy.providers[1]!).sort()).toEqual([
      'id',
      'label',
      'provision',
      'provisionRole',
      'redirect',
    ])
  })
})

describe('hookRows', () => {
  it('marks the ones a write waits for', () => {
    expect(hookRows(manifest)).toEqual([
      { event: 'published', awaited: true },
      { event: 'pathsChanged', awaited: false },
    ])
  })

  it('is empty when the host declared none', () => {
    expect(hookRows({ ...manifest, hooks: undefined })).toEqual([])
  })
})

describe('cacheFacts', () => {
  it('mirrors the constants rather than restating them', () => {
    // Imported from `core/cache-tags.ts`, so a screen that says seven days while
    // the header says something else is not representable.
    const facts = cacheFacts()
    expect(facts.find((f) => f.label === 'Edge cache')!.value).toContain('604800')
    expect(facts.find((f) => f.label === 'Edge cache')!.value).toContain('7 days')
    expect(facts.find((f) => f.label === 'Browser cache')!.value).toBe('max-age=0')
  })

  it('refuses to claim caching is on, because that lives in wrangler.jsonc', () => {
    expect(cacheFacts().find((f) => f.label === 'In effect?')!.value).toBe('Not visible from here')
  })

  it('gives every fact a reason, which is the point of the third column', () => {
    for (const fact of cacheFacts()) expect(fact.why.length).toBeGreaterThan(20)
  })
})

/* ------------------------------------------------------------------- screen --- */

describe('settingsView', () => {
  it('counts each section before the filter, so a heading can say "n of N"', () => {
    const v = view()
    expect(v.totals.types).toBe(5)
    expect(v.totals.blocks).toBe(7)
    expect(v.totals.globals).toBe(1)
    expect(v.totals.locales).toBe(3)
    expect(shownIn(v, 'blocks')).toBe(7)
  })

  it('narrows every section, not only the long one', () => {
    // A filter that silently applied to blocks and not to document types would be
    // a control whose scope a reader has to guess.
    const v = view('insight')
    expect(v.types.map((t) => t.name)).toEqual(['insight'])
    expect(v.blocks.map((b) => b.name)).toEqual(['insightRoot'])
    expect(v.locales).toEqual([])
  })

  it('finds a locale by code and by label', () => {
    expect(view('fr').locales.map((l) => l.code)).toEqual(['fr'])
    expect(view('Deutsch').locales.map((l) => l.code)).toEqual(['de'])
  })

  it('finds the caching section by a word in it', () => {
    expect(view('edge').cache).toHaveLength(1)
  })
})

describe('visibleSections', () => {
  it('keeps every section at rest, including the empty ones', () => {
    // "This site declares no locales" is an answer somebody came for, and a
    // section that vanishes when empty is indistinguishable from one the screen
    // forgot to render.
    // Deliberately the thinnest deployment there is: no locales, no globals, and
    // no policy at all (`auth: 'open'`). Every section is still drawn.
    const single: Manifest = { ...manifest, locales: undefined, globals: [] }
    const v = settingsView(single, indexManifest(single), undefined, '')
    expect(visibleSections(v, '').map((s) => s.id)).toEqual(SECTIONS.map((s) => s.id))
  })

  it('drops the ones that matched nothing once a filter is on', () => {
    const v = view('insight')
    expect(visibleSections(v, 'insight').map((s) => s.id)).toEqual(['types', 'blocks'])
  })

  it('reports one empty screen rather than seven empty sections', () => {
    const v = view('zzzz')
    expect(visibleSections(v, 'zzzz')).toEqual([])
    expect(isEmpty(v, 'zzzz')).toBe(true)
    expect(isEmpty(view(), '')).toBe(false)
  })
})

describe('SECTIONS', () => {
  it('leads with the two sections that answer a refusal', () => {
    // `under` lives in the first and `indexed` in the second, which is why they
    // are not in the order `ui-architecture.md` enumerates them.
    expect(SECTIONS.slice(0, 2).map((s) => s.id)).toEqual(['types', 'blocks'])
  })

  it('gives every section a prefixed anchor, so nothing else on the page collides', () => {
    for (const section of SECTIONS) expect(section.anchor).toBe(`settings-${section.id}`)
    expect(new Set(SECTIONS.map((s) => s.anchor)).size).toBe(SECTIONS.length)
  })

  it('has a row-count answer for every one of its ids', () => {
    // `shownIn` switches exhaustively over `SectionId`; a section added without a
    // branch there would render a heading with no count.
    const v = view()
    for (const section of SECTIONS) expect(typeof shownIn(v, section.id)).toBe('number')
  })
})
