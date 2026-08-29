import { describe, expect, it } from 'vitest'
import { appendRows } from '../../../src/admin/hooks/useVersions'
import {
  actorForm,
  actorNames,
  describeEdit,
  historyWhen,
  rootLabel,
  versionKindLabel,
  versionTitle,
  versionTone,
} from '../../../src/admin/ui/screens/history-model'
import type { Blok, Doc } from '../../../src/core/doc'
import type { Mutation } from '../../../src/core/mutations'
import type { ActivityEntry } from '../../../src/core/protocol'
import type { SchemaIndex } from '../../../src/core/schema'
import type { VersionMeta } from '../../../src/server/versions'

/**
 * The history slide-over's arithmetic, in Node with nothing mounted.
 *
 * Two of these were unreachable by any test before the port and are the reason the
 * file exists: `describeEdit` (the activity phrase, which has to degrade rather than
 * throw on a mutation naming a block that no longer exists) and `actorForm` (new —
 * how a raw actor string reads, and how it degrades when there is no name to be
 * had).
 */

/* ------------------------------------------------------------------ paging --- */

// `appendRows` lives in `admin/hooks/useVersions.ts` rather than beside the panel's
// other pure functions, because the paged state does: a copy in the panel could
// disagree with the one a checkpoint refreshes.
describe('appending a page', () => {
  const key = (row: { id: string }) => row.id

  it('appends in order', () => {
    expect(appendRows([{ id: 'a' }, { id: 'b' }], [{ id: 'c' }], key).map(key)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('drops a row it already holds, so a checkpoint saved mid-page cannot double', () => {
    const held = [{ id: 'a' }, { id: 'b' }]
    expect(appendRows(held, [{ id: 'b' }, { id: 'c' }], key).map(key)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate what it was given', () => {
    const held = [{ id: 'a' }]
    appendRows(held, [{ id: 'b' }], key)
    expect(held).toHaveLength(1)
  })

  it('is the identity on an empty page, which is what the last page answers', () => {
    expect(appendRows([{ id: 'a' }], [], key).map(key)).toEqual(['a'])
  })
})

/* ---------------------------------------------------------------- versions --- */

const version = (extra: Partial<VersionMeta> = {}): VersionMeta => ({
  id: 'ver_1',
  storyId: 'sty_1',
  kind: 'checkpoint',
  label: null,
  title: 'About',
  actor: null,
  createdAt: 1_000_000,
  schemaId: null,
  ...extra,
})

describe('a version row', () => {
  it('uses the label somebody typed', () => {
    expect(versionTitle(version({ label: 'Before the rewrite' }))).toBe('Before the rewrite')
  })

  it('falls back to what kind of version it is', () => {
    expect(versionTitle(version({ kind: 'publish' }))).toBe('Published')
    expect(versionTitle(version({ kind: 'checkpoint' }))).toBe('Checkpoint')
  })

  it('treats a whitespace-only label as no label', () => {
    expect(versionTitle(version({ kind: 'publish', label: '   ' }))).toBe('Published')
  })

  it('gives a publish the completion tone and a checkpoint the history one', () => {
    // Amber is history and drift in this system, which is also the colour of the
    // frame the stage gains while a version is being viewed.
    expect(versionTone('publish')).toBe('ok')
    expect(versionTone('checkpoint')).toBe('warn')
    expect(versionKindLabel('publish')).toBe('Published')
  })
})

describe('a history timestamp', () => {
  const now = Date.parse('2026-07-31T12:00:00Z')

  it('is relative inside a day', () => {
    expect(historyWhen(now - 5_000, now)).toBe('just now')
    expect(historyWhen(now - 20 * 60_000, now)).toBe('20m ago')
    expect(historyWhen(now - 5 * 3_600_000, now)).toBe('5h ago')
  })

  it('past a day, carries a time and not only a date', () => {
    // The distinction from `content-rows.ts`'s `when`, which stops at the date: a
    // version is chosen by matching it against a memory of an afternoon.
    const out = historyWhen(Date.parse('2026-03-14T15:20:00Z'), now)
    expect(out).not.toMatch(/ago/)
    expect(out).toMatch(/\d/)
    expect(out.length).toBeGreaterThan('14 Mar'.length)
  })
})

/* ------------------------------------------------------------------ actors --- */

describe('how an actor reads', () => {
  it('has nothing to say when there is no actor — `auth: open`', () => {
    expect(actorForm(null)).toEqual({ kind: 'none' })
    expect(actorForm(undefined)).toEqual({ kind: 'none' })
    expect(actorForm('  ')).toEqual({ kind: 'none' })
  })

  it('reads a token by the name in the string, which is all a token has', () => {
    expect(actorForm('token:deploy-bot')).toEqual({ kind: 'token', label: 'deploy-bot' })
  })

  it('still renders a token with no name behind the prefix', () => {
    expect(actorForm('token:')).toEqual({ kind: 'token', label: 'an API token' })
  })

  it('degrades a user id to the id itself rather than inventing a name', () => {
    expect(actorForm('usr_abc123')).toEqual({ kind: 'id', label: 'usr_abc123' })
  })

  it('uses a name when one is known', () => {
    expect(actorForm('usr_abc123', { usr_abc123: 'Dana Whitfield' })).toEqual({
      kind: 'name',
      label: 'Dana Whitfield',
    })
  })

  it('ignores a blank name in the map, so a bad row does not erase the id', () => {
    expect(actorForm('usr_abc123', { usr_abc123: '  ' })).toEqual({
      kind: 'id',
      label: 'usr_abc123',
    })
  })

  it('is total: a string of neither shape is a name, because that is the only true reading', () => {
    expect(actorForm('Dana')).toEqual({ kind: 'name', label: 'Dana' })
  })

  it('prefers a name over a token prefix nowhere near the start', () => {
    expect(actorForm('usr_token:x')).toEqual({ kind: 'id', label: 'usr_token:x' })
  })
})

const entry = (extra: Partial<ActivityEntry> = {}): ActivityEntry => ({
  syncId: 1,
  actor: 'usr_a',
  actorName: null,
  at: 1_000_000,
  mutations: [],
  ...extra,
})

describe('resolving actors from what the panel already holds', () => {
  it('names a version’s actor from an activity entry by the same person', () => {
    const names = actorNames([entry({ actor: 'usr_a', actorName: 'Dana' })])
    expect(actorForm('usr_a', names)).toEqual({ kind: 'name', label: 'Dana' })
  })

  it('leaves an actor absent from the trail as an id', () => {
    const names = actorNames([entry({ actor: 'usr_a', actorName: 'Dana' })])
    expect(actorForm('usr_b', names)).toEqual({ kind: 'id', label: 'usr_b' })
  })

  it('ignores an entry with no captured name', () => {
    expect(actorNames([entry({ actor: 'usr_a', actorName: null })])).toEqual({})
    expect(actorNames([entry({ actor: 'usr_a', actorName: '  ' })])).toEqual({})
  })

  it('lets the trail win over a seed, since the trail captured the name at the time', () => {
    const names = actorNames([entry({ actor: 'usr_a', actorName: 'Dana W' })], { usr_a: 'Dana' })
    expect(names.usr_a).toBe('Dana W')
  })

  it('keeps a seeded name for somebody the trail does not mention', () => {
    expect(actorNames([], { usr_z: 'Kim' }).usr_z).toBe('Kim')
  })
})

/* ---------------------------------------------------------------- activity --- */

const blok = (uid: string, type: string, extra: Partial<Blok> = {}): Blok => ({
  uid,
  type,
  parent: null,
  slot: null,
  order: 'a0',
  data: {},
  ...extra,
})

const schema: SchemaIndex = {
  page: {
    name: 'page',
    label: 'Page',
    fields: {
      title: { kind: 'text', label: 'Title' },
      body: { kind: 'blocks', label: 'Body', allow: ['hero'] },
    },
  },
  hero: {
    name: 'hero',
    label: 'Hero',
    fields: { heading: { kind: 'text', label: 'Heading' }, raw: { kind: 'text' } },
  },
  promo: { name: 'promo', label: 'Promo', fields: {} },
}

const doc: Doc = {
  root: 'root',
  bloks: {
    root: blok('root', 'page'),
    h1: blok('h1', 'hero', { parent: 'root', slot: 'body' }),
  },
}

const said = (...mutations: Mutation[]) => describeEdit(mutations, doc, schema)

describe('what one transaction says', () => {
  it('names the block and the field for a write', () => {
    expect(said({ t: 'set', uid: 'h1', field: 'heading', value: 'x' })).toBe(
      'Changed Hero · Heading',
    )
  })

  it('falls back to the field name when the field has no label', () => {
    expect(said({ t: 'set', uid: 'h1', field: 'raw', value: 'x' })).toBe('Changed Hero · raw')
  })

  it('calls a write to the root block the document’s own settings', () => {
    expect(said({ t: 'set', uid: 'root', field: 'title', value: 'x' })).toBe(
      'Changed Page settings · Title',
    )
  })

  it('degrades to "a block" for a uid the document no longer has', () => {
    // The log outlives the blocks it names, which is the whole reason this is
    // best-effort rather than a lookup.
    expect(said({ t: 'remove', uid: 'gone' })).toBe('Removed a block')
  })

  it('names an insert from the schema, since the blok is in the mutation', () => {
    expect(said({ t: 'insert', blok: blok('n1', 'promo') })).toBe('Added Promo')
  })

  it('names the destination type for a retype, not the source', () => {
    expect(said({ t: 'retype', uid: 'h1', type: 'promo' })).toBe('Changed Hero to Promo')
  })

  it('describes a move', () => {
    expect(said({ t: 'move', uid: 'h1', parent: 'root', slot: 'body', order: 'a5' })).toBe(
      'Moved Hero',
    )
  })

  it('counts the rest of a multi-mutation transaction', () => {
    expect(
      said({ t: 'set', uid: 'h1', field: 'heading', value: 'x' }, { t: 'remove', uid: 'h1' }),
    ).toBe('Changed Hero · Heading +1 more')
  })

  it('has an answer for an empty transaction', () => {
    expect(said()).toBe('No change')
  })

  it('falls back to the raw type for a block type the schema does not have', () => {
    expect(said({ t: 'insert', blok: blok('n1', 'unknown') })).toBe('Added unknown')
  })
})

describe('the root block’s label', () => {
  it('is the type’s own label, not "Page"', () => {
    expect(rootLabel(schema.page)).toBe('Page settings')
    expect(rootLabel(schema.hero)).toBe('Hero settings')
  })

  it('is plain "Settings" for a root type the schema does not have', () => {
    expect(rootLabel(undefined)).toBe('Settings')
  })
})
