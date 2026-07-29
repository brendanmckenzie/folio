import type { MigrateReport, MigrationStatus } from '../server/migrate'

/**
 * The banner an editor sees when the page they have open has not been migrated
 * (`schema-migrations.md` checkpoint 4).
 *
 * A **banner, not a lock**. Refusing to serve the editor until somebody runs a
 * migration would turn a schema drift into an outage, and the honest choice
 * between "editing against a stale model" and "not editing at all" is the first
 * one — an empty field that is *explained* is a different experience from an
 * empty field that is mysterious.
 *
 * Pure and exported so it can be tested without a DOM. Null when there is nothing
 * to say, so the caller renders `{behindBanner(...)}` and never a wrapper around
 * nothing.
 */
export function behindNotice(status: MigrationStatus | null): string | null {
  const pending = status?.story?.pending ?? []
  if (!status?.story?.behind || pending.length === 0) return null
  const what = pending.map((m) => m.description).join('; ')
  return pending.length === 1
    ? `This page has not been updated for the latest content model: ${what}`
    : `This page has not been updated for the latest content model (${pending.length} changes): ${what}`
}

interface BannerProps {
  status: MigrationStatus | null
}

export function MigrationBanner({ status }: BannerProps) {
  const notice = behindNotice(status)
  if (notice === null) return null
  return (
    <div className="migration-banner" role="status">
      {notice}
    </div>
  )
}

interface Props {
  status: MigrationStatus | null
  report: MigrateReport | null
  busy: boolean
  /** True only for an admin: the route behind Run refuses everyone else. */
  canRun: boolean
  onRun: (opts: { dryRun: boolean }) => void
  onRefresh: () => void
}

/**
 * The Migrations rail: what is configured, what has run, how many documents are
 * behind, and the two buttons.
 *
 * "Preview" before "Run", and in that order on screen, because the dry run is the
 * point of having one — it answers "142 documents, 388 mutations, 1 would need
 * chunking" before production does. Both are admin-only; the route refuses
 * everyone else regardless, and a button that always errors is worse than no
 * button (the same rule `Access.tsx` follows for an admin's own row).
 */
export function Migrations({ status, report, busy, canRun, onRun, onRefresh }: Props) {
  const rows = status?.migrations ?? []

  return (
    <div className="migrations">
      <header className="migrations__head">
        <h2>Content model</h2>
        <button type="button" onClick={onRefresh} title="Refresh">
          ↻
        </button>
      </header>

      {rows.length === 0 ? (
        <p className="migrations__empty">No content migrations are configured.</p>
      ) : (
        <>
          <ul className="migrations__list">
            {rows.map((m) => (
              <li
                key={m.id}
                className={`migrations__row ${m.applied ? 'is-applied' : 'is-pending'}`}
              >
                <span className="migrations__id">{m.id}</span>
                <span className="migrations__desc">{m.description}</span>
                <span className="migrations__badge">{m.applied ? 'run' : 'pending'}</span>
              </li>
            ))}
          </ul>

          <p className="migrations__behind">
            {status?.behind === 0
              ? 'Every document is up to date.'
              : `${status?.behind} document${status?.behind === 1 ? '' : 's'} behind the latest model.`}
          </p>

          {canRun ? (
            <div className="migrations__actions">
              <button type="button" disabled={busy} onClick={() => onRun({ dryRun: true })}>
                Preview
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() => onRun({ dryRun: false })}
              >
                Run
              </button>
            </div>
          ) : (
            <p className="migrations__empty">Only an admin can run a migration.</p>
          )}

          {report ? <Report report={report} /> : null}
        </>
      )}
    </div>
  )
}

/**
 * What a run (or a preview) actually did. Every number the spec's own dry-run
 * example names, plus the two lists that are the reason a dry run exists:
 * `oversized` (which documents will land as several transactions, and therefore
 * several undo steps) and `failed` (which documents did not migrate and why).
 */
function Report({ report }: { report: MigrateReport }) {
  return (
    <div className="migrations__report">
      <h3>{report.dryRun ? 'Preview' : 'Run'}</h3>
      <ul>
        <li>{report.stories} documents examined</li>
        <li>{report.changed} changed</li>
        <li>{report.unchanged} already up to date</li>
        <li>
          {report.mutations} mutations in drafts, {report.publishedMutations} in published snapshots
        </li>
        {report.dryRun ? null : <li>{report.transactions} transactions</li>}
      </ul>

      {report.oversized.length > 0 ? (
        <>
          <h3>Will be split into several transactions</h3>
          <ul>
            {report.oversized.map((o) => (
              <li key={o.storyId}>
                <code>{o.storyId}</code>: {o.mutations} mutations, {o.transactions} transactions
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {report.failed.length > 0 ? (
        <>
          <h3>Not migrated</h3>
          <ul className="migrations__failed">
            {report.failed.map((f) => (
              <li key={f.storyId}>
                <code>{f.storyId}</code>: {f.reason}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {report.dryRun ? (
        <p className="migrations__empty">Nothing was written. Run to apply.</p>
      ) : report.complete ? (
        <p className="migrations__empty">Every document is migrated.</p>
      ) : (
        <p className="migrations__empty">
          {report.behind} document{report.behind === 1 ? '' : 's'} still behind. Running again picks
          them up.
        </p>
      )}
    </div>
  )
}
