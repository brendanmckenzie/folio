import { useCallback, useState } from 'react'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Dialog } from '../Dialog'
import { EmptyState } from '../EmptyState'
import { ListHeader } from '../List'
import { type Column, Table } from '../Table'
import css from './Schedules.module.css'
import {
  ACTIONS,
  actionLabel,
  cancelPath,
  cancelWarning,
  health,
  isNarrowed,
  isUnnamed,
  outcomeLabel,
  outcomeOf,
  outcomeTone,
  parseSchedulesUrl,
  type ResolvedSchedule,
  relativeLabel,
  type SchedulesUrl,
  schedulesQuery,
  showing,
  STATUSES,
  titleOf,
  whenLabel,
} from './schedules-model'
import { messageOf } from './useContent'
import { useSchedules } from './useSchedules'

interface Props {
  apiBase: string
  query: Readonly<Record<string, string>>
  onQuery: (next: Record<string, string | undefined>) => void
  onNotice: (message: string) => void
  /** Opens a document in the editor. A schedule is *about* a document, and the
   * thing a person wants next is almost always to look at it. */
  onOpen: (id: string) => void
}

/** Matching Redirects', Content's and Documents'. */
const SKELETON = ['s1', 's2', 's3', 's4', 's5', 's6']

/**
 * What is scheduled across this site.
 *
 * **This screen is the reason a cron beat a Durable Object alarm.**
 * `docs/specs/platform/scheduled-publishing.md` decision 2 chose a cron partly
 * because "what is scheduled across this site" is one indexed D1 read where an alarm
 * design would have to wake every object — and it says the quiet part out loud: *"a
 * schedule nobody can list is a schedule nobody trusts."* The routes have been built
 * and tested since that spec landed and nothing rendered them, so until now the
 * feature was exactly the thing it was designed not to be.
 *
 * Three things it does that a table of the `schedules` columns would not.
 *
 * 1. **It reports the outcome, not the status.** `status` is `pending` or `failed`
 *    and neither answers the only question worth asking, which is *what is going to
 *    happen*. `outcomeOf` compares `at` to the clock and `attempts` to the cap and
 *    separates four cases the column conflates — see `schedules-model.ts`.
 * 2. **It diagnoses a missing cron.** A pending row in the past with no attempts
 *    means nothing ran the sweep, and the server structurally cannot report that: to
 *    D1 the row is simply pending. It takes a clock, so it takes a client. That is
 *    the banner, and it names the repair rather than the symptom, because if the
 *    sweep is not running then every row is affected and fixing three of them fixes
 *    nothing.
 * 3. **It says what cancelling does not do.** A campaign window is two rows — publish
 *    Tuesday, unpublish Friday — and the route cancels one action for one document.
 *    So the confirmation says the other one survives, which is the difference between
 *    a page that stays up and a page that comes down having never gone up.
 *
 * What it deliberately does not offer is `POST {base}/api/schedules/run`. That route
 * exists for an operator whose cron did not fire, and its own comment is careful that
 * "a cron trigger is the mechanism and this route is not it" — a **Run now** button in
 * an editor's UI would make the exception look like the mechanism, and its real
 * audience is holding a terminal. The banner names the configuration instead.
 *
 * No sort, for the reason `listSchedules` orders by `at` ascending: soonest first is
 * the only ordering a person reads this list in, and a second keyset buys nothing.
 */
export function Schedules({ apiBase, query, onQuery, onNotice, onOpen }: Props) {
  const url = parseSchedulesUrl(query)
  const data = useSchedules(apiBase, url)

  const [cancelling, setCancelling] = useState<ResolvedSchedule | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * One clock reading per render, taken here rather than inside each cell.
   *
   * Two rows a millisecond apart on either side of the overdue boundary would
   * otherwise disagree about what "now" is, and the banner would count a row the
   * table did not badge. It also means the whole screen is a pure function of
   * `(rows, now)`, which is what makes `schedules-model.ts` testable in Node.
   */
  const now = Date.now()
  const narrowed = isNarrowed(url)
  const firstLoad = data.page.loading && data.page.rows.length === 0
  const warning = health(data.page.rows, now)

  const go = useCallback((next: SchedulesUrl) => onQuery(schedulesQuery(next)), [onQuery])

  const cancel = useCallback(
    async (row: ResolvedSchedule) => {
      setBusy(true)
      try {
        const res = await fetch(`${apiBase}${cancelPath(row)}`, { method: 'DELETE' })
        if (!res.ok) throw new Error(await messageOf(res))
        setCancelling(null)
        onNotice(`${titleOf(row)} will no longer ${row.action} automatically`)
        data.reload()
      } catch (e) {
        onNotice((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [apiBase, data, onNotice],
  )

  const columns: Column<ResolvedSchedule>[] = [
    {
      key: 'document',
      label: 'Document',
      cell: (row) => (
        <span className={isUnnamed(row) ? css.unnamed : undefined}>{titleOf(row)}</span>
      ),
    },
    {
      key: 'action',
      label: 'Action',
      cell: (row) => <Badge tone="neutral">{actionLabel(row.action)}</Badge>,
    },
    {
      key: 'at',
      label: 'When',
      cell: (row) => (
        <span className={css.when}>
          {/* Absolute answers "when", relative answers "is that soon". Both, because
              a schedule list is read for the second question and audited for the
              first — and neither belongs in a tooltip. */}
          <span className={css.absolute}>{whenLabel(row.at)}</span>
          <span className={css.relative}>{relativeLabel(row.at, now)}</span>
        </span>
      ),
    },
    {
      key: 'outcome',
      label: 'Outcome',
      cell: (row) => {
        const outcome = outcomeOf(row, now)
        return (
          <span className={css.outcome}>
            <Badge tone={outcomeTone(outcome)}>{outcomeLabel(outcome)}</Badge>
            {/* The error is the whole value of a failed row, so it is in the table
                rather than behind a disclosure. Truncated by CSS with the full text
                as the title, because `last_error` is capped at 500 characters and a
                stack-shaped one would otherwise set the row height for the table. */}
            {row.lastError ? (
              <span className={css.error} title={row.lastError}>
                {row.lastError}
              </span>
            ) : null}
          </span>
        )
      },
    },
  ]

  return (
    <div className={css.screen}>
      <ListHeader
        actions={
          <>
            {/* Two filter groups rather than a select each: four values between them,
                and a chip that shows its state beats a closed menu that hides it. */}
            <fieldset className={css.chips}>
              <legend className={css.srOnly}>Filter by action</legend>
              <button
                type="button"
                className={`${css.chip} ${url.action === '' ? css.chipOn : ''}`}
                aria-pressed={url.action === ''}
                onClick={() => go({ ...url, action: '' })}
              >
                All actions
              </button>
              {ACTIONS.map((action) => (
                <button
                  key={action}
                  type="button"
                  className={`${css.chip} ${url.action === action ? css.chipOn : ''}`}
                  aria-pressed={url.action === action}
                  onClick={() => go({ ...url, action })}
                >
                  {actionLabel(action)}
                </button>
              ))}
            </fieldset>
            <fieldset className={css.chips}>
              <legend className={css.srOnly}>Filter by status</legend>
              <button
                type="button"
                className={`${css.chip} ${url.status === '' ? css.chipOn : ''}`}
                aria-pressed={url.status === ''}
                onClick={() => go({ ...url, status: '' })}
              >
                All
              </button>
              {STATUSES.map((status) => (
                <button
                  key={status}
                  type="button"
                  className={`${css.chip} ${url.status === status ? css.chipOn : ''}`}
                  aria-pressed={url.status === status}
                  onClick={() => go({ ...url, status })}
                >
                  {status === 'pending' ? 'Pending' : 'Failed'}
                </button>
              ))}
            </fieldset>
          </>
        }
      >
        Schedules
      </ListHeader>

      {warning ? (
        /* `role="status"` and not `alert`: this is a condition the screen arrived
           already showing, not an interruption, and an alert would be announced over
           whatever the person was reading when the poll returned. */
        <div className={css.banner} data-tone={warning.tone} role="status">
          {warning.message}
        </div>
      ) : null}

      {firstLoad ? (
        <div className={css.skeletons} aria-hidden="true">
          {SKELETON.map((key) => (
            <div className={css.skeleton} key={key} />
          ))}
        </div>
      ) : (
        <Table
          label="Schedules"
          columns={columns}
          rows={data.page.rows}
          /* `storyId` is not unique — a campaign window is two rows for one document
             — and `id` is the schedule's own key, so it is the row's identity here. */
          rowKey={(row) => row.id}
          /*
           * Every row opens, including one whose document could not be named.
           *
           * `Table`'s `onOpen` makes the first cell a button for *every* row, so a
           * per-row guard would not hide the control — it would leave a button that
           * looks live and does nothing, which is the defect `docs/ui-review.md`
           * objects to by name. Navigating instead is honest: the editor already
           * answers an unknown id with "No such document", which is the true state of
           * the world and more useful than a click that goes nowhere.
           */
          onOpen={(row) => onOpen(row.storyId)}
          actions={(row) => (
            <span className={css.rowActions}>
              <Button
                size="sm"
                variant="subtle"
                disabled={busy}
                title={`Cancel the scheduled ${row.action} of ${titleOf(row)}`}
                onClick={() => setCancelling(row)}
              >
                Cancel
              </Button>
            </span>
          )}
          empty={
            <EmptyState
              title={narrowed ? 'Nothing matches' : 'Nothing is scheduled'}
              body={
                narrowed
                  ? 'Try a different action or status.'
                  : 'A scheduled publish or unpublish appears here until it fires, and then disappears — a schedule that has run leaves a version, not a row. Schedule one from a document’s own publish menu.'
              }
              action={
                narrowed ? (
                  <Button size="sm" onClick={() => go({ status: '', action: '' })}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          }
        />
      )}

      <div className={css.footer}>
        <span className={css.count}>{showing(data.page.rows.length, data.page.total)}</span>
        <span className={css.pager}>
          <Button
            size="sm"
            disabled={!data.canGoBack}
            reason="This is the first page"
            onClick={data.prevPage}
          >
            Previous
          </Button>
          <Button
            size="sm"
            disabled={!data.page.cursor}
            reason="This is the last page"
            onClick={data.nextPage}
          >
            Next
          </Button>
        </span>
      </div>

      {cancelling ? (
        <Dialog
          title={`Cancel the scheduled ${cancelling.action}?`}
          description={cancelWarning(cancelling)}
          onClose={() => setCancelling(null)}
          actions={
            <>
              <Button size="sm" disabled={busy} onClick={() => setCancelling(null)}>
                Keep it
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => void cancel(cancelling)}
              >
                Cancel schedule
              </Button>
            </>
          }
        />
      ) : null}
    </div>
  )
}
