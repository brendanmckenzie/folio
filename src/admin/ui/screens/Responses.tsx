import { useCallback, useEffect, useState } from 'react'
import type { BulkFailure, BulkRefusal, BulkReport } from '../../../core/bulk'
import type { ResponseRow } from '../../../server/form-responses'
import { canDeleteForms, type Me } from '../../me'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Dialog } from '../Dialog'
import { EmptyState } from '../EmptyState'
import { ListHeader } from '../List'
import { type Column, Table } from '../Table'
import { ConfirmBulkDialog } from './ConfirmBulkDialog'
import type { Confirmation } from './content-model'
import css from './Responses.module.css'
import {
  ABSENT,
  type AnswerLine,
  answerLines,
  cellText,
  csvHref,
  deleteConfirmation,
  deleteOneWarning,
  deleteRefusal,
  fileHref,
  isNarrowed,
  isTicked,
  NOTHING,
  parseResponsesUrl,
  type ResponsesUrl,
  responsesQuery,
  retentionNote,
  retryLabel,
  runReport,
  selectAll,
  selectionBody,
  selectionSummary,
  sizeLabel,
  submittedExact,
  submittedLabel,
  tableColumns,
  type Ticked,
  tickAllShown,
  tickCount,
  toggleTick,
} from './responses-model'
import { messageOf } from './useContent'
import { useResponses } from './useResponses'

interface Props {
  apiBase: string
  /** The form whose responses these are — `route.screen.id`. */
  id: string
  me: Me
  query: Readonly<Record<string, string>>
  /** `replace`, not `push`: a filter keystroke must not be a history entry. */
  onQuery: (next: Record<string, string | undefined>) => void
  onNotice: (message: string) => void
  /** Reports the form's label for the breadcrumb, exactly as `FormBuilder` does
   *  once its own fetch answers. */
  onLabel: (label: string) => void
  onOpenBuilder: () => void
}

/** Six placeholder rows, matching every other list screen's skeleton count. */
const SKELETON = ['s1', 's2', 's3', 's4', 's5', 's6']

/**
 * A form's responses — `docs/specs/content-model/forms.md` phase 7, and the third
 * of decision 12's three screens.
 *
 * **Everything on this screen was typed by an anonymous stranger.** That is the
 * one thing worth knowing before editing it: every value reaches the DOM as a
 * text child or an attribute React escapes, there is no `dangerouslySetInnerHTML`
 * anywhere in this file or its model, an uploaded file is never rendered — only
 * downloaded, as an attachment, through the gated route — and the CSV's
 * formula-injection de-fanging is server-side, in `form-responses.ts`, because
 * that is where the file is written.
 *
 * Three access levels, checkpoint 8's ladder: reading is `FORMS` (publisher plus
 * `forms:read`, enforced by the route), exporting and deleting are `ADMIN`. The
 * export and the delete controls are drawn only for somebody the admin already
 * knows is an admin (`canDeleteForms`), because a control that 403s is a worse
 * way to learn about a permission than not offering it.
 */
export function Responses({
  apiBase,
  id,
  me,
  query,
  onQuery,
  onNotice,
  onLabel,
  onOpenBuilder,
}: Props) {
  const url = parseResponsesUrl(query)
  const data = useResponses(apiBase, id, url)
  const go = (next: ResponsesUrl) => onQuery(responsesQuery(next))

  const [ticked, setTicked] = useState<Ticked>(NOTHING)
  const [open, setOpen] = useState<ResponseRow | null>(null)
  const [deleting, setDeleting] = useState<ResponseRow | null>(null)
  const [confirm, setConfirm] = useState<{ confirmation: Confirmation; label: string } | null>(null)
  const [running, setRunning] = useState(false)

  const form = data.form
  const label = form?.label ?? ''
  // `onLabel` is a fresh closure on every render of the shell, so naming it here
  // would re-report the label on every one. The label is the trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reporting is keyed on the value, not on the identity of the reporter
  useEffect(() => {
    if (label) onLabel(label)
  }, [label])

  const rows = data.page.rows
  const count = tickCount(ticked)
  const columns = tableColumns(form?.fields ?? [])
  const hasFiles = columns.some((field) => field.kind === 'file')
  const mayDelete = canDeleteForms(me)

  /* ---------------------------------------------------------- one delete --- */

  const removeOne = useCallback(
    async (row: ResponseRow) => {
      setRunning(true)
      try {
        const res = await fetch(
          `${apiBase}/forms/${encodeURIComponent(id)}/responses/${encodeURIComponent(row.id)}`,
          { method: 'DELETE' },
        )
        if (!res.ok) throw new Error(await messageOf(res))
        const result = (await res.json()) as { files: number }
        onNotice(
          result.files > 0
            ? `Response deleted, with ${result.files} ${result.files === 1 ? 'file' : 'files'}.`
            : 'Response deleted.',
        )
        setTicked(NOTHING)
        data.reload()
      } catch (e) {
        onNotice((e as Error).message)
      } finally {
        setRunning(false)
      }
    },
    [apiBase, id, data, onNotice],
  )

  /* --------------------------------------------------------- bulk delete --- */

  /**
   * A finished run: say what happened, drop the selection, and re-read.
   *
   * The selection is cleared rather than kept, which is the safe direction here
   * more than anywhere: the rows it named are gone, and a selection that survived
   * a delete is a set of ids a second press would report as twenty-five more
   * successes over nothing.
   */
  const finished = useCallback(
    (done: number, failed: readonly BulkFailure[]) => {
      setTicked(NOTHING)
      setRunning(false)
      onNotice(runReport(done, failed))
      data.reload()
    },
    [data, onNotice],
  )

  const run = useCallback(
    async (body: Record<string, unknown>) => {
      setRunning(true)
      try {
        const outcome = await runDelete(apiBase, id, body)
        if ('refused' in outcome) {
          setRunning(false)
          // Re-confirmed against the *new* count, and the selection is
          // re-captured at it — pressing the same button again would otherwise
          // refuse forever with the number that has already moved.
          setConfirm({
            confirmation: deleteRefusal(outcome.refused),
            label: retryLabel(outcome.refused),
          })
          setTicked((prev) =>
            prev.all ? { ...prev, expected: outcome.refused.actual, exclude: new Set() } : prev,
          )
          return
        }
        finished(outcome.done, outcome.failed)
      } catch (e) {
        setRunning(false)
        onNotice((e as Error).message)
      }
    },
    [apiBase, id, finished, onNotice],
  )

  /* -------------------------------------------------------------- render --- */

  if (data.formError) {
    return (
      <div className={css.screen}>
        <ListHeader level={1}>Responses</ListHeader>
        <EmptyState title="Could not load this form" body={data.formError} />
      </div>
    )
  }

  if (data.page.error && rows.length === 0) {
    return (
      <div className={css.screen}>
        <ListHeader level={1}>{label || 'Responses'}</ListHeader>
        <EmptyState
          title="Could not load responses"
          body={data.page.error}
          action={
            <Button size="sm" onClick={data.reload}>
              Try again
            </Button>
          }
        />
      </div>
    )
  }

  const firstLoad = (data.page.loading || data.formLoading) && rows.length === 0
  const narrowed = isNarrowed(url)
  const note = retentionNote(data.page.oldest)

  const tableColumnsFor: Column<ResponseRow>[] = [
    {
      key: '_submitted',
      label: 'Submitted',
      cell: (row) => (
        <span className={css.stamp} title={submittedExact(row.createdAt)}>
          {submittedLabel(row.createdAt)}
        </span>
      ),
    },
    ...columns.map<Column<ResponseRow>>((field) => ({
      key: field.name,
      label: field.label || field.name,
      cell: (row) => {
        const text = cellText(field, row)
        return (
          <span className={text === ABSENT ? css.absent : css.cell} title={text}>
            {text}
          </span>
        )
      },
    })),
  ]

  return (
    <div className={css.screen}>
      <ListHeader
        level={1}
        actions={
          <>
            <input
              className={css.search}
              type="search"
              value={url.q}
              placeholder="Search answers"
              aria-label="Search responses"
              onChange={(e) => go({ ...url, q: e.target.value })}
            />
            <Button size="sm" onClick={onOpenBuilder}>
              Edit form
            </Button>
            {mayDelete ? (
              /* A link, not a fetch: the answer is a file, the route sets
                 `content-disposition`, and a same-origin navigation carries the
                 session cookie exactly as every other admin request does. */
              <a className={css.export} href={csvHref(apiBase, id, url)}>
                Export CSV
              </a>
            ) : null}
          </>
        }
      >
        {label || 'Responses'}
      </ListHeader>

      <div className={css.controls}>
        <fieldset className={css.dates}>
          <legend className={css.srOnly}>Filter by date</legend>
          <label className={css.date}>
            From
            <input
              type="date"
              className={css.dateInput}
              value={url.from}
              max={url.to || undefined}
              onChange={(e) => go({ ...url, from: e.target.value })}
            />
          </label>
          <label className={css.date}>
            To
            <input
              type="date"
              className={css.dateInput}
              value={url.to}
              min={url.from || undefined}
              onChange={(e) => go({ ...url, to: e.target.value })}
            />
          </label>
        </fieldset>
        {narrowed ? (
          <Button size="sm" variant="subtle" onClick={() => go({ from: '', to: '', q: '' })}>
            Clear filters
          </Button>
        ) : null}
      </div>

      {mayDelete ? (
        <div className={css.bulkBar}>
          <button
            type="button"
            className={css.selectAll}
            disabled={rows.length === 0}
            onClick={() => setTicked((prev) => tickAllShown(prev, rows))}
          >
            {rows.length > 0 && rows.every((row) => isTicked(ticked, row.id))
              ? 'Deselect all shown'
              : 'Select all shown'}
          </button>
          {/* Offered only when the list has been asked for a count: `expected`
              has to be the number the person read, or the server's guard is
              comparing against something nobody agreed to. */}
          {data.page.total !== undefined && data.page.total > rows.length && !ticked.all ? (
            <button
              type="button"
              className={css.selectAll}
              onClick={() => setTicked(selectAll(url, data.page.total ?? 0))}
            >
              {`Select all ${data.page.total.toLocaleString('en-US')} matching`}
            </button>
          ) : null}
          {/* Announced: the count changes without the focus moving, so a screen
              reader user is otherwise never told what they have. */}
          <span className={css.bulkText} role="status">
            {selectionSummary(ticked, rows)}
          </span>
          <span className={css.bulkActions}>
            <Button
              size="sm"
              variant="danger"
              disabled={count === 0 || running}
              reason={running ? 'Working…' : 'Select some responses first'}
              onClick={() => {
                const confirmation = deleteConfirmation(ticked, rows, hasFiles)
                if (confirmation) setConfirm({ confirmation, label: `Delete ${count}` })
              }}
            >
              Delete
            </Button>
          </span>
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
          label={`Responses to ${label || 'this form'}`}
          columns={tableColumnsFor}
          rows={rows}
          rowKey={(row) => row.id}
          onOpen={(row) => setOpen(row)}
          {...(mayDelete
            ? {
                select: {
                  head: (
                    <input
                      type="checkbox"
                      className={css.tick}
                      aria-label="Select every response shown"
                      checked={rows.length > 0 && rows.every((row) => isTicked(ticked, row.id))}
                      disabled={rows.length === 0}
                      onChange={() => setTicked((prev) => tickAllShown(prev, rows))}
                    />
                  ),
                  cell: (row: ResponseRow) => (
                    <input
                      type="checkbox"
                      className={css.tick}
                      aria-label={`Select the response from ${submittedExact(row.createdAt)}`}
                      checked={isTicked(ticked, row.id)}
                      onChange={() => setTicked((prev) => toggleTick(prev, row.id))}
                    />
                  ),
                },
              }
            : {})}
          actions={(row) => (
            <span className={css.rowActions}>
              <Button size="sm" variant="subtle" onClick={() => setOpen(row)}>
                Open
              </Button>
              {mayDelete ? (
                <Button
                  size="sm"
                  variant="subtle"
                  disabled={running}
                  onClick={() => setDeleting(row)}
                >
                  Delete
                </Button>
              ) : null}
            </span>
          )}
          empty={
            <EmptyState
              title={narrowed ? 'Nothing matches' : 'No responses yet'}
              body={
                narrowed
                  ? 'Try a wider date range, or clear the search.'
                  : 'When somebody fills this form in, their answers land here. Nothing else has to be wired up.'
              }
              action={
                narrowed ? (
                  <Button size="sm" onClick={() => go({ from: '', to: '', q: '' })}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          }
        />
      )}

      <div className={css.footer}>
        <span className={css.count}>
          {data.page.total === undefined
            ? `${rows.length} shown`
            : `${rows.length} of ${data.page.total.toLocaleString('en-US')} ${
                data.page.total === 1 ? 'response' : 'responses'
              }`}
        </span>
        {note ? <span className={css.retention}>{note}</span> : null}
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
            disabled={data.page.cursor === null}
            reason="This is the last page"
            onClick={data.nextPage}
          >
            Next
          </Button>
        </span>
      </div>

      {/*
        One dialog at a time, and it is not a style preference: `Dialog` owns the
        focus trap, and a second one mounted inside the first steals it and never
        gives it back (spec 32 phase 4 found that). Opening a confirmation from
        the drawer therefore *closes* the drawer first — see the drawer's own
        Delete button.
      */}
      {open && !deleting && !confirm ? (
        <ResponseDrawer
          apiBase={apiBase}
          formId={id}
          response={open}
          lines={answerLines(open, form?.fields ?? [])}
          canDelete={mayDelete}
          onClose={() => setOpen(null)}
          onDelete={() => {
            const row = open
            setOpen(null)
            setDeleting(row)
          }}
        />
      ) : null}

      {deleting ? (
        <Dialog
          title="Delete this response?"
          description={deleteOneWarning(deleting)}
          danger
          onClose={() => setDeleting(null)}
          actions={
            <>
              <Button onClick={() => setDeleting(null)}>Cancel</Button>
              <Button
                variant="danger"
                disabled={running}
                reason="Working…"
                onClick={() => {
                  const row = deleting
                  setDeleting(null)
                  void removeOne(row)
                }}
              >
                Delete it
              </Button>
            </>
          }
        />
      ) : null}

      {confirm ? (
        <ConfirmBulkDialog
          confirmation={confirm.confirmation}
          confirmLabel={confirm.label}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null)
            void run({ selection: selectionBody(ticked) })
          }}
        />
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------- the drawer --- */

/**
 * One response, every key it holds.
 *
 * A `Dialog` rather than a bespoke slide-over: there is exactly one focus trap in
 * this admin (`useFocusTrap`, via `Dialog`) and a seventh hand-rolled one is the
 * thing `CLAUDE.md` names by name. `size="wide"` because a message field is prose
 * and a 420px column turns it into a ribbon.
 *
 * A retired key is **shown, marked, and never hidden** (decision 7): the row is a
 * record of what somebody sent, and a drawer that quietly dropped the answers to
 * questions since removed would be a record of something else.
 */
function ResponseDrawer({
  apiBase,
  formId,
  response,
  lines,
  canDelete,
  onClose,
  onDelete,
}: {
  apiBase: string
  formId: string
  response: ResponseRow
  lines: readonly AnswerLine[]
  canDelete: boolean
  onClose: () => void
  onDelete: () => void
}) {
  return (
    <Dialog
      title="Response"
      description={`${submittedExact(response.createdAt)} · answered version ${response.version}`}
      size="wide"
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Close</Button>
          {canDelete ? (
            <Button variant="danger" onClick={onDelete}>
              Delete
            </Button>
          ) : null}
        </>
      }
    >
      <dl className={css.answers}>
        {lines.map((line) => (
          <div className={css.answer} key={line.name}>
            <dt className={css.term}>
              {line.label}
              {line.retired ? (
                <Badge
                  tone="warn"
                  title="No longer a question on this form. The answer is kept exactly as it was sent."
                >
                  retired
                </Badge>
              ) : null}
            </dt>
            <dd className={css.value}>
              {line.file ? (
                <a
                  className={css.download}
                  href={fileHref(apiBase, formId, response.id, line.name)}
                >
                  {line.file.filename}
                  <span className={css.size}>{sizeLabel(line.file.size)}</span>
                </a>
              ) : (
                <span className={line.value === ABSENT ? css.absent : undefined}>{line.value}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>

      <dl className={css.meta}>
        <div className={css.answer}>
          <dt className={css.term}>Page</dt>
          <dd className={css.value}>
            {response.page ? <code className={css.mono}>{response.page}</code> : ABSENT}
          </dd>
        </div>
        <div className={css.answer}>
          <dt className={css.term}>Locale</dt>
          <dd className={css.value}>
            {response.locale ? <code className={css.mono}>{response.locale}</code> : ABSENT}
          </dd>
        </div>
        <div className={css.answer}>
          <dt className={css.term}>Reference</dt>
          <dd className={css.value}>
            <code className={css.mono}>{response.id}</code>
          </dd>
        </div>
      </dl>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ the job --- */

/**
 * A whole bulk delete: post, read the report, post again with its cursor.
 *
 * **Loop on `continueFrom`, never on `seen < total`** — a batch whose rows were
 * all refused still advances the cursor, and a comparison of counts would spin. A
 * cursor that has not *moved* ends the loop too, which is the case
 * `content-model.ts`'s own runner had to name: `bulk-writes.md` decision 11 is
 * right about the condition and silent about a server that answers the same
 * cursor forever.
 */
async function runDelete(
  apiBase: string,
  formId: string,
  body: Record<string, unknown>,
): Promise<{ done: number; failed: BulkFailure[] } | { refused: BulkRefusal }> {
  let continueFrom: string | null = null
  let done = 0
  const failed: BulkFailure[] = []
  for (;;) {
    const res = await fetch(`${apiBase}/forms/${encodeURIComponent(formId)}/responses/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, ...(continueFrom === null ? {} : { continueFrom }) }),
    })
    // The guard runs once, at the start of a job, so a refusal can only arrive on
    // the first call — and it arrives before anything is deleted.
    if (res.status === 409) return { refused: (await res.json()) as BulkRefusal }
    if (!res.ok) throw new Error(await messageOf(res))
    const report = (await res.json()) as BulkReport<'delete'>
    done += report.done
    failed.push(...report.failed)
    if (report.continueFrom === null || report.continueFrom === continueFrom) {
      return { done, failed }
    }
    continueFrom = report.continueFrom
  }
}
