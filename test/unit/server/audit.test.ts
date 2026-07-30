import { describe, expect, it } from 'vitest'
import {
  type AuditedStory,
  auditDocuments,
  auditSchema,
  auditStories,
  type DocumentSizeFinding,
  WARN_DOC_BYTES,
} from '../../../src/server/audit'
import type { Blok, Doc, Json } from '../../../src/core/doc'
import { asset, blocks, boolean, select, text } from '../../../src/core/fields'
import { docBytes, MAX_DOC_BYTES } from '../../../src/core/protocol'
import type { SchemaIndex } from '../../../src/core/schema'

/**
 * The drift report's two halves (`schema-migrations.md` decision 7), tested pure:
 * `auditDocuments` over documents a caller already has, `auditSchema` over the
 * declarations alone.
 *
 * The schema half carries the two checks `conditional-fields.md` deferred here —
 * a `showIf` naming a field that does not exist, and a `summary` naming a hidden
 * field. Both are code mistakes with no runtime symptom: `matches` is total, so
 * an unknown condition field simply evaluates false and the input is never drawn.
 */

const b = (uid: string, type: string, data: Record<string, Json> = {}): Blok => ({
  uid,
  type,
  parent: 'root',
  slot: 'body',
  order: 'a0',
  data,
})

const doc = (bloks: Blok[]): { doc: Doc } => ({
  doc: {
    root: 'root',
    bloks: {
      root: { uid: 'root', type: 'page', parent: null, slot: null, order: 'a0', data: {} },
      ...Object.fromEntries(bloks.map((x) => [x.uid, x])),
    },
  },
})

const SCHEMA: SchemaIndex = {
  page: { name: 'page', label: 'Page', fields: { body: blocks({ allow: ['hero'] }) } },
  hero: {
    name: 'hero',
    label: 'Hero',
    summary: 'title',
    fields: { title: text(), align: select({ options: [{ label: 'L', value: 'left' }] }) },
  },
}

describe('auditDocuments: orphan keys', () => {
  it('counts a key the schema no longer declares, per document and per blok', () => {
    const findings = auditDocuments(
      [
        doc([b('a', 'hero', { title: 'A', heading: 'old' }), b('b', 'hero', { heading: 'old' })]),
        doc([b('c', 'hero', { heading: 'old' })]),
      ],
      SCHEMA,
    )
    expect(findings.find((f) => f.check === 'orphan-key')).toMatchObject({
      check: 'orphan-key',
      type: 'hero',
      field: 'heading',
      documents: 2,
      bloks: 3,
    })
  })

  /**
   * The one exclusion, and it matters: clearing a field is `set … null` (the
   * vocabulary has no delete-key), so a *completed* rename leaves a null key
   * behind. Reporting those would mean every successful migration left permanent
   * drift in the report, and an orphan key only matters when it holds content
   * nobody can see.
   */
  it('ignores a null orphan key: that is a field a migration already cleared', () => {
    const findings = auditDocuments([doc([b('a', 'hero', { title: 'A', heading: null })])], SCHEMA)
    expect(findings.filter((f) => f.check === 'orphan-key')).toEqual([])
  })

  it('reports nothing for a blok whose type is unknown, since there is no schema to be orphaned from', () => {
    const findings = auditDocuments([doc([b('a', 'mystery', { anything: 1 })])], SCHEMA)
    expect(findings.map((f) => f.check)).toEqual(['unknown-type'])
  })
})

describe('auditDocuments: unknown types', () => {
  it('counts a blok whose type nothing declares any more', () => {
    const findings = auditDocuments(
      [
        doc([b('a', 'bigQuote'), b('b', 'bigQuote')]),
        doc([b('c', 'hero', { title: '', align: '' })]),
      ],
      SCHEMA,
    )
    expect(findings.find((f) => f.check === 'unknown-type')).toEqual({
      check: 'unknown-type',
      type: 'bigQuote',
      field: null,
      documents: 1,
      bloks: 2,
    })
  })
})

describe('auditDocuments: missing fields', () => {
  it('counts a declared field the document has no key for', () => {
    const findings = auditDocuments([doc([b('a', 'hero', { title: 'A' })])], SCHEMA)
    expect(findings.find((f) => f.check === 'missing-field')).toEqual({
      check: 'missing-field',
      type: 'hero',
      field: 'align',
      documents: 1,
      bloks: 1,
    })
  })

  /** A cleared field has a key, so it is present. Nothing to fill. */
  it('does not report a field explicitly set to null', () => {
    const findings = auditDocuments([doc([b('a', 'hero', { title: 'A', align: null })])], SCHEMA)
    expect(findings.filter((f) => f.check === 'missing-field')).toEqual([])
  })

  /** Children are separate bloks, not a value on the parent: no key to be missing. */
  it('never reports a blocks-kind field, which has no value on the parent', () => {
    const findings = auditDocuments([doc([])], SCHEMA)
    expect(findings.filter((f) => f.field === 'body')).toEqual([])
  })
})

describe('auditDocuments: ordering and emptiness', () => {
  it('sorts by document count, most first', () => {
    const findings = auditDocuments(
      [
        doc([b('a', 'hero', { title: 'A', align: 'left', gone: 1 })]),
        doc([b('b', 'hero', { title: 'B', align: 'left', gone: 1 })]),
        doc([b('c', 'hero', { title: 'C', align: 'left', other: 1 })]),
      ],
      SCHEMA,
    )
    expect(findings.map((f) => [f.check, f.field, f.documents])).toEqual([
      ['orphan-key', 'gone', 2],
      ['orphan-key', 'other', 1],
    ])
  })

  it('reports nothing for documents that match the schema exactly', () => {
    expect(auditDocuments([doc([b('a', 'hero', { title: 'A', align: 'left' })])], SCHEMA)).toEqual(
      [],
    )
  })

  it('reports nothing for no documents at all', () => {
    expect(auditDocuments([], SCHEMA)).toEqual([])
  })
})

/**
 * `document-size`: the byte ceiling nobody watches, because the blok ceiling is
 * the one that sounds like the limit. Eight languages of long richtext is eight
 * times the payload at the same block count, so `MAX_DOC_BYTES` is reachable on
 * a page whose block count is unremarkable — and the first symptom without this
 * check is an editor's save being refused.
 *
 * Sized against `WARN_DOC_BYTES` rather than a literal on purpose: the threshold
 * is an argued judgement call, and a test that pinned 6 MB would have to be
 * rewritten to change it rather than simply following.
 */
describe('auditStories: a document approaching MAX_DOC_BYTES', () => {
  /** One published row whose body is `filler` bytes of prose, plus optional translations. */
  const story = (
    id: string,
    filler: number,
    i18n?: Record<string, Record<string, Json>>,
  ): AuditedStory => ({
    id,
    type: 'page',
    doc: {
      root: 'root',
      bloks: {
        root: { uid: 'root', type: 'page', parent: null, slot: null, order: 'a0', data: {} },
        body: {
          uid: 'body',
          type: 'hero',
          parent: 'root',
          slot: 'body',
          order: 'a0',
          data: { title: 'x'.repeat(filler) },
          ...(i18n ? { i18n } : {}),
        },
      },
    },
  })

  it('says nothing about a document under the threshold', () => {
    const under = story('sty_small', WARN_DOC_BYTES - 4096)
    expect(docBytes(under.doc)).toBeLessThan(WARN_DOC_BYTES)
    expect(auditStories([under])).toEqual([])
  })

  it('reports exactly one finding, naming the story, once it is over', () => {
    const over = story('sty_big', WARN_DOC_BYTES)
    const findings = auditStories([over]) as DocumentSizeFinding[]
    expect(findings).toHaveLength(1)
    const finding = findings[0]!
    expect(finding).toMatchObject({
      check: 'document-size',
      story: 'sty_big',
      type: 'page',
      bytes: docBytes(over.doc),
      locales: [],
    })
    expect(finding.bytes).toBeGreaterThanOrEqual(WARN_DOC_BYTES)
    expect(finding.bytes).toBeLessThan(MAX_DOC_BYTES)
    expect(finding.detail).toContain('% of the 8.0 MB document cap')
  })

  /**
   * The measurement has to be the one the door makes. A warning derived from a
   * different serialisation would disagree with `docCapError` at exactly the
   * size where an operator is relying on it.
   */
  it('counts the bytes docCapError counts', () => {
    const over = story('sty_big', WARN_DOC_BYTES)
    const finding = (auditStories([over]) as DocumentSizeFinding[])[0]!
    expect(finding.bytes).toBe(new TextEncoder().encode(JSON.stringify(over.doc)).byteLength)
  })

  /**
   * Localisation is the reason this became reachable, so the finding says where
   * the weight went: "6.5 MB" is alarming, "of which 4 MB is fr and de" is
   * something an operator can act on.
   */
  it('attributes the weight per locale, heaviest first', () => {
    const over = story('sty_i18n', 1024 * 1024, {
      de: { title: 'd'.repeat(2 * 1024 * 1024) },
      fr: { title: 'f'.repeat(3 * 1024 * 1024) },
      es: { title: 'e'.repeat(512) },
    })
    const finding = (auditStories([over]) as DocumentSizeFinding[])[0]!
    expect(finding.locales.map((l) => l.code)).toEqual(['fr', 'de', 'es'])
    expect(finding.locales[0]!.bytes).toBeGreaterThan(3 * 1024 * 1024)
    // The parts are a real subtree of the whole, so they sum to just under it.
    const translated = finding.locales.reduce((n, l) => n + l.bytes, 0)
    expect(translated).toBeLessThan(finding.bytes)
    expect(finding.detail).toContain('is translations (fr ')
  })

  it('reports the heaviest document first', () => {
    const findings = auditStories([
      story('sty_a', WARN_DOC_BYTES),
      story('sty_c', WARN_DOC_BYTES + 512 * 1024),
      story('sty_b', WARN_DOC_BYTES + 1024),
    ]) as DocumentSizeFinding[]
    expect(findings.map((f) => f.story)).toEqual(['sty_c', 'sty_b', 'sty_a'])
  })

  it('says nothing about no documents at all', () => {
    expect(auditStories([])).toEqual([])
  })
})

/**
 * `conditional-fields.md`'s deferred debt, first half. Spec 4's plan asked for
 * this check and its agent correctly declined to edit another spec's file.
 */
describe('auditSchema: a showIf naming a field that does not exist', () => {
  it('names the block, the field and the missing condition field', () => {
    const findings = auditSchema({
      hero: {
        name: 'hero',
        label: 'Hero',
        fields: {
          title: text(),
          caption: text({ showIf: { field: 'showCaption', eq: true } }),
        },
      },
    })
    expect(findings).toEqual([
      {
        check: 'unknown-condition-field',
        block: 'hero',
        field: 'caption',
        detail: expect.stringContaining("showIf names 'showCaption'"),
      },
    ])
  })

  it('walks into all / any / not', () => {
    const findings = auditSchema({
      hero: {
        name: 'hero',
        label: 'Hero',
        fields: {
          real: boolean(),
          a: text({
            showIf: {
              all: [
                { field: 'real', eq: true },
                { field: 'ghost', eq: 1 },
              ],
            },
          }),
          b: text({ showIf: { any: [{ field: 'phantom', isSet: true }] } }),
          c: text({ showIf: { not: { field: 'spectre', ne: null } } }),
        },
      },
    })
    expect(findings.map((f) => f.field)).toEqual(['a', 'b', 'c'])
  })

  it('reports nothing when every condition names a declared field', () => {
    expect(
      auditSchema({
        hero: {
          name: 'hero',
          label: 'Hero',
          fields: {
            showCaption: boolean(),
            caption: text({ showIf: { field: 'showCaption', eq: true } }),
          },
        },
      }),
    ).toEqual([])
  })
})

/** `conditional-fields.md`'s deferred debt, second half. */
describe('auditSchema: a summary naming a hidden field', () => {
  it('reports a summary field marked hidden', () => {
    const findings = auditSchema({
      hero: {
        name: 'hero',
        label: 'Hero',
        summary: 'internalRef',
        fields: { internalRef: text({ hidden: true }), title: text() },
      },
    })
    expect(findings).toEqual([
      {
        check: 'hidden-summary-field',
        block: 'hero',
        field: 'internalRef',
        detail: expect.stringContaining('hidden: true'),
      },
    ])
  })

  /**
   * `showIf` counts as hiding: a summary present on some bloks of a type and
   * absent on others is the same confusion, intermittently — which is harder to
   * work out, not easier.
   */
  it('reports a summary field behind a showIf', () => {
    const findings = auditSchema({
      hero: {
        name: 'hero',
        label: 'Hero',
        summary: 'caption',
        fields: {
          showCaption: boolean(),
          caption: text({ showIf: { field: 'showCaption', eq: true } }),
        },
      },
    })
    expect(findings.map((f) => f.check)).toEqual(['hidden-summary-field'])
  })

  it('reports a summary naming a field the block does not declare at all', () => {
    const findings = auditSchema({
      hero: { name: 'hero', label: 'Hero', summary: 'nope', fields: { title: text() } },
    })
    expect(findings).toEqual([
      {
        check: 'unknown-summary-field',
        block: 'hero',
        field: 'nope',
        detail: expect.stringContaining('every tree row is unlabelled'),
      },
    ])
  })

  it('reports nothing for an ordinary visible summary field', () => {
    expect(
      auditSchema({
        hero: { name: 'hero', label: 'Hero', summary: 'title', fields: { title: text() } },
      }),
    ).toEqual([])
  })

  it('reports nothing for a block with no summary', () => {
    expect(
      auditSchema({
        hero: { name: 'hero', label: 'Hero', fields: { file: asset({ hidden: true }) } },
      }),
    ).toEqual([])
  })
})
