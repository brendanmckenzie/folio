/**
 * The Model screen's arithmetic: who may run a migration, what a batched run adds
 * up to, what a batched audit adds up to, and how the audit's three arrays become
 * the panel's groups and rows.
 *
 * Pure functions over plain data, for the admin's testing convention — no admin
 * test mounts a component (`vitest.config.ts` runs the unit project under
 * `environment: 'node'`), so a screen's *logic* has to live somewhere a Node test
 * can reach it. `content-model.ts` and `documents-model.ts` are the pattern; this
 * is the third instance.
 *
 * The two merges are the whole reason this file is not three lines long. Both
 * `POST {base}/api/migrate` and `GET {base}/api/audit` answer **one batch and a
 * cursor** — a Worker's CPU limit is why (`server/migrate.ts`'s header) — so the
 * screen's job is to walk to the end and add up, and *a report that came back with
 * a `continueFrom` is not a finished run*. Everything about that is here rather
 * than in `useModel.ts`, because it is the part that can be wrong.
 */
import type {
  AuditReport,
  ContentFinding,
  SchemaFinding,
  StoryFinding,
} from '../../../server/audit'
import { hasScope } from '../../../server/auth/roles'
import type { MigrateReport, MigrationStatus } from '../../../server/migrate'
import type { Me } from '../../me'
import type { BadgeTone } from '../Badge'

/* ---------------------------------------------------------------- who may --- */

/**
 * `POST {base}/api/migrate` and `GET {base}/api/audit` are both `ADMIN`
 * (`server/routes/migrations.ts`), so one predicate answers both — and the two
 * names below exist so a call site reads as the thing it is about rather than as a
 * role check that happens to be shared.
 *
 * Local to this screen rather than in `admin/me.ts`, deliberately. `me.ts` is the
 * admin's only source of truth about permissions and this belongs there — but its
 * vocabulary is `edit / create / publish / manage`, and `admin` is a fifth need
 * with exactly one consumer today. It moves there when Access lands and there are
 * two.
 *
 * Note it is **true under `auth: 'open'`**, unlike `canManageAccess`. That is not
 * an inconsistency: the access surface 404s on an open deployment, while
 * `requireAccess` passes every request through on one — so a Run button that
 * greyed itself out there would be refusing something the server allows.
 */
function isAdmin(me: Me): boolean {
  if (me.mode === 'open') return true
  const actor = me.actor
  if (!actor) return false
  return actor.kind === 'user' ? actor.role === 'admin' : hasScope(actor.scopes, 'admin')
}

/** May they run or preview a migration? */
export function canRunMigrations(me: Me): boolean {
  return isAdmin(me)
}

/**
 * May they read the drift report?
 *
 * Gates the *fetch*, not just the button. The route answers `403` to everyone
 * else, and a screen that asked anyway would turn "this panel is not for you" into
 * an error toast on every load — which is the difference between an explanation
 * and a fault.
 */
export function canReadAudit(me: Me): boolean {
  return isAdmin(me)
}

/**
 * Why Run is disabled, for `Button`'s `reason`. Worded like `server/auth/roles.ts`'s
 * `refusalOf`, so the pre-emptive explanation and the refusal a `curl` would get
 * say the same thing.
 */
export function whyNotRun(me: Me): string | undefined {
  if (canRunMigrations(me)) return undefined
  const actor = me.actor
  if (!actor) return 'Sign in to run a migration'
  return actor.kind === 'token'
    ? "This token is missing the 'admin' scope"
    : `Your role (${actor.role}) may not run a migration; admin is required`
}

/* ------------------------------------------------------------ migrations --- */

/**
 * How many batches one run may take before the screen gives up and says so.
 *
 * A ceiling rather than a `while (cursor)`, because a cursor that stopped
 * advancing — a server bug, a proxy caching the response — would otherwise be an
 * infinite loop in somebody's browser tab. At the default batch of 25 this covers
 * 12,500 documents; past that a run finishes over two visits, which is a
 * consequence of the design rather than a failure of it.
 */
export const MAX_RUN_BATCHES = 500

/** The same ceiling for the audit walk, and for the same reason. */
export const MAX_AUDIT_BATCHES = 500

/** One run or preview, as the screen holds it while it happens. */
export interface RunState {
  dryRun: boolean
  /** Batches that have answered. Shown as it climbs, so a long run is visibly
   * progressing rather than sitting behind one spinner. */
  batches: number
  /** More batches are owed and in flight. */
  running: boolean
  /** Merged across every batch so far, or null before the first answers. */
  report: MigrateReport | null
  error?: string
}

/**
 * Two batches of one run, as one report. The later batch wins for everything that
 * describes where the run *got to* (`continueFrom`, `behind`, `complete`);
 * everything that counts adds up.
 *
 * A near-copy of `admin/hooks/useMigrations.ts`'s `mergeReports`, which serves the
 * old single-screen admin's rail. Copied rather than imported: that file is deleted
 * at `docs/ui-architecture.md`'s port phase 8, and a new screen importing from a
 * module scheduled for deletion is a dependency pointing the wrong way through
 * time. The duplication has a date on it.
 */
export function mergeMigrateReports(a: MigrateReport, b: MigrateReport): MigrateReport {
  return {
    ...b,
    // What was pending when the run *started*. A later batch sees the same set,
    // and after the ledger is written it would see an empty one.
    pending: a.pending,
    stories: a.stories + b.stories,
    changed: a.changed + b.changed,
    unchanged: a.unchanged + b.unchanged,
    mutations: a.mutations + b.mutations,
    publishedMutations: a.publishedMutations + b.publishedMutations,
    transactions: a.transactions + b.transactions,
    oversized: [...a.oversized, ...b.oversized],
    failed: [...a.failed, ...b.failed],
  }
}

/**
 * Did the run stop short of the end?
 *
 * **The single most important predicate on this screen.** `POST /migrate` answering
 * `200` means one batch succeeded, not that the migration is done: a non-null
 * `continueFrom` means there are more documents, and treating that response as a
 * success is how a site ends up half migrated with a green tick over it. The walk
 * in `useModel.ts` is what normally makes this false; this is what says so when the
 * batch ceiling or an error stopped it first.
 */
export function isUnfinished(report: MigrateReport): boolean {
  return report.continueFrom !== null
}

/** `n` of `word`, pluralised. Used often enough here to be worth naming once. */
export function count(n: number, word: string, plural = `${word}s`): string {
  return `${n} ${n === 1 ? word : plural}`
}

/**
 * What a finished run or preview says, as one sentence for the toast.
 *
 * The unfinished case is stated first because it is the one that must never read
 * as success — and it names the cursor's consequence ("running again picks up
 * where this stopped") rather than the cursor.
 */
export function runNotice(run: RunState): string {
  const report = run.report
  if (!report) return run.dryRun ? 'Nothing to preview' : 'Nothing to run'
  const over = `${count(report.stories, 'document')} in ${count(run.batches, 'batch', 'batches')}`
  if (isUnfinished(report)) {
    return `Stopped after ${over}: ${count(report.behind, 'document')} still behind. Running again picks up where this stopped.`
  }
  if (run.dryRun) {
    return `Preview over ${over}: ${count(report.mutations, 'mutation')} in ${count(report.changed, 'document')}. Nothing was written.`
  }
  if (report.complete) {
    return `Migrated ${count(report.changed, 'document')} of ${over}. Every document is up to date.`
  }
  return `Ran over ${over}. ${count(report.behind, 'document')} still behind — running again picks them up.`
}

/** `run` for a migration that has been recorded, `pending` for one that has not. */
export function migrationTone(applied: boolean): BadgeTone {
  // `warn` is drift, per `docs/design-system.md`'s state palette — and pending is
  // exactly that. Not `danger`: nothing is broken, something is owed.
  return applied ? 'ok' : 'warn'
}

/**
 * The screen's banner: what is drifted, and what to do about it. Null when there
 * is nothing to say.
 *
 * A **banner in flow, never an overlay** (`ui-architecture.md`'s cross-cutting
 * rule, and `admin/Migrations.tsx`'s `MigrationBanner` is the model): an
 * explanation somebody reads once and carries on past is not an alert.
 *
 * Null when nothing is pending *and* nothing is behind, rather than a green "all
 * up to date" line — the migration table below it already shows every migration
 * wearing `run`, so a banner saying the same thing is furniture. This is the same
 * rule the audit panel follows and the Home screen's equivalent block will.
 *
 * The two halves are separately null-able because they genuinely come apart, and
 * the pending-with-nothing-behind case is the one that reads as a contradiction
 * until it is spelled out: a migration nothing has reached yet is pending over an
 * empty set, and running it only writes the ledger row.
 */
export function driftBanner(status: MigrationStatus | null): string | null {
  if (!status) return null
  const pending = status.pending.length
  const behind = status.behind
  if (pending === 0 && behind === 0) return null
  if (pending === 0) {
    return (
      `Every configured migration has been recorded, but ${count(behind, 'document')} ` +
      `${behind === 1 ? 'is' : 'are'} still behind the latest model — each one failed or ` +
      `arrived after the run. Running again picks them up.`
    )
  }
  if (behind === 0) {
    return (
      `${count(pending, 'migration')} ${pending === 1 ? 'is' : 'are'} pending, and no document ` +
      `is behind ${pending === 1 ? 'it' : 'them'}: running only records the ledger row.`
    )
  }
  return (
    `${count(pending, 'migration')} pending, and ${count(behind, 'document')} behind the latest ` +
    `content model. Preview first — a dry run reports exactly what would change and writes nothing.`
  )
}

/* ----------------------------------------------------------------- audit --- */

/**
 * One `GET {base}/api/audit` response, minus the three named projections.
 *
 * `orphanKeys`, `unknownTypes` and `missingFields` are filters over `content` that
 * `server/audit.ts` keeps because the spec's route example named them. The screen
 * reads `content` instead — the *extensible* surface — which is what makes the file
 * header's promise true from this end too: a check added to `DOCUMENT_CHECKS`
 * appears in this panel with no edit here. Dropping them from the client's model
 * also means the merge below has one tally to get right rather than four.
 */
export type AuditBatch = Pick<
  AuditReport,
  'documents' | 'content' | 'stories' | 'schema' | 'continueFrom'
>

/** The audit walk, as the screen holds it. */
export interface AuditState {
  /** Null until the first batch answers. */
  data: AuditBatch | null
  loading: boolean
  /** Batches merged so far, so `documents` can be read as "over N requests". */
  batches: number
  error?: string
}

/** How many of a finding's sampled documents the panel links to. */
export const AUDIT_SAMPLE_LINKS = 5

/**
 * Two batches of one walk, as one report.
 *
 * Three different merges, and each is a decision:
 *
 *   - **`content` is a tally**, keyed by `(check, type, field)` exactly as
 *     `auditDocuments` keys it, so the same finding met in two batches is one row
 *     with the counts summed — and then **re-sorted**, because two batches each
 *     ordered by their own counts are not ordered by the sum. See
 *     `compareContentFindings` for why the comparator is restated here rather than
 *     imported from the module that already has one.
 *   - **`stories` concatenates and re-sorts by check**, because a story finding
 *     names one document and is never deduplicated — a batch is a disjoint set of
 *     documents. Re-sorted so a family's rows are contiguous; `document-size`'s
 *     own heaviest-first order is restored by `compareStoryFindings`.
 *   - **`schema` takes the later batch, not both.** A schema check reads no
 *     document, so every batch answers the identical set and concatenating would
 *     report the same code fault once per hundred documents on the site. This is
 *     the one merge where the obvious implementation is visibly wrong the first
 *     time a second batch arrives.
 */
export function mergeAudits(a: AuditBatch, b: AuditBatch): AuditBatch {
  return {
    documents: a.documents + b.documents,
    content: mergeContentFindings(a.content, b.content),
    stories: [...a.stories, ...b.stories].sort(compareStoryFindings),
    schema: b.schema,
    continueFrom: b.continueFrom,
  }
}

function mergeContentFindings(
  a: readonly ContentFinding[],
  b: readonly ContentFinding[],
): ContentFinding[] {
  const tally = new Map<string, ContentFinding>()
  for (const finding of [...a, ...b]) {
    const key = `${finding.check} ${finding.type} ${finding.field ?? ''}`
    const row = tally.get(key)
    if (!row) {
      tally.set(key, { ...finding, sample: finding.sample.slice(0, AUDIT_SAMPLE_LINKS) })
      continue
    }
    row.documents += finding.documents
    row.bloks += finding.bloks
    // Capped on the way in, so a walk over fifty batches holds five ids per
    // finding rather than two hundred and fifty it will never draw.
    row.sample = [...row.sample, ...finding.sample].slice(0, AUDIT_SAMPLE_LINKS)
  }
  return [...tally.values()].sort(compareContentFindings)
}

/**
 * The report's reading order — widest drift first, then a stable tiebreak.
 *
 * **Restated from `server/audit.ts`'s identical comparator, and that is a bundle
 * constraint rather than a preference.** Importing it would be a *value* import
 * from `server/audit.ts`, which reaches `server/stories.ts` and the whole D1 layer
 * through it; `admin/me.ts` can import `atLeast` from `server/auth/roles.ts`
 * because that file imports nothing at all, and this one is not in that position.
 * Two implementations of one ordering, so `model-screen.test.ts` pins this one
 * against the shape the route answers.
 */
function compareContentFindings(a: ContentFinding, b: ContentFinding): number {
  return (
    b.documents - a.documents ||
    a.check.localeCompare(b.check) ||
    a.type.localeCompare(b.type) ||
    (a.field ?? '').localeCompare(b.field ?? '')
  )
}

/**
 * Story findings grouped by check, heaviest first within a check.
 *
 * `bytes` is `document-size`'s own field rather than every check's, so it is read
 * off the record and defaults to zero — which leaves a check that carries no size
 * ordered by story id, and that is the right fallback: it is stable, and it is what
 * `documentSize`'s own tiebreak does.
 */
export function compareStoryFindings(a: StoryFinding, b: StoryFinding): number {
  const bytes = (f: StoryFinding) => (f as { bytes?: number }).bytes ?? 0
  return (
    a.check.localeCompare(b.check) || bytes(b) - bytes(a) || a.story.localeCompare(b.story) || 0
  )
}

/* ------------------------------------------------------- the audit panel --- */

/**
 * One row of the panel: what the finding is about, what is different about it, and
 * how to reach it.
 *
 * **Three fields where there used to be two, and the split is the fix for a wall of
 * text.** The first version rendered `detail` as the row's label, which drew the
 * schema group as nine rows whose only varying token was the first one — the clause
 * after it was identical, and the family's own prose above already said it better and
 * once. So:
 *
 *   - `subject` and `note` are what **differs**, and they are the row.
 *   - `detail` is the report's whole sentence, kept but **not drawn inline**: the
 *     screen hangs it off the row's `title`, which is the same escape hatch `Row`
 *     uses for a truncated `meta`. Reachable rather than dropped, because for one
 *     family — `document-size` — the sentence is real content.
 *   - the shared half appears once, in `AuditFamily.body`.
 *
 * `note` comes from the *check* rather than being derived here (`server/audit.ts`'s
 * `Explained`). That matters: "every row in this family says the same thing" is a
 * property of the check, so a family with nothing varying omits it and this screen
 * needs no per-family branch to find that out.
 */
export interface AuditRow {
  key: string
  /**
   * The identifier the row is about — `hero.heading`, `hero`, a block name —
   * rendered monospaced. **Null when the subject is a document**, in which case
   * `stories[0]` is it: drawing a story id as both a mono subject and a link beside
   * itself was the id twice on one row.
   */
  subject: string | null
  /** The short varying half of `detail`, from `Explained.note`. Absent when the
   * identifier is the whole difference between this row and its siblings. */
  note?: string
  /** The report's own sentence. Not drawn inline — see the note above. */
  detail?: string
  /** Documents this row links to. Every one is a `{ name: 'edit', id }` screen. */
  stories: string[]
  /** Documents carrying this finding that `stories` does not name. */
  more: number
  /** A tally finding's counts; absent for a per-document or schema finding. */
  documents?: number
  bloks?: number
}

/** All the rows one check produced, with what the check means. */
export interface AuditFamily {
  check: string
  title: string
  /** What the check found and why it matters. One paragraph, not a tooltip. */
  body: string
  rows: AuditRow[]
}

/** One of `server/audit.ts`'s three arrays, and what makes it its own thing. */
export interface AuditGroup {
  kind: 'content' | 'stories' | 'schema'
  title: string
  body: string
  families: AuditFamily[]
}

const GROUPS: Record<AuditGroup['kind'], { title: string; body: string }> = {
  content: {
    title: 'In stored values',
    body: 'Faults in what published documents hold, counted across the site. A count with a handful of examples rather than a row per blok: a site with 400 heroes carrying an orphan key needs the number first.',
  },
  stories: {
    title: 'Whole documents',
    body: 'Faults that are true of a document rather than of a value inside one, so each names the document it is about.',
  },
  schema: {
    title: 'In the schema',
    body: 'Mistakes in the declarations themselves. No document is involved — these are code faults, and every one of them is silent at runtime, which is the reason they are reported at all.',
  },
}

/**
 * What each check found, in the panel's words.
 *
 * Keyed by `Finding.check`, which `server/audit.ts` describes as "kebab-ish and
 * stable — the admin keys off it". A check with no entry here still renders, under
 * a humanised version of its own name: that is what keeps the file header's promise
 * that "a new check needs no route change, no response-shape change and no admin
 * change to be visible". A missing description is a worse panel, not a hidden
 * finding.
 */
const CHECKS: Record<string, { title: string; body: string }> = {
  'orphan-key': {
    title: 'Orphaned keys',
    body: 'A key the schema no longer declares, still holding content. Nothing renders it and the inspector never draws it, so it sits in the document indefinitely — invisible until something says so. A migration is how it is cleared or moved.',
  },
  'unknown-type': {
    title: 'Unknown block types',
    body: 'A blok whose type nothing declares any more. It reads “Unknown block type” in the editor and renders nothing at all on the live page: the loudest possible failure and the quietest possible symptom.',
  },
  'missing-field': {
    title: 'Missing fields',
    body: 'A field the schema declares that these documents have no key for — added after they were written. It resolves to its kind’s empty value, so it renders blank rather than breaking, which is why nobody notices. A default migration fills them in.',
  },
  'translated-not-translatable': {
    title: 'Translations in fields nobody marked translatable',
    body: 'The renderer honours these deliberately, so un-marking a field cannot silently hide work somebody already translated. But the inspector will not let anybody change them again, so they are content that is frozen rather than lost.',
  },
  'unknown-locale': {
    title: 'Translations under undeclared locales',
    body: 'A translation under a locale code the config no longer names. Inert — the page renders its fallback — and nothing strips these automatically, because a locale is at least as often removed by mistake as on purpose. The second part of the subject is the locale code.',
  },
  'unknown-document-type': {
    title: 'Documents of an undeclared type',
    body: 'The document type these carry is not declared any more, so the generated nav has no list screen for them and no migration can run over them. This panel is the only route back to the document, which is why every row here is a link.',
  },
  'document-size': {
    title: 'Documents approaching the size cap',
    body: 'The transaction that crosses the document cap is refused whole, so the edit that crosses it is the one that is lost. There is no soft landing: split the page, retire a locale, or move a block off it while there is still room.',
  },
  'unknown-condition-field': {
    title: 'A showIf naming a field that does not exist',
    body: 'Condition matching is total, so an unknown field name evaluates false and never throws — the input is simply never drawn, and nothing anywhere says why.',
  },
  'hidden-summary-field': {
    title: 'A summary naming a hidden field',
    body: 'The value is real and the block tree renders it, but the inspector never shows it — so an editor cannot work out where a row’s label comes from, let alone change it.',
  },
  'unknown-summary-field': {
    title: 'A summary naming a field that does not exist',
    body: 'Every row of this block type is unlabelled in the block tree, with nothing to explain it.',
  },
  'not-translatable': {
    title: 'Text fields nobody marked translatable',
    body: 'Translatable is opt-in per field, deliberately. The cost of opt-in is that omissions are invisible: a heading nobody marked never reaches a translator, and the editor says nothing about why.',
  },
  'indexed-unsupported': {
    title: 'An indexed flag on a kind that cannot be indexed',
    body: 'Only text, textarea, number, boolean and select project to a scalar. The field builders make this unrepresentable, so it arrived from a hand-written schema or an importer — and filtering on the field 400s as if it were never declared.',
  },
  'indexed-not-root': {
    title: 'An indexed flag on a block that is no type’s root',
    body: 'The content index is a fixed projection of a document, so only its root block is read. The flag looks like it works and does nothing at all.',
  },
}

/** `unknown-locale` → `Unknown locale`, for a check this panel has no words for. */
function fallbackLabel(check: string): { title: string; body: string } {
  const words = check.replace(/-/g, ' ')
  return {
    title: words.charAt(0).toUpperCase() + words.slice(1),
    body: 'This panel has no description for this check yet. Its own detail line, and `server/audit.ts`, are what it means.',
  }
}

function labelOf(check: string): { title: string; body: string } {
  return CHECKS[check] ?? fallbackLabel(check)
}

/**
 * The panel, as three groups of families of rows — or `[]` when the site is clean.
 *
 * **Empty means absent**, and the screen renders nothing at all rather than a green
 * tick or an "all clear" card. That is `ui-architecture.md`'s rule for the Home
 * screen's equivalent block and it holds here for the same reason: a panel that is
 * always on screen is one nobody reads, so it earns its place by only appearing
 * when it has something to say.
 *
 * Families come out **in the order their findings appear in the report**, not in a
 * severity order defined here. The server has already ordered each array
 * meaningfully — `content` by how many documents each finding touches, `stories` by
 * check and then by weight — and a second ordering in the admin would be a
 * severity table to argue about, kept in step with a check list that lives
 * somewhere else. First appearance is the same rule `nav.ts` gives its groups.
 */
export function auditGroups(data: AuditBatch | null): AuditGroup[] {
  if (!data) return []
  const groups: AuditGroup[] = [
    group('content', data.content, contentRow),
    group('stories', data.stories, storyRow),
    group('schema', data.schema, schemaRow),
  ]
  return groups.filter((g) => g.families.length > 0)
}

function group<T extends { check: string }>(
  kind: AuditGroup['kind'],
  findings: readonly T[],
  row: (finding: T, index: number) => AuditRow,
): AuditGroup {
  const families = new Map<string, AuditFamily>()
  for (const [i, finding] of findings.entries()) {
    const family =
      families.get(finding.check) ??
      ({ check: finding.check, ...labelOf(finding.check), rows: [] } satisfies AuditFamily)
    family.rows.push(row(finding, i))
    families.set(finding.check, family)
  }
  return { kind, ...GROUPS[kind], families: [...families.values()] }
}

/**
 * A tally row. `subject` is `type.field`, or the block type alone when the finding
 * is about the blok itself — which is what `Finding.field === null` means.
 */
function contentRow(finding: ContentFinding, index: number): AuditRow {
  const sample = finding.sample.slice(0, AUDIT_SAMPLE_LINKS)
  return {
    key: `${finding.check}:${finding.type}:${finding.field ?? ''}:${index}`,
    subject: finding.field === null ? finding.type : `${finding.type}.${finding.field}`,
    stories: sample,
    // Never negative: a merge sums `documents` and caps `sample`, and a caller
    // that passed documents with no ids gets a count with nothing to open.
    more: Math.max(0, finding.documents - sample.length),
    documents: finding.documents,
    bloks: finding.bloks,
  }
}

/**
 * A per-document row. `subject` is null because the subject *is* the document, and
 * the link already names it — see `AuditRow.subject`.
 */
function storyRow(finding: StoryFinding, index: number): AuditRow {
  return {
    key: `${finding.check}:${finding.story}:${index}`,
    subject: null,
    ...(finding.note === undefined ? {} : { note: finding.note }),
    detail: finding.detail,
    stories: [finding.story],
    more: 0,
  }
}

/** A code fault: no document to link to, so `stories` is empty by construction. */
function schemaRow(finding: SchemaFinding, index: number): AuditRow {
  return {
    key: `${finding.check}:${finding.block}:${finding.field ?? ''}:${index}`,
    subject: finding.field === null ? finding.block : `${finding.block}.${finding.field}`,
    ...(finding.note === undefined ? {} : { note: finding.note }),
    detail: finding.detail,
    stories: [],
    more: 0,
  }
}

/* ------------------------------------------------------- naming a document --- */

/**
 * Every story id the panel is about to draw a link for, deduplicated.
 *
 * Derived from the **rendered groups** rather than from the report, so the set that
 * gets resolved and the set that gets drawn cannot come apart: `contentRow` caps a
 * sample at `AUDIT_SAMPLE_LINKS`, and reading the report directly would be a second
 * place that has to remember to.
 *
 * One request for the union, never one per finding — `GET {base}/api/stories?ids=`
 * resolves a batch and chunks above D1's bind limit, which is what it exists for
 * (`foundation/pagination.md` decision 7).
 */
export function linkedStoryIds(groups: readonly AuditGroup[]): string[] {
  const seen = new Set<string>()
  for (const group of groups) {
    for (const family of group.families) {
      for (const row of family.rows) {
        for (const id of row.stories) seen.add(id)
      }
    }
  }
  return [...seen]
}

/** What a resolved batch of ids is held as: a label, or null for "asked, nothing". */
export type StoryTitles = Readonly<Record<string, string | null>>

/**
 * A document's label, or null when its id is the best there is.
 *
 * The two nulls are deliberately the same answer, because they render identically and
 * an operator cannot act on the difference: **not asked yet** (titles arrive a moment
 * after the findings, on purpose — a finding must not wait on a second round trip)
 * and **asked, absent**. The second is normal rather than an error: a document can be
 * published, audited, and then deleted, and `?ids=` answers a missing row by omission
 * rather than 404ing (`pagination.md`'s edge cases say so, and the finding is still
 * true of the site that published it).
 */
export function storyLabel(id: string, titles: StoryTitles): string | null {
  return titles[id] ?? null
}

/** How many findings the walk has turned up, for the panel's heading. */
export function auditFindingCount(data: AuditBatch | null): number {
  if (!data) return 0
  return data.content.length + data.stories.length + data.schema.length
}

/**
 * What the panel says it covered. The honest version of a partial walk: a report
 * over the first hundred documents of a thousand is a report about a hundred
 * documents, and saying "228 audited" without saying "of an unknown number more"
 * is exactly the silent-first-batch failure this screen exists not to have.
 */
export function auditScope(state: AuditState): string {
  const data = state.data
  if (!data) return ''
  const over = `${count(data.documents, 'published document')} audited`
  if (data.continueFrom === null) {
    return state.batches > 1
      ? `${over}, in ${count(state.batches, 'batch', 'batches')}.`
      : `${over}.`
  }
  return `${over} so far, and there are more. This report covers only what has been read.`
}
