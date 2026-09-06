import { useCallback, useId, useState } from 'react'
import { canDeleteForms, canEdit, type Me } from '../../me'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Dialog } from '../Dialog'
import { EmptyState } from '../EmptyState'
import { Field, Input } from '../Field'
import { ListHeader } from '../List'
import type { Screen } from '../route'
import { type Column, Table } from '../Table'
import { FormDeleteDialog } from './FormDeleteDialog'
import css from './Forms.module.css'
import {
  BLANK_FORM_DRAFT,
  createFormBody,
  type FormDraft,
  formDraftRefusal,
  type FormRow,
  formStatus,
  questionsLabel,
  responsesLabel,
  statusHint,
  updatedLabel,
} from './forms-model'
import { messageOf } from './useContent'
import { useForms } from './useForms'

interface Props {
  apiBase: string
  me: Me
  onOpen: (screen: Screen) => void
  onNotice: (message: string) => void
}

/** Six placeholder rows, matching Redirects' and Documents' skeleton count. */
const SKELETON = ['s1', 's2', 's3', 's4', 's5', 's6']

/**
 * The forms list — `docs/specs/content-model/forms.md` phase 6, decision 12's
 * "a `Forms` nav item and three screens" (this is the first of the three).
 *
 * **No search box and no filter chips**, unlike `Redirects`. `GET
 * {base}/api/forms` takes neither a `q` nor a `state` (`forms-model.ts`'s
 * header states why): decision 2 bounds a form by what a person will build, not
 * by what a query narrows.
 *
 * Every row opens the builder; the responses table and the delete confirmation
 * are the row's own actions, so a row never has to be opened just to find out
 * how many people answered it.
 */
export function Forms({ apiBase, me, onOpen, onNotice }: Props) {
  const data = useForms(apiBase)

  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<FormRow | null>(null)
  const [busy, setBusy] = useState(false)

  const create = useCallback(
    async (draft: FormDraft) => {
      setBusy(true)
      try {
        const res = await fetch(`${apiBase}/forms`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(createFormBody(draft)),
        })
        if (!res.ok) throw new Error(await messageOf(res))
        const form = (await res.json()) as { id: string }
        setCreating(false)
        // Straight to the builder, the way a new document opens straight to the
        // editor — a form with no questions yet has nothing a list row can show.
        onOpen({ name: 'form', id: form.id })
      } catch (e) {
        // Left open: a slug collision names the existing form and is exactly
        // the kind of thing somebody fixes by editing what they typed, not by
        // starting over from a toast.
        onNotice((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [apiBase, onOpen, onNotice],
  )

  const remove = useCallback(
    async (row: FormRow) => {
      setBusy(true)
      try {
        const res = await fetch(`${apiBase}/forms/${encodeURIComponent(row.id)}`, {
          method: 'DELETE',
        })
        if (!res.ok) throw new Error(await messageOf(res))
        onNotice(`"${row.label}" and everything it collected are gone.`)
        data.reload()
      } catch (e) {
        onNotice((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [apiBase, data, onNotice],
  )

  const columns: Column<FormRow>[] = [
    {
      key: 'label',
      label: 'Form',
      cell: (row) => <span className={css.label}>{row.label || 'Untitled form'}</span>,
    },
    {
      key: 'name',
      label: 'Name',
      cell: (row) => <code className={css.slug}>{row.name}</code>,
    },
    {
      key: 'status',
      label: 'Status',
      cell: (row) => {
        const status = formStatus(row)
        return (
          <Badge tone={status === 'open' ? 'ok' : 'neutral'} title={statusHint(row)}>
            {status === 'open' ? 'Open' : 'Closed'}
          </Badge>
        )
      },
    },
    {
      key: 'questions',
      label: 'Questions',
      numeric: true,
      cell: (row) => questionsLabel(row),
    },
    {
      key: 'responses',
      label: 'Responses',
      numeric: true,
      cell: (row) => responsesLabel(row),
    },
    {
      key: 'updated',
      label: 'Last edited',
      cell: (row) => <span className={css.stamp}>{updatedLabel(row)}</span>,
    },
  ]

  if (data.page.error && data.page.rows.length === 0) {
    return (
      <div className={css.screen}>
        <ListHeader level={1}>Forms</ListHeader>
        <EmptyState
          title="Could not load forms"
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

  const firstLoad = data.page.loading && data.page.rows.length === 0

  return (
    <div className={css.screen}>
      <ListHeader
        level={1}
        actions={
          canEdit(me) ? (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              New form
            </Button>
          ) : undefined
        }
      >
        Forms
      </ListHeader>

      {firstLoad ? (
        <div className={css.skeletons} aria-hidden="true">
          {SKELETON.map((key) => (
            <div className={css.skeleton} key={key} />
          ))}
        </div>
      ) : (
        <Table
          label="Forms"
          columns={columns}
          rows={data.page.rows}
          rowKey={(row) => row.id}
          onOpen={(row) => onOpen({ name: 'form', id: row.id })}
          actions={(row) => (
            <span className={css.rowActions}>
              <Button
                size="sm"
                variant="subtle"
                onClick={() => onOpen({ name: 'responses', id: row.id })}
              >
                Responses
              </Button>
              {canDeleteForms(me) ? (
                <Button
                  size="sm"
                  variant="subtle"
                  disabled={busy}
                  title={`Delete "${row.label}"`}
                  onClick={() => setDeleting(row)}
                >
                  Delete
                </Button>
              ) : null}
            </span>
          )}
          empty={
            <EmptyState
              title="No forms yet"
              body="Build one to collect names, messages or applications straight into Folio — no third-party dashboard, no developer route to write."
              action={
                canEdit(me) ? (
                  <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
                    New form
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
            ? `${data.page.rows.length} shown`
            : `${data.page.rows.length} of ${data.page.total} ${data.page.total === 1 ? 'form' : 'forms'}`}
        </span>
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

      {creating ? (
        <NewFormDialog
          busy={busy}
          onClose={() => setCreating(false)}
          onSubmit={(draft) => void create(draft)}
        />
      ) : null}

      {deleting ? (
        <FormDeleteDialog
          apiBase={apiBase}
          id={deleting.id}
          label={deleting.label}
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            const row = deleting
            setDeleting(null)
            void remove(row)
          }}
        />
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ create --- */

function NewFormDialog({
  busy,
  onClose,
  onSubmit,
}: {
  busy: boolean
  onClose: () => void
  onSubmit: (draft: FormDraft) => void
}) {
  const [draft, setDraft] = useState<FormDraft>(BLANK_FORM_DRAFT)
  /** Refusals appear on the first submit, not on the first keystroke —
   *  `Redirects.tsx`'s `NewRedirectDialog` states the reason. */
  const [submitted, setSubmitted] = useState(false)
  const formId = useId()

  const refusal = formDraftRefusal(draft)
  const shown = submitted ? refusal : null

  const submit = () => {
    setSubmitted(true)
    if (!refusal) onSubmit(draft)
  }

  return (
    <Dialog
      title="New form"
      description="Starts empty — the builder is where questions get added."
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form={formId} disabled={busy} reason="Saving…">
            Create form
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className={css.form}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <Field label="Label" required error={shown ?? undefined}>
          {(id) => (
            <Input
              id={id}
              value={draft.label}
              placeholder="Contact us"
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
          )}
        </Field>

        <Field
          label="Name"
          help="A stable handle for the admin — this is what rides back on a redirect after somebody submits. Leave it blank to derive one from the label."
        >
          {(id) => (
            <Input
              id={id}
              value={draft.name}
              placeholder="contact"
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          )}
        </Field>
      </form>
    </Dialog>
  )
}
