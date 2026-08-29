import { describe, expect, it } from 'vitest'
import {
  type AuditedStory,
  auditDocuments,
  auditSchema,
  auditStories,
  type DocumentSizeFinding,
  FINDING_SAMPLE,
  WARN_DOC_BYTES,
} from '../../../src/server/audit'
import type { Blok, Doc, Json } from '../../../src/core/doc'
import { asset, blocks, boolean, select, text, textarea } from '../../../src/core/fields'
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

/**
 * One published document. `id` defaults, because most tests here are about *one*
 * document and its findings — but it is a parameter rather than a constant, since
 * `ContentFinding.sample` is per document and a fixture that reused one id would
 * make the sample look like it deduplicates when it does not.
 */
const doc = (bloks: Blok[], id = 'sty_1'): { id: string; doc: Doc } => ({
  id,
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
        doc(
          [b('a', 'hero', { title: 'A', heading: 'old' }), b('b', 'hero', { heading: 'old' })],
          'sty_1',
        ),
        doc([b('c', 'hero', { heading: 'old' })], 'sty_2'),
      ],
      SCHEMA,
    )
    expect(findings.find((f) => f.check === 'orphan-key')).toMatchObject({
      check: 'orphan-key',
      type: 'hero',
      field: 'heading',
      documents: 2,
      bloks: 3,
      // One id per *document*, not per blok: two faulty bloks on one page are one
      // thing to go and look at.
      sample: ['sty_1', 'sty_2'],
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
        doc([b('a', 'bigQuote'), b('b', 'bigQuote')], 'sty_1'),
        doc([b('c', 'hero', { title: '', align: '' })], 'sty_2'),
      ],
      SCHEMA,
    )
    expect(findings.find((f) => f.check === 'unknown-type')).toEqual({
      check: 'unknown-type',
      type: 'bigQuote',
      field: null,
      documents: 1,
      bloks: 2,
      sample: ['sty_1'],
    })
  })
})

/**
 * `ContentFinding.sample`: what turns a count into something an operator can open.
 *
 * The tally is deliberately a count rather than a row per blok — a site with 400
 * heroes carrying an orphan key needs the number — and the admin's audit panel is
 * required to link each finding to the document it is about. Five ids plus the
 * remaining count is the answer to both.
 */
describe('auditDocuments: the sample', () => {
  it('caps at FINDING_SAMPLE while the count keeps climbing', () => {
    const docs = Array.from({ length: 9 }, (_, i) =>
      doc([b('a', 'hero', { title: 'A', align: 'left', gone: 1 })], `sty_${i}`),
    )
    const finding = auditDocuments(docs, SCHEMA)[0]!
    expect(finding.documents).toBe(9)
    expect(finding.sample).toEqual(['sty_0', 'sty_1', 'sty_2', 'sty_3', 'sty_4'])
    expect(finding.sample).toHaveLength(FINDING_SAMPLE)
  })

  /**
   * A caller with no ids gets a count with nothing to open, rather than an error.
   * `auditDocuments` is callable with a bare `{ doc }` literal and the file header
   * treats that as worth keeping.
   */
  it('is empty for documents passed with no id', () => {
    const bare = [{ doc: doc([b('a', 'hero', { title: 'A', heading: 'old' })]).doc }]
    const finding = auditDocuments(bare, SCHEMA)[0]!
    expect(finding.documents).toBe(1)
    expect(finding.sample).toEqual([])
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
      sample: ['sty_1'],
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
        doc([b('a', 'hero', { title: 'A', align: 'left', gone: 1 })], 'sty_1'),
        doc([b('b', 'hero', { title: 'B', align: 'left', gone: 1 })], 'sty_2'),
        doc([b('c', 'hero', { title: 'C', align: 'left', other: 1 })], 'sty_3'),
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
 * `unknown-document-type`: where `DataList.tsx`'s deleted "Unknown type" heading
 * went (`docs/ui-architecture.md` port phase 3 → 5).
 *
 * Not the same finding as `unknown-type` above, and the difference is the reason it
 * exists: that one is a `blok.type` inside a document, this one is `stories.type` —
 * the document's own kind. The admin's nav is generated from the manifest, so an
 * undeclared type has no list screen, which made a code change able to hide content
 * with no way back to it. The finding names the story, so the audit panel's link is
 * the way back.
 */
describe('auditStories: a document whose type is no longer declared', () => {
  const TYPES = [{ name: 'page', label: 'Page', kind: 'page' as const, root: 'page' }]
  const row = (id: string, type: string): AuditedStory => ({
    id,
    type,
    doc: { root: 'root', bloks: {} },
  })

  it('names the story and its orphaned type', () => {
    const findings = auditStories([row('sty_a', 'page'), row('sty_b', 'profile')], {
      types: TYPES,
    })
    expect(findings).toEqual([
      {
        check: 'unknown-document-type',
        story: 'sty_b',
        type: 'profile',
        note: "type 'profile'",
        detail: expect.stringContaining("document type 'profile' is not declared any more"),
      },
    ])
  })

  /**
   * Silent without declared types, matching `unusableIndex`: no types means "cannot
   * judge", not "every type is undeclared". Otherwise every call with a bare schema
   * — which is how half this file's tests are written — would report every document.
   */
  it('says nothing when no types are declared at all', () => {
    expect(auditStories([row('sty_b', 'profile')])).toEqual([])
  })

  /** It reports before `document-size`, which is the panel's reading order: a
   * document nothing can reach is worse than one that is merely getting heavy. */
  it('comes before the size finding', () => {
    const heavy: AuditedStory = {
      id: 'sty_big',
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
            data: { title: 'x'.repeat(WARN_DOC_BYTES) },
          },
        },
      },
    }
    const findings = auditStories([heavy, row('sty_lost', 'profile')], { types: TYPES })
    expect(findings.map((f) => f.check)).toEqual(['unknown-document-type', 'document-size'])
  })
})

/**
 * `Explained.note`: the short varying half of a `detail`, and whether it is there
 * at all.
 *
 * The reason it exists is a fault the audit panel made visible: nine
 * `not-translatable` findings rendered as nine copies of one sentence whose only
 * varying token was the first. So the *check* says what differs, and a check whose
 * rows differ only by their identifier says nothing — which is what stops the admin
 * needing a branch per family to work that out.
 */
describe('a finding’s note', () => {
  it('is the varying word where the sentence is otherwise identical', () => {
    const findings = auditSchema(
      { hero: { name: 'hero', label: 'Hero', fields: { title: text(), body: textarea() } } },
      // A locale config is what makes the translatable checks speak at all: on a
      // single-locale site they are silent by design.
      { locales: { default: 'en', available: [{ code: 'en', label: 'English' }] } },
    )
    const notes = findings.filter((f) => f.check === 'not-translatable').map((f) => f.note)
    expect(notes).toEqual(['text', 'textarea'])
    // And the whole sentence survives for the developer reading JSON.
    expect(findings[0]?.detail).toContain("no 'translatable: true'")
  })

  /** Absent is an answer: `block` and `field` are the entire finding. */
  it('is absent when the identifier is the whole difference', () => {
    const findings = auditSchema({
      hero: { name: 'hero', label: 'Hero', summary: 'nope', fields: { title: text() } },
    })
    expect(findings[0]?.check).toBe('unknown-summary-field')
    expect(findings[0]?.note).toBeUndefined()
  })

  /**
   * `document-size` is the family that argues against hiding a detail: every figure
   * in it varies and the figures are the point, so the note carries all of them and
   * only the standing consequence is left to `detail`.
   */
  it('carries every figure for document-size, leaving only the advice in detail', () => {
    const over: AuditedStory = {
      id: 'sty_big',
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
            data: { title: 'x'.repeat(WARN_DOC_BYTES) },
          },
        },
      },
    }
    const finding = auditStories([over])[0]!
    expect(finding.note).toContain('% of the 8.0 MB document cap')
    // Composed, not written twice: the detail is the note plus the consequence.
    expect(finding.detail.startsWith(finding.note ?? '')).toBe(true)
    expect(finding.detail).toContain('refused whole')
    expect(finding.note).not.toContain('refused whole')
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
        // The missing name is the one fact `block` and `field` do not carry, so it
        // is the note — a row reading only `hero.caption` would not say what is
        // wrong with it. See `Explained`.
        note: "showIf names 'showCaption'",
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
        note: 'hidden: true',
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
