import { useId } from 'react'
import type { MigrateReport } from '../../../server/migrate'
import type { Me } from '../../me'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { EmptyState } from '../EmptyState'
import { ListHeader } from '../List'
import { href } from '../route'
import { type Column, Table } from '../Table'
import css from './Model.module.css'
import {
  type AuditGroup,
  type AuditRow,
  type AuditState,
  auditFindingCount,
  auditGroups,
  auditScope,
  canRunMigrations,
  count,
  driftBanner,
  isUnfinished,
  linkedStoryIds,
  migrationTone,
  type RunState,
  runNotice,
  storyLabel,
  type StoryTitles,
  whyNotRun,
} from './model-model'
import { useModel, useStoryTitles } from './useModel'

interface Props {
  apiBase: string
  /** Where Folio is mounted, for `href(...)` links to the documents a finding names. */
  mount: string
  me: Me
  onNotice: (message: string) => void
}

/** Four placeholder rows, matching Content's and Documents'. */
const SKELETON = ['s1', 's2', 's3', 's4']

/** No document names resolved, for a list that does not resolve them. Frozen and
 * shared rather than a `{}` literal per render, which would be a new object identity
 * on every pass through `Run`. */
const NO_TITLES: StoryTitles = Object.freeze({})

/**
 * The content model as a screen — `docs/ui-architecture.md`'s port phase 5, and the
 * end of the audit having no surface at all.
 *
 * Two halves, and they are here together because they answer the same question from
 * opposite ends. **Migrations** are what the code says the documents should be;
 * **the audit** is what the documents actually are. A migration list on its own
 * tells you a run is owed; a drift report on its own tells you something is wrong
 * and not that a migration would fix it.
 *
 * Three things this screen does that the surface it replaces
 * (`admin/Migrations.tsx`, a 280px rail beside an unrelated document) could not:
 *
 * 1. **It is a screen**, so the migration table has room for a description and the
 *    audit has room to exist at all. The rail rendered migration status and
 *    nothing else, which is why every drift finding was reachable only by `curl`.
 * 2. **A run reports progress while it happens.** `POST /migrate` is batched — a
 *    Worker's CPU limit is why — so a run over a large site is many requests, and
 *    the old rail showed one disabled button until the last of them answered.
 * 3. **A finding is a link.** That is the difference between a report and a tool,
 *    and for one family it is the only route to the document at all: see
 *    `unknown-document-type` in `server/audit.ts`, which is where
 *    `DataList.tsx`'s deleted "Unknown type" heading went.
 */
export function Model({ apiBase, mount, me, onNotice }: Props) {
  const data = useModel(apiBase, me, onNotice)
  const migrationsId = useId()
  const auditId = useId()

  const banner = driftBanner(data.status)
  const rows = data.status?.migrations ?? []
  const mayRun = canRunMigrations(me)

  return (
    <div className={css.screen}>
      <ListHeader
        level={1}
        actions={
          <Button size="sm" disabled={data.statusLoading} reason="Loading…" onClick={data.reload}>
            Refresh
          </Button>
        }
      >
        Content model
      </ListHeader>

      {/*
        A banner in flow, never an overlay — `ui-architecture.md`'s cross-cutting
        rule, and `MigrationBanner`'s comment is the argument: an explanation
        somebody reads once and carries on past is not an alert.

        Deliberately **not** `role="status"`, unlike the editor's version of this
        banner. There, it announces a condition over a page the editor was already
        reading; here it *is* the screen's content, and a live region would
        re-announce the same sentence every time the ledger is re-read.
      */}
      {banner ? <p className={css.banner}>{banner}</p> : null}

      <section className={css.section} aria-labelledby={migrationsId}>
        <h2 className={css.heading} id={migrationsId}>
          Migrations
        </h2>

        {data.statusError ? (
          <EmptyState
            title="Could not read the migration ledger"
            body={data.statusError}
            action={
              <Button size="sm" onClick={data.reload}>
                Try again
              </Button>
            }
          />
        ) : data.statusLoading && data.status === null ? (
          <div className={css.skeletons} aria-hidden="true">
            {SKELETON.map((key) => (
              <div className={css.skeleton} key={key} />
            ))}
          </div>
        ) : (
          <>
            <Table
              label="Declared content migrations"
              columns={MIGRATION_COLUMNS}
              rows={rows}
              rowKey={(row) => row.id}
              empty={
                <EmptyState
                  title="No content migrations are declared"
                  body="A migration is a function in code, handed to createFolio as its migrations option. Until there is one, a schema change moves the model and leaves stored documents where they are — which is what the drift report below is for."
                />
              }
            />

            <div className={css.actions}>
              <span className={css.behind}>
                {data.status?.behind === 0
                  ? 'Every document has had every declared migration.'
                  : `${count(data.status?.behind ?? 0, 'document')} behind the latest model.`}
              </span>
              {/*
                Preview before Run, in that order on screen, because the dry run is
                the point of having one: `schema-migrations.md`'s own user story is
                "a dry run that reports 142 documents, 388 mutations, 1 would need
                chunking, so that I find out before production does".

                Both carry `reason`, because `POST /migrate` is ADMIN and the
                sidebar shows this screen to everybody — a non-admin editor is here
                legitimately, to find out why a document is behind the model. So the
                buttons explain themselves rather than being absent: absent is for a
                control that could never act, and this one acts for the person one
                seat over.
              */}
              <Button
                size="sm"
                disabled={!mayRun || data.run?.running === true}
                reason={whyNotRun(me) ?? 'A run is in flight'}
                onClick={() => data.start({ dryRun: true })}
              >
                Preview
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!mayRun || data.run?.running === true}
                reason={whyNotRun(me) ?? 'A run is in flight'}
                onClick={() => data.start({ dryRun: false })}
              >
                Run
              </Button>
            </div>

            {data.run ? <Run run={data.run} mount={mount} /> : null}
          </>
        )}
      </section>

      {/*
        The audit panel, **absent entirely when there is nothing wrong** — no green
        tick, no "all clear" card. `ui-architecture.md` states that rule for the
        Home screen's equivalent block and it holds here for the same reason: a
        panel that is always on screen is one nobody reads.

        The one thing that does render over a clean site is the line saying how far
        the walk reached, and only when it did not reach the end. "Nothing found in
        the first hundred documents" and "nothing found" are different claims, and
        presenting the first as the second is the failure this screen exists not to
        have.
      */}
      <Audit
        state={data.audit}
        auditId={auditId}
        apiBase={apiBase}
        mount={mount}
        onContinue={data.continueAudit}
      />
    </div>
  )
}

/* ------------------------------------------------------------ migrations --- */

interface MigrationRow {
  id: string
  description: string
  applied: boolean
}

/**
 * No column is sortable, and that is not an omission.
 *
 * A migration list has exactly one meaningful order — the order they run in, which
 * is the order `migrationStatus` answers — and re-sorting it by description or by
 * ledger state would hide the one fact the list is for: `0002` cannot have run
 * before `0001`. `runMigrations` refuses a migration inserted into the past for the
 * same reason.
 */
const MIGRATION_COLUMNS: Column<MigrationRow>[] = [
  {
    key: 'id',
    label: 'Migration',
    cell: (row) => (
      <Badge mono tone="neutral">
        {row.id}
      </Badge>
    ),
  },
  { key: 'description', label: 'What it does', cell: (row) => row.description },
  {
    key: 'applied',
    label: 'Ledger',
    cell: (row) => (
      <Badge
        tone={migrationTone(row.applied)}
        title={
          row.applied
            ? 'Recorded in schema_migrations: this migration has reached every document.'
            : 'Not recorded yet. A row is written when the sweep finishes with nothing behind.'
        }
      >
        {row.applied ? 'run' : 'pending'}
      </Badge>
    ),
  },
]

/**
 * What a run or a preview did, and — the part the old rail could not say — whether
 * it is *finished*.
 *
 * `isUnfinished` is checked before anything else is reported, because a batch that
 * answered `200` with a cursor is a partial run, and a screen that summed its
 * numbers under a heading reading "Run" would be claiming a migration landed when
 * half the site has not seen it.
 */
function Run({ run, mount }: { run: RunState; mount: string }) {
  const report = run.report
  const progress = run.running
    ? `Batch ${run.batches + 1}…`
    : `${count(run.batches, 'batch', 'batches')}`

  return (
    <div className={css.report}>
      <div className={css.reportHead}>
        <h3 className={css.subheading}>{run.dryRun ? 'Preview' : 'Run'}</h3>
        <span className={css.progress}>{progress}</span>
      </div>

      {report === null ? (
        <p className={css.note}>Reading the first batch…</p>
      ) : (
        <>
          <dl className={css.stats}>
            <Stat label="Documents examined" value={report.stories} />
            <Stat label="Changed" value={report.changed} />
            <Stat label="Already up to date" value={report.unchanged} />
            <Stat label="Mutations in drafts" value={report.mutations} />
            <Stat label="In published snapshots" value={report.publishedMutations} />
            {run.dryRun ? null : <Stat label="Transactions" value={report.transactions} />}
          </dl>

          {/*
            `oversized` is surfaced rather than summarised, per the spec's own note:
            these documents land as several transactions and therefore several undo
            steps, and the dry run naming them is the reason a dry run exists.

            Both lists reuse the audit's row shape, so their per-row facts are `note`
            and their subject is the document — the same rule the panel below follows.
            They pass no `titles`: a run report is read by whoever started the run,
            usually beside a `curl` that names the same ids, and resolving names here
            would be a second `?ids=` request in the middle of one.
          */}
          {report.oversized.length > 0 ? (
            <FindingList
              title="Will be split into several transactions"
              body="Chunked at the wire's per-transaction cap, so each of these is several undo steps rather than one. That is the trade: the alternative is refusing to migrate a site's biggest pages."
              mount={mount}
              titles={NO_TITLES}
              rows={report.oversized.map((o) => ({
                key: o.storyId,
                subject: null,
                note: `${count(o.mutations, 'mutation')} in ${count(o.transactions, 'transaction')}`,
                stories: [o.storyId],
                more: 0,
              }))}
            />
          ) : null}

          {report.failed.length > 0 ? (
            <FindingList
              title="Not migrated"
              body="Each of these is recorded rather than skipped, so the ledger does not claim the run is complete. Re-running picks them up."
              mount={mount}
              titles={NO_TITLES}
              rows={report.failed.map((f) => ({
                key: f.storyId,
                subject: null,
                // A refusal is per row by construction — no two documents fail the
                // same way twice — so it is a note rather than a hover.
                note: f.reason,
                stories: [f.storyId],
                more: 0,
              }))}
            />
          ) : null}

          <p className={css.note}>{run.running ? runningNote(report) : runNotice(run)}</p>
          {run.error ? <p className={css.error}>{run.error}</p> : null}
        </>
      )}
    </div>
  )
}

/** What a run says while it is still going: where it is, never how it went. */
function runningNote(report: MigrateReport): string {
  return isUnfinished(report)
    ? `${count(report.behind, 'document')} still behind. Continuing…`
    : 'Finishing…'
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className={css.stat}>
      <dt className={css.statLabel}>{label}</dt>
      <dd className={css.statValue}>{value}</dd>
    </div>
  )
}

/* ----------------------------------------------------------------- audit --- */

function Audit({
  state,
  auditId,
  apiBase,
  mount,
  onContinue,
}: {
  state: AuditState
  auditId: string
  apiBase: string
  mount: string
  onContinue: () => void
}) {
  const groups = auditGroups(state.data)
  const findings = auditFindingCount(state.data)
  const partial = state.data !== null && state.data.continueFrom !== null
  /*
   * Resolved before the early return below, because a hook cannot be conditional —
   * and harmless there: with no groups there are no ids, and `useStoryTitles` makes
   * no request for an empty set.
   */
  const titles = useStoryTitles(apiBase, linkedStoryIds(groups))

  /*
   * Nothing to say and nothing still to read: the panel does not exist. No heading,
   * no tick, no empty state — see the comment at the call site.
   *
   * One condition rather than four, and it covers the non-admin case too: `useModel`
   * does not fetch for an actor `GET /audit` would refuse, so `data` stays null,
   * `loading` is false, and the whole panel is absent rather than explaining itself.
   * A "you may not read this" card would be a control that cannot act, rendered.
   */
  if (groups.length === 0 && !partial && !state.error && !state.loading) return null

  return (
    <section className={css.section} aria-labelledby={auditId}>
      <h2 className={css.heading} id={auditId}>
        Drift{findings > 0 ? ` · ${findings}` : ''}
      </h2>
      <p className={css.note}>
        What the published content actually is, as against what the code now says it should be.
        Read-only: nothing here modifies a document.
      </p>

      {state.error ? (
        <EmptyState
          title="Could not read the drift report"
          body={state.error}
          action={
            <Button size="sm" onClick={onContinue}>
              Try again
            </Button>
          }
        />
      ) : null}

      {state.data === null && state.loading ? (
        <div className={css.skeletons} aria-hidden="true">
          {SKELETON.map((key) => (
            <div className={css.skeleton} key={key} />
          ))}
        </div>
      ) : null}

      {groups.map((group) => (
        <Group key={group.kind} group={group} mount={mount} titles={titles} />
      ))}

      {groups.length === 0 && partial ? <p className={css.note}>Nothing found so far.</p> : null}

      {state.data ? (
        <div className={css.actions}>
          <span className={css.behind}>{auditScope(state)}</span>
          {/*
            "Walk it to exhaustion, or offer to" — this is the offer. The first
            batch rides the page load; the rest is a click, because a full walk is
            one request per hundred published documents and every one of them parses
            and walks every blok. Auto-exhausting on mount would make opening this
            screen the most expensive thing in the admin for a panel a visitor may
            not have come for.
          */}
          {partial ? (
            <Button size="sm" disabled={state.loading} reason="Reading…" onClick={onContinue}>
              Audit the rest
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function Group({
  group,
  mount,
  titles,
}: {
  group: AuditGroup
  mount: string
  titles: StoryTitles
}) {
  return (
    <div className={css.group}>
      <h3 className={css.subheading}>{group.title}</h3>
      <p className={css.note}>{group.body}</p>
      {group.families.map((family) => (
        <FindingList
          key={family.check}
          title={family.title}
          body={family.body}
          rows={family.rows}
          mount={mount}
          titles={titles}
        />
      ))}
    </div>
  )
}

/**
 * One family's rows.
 *
 * Not `List` / `Row`: those carry `role="option"` inside a `role="listbox"`, which
 * would tell a screen reader these are selectable, and they are not — the panel is
 * a report whose rows happen to contain links. A plain `<ul>` of `<li>` is the
 * honest markup, and the links inside it are the interactive elements.
 *
 * **A row draws what differs, and nothing that repeats.** `detail` is the report's
 * whole sentence and it goes on the row's `title`, not into the row: rendered inline
 * it made the schema group nine lines whose only varying token was the first, and the
 * family's `body` above already says the shared half once and better. `note` is the
 * short varying half, and `server/audit.ts` omits it for the families where nothing
 * varies beyond the identifier — so this needs no per-family branch to know that.
 *
 * `title` on the `<li>` is the same escape hatch `Row` uses for a truncated `meta`.
 * It is not keyboard-reachable, which is why the varying content is in `note` rather
 * than left behind the hover: `document-size` is the family that would have lost
 * something, and its note carries every figure the sentence spells out.
 */
function FindingList({
  title,
  body,
  rows,
  mount,
  titles,
}: {
  title: string
  body: string
  rows: readonly AuditRow[]
  mount: string
  titles: StoryTitles
}) {
  return (
    <div className={css.family}>
      <h4 className={css.familyTitle}>{title}</h4>
      <p className={css.note}>{body}</p>
      <ul className={css.findings}>
        {rows.map((row) => (
          <li className={css.finding} key={row.key} title={row.detail}>
            {row.subject === null ? null : (
              <Badge mono tone="neutral">
                {row.subject}
              </Badge>
            )}
            {row.documents === undefined ? null : (
              <span className={css.counts}>
                {count(row.documents, 'document')} · {count(row.bloks ?? 0, 'blok')}
              </span>
            )}
            {row.note ? <span className={css.rowNote}>{row.note}</span> : null}
            {row.stories.length > 0 ? (
              <span className={css.links}>
                {row.stories.map((id) => (
                  <StoryLink key={id} id={id} mount={mount} titles={titles} />
                ))}
                {row.more > 0 ? <span className={css.more}>and {row.more} more</span> : null}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * A link to the document a finding is about, named.
 *
 * One anchor holding both the title and the id, not two elements: the id is the
 * accessible name's other half, and `design-system.md`'s third commitment is that an
 * identifier is a typographic citizen rather than debug output — a title alone would
 * make two same-titled pages indistinguishable, which is the same reason the palette
 * shows a path.
 *
 * No title yet, or none to have, and the id stands alone. Both cases are
 * `storyLabel`'s null and neither is an error: see its comment.
 */
function StoryLink({ id, mount, titles }: { id: string; mount: string; titles: StoryTitles }) {
  const label = storyLabel(id, titles)
  return (
    <a className={css.link} href={href({ name: 'edit', id }, mount)}>
      {label === null ? null : <span className={css.linkTitle}>{label}</span>}
      <span className={css.linkId}>{id}</span>
    </a>
  )
}
