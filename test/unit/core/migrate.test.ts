import { describe, expect, it } from 'vitest'
import type { Blok, Doc, Json } from '../../../src/core/doc'
import {
  block,
  defineMigration,
  field,
  latestMigrationId,
  type Migration,
  migrateDoc,
  migrationContext,
  pendingFor,
  validateMigrations,
} from '../../../src/core/migrate'
import { applyAll } from '../../../src/core/mutations'
import type { DocumentType, SchemaIndex } from '../../../src/core/schema'
import { blocks, text } from '../../../src/core/fields'

/**
 * `schema-migrations.md`'s helpers and the idempotence they exist to implement.
 *
 * The test that matters in every block below is the second run: **a migration
 * applied to an already-migrated document must produce zero mutations**
 * (checkpoint 2). That is the correctness mechanism the whole runner leans on —
 * it makes a partial failure recoverable by re-running, makes the ledger an
 * optimisation, and makes "did that work" answerable by doing it again.
 */

const b = (
  uid: string,
  type: string,
  data: Record<string, Json> = {},
  over: Partial<Blok> = {},
): Blok => ({ uid, type, parent: 'root', slot: 'body', order: 'a0', data, ...over })

function doc(bloks: Blok[]): Doc {
  const root = b('root', 'page', { title: 'Home' }, { parent: null, slot: null })
  const map: Record<string, Blok> = { root }
  for (const blok of bloks) map[blok.uid] = blok
  return { root: 'root', bloks: map }
}

const SCHEMA: SchemaIndex = {
  page: { name: 'page', label: 'Page', fields: { body: blocks({ allow: ['hero'] }) } },
  hero: { name: 'hero', label: 'Hero', fields: { title: text() } },
  quote: { name: 'quote', label: 'Quote', fields: { text: text() } },
  container: {
    name: 'container',
    label: 'Container',
    fields: { body: blocks({ allow: ['hero'] }) },
  },
}

const PAGE: DocumentType = { name: 'page', label: 'Page', kind: 'page', root: 'page' }

/** `[]` twice over: run the helper, apply what it produced, run it again. */
function twice(d: Doc, run: (d: Doc) => ReturnType<typeof field.rename>) {
  const first = run(d)
  const after = applyAll(d, first)
  return { first, second: run(after), after }
}

const heroOf = (d: Doc) => d.bloks.h!

describe('field.rename', () => {
  it('writes the new field and clears the old one', () => {
    const d = doc([b('h', 'hero', { heading: 'Hi' })])
    const { first, after } = twice(d, (x) => field.rename(heroOf(x), 'heading', 'title'))
    expect(first).toEqual([
      { t: 'set', uid: 'h', field: 'title', value: 'Hi' },
      { t: 'set', uid: 'h', field: 'heading', value: null },
    ])
    expect(after.bloks.h!.data).toEqual({ heading: null, title: 'Hi' })
  })

  /**
   * Cleared, not deleted, and that is not a shortcut: the mutation vocabulary has
   * no delete-key, and adding one would have been a second wire change this spec
   * deliberately did not make. `null` is what `resolveValue` renders as empty,
   * what `diff` already treats as equal to an absent key, and what the audit
   * ignores when counting orphan keys.
   */
  it('produces nothing on a second run, because the source is now null', () => {
    const d = doc([b('h', 'hero', { heading: 'Hi' })])
    expect(twice(d, (x) => field.rename(heroOf(x), 'heading', 'title')).second).toEqual([])
  })

  it('produces nothing for a document that never had the old field', () => {
    const d = doc([b('h', 'hero', { title: 'Hi' })])
    expect(field.rename(heroOf(d), 'heading', 'title')).toEqual([])
  })

  /**
   * A rename means the old field's value *is* the new field's value. Keeping
   * `to` instead would make the outcome depend on whether an editor happened to
   * touch the new input before the migration ran.
   */
  it('overwrites the destination when both hold a value', () => {
    const d = doc([b('h', 'hero', { heading: 'Real', title: '' })])
    expect(field.rename(heroOf(d), 'heading', 'title')[0]).toEqual({
      t: 'set',
      uid: 'h',
      field: 'title',
      value: 'Real',
    })
  })

  it('is a no-op when from and to are the same field', () => {
    const d = doc([b('h', 'hero', { title: 'Hi' })])
    expect(field.rename(heroOf(d), 'title', 'title')).toEqual([])
  })

  it('moves a structured value verbatim', () => {
    const value = { kind: 'story', id: 'sty_a' }
    const d = doc([b('h', 'hero', { link: value })])
    expect(field.rename(heroOf(d), 'link', 'href')[0]).toEqual({
      t: 'set',
      uid: 'h',
      field: 'href',
      value,
    })
  })
})

describe('field.remove', () => {
  it('clears a field the schema no longer declares', () => {
    const d = doc([b('h', 'hero', { legacyFlag: true })])
    const { first, second } = twice(d, (x) => field.remove(heroOf(x), 'legacyFlag'))
    expect(first).toEqual([{ t: 'set', uid: 'h', field: 'legacyFlag', value: null }])
    expect(second).toEqual([])
  })

  it('produces nothing for a field that is absent, rather than adding a null key', () => {
    const d = doc([b('h', 'hero', {})])
    expect(field.remove(heroOf(d), 'legacyFlag')).toEqual([])
  })
})

/**
 * The retroactive half of `Field.default`, which `field-defaults-and-presets.md`
 * deferred here: that key is read at *creation* only, so a field added to a
 * schema never appears in documents written before it.
 */
describe('field.default', () => {
  it('fills a field the document has no key for', () => {
    const d = doc([b('h', 'hero', { title: 'Hi' })])
    const { first, second } = twice(d, (x) => field.default(heroOf(x), 'align', 'left'))
    expect(first).toEqual([{ t: 'set', uid: 'h', field: 'align', value: 'left' }])
    expect(second).toEqual([])
  })

  /**
   * Strictly "absent", not "empty". An editor who cleared a field chose that, and
   * a tool for filling holes must not be a tool for overwriting decisions. It
   * also means this is a no-op on every document created since the field existed,
   * which is exactly the population it should not touch.
   */
  it.each<[string, Json]>([
    ['an empty string', ''],
    ['false', false],
    ['zero', 0],
    ['an explicit null (a cleared field)', null],
    ['an empty array', []],
  ])('leaves %s alone', (_label, existing) => {
    const d = doc([b('h', 'hero', { align: existing })])
    expect(field.default(heroOf(d), 'align', 'left')).toEqual([])
  })
})

describe('field.map', () => {
  it('rewrites a value through the transform', () => {
    const d = doc([b('h', 'hero', { topic: 'Design' })])
    const { first, second } = twice(d, (x) =>
      field.map(heroOf(x), 'topic', (v) => String(v).toLowerCase()),
    )
    expect(first).toEqual([{ t: 'set', uid: 'h', field: 'topic', value: 'design' }])
    expect(second).toEqual([])
  })

  /**
   * Idempotent by comparison rather than by a marker, which is why `map` is only
   * safe with an idempotent transform. Stated, not hidden.
   */
  it('produces nothing when the transform is already satisfied', () => {
    const d = doc([b('h', 'hero', { topic: 'design' })])
    expect(field.map(heroOf(d), 'topic', (v) => String(v).toLowerCase())).toEqual([])
  })

  it('compares deeply, so a structurally identical object emits nothing', () => {
    const d = doc([b('h', 'hero', { meta: { a: [1, 2] } })])
    expect(field.map(heroOf(d), 'meta', () => ({ a: [1, 2] }))).toEqual([])
  })

  it('produces nothing for an absent or cleared field', () => {
    expect(field.map(heroOf(doc([b('h', 'hero', {})])), 'topic', () => 'x')).toEqual([])
    expect(field.map(heroOf(doc([b('h', 'hero', { topic: null })])), 'topic', () => 'x')).toEqual(
      [],
    )
  })
})

describe('field.split', () => {
  it('writes every part and clears the source', () => {
    const d = doc([b('h', 'hero', { name: 'Ada Lovelace' })])
    const parts = {
      firstName: (v: Json) => String(v).split(' ')[0]!,
      lastName: (v: Json) => String(v).split(' ').slice(1).join(' '),
    }
    const { first, second, after } = twice(d, (x) => field.split(heroOf(x), 'name', parts))
    expect(first).toEqual([
      { t: 'set', uid: 'h', field: 'firstName', value: 'Ada' },
      { t: 'set', uid: 'h', field: 'lastName', value: 'Lovelace' },
      { t: 'set', uid: 'h', field: 'name', value: null },
    ])
    expect(after.bloks.h!.data).toEqual({ name: null, firstName: 'Ada', lastName: 'Lovelace' })
    expect(second).toEqual([])
  })

  /** That is `field.remove`, said badly — so it is refused rather than performed. */
  it('refuses to clear the source when there are no parts', () => {
    const d = doc([b('h', 'hero', { name: 'Ada' })])
    expect(field.split(heroOf(d), 'name', {})).toEqual([])
  })
})

describe('block.retype', () => {
  it('retypes and seeds the fields the new type introduces', () => {
    const d = doc([b('q', 'bigQuote', { text: 'Hi' })])
    const run = (x: Doc) => block.retype(x.bloks.q!, 'quote', { size: 'large' })
    const first = run(d)
    expect(first).toEqual([
      { t: 'retype', uid: 'q', type: 'quote' },
      { t: 'set', uid: 'q', field: 'size', value: 'large' },
    ])
    const after = applyAll(d, first)
    expect(after.bloks.q!.type).toBe('quote')
    expect(run(after)).toEqual([])
  })

  it('keeps the uid, the position and the children', () => {
    const d = doc([
      b('q', 'bigQuote', { text: 'Hi' }, { order: 'a3' }),
      b('c1', 'hero', {}, { parent: 'q', slot: 'body', order: 'a0' }),
      b('c2', 'hero', {}, { parent: 'q', slot: 'body', order: 'a1' }),
    ])
    const after = applyAll(d, block.retype(d.bloks.q!, 'quote'))
    expect(after.bloks.q).toEqual({ ...d.bloks.q!, type: 'quote' })
    expect(after.bloks.c1).toEqual(d.bloks.c1)
    expect(after.bloks.c2).toEqual(d.bloks.c2)
  })

  /** Same rule as `field.default`: a re-run must not stomp a value an editor changed. */
  it('does not re-seed a field that already has a value', () => {
    const d = doc([b('q', 'quote', { text: 'Hi', size: 'small' })])
    expect(block.retype(d.bloks.q!, 'quote', { size: 'large' })).toEqual([])
  })

  it('emits only the sets when the type already matches', () => {
    const d = doc([b('q', 'quote', { text: 'Hi' })])
    expect(block.retype(d.bloks.q!, 'quote', { size: 'large' })).toEqual([
      { t: 'set', uid: 'q', field: 'size', value: 'large' },
    ])
  })
})

describe('block.wrap', () => {
  it('inserts a parent in the blok’s own place and moves the blok inside it', () => {
    const d = doc([b('h', 'hero', { title: 'Hi' }, { order: 'a2' })])
    const ms = block.wrap(d, d.bloks.h!, 'container', 'body')
    expect(ms).toHaveLength(2)
    const [insert, move] = ms
    if (insert?.t !== 'insert' || move?.t !== 'move') throw new Error('unexpected shape')
    // The wrapper takes the blok's own parent, slot and order, so nothing moves
    // in the rendered order.
    expect(insert.blok).toMatchObject({
      type: 'container',
      parent: 'root',
      slot: 'body',
      order: 'a2',
    })
    expect(move).toEqual({
      uid: 'h',
      t: 'move',
      parent: insert.blok.uid,
      slot: 'body',
      order: 'a0',
    })

    const after = applyAll(d, ms)
    expect(after.bloks.h!.parent).toBe(insert.blok.uid)
    expect(after.bloks[insert.blok.uid]!.parent).toBe('root')
  })

  /**
   * Idempotent by *shape*, not by uid: the wrapper's uid is fresh every call, so
   * a dry run and the real run allocate different ones. Which is why idempotence
   * is "zero mutations against an already-migrated document" rather than
   * "identical mutations".
   */
  it('produces nothing once the parent is already a container', () => {
    const d = doc([b('h', 'hero', {})])
    const after = applyAll(d, block.wrap(d, d.bloks.h!, 'container', 'body'))
    expect(block.wrap(after, after.bloks.h!, 'container', 'body')).toEqual([])
  })

  it('refuses to wrap the root, which has no parent to hang a wrapper off', () => {
    const d = doc([])
    expect(block.wrap(d, d.bloks.root!, 'container', 'body')).toEqual([])
  })

  it('seeds the wrapper’s own fields when given', () => {
    const d = doc([b('h', 'hero', {})])
    const [insert] = block.wrap(d, d.bloks.h!, 'container', 'body', { width: 'wide' })
    if (insert?.t !== 'insert') throw new Error('unexpected shape')
    expect(insert.blok.data).toEqual({ width: 'wide' })
  })
})

describe('migrationContext.each', () => {
  it('walks every blok of a type in uid order and flattens the result', () => {
    const d = doc([
      b('zz', 'hero', { heading: 'Z' }),
      b('aa', 'hero', { heading: 'A' }),
      b('mm', 'quote', { heading: 'M' }),
    ])
    const ctx = migrationContext(d, SCHEMA, PAGE)
    expect(ctx.each('hero', (blok) => field.rename(blok, 'heading', 'title'))).toEqual([
      { t: 'set', uid: 'aa', field: 'title', value: 'A' },
      { t: 'set', uid: 'aa', field: 'heading', value: null },
      { t: 'set', uid: 'zz', field: 'title', value: 'Z' },
      { t: 'set', uid: 'zz', field: 'heading', value: null },
    ])
  })

  it('produces nothing for a type the document does not contain', () => {
    const ctx = migrationContext(doc([]), SCHEMA, PAGE)
    expect(ctx.each('hero', () => [{ t: 'remove', uid: 'x' }])).toEqual([])
  })

  it('hands the schema and the document type through', () => {
    const ctx = migrationContext(doc([]), SCHEMA, PAGE)
    expect(ctx.schema).toBe(SCHEMA)
    expect(ctx.type).toBe(PAGE)
  })
})

describe('migrateDoc', () => {
  const rename = defineMigration({
    id: '0001-heading-to-title',
    description: 'hero.heading → hero.title',
    up: (_d, ctx) => ctx.each('hero', (blok) => field.rename(blok, 'heading', 'title')),
  })
  const upper = defineMigration({
    id: '0002-title-upper',
    description: 'shout every hero title',
    up: (_d, ctx) =>
      ctx.each('hero', (blok) => field.map(blok, 'title', (v) => String(v).toUpperCase())),
  })

  /**
   * Load-bearing: each migration sees the document as the one before it left it.
   * Without that, 0002 above would find no `title` at all and a chain of
   * migrations would only ever be a set of independent ones.
   */
  it('runs migrations in order, each over the previous one’s result', () => {
    const d = doc([b('h', 'hero', { heading: 'hi' })])
    const { mutations, doc: out } = migrateDoc(d, [rename, upper], SCHEMA, PAGE)
    expect(mutations.map((m) => (m.t === 'set' ? [m.field, m.value] : m.t))).toEqual([
      ['title', 'hi'],
      ['heading', null],
      ['title', 'HI'],
    ])
    expect(out.bloks.h!.data).toEqual({ heading: null, title: 'HI' })
  })

  it('produces nothing at all for an already-migrated document', () => {
    const d = doc([b('h', 'hero', { heading: 'hi' })])
    const once = migrateDoc(d, [rename, upper], SCHEMA, PAGE)
    expect(migrateDoc(once.doc, [rename, upper], SCHEMA, PAGE).mutations).toEqual([])
  })

  it('returns the document unchanged for an empty migration list', () => {
    const d = doc([b('h', 'hero', { heading: 'hi' })])
    expect(migrateDoc(d, [], SCHEMA, PAGE)).toEqual({ mutations: [], doc: d })
  })
})

describe('pendingFor', () => {
  const ms: Migration[] = [
    { id: '0001-a', description: 'a', up: () => [] },
    { id: '0002-b', description: 'b', up: () => [] },
    { id: '0003-c', description: 'c', up: () => [] },
  ]

  /**
   * Null means "before the first migration", which is the reading a row written
   * before `stories.schema_id` existed has to get: it is exactly the population
   * this whole feature is for.
   */
  it('hands back every migration for a null watermark', () => {
    expect(pendingFor(null, ms).map((m) => m.id)).toEqual(['0001-a', '0002-b', '0003-c'])
    expect(pendingFor(undefined, ms).map((m) => m.id)).toHaveLength(3)
  })

  it('hands back the ones after the watermark, exclusive', () => {
    expect(pendingFor('0001-a', ms).map((m) => m.id)).toEqual(['0002-b', '0003-c'])
    expect(pendingFor('0003-c', ms)).toEqual([])
  })

  it('hands back nothing for a watermark past every configured id', () => {
    // A deploy rolled back to a build that has fewer migrations than the
    // database has already had. Nothing to do is the right answer.
    expect(pendingFor('0009-later', ms)).toEqual([])
  })

  it('is empty when nothing is configured', () => {
    expect(pendingFor(null, [])).toEqual([])
  })
})

describe('latestMigrationId', () => {
  it('is the last configured id, or null with none', () => {
    expect(latestMigrationId([])).toBeNull()
    expect(
      latestMigrationId([
        { id: '0001-a', description: 'a', up: () => [] },
        { id: '0002-b', description: 'b', up: () => [] },
      ]),
    ).toBe('0002-b')
  })
})

/**
 * The declared order *is* the run order and `stories.schema_id` compares
 * lexicographically, so a set whose two orders disagree would migrate documents
 * in an order that depends on which comparison was used. Checked, not assumed.
 */
describe('validateMigrations', () => {
  const m = (id: string): Migration => ({ id, description: id, up: () => [] })

  it('accepts an empty or absent list', () => {
    expect(() => validateMigrations(undefined)).not.toThrow()
    expect(() => validateMigrations([])).not.toThrow()
  })

  it('accepts zero-padded ids in order', () => {
    expect(() => validateMigrations([m('0001-a'), m('0002-b'), m('0010-c')])).not.toThrow()
  })

  it('accepts ids with no numeric prefix at all, as long as they sort', () => {
    expect(() => validateMigrations([m('alpha'), m('beta')])).not.toThrow()
  })

  it('refuses a duplicate id', () => {
    expect(() => validateMigrations([m('0001-a'), m('0001-a')])).toThrow(/duplicate migration id/)
  })

  it('refuses an empty id or one with surrounding whitespace', () => {
    expect(() => validateMigrations([m('')])).toThrow(/must be non-empty/)
    expect(() => validateMigrations([m(' 0001-a')])).toThrow(/must be non-empty/)
  })

  it('refuses a migration with no description, which an editor reads', () => {
    expect(() => validateMigrations([{ id: '0001-a', description: '', up: () => [] }])).toThrow(
      /no description/,
    )
  })

  it('refuses ids declared out of lexicographic order', () => {
    expect(() => validateMigrations([m('0002-b'), m('0001-a')])).toThrow(/sorts before it/)
  })

  /** The unpadded trap: '10-c' sorts before '2-b', so the run order would be wrong. */
  it('refuses a mixture of padded and unpadded numeric prefixes', () => {
    expect(() => validateMigrations([m('0001-a'), m('2-b')])).toThrow(/same width/)
  })

  it('refuses a numeric prefix on some ids and not others', () => {
    expect(() => validateMigrations([m('0001-a'), m('later')])).toThrow(/same width/)
  })
})
