import { describe, expect, it } from 'vitest'
import {
  AUDIT_SAMPLE_LINKS,
  type AuditBatch,
  type AuditState,
  auditFindingCount,
  auditGroups,
  auditScope,
  canReadAudit,
  canRunMigrations,
  driftBanner,
  isUnfinished,
  linkedStoryIds,
  mergeAudits,
  mergeMigrateReports,
  type RunState,
  runNotice,
  storyLabel,
  whyNotRun,
} from '../../../src/admin/ui/screens/model-model'
import type { ContentFinding, SchemaFinding, StoryFinding } from '../../../src/server/audit'
import type { MigrateReport, MigrationStatus } from '../../../src/server/migrate'
import type { Me } from '../../../src/admin/me'

/**
 * The Model screen's arithmetic (`docs/ui-architecture.md` port phase 5).
 *
 * Every test here is about **one batch not being the answer**. Both of the screen's
 * routes are resumable by a cursor — `POST /migrate` because a Worker's CPU limit
 * says so, `GET /audit` for the same reason — so the two merges and the wording that
 * depends on them are where this screen can be wrong in a way nobody notices: a
 * half-migrated site under a heading reading "Run", or a drift report over the first
 * hundred documents of a thousand presented as the whole answer.
 */

/* ------------------------------------------------------------ permissions --- */

const user = (role: 'viewer' | 'editor' | 'publisher' | 'admin'): Me => ({
  mode: 'session',
  actor: { kind: 'user', id: 'usr_a', name: 'Ada', colour: '#f00', role },
  loginUrl: '/folio/login',
})

describe('who may run a migration', () => {
  it('is anybody on an open deployment', () => {
    // Not an inconsistency with `canManageAccess`, which is false here: the access
    // surface 404s on an open deployment and `POST /migrate` does not.
    const open: Me = { mode: 'open', actor: null, loginUrl: '' }
    expect(canRunMigrations(open)).toBe(true)
    expect(canReadAudit(open)).toBe(true)
    expect(whyNotRun(open)).toBeUndefined()
  })

  it('is an admin, and nobody weaker', () => {
    expect(canRunMigrations(user('admin'))).toBe(true)
    expect(canRunMigrations(user('publisher'))).toBe(false)
    expect(canRunMigrations(user('editor'))).toBe(false)
    expect(canRunMigrations(user('viewer'))).toBe(false)
  })

  /** Both routes are `ADMIN`, so one predicate answers both. */
  it('is the same answer for the drift report', () => {
    expect(canReadAudit(user('admin'))).toBe(true)
    expect(canReadAudit(user('publisher'))).toBe(false)
  })

  it('is a token holding the admin scope', () => {
    const token = (scopes: Me['actor'] extends null ? never : string[]): Me => ({
      mode: 'session',
      actor: { kind: 'token', id: 'tok_a', name: 'deploy', scopes: scopes as never },
      loginUrl: '',
    })
    expect(canRunMigrations(token(['admin']))).toBe(true)
    expect(canRunMigrations(token(['content:write']))).toBe(false)
    expect(whyNotRun(token(['content:write']))).toContain("missing the 'admin' scope")
  })

  /** Worded like `refusalOf`, so the pre-emptive reason and the server's 403 agree. */
  it('explains the refusal by naming the role and what is required', () => {
    expect(whyNotRun(user('publisher'))).toBe(
      'Your role (publisher) may not run a migration; admin is required',
    )
    expect(whyNotRun({ mode: 'session', actor: null, loginUrl: '/l' })).toBe(
      'Sign in to run a migration',
    )
  })
})

/* -------------------------------------------------------------- the ledger --- */

const status = (over: Partial<MigrationStatus> = {}): MigrationStatus => ({
  migrations: [],
  pending: [],
  behind: 0,
  ...over,
})

describe('driftBanner', () => {
  /**
   * Null, not a green line. The table below the banner already shows every
   * migration wearing `run`, so a banner repeating it is furniture — the same rule
   * the audit panel follows.
   */
  it('is null when nothing is pending and nothing is behind', () => {
    expect(driftBanner(status())).toBeNull()
    expect(driftBanner(null)).toBeNull()
  })

  it('names both numbers and points at the dry run', () => {
    const notice = driftBanner(status({ pending: ['0001-a', '0002-b'], behind: 142 }))
    expect(notice).toContain('2 migrations pending')
    expect(notice).toContain('142 documents behind')
    expect(notice).toContain('Preview first')
  })

  /**
   * The case that reads as a contradiction until it is spelled out: everything is
   * recorded and documents are still behind. That is a failed or newly created
   * document, and re-running is the answer.
   */
  it('explains documents behind with nothing pending', () => {
    const notice = driftBanner(status({ pending: [], behind: 1 }))
    expect(notice).toContain('1 document is still behind')
    expect(notice).toContain('Running again picks them up')
  })

  /** And its mirror: pending over an empty set writes only the ledger row. */
  it('explains a pending migration with nothing behind it', () => {
    const notice = driftBanner(status({ pending: ['0001-a'], behind: 0 }))
    expect(notice).toContain('1 migration is pending')
    expect(notice).toContain('only records the ledger row')
  })
})

/* ---------------------------------------------------------------- the run --- */

const report = (over: Partial<MigrateReport> = {}): MigrateReport => ({
  pending: ['0001-a'],
  stories: 2,
  changed: 1,
  unchanged: 1,
  mutations: 4,
  publishedMutations: 2,
  transactions: 1,
  oversized: [],
  failed: [],
  dryRun: false,
  continueFrom: 'sty_b',
  behind: 5,
  complete: false,
  ...over,
})

describe('mergeMigrateReports', () => {
  it('adds up everything that counts', () => {
    const merged = mergeMigrateReports(report(), report({ stories: 3, changed: 2, mutations: 6 }))
    expect(merged).toMatchObject({
      stories: 5,
      changed: 3,
      unchanged: 2,
      mutations: 10,
      publishedMutations: 4,
      transactions: 2,
    })
  })

  it('takes the later batch for everything that says where the run got to', () => {
    const merged = mergeMigrateReports(
      report({ continueFrom: 'sty_b', behind: 5, complete: false }),
      report({ continueFrom: null, behind: 0, complete: true }),
    )
    expect(merged.continueFrom).toBeNull()
    expect(merged.behind).toBe(0)
    expect(merged.complete).toBe(true)
  })

  /**
   * What was pending when the run *started*. After the last batch writes the ledger
   * a re-read would answer an empty list, and a report that said "0 migrations
   * pending, 388 mutations" would be describing work it cannot name.
   */
  it('keeps the first batch’s pending list', () => {
    const merged = mergeMigrateReports(
      report({ pending: ['0001-a', '0002-b'] }),
      report({ pending: [] }),
    )
    expect(merged.pending).toEqual(['0001-a', '0002-b'])
  })

  it('concatenates the oversized and failed lists', () => {
    const merged = mergeMigrateReports(
      report({ oversized: [{ storyId: 'sty_a', mutations: 400, transactions: 2 }] }),
      report({ failed: [{ storyId: 'sty_c', reason: 'nope' }] }),
    )
    expect(merged.oversized).toHaveLength(1)
    expect(merged.failed).toEqual([{ storyId: 'sty_c', reason: 'nope' }])
  })
})

describe('isUnfinished', () => {
  /**
   * The screen's most important predicate. A `200` with a cursor is one batch
   * having succeeded, not a migration having landed.
   */
  it('is true for a batch that came back with a cursor', () => {
    expect(isUnfinished(report({ continueFrom: 'sty_b' }))).toBe(true)
    expect(isUnfinished(report({ continueFrom: null }))).toBe(false)
  })

  /**
   * And it is not the same question as `complete`, which is about whether anything
   * is *behind* — a sweep can reach the end of the table with failures behind it.
   */
  it('is not the same as complete', () => {
    const stopped = report({ continueFrom: 'sty_b', complete: true, behind: 0 })
    expect(isUnfinished(stopped)).toBe(true)
    expect(stopped.complete).toBe(true)
  })
})

describe('runNotice', () => {
  const run = (over: Partial<RunState> = {}): RunState => ({
    dryRun: false,
    batches: 3,
    running: false,
    report: report({ continueFrom: null, complete: true, behind: 0 }),
    ...over,
  })

  it('never reads as success when the run stopped short', () => {
    const notice = runNotice(run({ report: report({ continueFrom: 'sty_z', behind: 12 }) }))
    expect(notice).toContain('Stopped after')
    expect(notice).toContain('12 documents still behind')
    expect(notice).not.toContain('up to date')
  })

  it('says a preview wrote nothing', () => {
    const notice = runNotice(run({ dryRun: true }))
    expect(notice).toContain('Preview over')
    expect(notice).toContain('Nothing was written')
  })

  it('names the batch count, because a run is many requests', () => {
    expect(runNotice(run({ batches: 1 }))).toContain('1 batch')
    expect(runNotice(run({ batches: 6 }))).toContain('6 batches')
  })

  it('claims completeness only when nothing is behind', () => {
    expect(runNotice(run())).toContain('Every document is up to date')
    const partial = runNotice(run({ report: report({ continueFrom: null, behind: 3 }) }))
    expect(partial).toContain('3 documents still behind')
    expect(partial).not.toContain('up to date')
  })
})

/* -------------------------------------------------------------- the audit --- */

const content = (over: Partial<ContentFinding> = {}): ContentFinding => ({
  check: 'orphan-key',
  type: 'hero',
  field: 'heading',
  documents: 2,
  bloks: 3,
  sample: ['sty_a', 'sty_b'],
  ...over,
})

const story = (over: Partial<StoryFinding> = {}): StoryFinding => ({
  check: 'document-size',
  story: 'sty_big',
  type: 'page',
  detail: '6.1 MB serialised',
  ...over,
})

const schema = (over: Partial<SchemaFinding> = {}): SchemaFinding => ({
  check: 'not-translatable',
  block: 'hero',
  field: 'title',
  detail: "'title' is a text field with no 'translatable: true'",
  ...over,
})

const batch = (over: Partial<AuditBatch> = {}): AuditBatch => ({
  documents: 100,
  content: [],
  stories: [],
  schema: [],
  continueFrom: null,
  ...over,
})

describe('mergeAudits', () => {
  it('sums the documents examined and takes the later cursor', () => {
    const merged = mergeAudits(
      batch({ documents: 100, continueFrom: 'sty_m' }),
      batch({ documents: 40, continueFrom: null }),
    )
    expect(merged.documents).toBe(140)
    expect(merged.continueFrom).toBeNull()
  })

  it('tallies the same content finding met in two batches', () => {
    const merged = mergeAudits(
      batch({ content: [content({ documents: 2, bloks: 3 })] }),
      batch({ content: [content({ documents: 5, bloks: 9 })] }),
    )
    expect(merged.content).toHaveLength(1)
    expect(merged.content[0]).toMatchObject({ documents: 7, bloks: 12 })
  })

  /** Keyed on `(check, type, field)`, exactly as `auditDocuments` keys it. */
  it('keeps findings apart when any part of the key differs', () => {
    const merged = mergeAudits(
      batch({ content: [content({ field: 'heading' })] }),
      batch({
        content: [
          content({ field: 'subtitle' }),
          content({ check: 'missing-field' }),
          content({ type: 'quote' }),
        ],
      }),
    )
    expect(merged.content).toHaveLength(4)
  })

  /**
   * Two batches each ordered by their own counts are not ordered by the sum, so the
   * merge re-sorts — and the comparator has to be the one the route uses, because
   * the panel's reading order is "widest drift first".
   */
  it('re-sorts the merged tally by document count', () => {
    const merged = mergeAudits(
      batch({
        content: [
          content({ field: 'a', documents: 9, bloks: 9 }),
          content({ field: 'b', documents: 1, bloks: 1 }),
        ],
      }),
      batch({ content: [content({ field: 'b', documents: 40, bloks: 40 })] }),
    )
    expect(merged.content.map((f) => [f.field, f.documents])).toEqual([
      ['b', 41],
      ['a', 9],
    ])
  })

  it('caps the sample rather than accumulating one id per batch', () => {
    let merged = batch({ content: [content({ sample: ['sty_1'] })] })
    for (const id of ['sty_2', 'sty_3', 'sty_4', 'sty_5', 'sty_6', 'sty_7']) {
      merged = mergeAudits(merged, batch({ content: [content({ sample: [id] })] }))
    }
    expect(merged.content[0]?.sample).toHaveLength(AUDIT_SAMPLE_LINKS)
    // The first ones met, not the last: the sample is a way in, and stability
    // means a report re-read after one more batch does not point somewhere else.
    expect(merged.content[0]?.sample[0]).toBe('sty_1')
    // The count still climbs past the cap, which is what `and N more` reads.
    expect(merged.content[0]?.documents).toBe(14)
  })

  it('concatenates story findings, since a batch is a disjoint set of documents', () => {
    const merged = mergeAudits(
      batch({ stories: [story({ story: 'sty_a' })] }),
      batch({ stories: [story({ story: 'sty_b' })] }),
    )
    expect(merged.stories.map((f) => f.story)).toEqual(['sty_a', 'sty_b'])
  })

  /** `document-size` reports the heaviest first, and a merge has to restore that. */
  it('restores heaviest-first across batches', () => {
    const heavy = (id: string, bytes: number) => ({ ...story({ story: id }), bytes })
    const merged = mergeAudits(
      batch({ stories: [heavy('sty_a', 100)] }),
      batch({ stories: [heavy('sty_c', 900), heavy('sty_b', 500)] }),
    )
    expect(merged.stories.map((f) => f.story)).toEqual(['sty_c', 'sty_b', 'sty_a'])
  })

  /** And it groups by check first, so a family's rows are contiguous. */
  it('groups story findings by check', () => {
    const merged = mergeAudits(
      batch({ stories: [story({ story: 'sty_a' })] }),
      batch({
        stories: [
          story({ check: 'unknown-document-type', story: 'sty_x' }),
          story({ story: 'sty_b' }),
        ],
      }),
    )
    expect(merged.stories.map((f) => f.check)).toEqual([
      'document-size',
      'document-size',
      'unknown-document-type',
    ])
  })

  /**
   * The merge where the obvious implementation is wrong. A schema check reads no
   * document, so every batch answers the identical set — concatenating would report
   * the same code fault once per hundred documents on the site.
   */
  it('takes the later batch’s schema findings rather than both', () => {
    const merged = mergeAudits(batch({ schema: [schema()] }), batch({ schema: [schema()] }))
    expect(merged.schema).toHaveLength(1)
  })
})

describe('auditGroups', () => {
  /**
   * **Absent entirely when there is nothing wrong** — `ui-architecture.md`'s rule
   * for the Home screen's equivalent block. No green tick, no "all clear" card, and
   * therefore nothing for the screen to wrap in a heading.
   */
  it('is empty for a clean site, and for a walk that has not started', () => {
    expect(auditGroups(batch())).toEqual([])
    expect(auditGroups(null)).toEqual([])
    expect(auditFindingCount(null)).toBe(0)
  })

  it('drops a group with no findings rather than rendering an empty heading', () => {
    const groups = auditGroups(batch({ schema: [schema()] }))
    expect(groups.map((g) => g.kind)).toEqual(['schema'])
  })

  it('keeps the three groups in report order', () => {
    const groups = auditGroups(
      batch({ content: [content()], stories: [story()], schema: [schema()] }),
    )
    expect(groups.map((g) => g.kind)).toEqual(['content', 'stories', 'schema'])
  })

  /**
   * Families in the order their findings appear, not in a severity order defined
   * here: the server has already ordered `content` by how many documents each
   * finding touches, and a second ordering in the admin would be a table to keep in
   * step with a check list that lives elsewhere.
   */
  it('orders families by first appearance', () => {
    const groups = auditGroups(
      batch({
        content: [
          content({ check: 'missing-field', documents: 40 }),
          content({ check: 'orphan-key', documents: 9 }),
          content({ check: 'missing-field', field: 'align', documents: 2 }),
        ],
      }),
    )
    expect(groups[0]?.families.map((f) => f.check)).toEqual(['missing-field', 'orphan-key'])
    expect(groups[0]?.families[0]?.rows).toHaveLength(2)
  })

  it('names a content row by type and field, and the type alone when there is none', () => {
    const groups = auditGroups(
      batch({
        content: [
          content({ check: 'orphan-key', field: 'heading' }),
          content({ check: 'unknown-type', field: null }),
        ],
      }),
    )
    const rows = groups[0]?.families.flatMap((f) => f.rows) ?? []
    expect(rows.map((r) => r.subject)).toEqual(['hero.heading', 'hero'])
  })

  /**
   * The requirement that makes this a tool rather than a report
   * (`ui-architecture.md`, Model): each finding links to the document it is about.
   * A tally links to its sample and says how many it is not naming.
   */
  it('links a tally to its sampled documents and counts the rest', () => {
    const groups = auditGroups(
      batch({ content: [content({ documents: 400, sample: ['sty_a', 'sty_b'] })] }),
    )
    const row = groups[0]?.families[0]?.rows[0]
    expect(row?.stories).toEqual(['sty_a', 'sty_b'])
    expect(row?.more).toBe(398)
    expect(row?.documents).toBe(400)
  })

  it('never reports a negative remainder when a sample outruns its count', () => {
    // Cannot happen from the route, and a caller with no ids is the other end of
    // the same guard: a count with nothing to open must still render.
    const groups = auditGroups(batch({ content: [content({ documents: 1, sample: [] })] }))
    expect(groups[0]?.families[0]?.rows[0]).toMatchObject({ stories: [], more: 1 })
  })

  /**
   * A per-document finding is its own link, which for one check is the *only* route
   * to the document — see `unknown-document-type` in `server/audit.ts`.
   *
   * `subject` is null rather than the story id: the link already names the document,
   * and the first version drew the id twice on one row — once as a mono subject and
   * once as the link beside it.
   */
  it('makes the document the subject of a story row rather than naming it twice', () => {
    const groups = auditGroups(
      batch({
        stories: [story({ check: 'unknown-document-type', story: 'sty_lost', detail: 'gone' })],
      }),
    )
    const row = groups[0]?.families[0]?.rows[0]
    expect(row).toMatchObject({ subject: null, stories: ['sty_lost'], detail: 'gone' })
    expect(groups[0]?.families[0]?.title).toBe('Documents of an undeclared type')
  })

  /**
   * The fix for a wall of text. A row carries the *varying* half; the shared
   * explanation is the family's `body`, once. `detail` survives on the row for the
   * screen to hang off a `title`, but it is not what the row reads as.
   */
  it('carries the check’s note through to the row, and keeps detail beside it', () => {
    const groups = auditGroups(
      batch({ schema: [schema({ note: 'text', detail: 'the whole sentence' })] }),
    )
    expect(groups[0]?.families[0]?.rows[0]).toMatchObject({
      subject: 'hero.title',
      note: 'text',
      detail: 'the whole sentence',
    })
  })

  /** No note is a real answer from the check: the identifier is the whole difference,
   * so there is nothing for the row to add and nothing for it to invent. */
  it('leaves a row without a note when the check gave none', () => {
    const groups = auditGroups(batch({ schema: [schema({ note: undefined })] }))
    expect(groups[0]?.families[0]?.rows[0]?.note).toBeUndefined()
    const stories = auditGroups(batch({ stories: [story({ note: undefined })] }))
    expect(stories[0]?.families[0]?.rows[0]?.note).toBeUndefined()
  })

  /** A code fault has no document, so there is nothing to link to. */
  it('gives a schema finding no links', () => {
    const groups = auditGroups(batch({ schema: [schema()] }))
    expect(groups[0]?.families[0]?.rows[0]).toMatchObject({
      subject: 'hero.title',
      stories: [],
      more: 0,
    })
  })

  /**
   * `server/audit.ts`'s header promises that "a new check needs no route change, no
   * response-shape change and no admin change to be visible". This is that promise
   * from the admin's end: a check with no description still renders, under a
   * humanised version of its own name.
   */
  it('renders a check it has never heard of', () => {
    const groups = auditGroups(batch({ content: [content({ check: 'some-new-check' })] }))
    expect(groups[0]?.families[0]?.title).toBe('Some new check')
    expect(groups[0]?.families[0]?.rows).toHaveLength(1)
  })

  it('counts every finding for the panel’s heading', () => {
    expect(
      auditFindingCount(
        batch({ content: [content(), content({ field: 'x' })], stories: [story()], schema: [] }),
      ),
    ).toBe(3)
  })
})

/**
 * Naming the document a finding is about.
 *
 * The ids are resolved by the *screen*, through `GET {base}/api/stories?ids=`, which
 * already batches and chunks. `server/stories.ts`'s `PublishedDocRow` carries the
 * argument against the alternative: a `title` on the audit's batch reader
 * denormalises a column into a reporting module, and `reindex` would pay for it.
 */
describe('linkedStoryIds', () => {
  it('is the deduplicated union of every id the panel will link', () => {
    const groups = auditGroups(
      batch({
        content: [
          content({ sample: ['sty_a', 'sty_b'] }),
          content({ field: 'other', sample: ['sty_b', 'sty_c'] }),
        ],
        stories: [story({ story: 'sty_c' })],
      }),
    )
    // `sty_b` and `sty_c` each appear twice across findings and once here: the fetch
    // is one request for the union, never one per finding.
    expect(linkedStoryIds(groups).sort()).toEqual(['sty_a', 'sty_b', 'sty_c'])
  })

  it('is empty for a clean site, so nothing is requested', () => {
    expect(linkedStoryIds(auditGroups(batch()))).toEqual([])
  })

  /** A schema finding is a code fault with no document, so it contributes nothing. */
  it('ignores schema findings', () => {
    expect(linkedStoryIds(auditGroups(batch({ schema: [schema()] })))).toEqual([])
  })

  /** Derived from the rendered rows, so the ids resolved and the ids drawn are one
   * set — `contentRow` caps a sample and reading the report would be a second place
   * that has to remember to. */
  it('never exceeds the number of links a row draws', () => {
    const wide = content({ documents: 90, sample: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })
    expect(linkedStoryIds(auditGroups(batch({ content: [wide] })))).toHaveLength(AUDIT_SAMPLE_LINKS)
  })
})

describe('storyLabel', () => {
  it('is the resolved title', () => {
    expect(storyLabel('sty_a', { sty_a: 'Our team' })).toBe('Our team')
  })

  /**
   * Both nulls are the same answer because they render identically: **not asked
   * yet** — titles arrive after the findings on purpose — and **asked, absent**, which
   * is a document published, audited and then deleted. `?ids=` answers a missing row
   * by omission rather than 404ing, so absent is normal rather than an error.
   */
  it('is null for an id nothing has resolved, and for one that came back absent', () => {
    expect(storyLabel('sty_a', {})).toBeNull()
    expect(storyLabel('sty_a', { sty_a: null })).toBeNull()
  })
})

describe('auditScope', () => {
  const state = (over: Partial<AuditState> = {}): AuditState => ({
    data: batch({ documents: 100 }),
    loading: false,
    batches: 1,
    ...over,
  })

  /**
   * The whole point of the line. "228 audited" without "and there are more" is the
   * silent-first-batch failure: a report over a prefix presented as the answer.
   */
  it('says the report is partial when the walk has not reached the end', () => {
    const line = auditScope(state({ data: batch({ documents: 100, continueFrom: 'sty_m' }) }))
    expect(line).toContain('100 published documents audited so far')
    expect(line).toContain('there are more')
  })

  it('is a plain count once the walk is done', () => {
    expect(auditScope(state())).toBe('100 published documents audited.')
  })

  it('names the batch count for a walk that took several', () => {
    expect(auditScope(state({ data: batch({ documents: 240 }), batches: 3 }))).toBe(
      '240 published documents audited, in 3 batches.',
    )
  })

  it('is empty before the first batch lands', () => {
    expect(auditScope(state({ data: null }))).toBe('')
  })
})
