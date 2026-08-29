import { describe, expect, it } from 'vitest'
import type { Me } from '../../../src/admin/me'
import {
  ATTENTION_LIMIT,
  type ActorDirectory,
  EDITOR_UNKNOWN_NOTE,
  MEDIA_LIMIT,
  RECENT_LIMIT,
  type SiteCounts,
  actorDirectory,
  attention,
  homeRequests,
  placeOf,
  publishActor,
  quickCards,
} from '../../../src/admin/ui/screens/home-model'
import type { AuditBatch } from '../../../src/admin/ui/screens/model-model'
import type { DocumentType } from '../../../src/core/schema'
import type { MigrationStatus } from '../../../src/server/migrate'

/**
 * The Home screen's arithmetic (`docs/ui-architecture.md` port phase 6).
 *
 * Almost every test here is about the screen **not saying something it cannot
 * know**. Home is the one surface where a plausible list is indistinguishable from
 * a working feature, so the assertions are mostly negative: no count on a card that
 * has none, no author on a row whose table records none, no invented name for an
 * actor that did not resolve, and no block at all when there is nothing wrong.
 *
 * The two positive ones that matter are the request shapes: `?recent=1` and not
 * `?flat=1` (the difference `test/workers/recency.test.ts` asserts from the server
 * end), and one `/counts` rather than a count per card.
 */

/* ------------------------------------------------------------------- types --- */

const PAGE: DocumentType = { name: 'page', label: 'Page', kind: 'page', root: 'page' }
const PERSON: DocumentType = { name: 'person', label: 'Person', kind: 'record', root: 'person' }
const OFFICE: DocumentType = { name: 'office', label: 'Office', kind: 'record', root: 'office' }
const HEADER: DocumentType = { name: 'header', label: 'Header', kind: 'singleton', root: 'header' }
const FOOTER: DocumentType = { name: 'footer', label: 'Footer', kind: 'singleton', root: 'footer' }

const TYPES = [PAGE, PERSON, OFFICE, HEADER, FOOTER]

const COUNTS: SiteCounts = { pages: 12, types: { page: 9, person: 4, office: 2 } }

const cards = (over: Partial<Parameters<typeof quickCards>[0]> = {}) =>
  quickCards({
    types: TYPES,
    globals: ['footer'],
    counts: COUNTS,
    assets: 31,
    mayCreate: true,
    ...over,
  })

/* ------------------------------------------------------------ quick access --- */

describe('quick access cards', () => {
  it('is pages, then records, then every singleton, then assets', () => {
    expect(cards().map((card) => card.key)).toEqual([
      'pages',
      'type:person',
      'type:office',
      // `footer` is the declared global and comes first; `header` is a singleton
      // nobody declared and is still exactly one document somebody has to reach —
      // the same set and the same order `ui/nav.ts`'s globals group builds.
      'global:footer',
      'global:header',
      'assets',
    ])
  })

  it('gives Pages the routed count, not the sum of the page kinds', () => {
    // The distinction `countStories`' third argument exists for: a second page
    // type's documents are in the tree too, so `pages` and `types.page` are answers
    // to different questions and the card wants the first.
    const pages = cards().find((card) => card.key === 'pages')
    expect(pages?.count).toBe(12)
    expect(COUNTS.types.page).toBe(9)
  })

  it('has no count anywhere until /counts answers, rather than a zero', () => {
    // A zero that becomes 1,284 a moment later reads as data loss for as long as it
    // is wrong, which is why `count` is spread in conditionally.
    for (const card of cards({ counts: null, assets: undefined })) {
      expect(card).not.toHaveProperty('count')
    }
  })

  it('counts a record type with nothing in it as 0 rather than dropping the number', () => {
    // Absent means "not asked yet"; a declared type the route reported nothing for is
    // genuinely empty, and the empty state is a fact worth showing.
    const counts: SiteCounts = { pages: 1, types: {} }
    expect(cards({ counts }).find((card) => card.key === 'type:person')?.count).toBe(0)
  })

  it('never gives a global a count, because there is exactly one by construction', () => {
    for (const card of cards()) {
      if (card.key.startsWith('global:')) expect(card).not.toHaveProperty('count')
    }
  })

  it('links a global straight at its derived document id', () => {
    expect(cards().find((card) => card.key === 'global:footer')?.screen).toEqual({
      name: 'edit',
      id: 'sng_footer',
    })
  })

  it('gives a create action to records and assets, and to nothing else', () => {
    const withCreate = cards()
      .filter((card) => card.create)
      .map((card) => [card.key, card.create?.kind])
    // Pages is absent because a page needs a parent and a position and `under` decides
    // which types may be at the root — Content's `NewPageButton` owns all three. A
    // global is absent because the card already *is* the link to its one document.
    expect(withCreate).toEqual([
      ['type:person', 'document'],
      ['type:office', 'document'],
      ['assets', 'upload'],
    ])
  })

  it('names the type a create action would post, not just the label', () => {
    const create = cards().find((card) => card.key === 'type:person')?.create
    expect(create).toEqual({ kind: 'document', type: 'person', label: 'New person' })
  })

  it('omits every create action for somebody who may not create', () => {
    // Absent, not disabled: a viewer's create is impossible rather than refusable.
    expect(cards({ mayCreate: false }).some((card) => card.create)).toBe(false)
  })

  it('is pages and assets alone on a site declaring no records or singletons', () => {
    expect(cards({ types: [PAGE], globals: [] }).map((card) => card.key)).toEqual([
      'pages',
      'assets',
    ])
  })

  it('ignores a declared global whose type the manifest does not carry', () => {
    // A `globals` entry naming a retired type would otherwise produce a card linking
    // to `sng_gone`, which is a link to nothing.
    expect(cards({ globals: ['gone', 'footer'] }).map((card) => card.key)).toContain(
      'global:footer',
    )
    expect(cards({ globals: ['gone', 'footer'] }).map((card) => card.key)).not.toContain(
      'global:gone',
    )
  })
})

/* ---------------------------------------------------------- latest changes --- */

describe('where a changed document lives', () => {
  it('is the path for a routed page', () => {
    expect(placeOf({ path: '/about/team', type: 'page' }, TYPES)).toBe('/about/team')
  })

  it('is `/` for the home page, whose path is genuinely the empty string', () => {
    expect(placeOf({ path: '', type: 'page' }, TYPES)).toBe('/')
  })

  it("is the type's label for an unrouted document", () => {
    // The one case flat mode cannot show at all — `path is not null` is what makes
    // flat mode the page tree's twin, and `?recent=1` exists to include these.
    expect(placeOf({ path: null, type: 'person' }, TYPES)).toBe('Person')
  })

  it('falls back to the raw type name for a type nothing declares', () => {
    expect(placeOf({ path: null, type: 'retired' }, TYPES)).toBe('retired')
  })

  it('admits that a story row records no author, rather than showing a blank column', () => {
    // The whole point: nothing on `StoryMeta` names a person, so the block says so
    // once instead of drawing a "Who" column of dashes.
    expect(EDITOR_UNKNOWN_NOTE).toContain('activity trail')
  })
})

/* -------------------------------------------------------- latest published --- */

const admin: Me = {
  mode: 'session',
  actor: { kind: 'user', id: 'usr_ada', name: 'Ada', colour: '#f00', role: 'admin' },
  loginUrl: '/folio/login',
}

const anonymous: Me = { mode: 'open', actor: null, loginUrl: '' }

const directory: ActorDirectory = { usr_grace: 'Grace Hopper' }

describe('who published something', () => {
  it('is "You" for your own publish, with no request needed', () => {
    expect(publishActor('usr_ada', { me: admin, directory: {} })).toEqual({
      kind: 'self',
      text: 'You',
    })
  })

  it('is a resolved name for a colleague', () => {
    expect(publishActor('usr_grace', { me: admin, directory })).toEqual({
      kind: 'user',
      text: 'Grace Hopper',
    })
  })

  it('degrades to the recorded id, marked as an id, when no name resolves', () => {
    // The normal case for an editor or a publisher: `/users` is admin-only, so there
    // is no route that maps a user id to a name for them at all. The id is exactly
    // what the version row holds, so showing it is the honest answer — and `kind`
    // is what lets the screen typeset it as an identifier rather than as a name.
    expect(publishActor('usr_grace', { me: admin, directory: {} })).toEqual({
      kind: 'id',
      text: 'usr_grace',
    })
  })

  it('never looks a token up as a user id', () => {
    // Checked before the self and directory branches. A directory that happened to
    // hold the key would otherwise rename a token to a person.
    expect(
      publishActor('token:deploy', { me: admin, directory: { 'token:deploy': 'Ada' } }),
    ).toEqual({ kind: 'token', text: 'token:deploy' })
  })

  it('says Unknown for a publish with no actor at all', () => {
    expect(publishActor(null, { me: admin, directory })).toEqual({ kind: 'none', text: 'Unknown' })
  })

  it('resolves nobody as "You" on a deployment with no accounts', () => {
    // `auth: 'open'` has no actor, so every publish it recorded has a null one — and
    // an id from a previous configuration must not become "You" by default.
    expect(publishActor('usr_ada', { me: anonymous, directory: {} }).kind).toBe('id')
  })

  it('builds a directory from a page of users, skipping a row with no name', () => {
    expect(
      actorDirectory([
        { id: 'usr_a', name: 'Ada' },
        { id: 'usr_b', name: '' },
      ]),
    ).toEqual({ usr_a: 'Ada' })
  })
})

/* --------------------------------------------------------- needs attention --- */

const clean: MigrationStatus = { migrations: [], pending: [], behind: 0 }

const emptyAudit: AuditBatch = {
  documents: 40,
  content: [],
  stories: [],
  schema: [],
  continueFrom: null,
}

describe('needs attention', () => {
  it('is quiet on a clean site, so the block renders nothing at all', () => {
    // No green tick, no "all clear" panel. Explicit in `ui-architecture.md` and the
    // whole character of the block.
    const quiet = attention({ status: clean, audit: emptyAudit })
    expect(quiet.quiet).toBe(true)
    expect(quiet.rows).toEqual([])
    expect(quiet.banner).toBeNull()
  })

  it('is quiet before anything has answered, rather than claiming trouble', () => {
    // Which is why the block has no skeleton: a placeholder resolving to nothing
    // would have said something was wrong for as long as it was on screen.
    expect(attention({ status: null, audit: null }).quiet).toBe(true)
  })

  it('is one row per pending migration, each pointing at Model', () => {
    const status: MigrationStatus = {
      migrations: [
        { id: '001-rename', description: 'Rename hero.heading', applied: false },
        { id: '002-defaults', description: 'Fill new defaults', applied: false },
      ],
      pending: ['001-rename', '002-defaults'],
      behind: 7,
    }
    const needs = attention({ status, audit: emptyAudit })
    expect(needs.quiet).toBe(false)
    expect(needs.rows.map((row) => row.subject)).toEqual(['001-rename', '002-defaults'])
    expect(needs.rows.map((row) => row.detail)).toEqual([
      'Rename hero.heading',
      'Fill new defaults',
    ])
    expect(needs.rows.every((row) => row.screen.name === 'model')).toBe(true)
    // `driftBanner`'s sentence rather than one of this screen's own, so Home and
    // Model say the same thing about the same ledger.
    expect(needs.banner).toContain('7 documents')
  })

  it('speaks up for documents behind the model with nothing pending', () => {
    // A run that failed or a document that arrived after one: a true condition with
    // no pending migration to hang a row on, which is why `banner` alone breaks
    // `quiet`.
    const status: MigrationStatus = {
      migrations: [{ id: '001', description: 'One', applied: true }],
      pending: [],
      behind: 3,
    }
    const needs = attention({ status, audit: emptyAudit })
    expect(needs.quiet).toBe(false)
    expect(needs.rows).toEqual([])
    expect(needs.banner).toContain('3 documents')
  })

  it('links a finding to the document it names, and a schema fault to Model', () => {
    const audit: AuditBatch = {
      documents: 40,
      content: [
        {
          check: 'orphan-key',
          type: 'hero',
          field: 'subtitle',
          documents: 3,
          bloks: 4,
          sample: ['sty_about', 'sty_team'],
        },
      ],
      stories: [],
      schema: [
        {
          check: 'indexed-not-root',
          block: 'hero',
          field: 'heading',
          detail: 'hero is no type’s root, so the flag does nothing',
        },
      ],
      continueFrom: null,
    }
    const rows = attention({ status: clean, audit }).rows
    const orphan = rows.find((row) => row.subject === 'hero.subtitle')
    expect(orphan?.screen).toEqual({ name: 'edit', id: 'sty_about' })
    // A schema check reads no document — it is a code fault — so there is nothing to
    // link to but the panel that explains it.
    const schema = rows.find((row) => row.subject === 'hero.heading')
    expect(schema?.screen).toEqual({ name: 'model' })
  })

  it('caps the list and reports the remainder rather than truncating silently', () => {
    const audit: AuditBatch = {
      documents: 40,
      content: [],
      stories: Array.from({ length: ATTENTION_LIMIT + 4 }, (_, i) => ({
        check: 'document-size',
        story: `sty_${i}`,
        type: 'page',
        detail: `${i} bytes`,
      })),
      schema: [],
      continueFrom: null,
    }
    const needs = attention({ status: clean, audit })
    expect(needs.rows).toHaveLength(ATTENTION_LIMIT)
    expect(needs.more).toBe(4)
  })

  it('names a document-shaped finding by its story id, since nothing else is drawn beside it', () => {
    // `AuditRow.subject` is null for a finding whose subject *is* a document, so the
    // Model panel does not print the id twice — once as a mono subject and once as a
    // link. This block draws no such link (the whole row navigates), so the id
    // becomes the subject and appears exactly once.
    const audit: AuditBatch = {
      documents: 1,
      content: [],
      stories: [{ check: 'document-size', story: 'sty_huge', type: 'page', detail: '900 kB' }],
      schema: [],
      continueFrom: null,
    }
    const row = attention({ status: clean, audit }).rows[0]
    expect(row?.subject).toBe('sty_huge')
    expect(row?.screen).toEqual({ name: 'edit', id: 'sty_huge' })
  })
})

/* ---------------------------------------------------------------- requests --- */

describe('the requests Home makes', () => {
  const req = homeRequests('/folio/api')

  it('asks for recency across every type, and never flat mode', () => {
    // The one substitution that would look right and be wrong: `?flat=1` filters
    // `path is not null`, so it answers every routed *page* and silently drops the
    // records an afternoon was spent on. `test/workers/recency.test.ts` asserts the
    // same difference from the server end.
    expect(req.changes).toContain('recent=1')
    expect(req.changes).not.toContain('flat=1')
    expect(req.changes).toContain(`limit=${RECENT_LIMIT}`)
  })

  it('asks for every card’s number in one request', () => {
    // Not one `?type=X&limit=1&count=1` per card, which on a site with twenty record
    // types is twenty requests to draw a screen whose whole job is being fast.
    expect(req.counts).toBe('/folio/api/counts')
  })

  it('gets the Assets card’s count from the same request as the media tiles', () => {
    expect(req.media).toContain(`limit=${MEDIA_LIMIT}`)
    expect(req.media).toContain('count=1')
    // `sort=created` is the route's own default and newest-first: a URL that states a
    // default is a URL somebody has to keep in step with one.
    expect(req.media).not.toContain('sort=')
  })

  it('asks the site-wide migration question, not the per-document one', () => {
    // `?story=` answers "is *this* document behind", which is the editor's banner.
    expect(req.migrations).toBe('/folio/api/migrations')
  })

  it('bounds the audit to one batch', () => {
    expect(req.audit).toContain('batch=')
  })

  it('is relative to whatever mount the host configured', () => {
    // Every path in the admin is relative to `apiBase`, which is host-configurable —
    // the property that made the `{base}/api` prefix move free on the client.
    expect(homeRequests('/cms/api').published.startsWith('/cms/api/published')).toBe(true)
  })
})
