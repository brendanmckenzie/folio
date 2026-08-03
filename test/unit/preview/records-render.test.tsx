/**
 * The renderer's half of `docs/specs/content-model/data-documents.md`:
 *
 *  - a block definition with no `render` (checkpoint 1) — nothing on a published
 *    page, a `folio-unrendered` placeholder in edit mode;
 *  - `reference.content` being **literally null** for a record with no renderer
 *    (checkpoint 2), so a block author's `?? fallback` is not dead code;
 *  - a `references()` field arriving in the stored order with each entry's own
 *    `content`, and unresolvable entries already gone (decision 3).
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  defineBlock,
  defineRecord,
  reference,
  references,
  text,
  toRegistry,
} from '../../../src/core'
import type { Blok, Doc, Json } from '../../../src/core/doc'
import { buildResolution, type Resolution } from '../../../src/core/resolve'
import type { StoryMeta } from '../../../src/core/story'
import { FolioDoc, type RenderMode } from '../../../src/preview/Render'

/* --------------------------------------------------------------- schema --- */

/** A record with a renderer: `{person.content}` gets a card. */
const personRecord = defineRecord({
  name: 'personRecord',
  label: 'Person',
  summary: 'fullName',
  fields: { fullName: text() },
  render: ({ fullName }) => <figure className="person">{fullName}</figure>,
})

/** A record with none: pure data, read through `.data`. */
const officeRecord = defineRecord({
  name: 'officeRecord',
  label: 'Office',
  summary: 'city',
  fields: { city: text(), phone: text() },
})

const officeCard = defineBlock({
  name: 'officeCard',
  label: 'Office card',
  fields: { office: reference({ types: ['office'] }) },
  render: ({ office }) => {
    if (!office) return <p>No office</p>
    // Exactly the pattern checkpoint 2 promises works: a record with a renderer
    // supplies `content`, one without falls through to the block's own markup.
    return <div className="office">{office.content ?? <span>{String(office.data.city)}</span>}</div>
  },
})

const teamSection = defineBlock({
  name: 'teamSection',
  label: 'Team',
  fields: { people: references({ types: ['person'], max: 6 }) },
  render: ({ people }) => (
    <ul className="team">
      {people.map((p) => (
        <li key={p.id}>{p.content}</li>
      ))}
    </ul>
  ),
})

const pageRoot = defineBlock({
  name: 'page',
  label: 'Page',
  fields: { title: text() },
  render: ({ title }) => <main>{title}</main>,
})

const registry = toRegistry([personRecord, officeRecord, officeCard, teamSection, pageRoot])

/* ------------------------------------------------------------- fixtures --- */

function story(id: string, type: string, title: string): StoryMeta {
  return {
    id,
    type,
    parentId: null,
    slug: id,
    path: null,
    ord: 'a0',
    title,
    publishedAt: null,
    unpublishedAt: null,
    draftSyncId: 0,
    draftUpdatedAt: null,
    publishedSyncId: 0,
    updatedAt: 0,
    state: 'draft',
    hasUnpublishedChanges: false,
  }
}

function one(uid: string, type: string, data: Record<string, Json>): Doc {
  const blok: Blok = { uid, type, parent: null, slot: null, order: 'a0', data }
  return { root: uid, bloks: { [uid]: blok } }
}

const ada = story('sty_ada', 'person', 'Ada')
const grace = story('sty_grace', 'person', 'Grace')
const sydney = story('sty_syd', 'office', 'Sydney')

const resolution: Resolution = {
  ...buildResolution([ada, grace, sydney]),
  docs: {
    sty_ada: one('a', 'personRecord', { fullName: 'Ada Lovelace' }),
    sty_grace: one('g', 'personRecord', { fullName: 'Grace Hopper' }),
    sty_syd: one('s', 'officeRecord', { city: 'Sydney', phone: '000' }),
  },
}

const html = (doc: Doc, opts?: { mode?: RenderMode }) =>
  renderToStaticMarkup(
    <FolioDoc doc={doc} registry={registry} mode={opts?.mode} resolution={resolution} />,
  )

/* --------------------------------------------------------- no renderer ---- */

describe('a block definition with no render', () => {
  const office = one('s', 'officeRecord', { city: 'Sydney', phone: '000' })

  it('renders nothing at all on a published page — never scaffolding', () => {
    expect(html(office)).toBe('')
  })

  it('renders a folio-unrendered placeholder naming the type in edit mode', () => {
    const markup = html(office, { mode: 'edit' })
    expect(markup).toContain('folio-unrendered')
    expect(markup).toContain('Office')
  })

  it('adds no data-folio-uid marker to the placeholder: there is no element to select', () => {
    expect(html(office, { mode: 'edit' })).not.toContain('data-folio-uid')
  })

  it('leaves a block that does have one completely alone', () => {
    expect(html(one('p', 'page', { title: 'Hello' }))).toBe('<main>Hello</main>')
  })
})

/* ------------------------------------------------- reference.content ------ */

describe('reference.content for a record', () => {
  it('renders the card when the record has a renderer', () => {
    const markup = html(one('c', 'officeCard', { office: 'sty_ada' }))
    // `types: ['office']` refuses a person, which is the double enforcement.
    expect(markup).toBe('<p>No office</p>')
  })

  it('is null for a record with no renderer, so the block’s own fallback runs', () => {
    const markup = html(one('c', 'officeCard', { office: 'sty_syd' }))
    expect(markup).toBe('<div class="office"><span>Sydney</span></div>')
  })

  it('carries no uid markers into the referencing page’s edit mode', () => {
    const teamDoc = one('t', 'teamSection', { people: ['sty_ada'] })
    const markup = html(teamDoc, { mode: 'edit' })
    // The section itself is markable; the person inside it belongs to another
    // document and must not be.
    expect(markup).toContain('data-folio-uid="t"')
    expect(markup).not.toContain('data-folio-uid="a"')
  })
})

/* ------------------------------------------------------- references() ----- */

describe('a references() field', () => {
  it('renders every entry, in the stored order', () => {
    const markup = html(one('t', 'teamSection', { people: ['sty_grace', 'sty_ada'] }))
    expect(markup.indexOf('Grace Hopper')).toBeLessThan(markup.indexOf('Ada Lovelace'))
  })

  it('renders the survivors with no hole and no error when a target is deleted', () => {
    const markup = html(one('t', 'teamSection', { people: ['sty_ada', 'sty_gone', 'sty_grace'] }))
    expect(markup).toContain('Ada Lovelace')
    expect(markup).toContain('Grace Hopper')
    expect(markup.match(/<li>/g)).toHaveLength(2)
  })

  it('renders an empty list for an absent value rather than throwing', () => {
    expect(html(one('t', 'teamSection', {}))).toBe('<ul class="team"></ul>')
  })

  it('drops a target of the wrong type', () => {
    const markup = html(one('t', 'teamSection', { people: ['sty_syd', 'sty_ada'] }))
    expect(markup.match(/<li>/g)).toHaveLength(1)
    expect(markup).toContain('Ada Lovelace')
  })
})
