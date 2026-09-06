import { useEffect, useState } from 'react'
import type { Json } from '../../../../core/doc'
import type { Page } from '../../../../core/pagination'
import { Badge } from '../../Badge'
import { Button } from '../../Button'
import { Dialog } from '../../Dialog'
import { EmptyState } from '../../EmptyState'
import { Field, Input } from '../../Field'
import css from './fields.module.css'
import { type FormRow, formStatus, matchesForm, questionsLabel, statusHint } from '../forms-model'
import { messageOf } from '../useContent'

/**
 * A `form` field: one form off the Forms screen, chosen rather than typed.
 *
 * **This replaces a text box that wanted a `frm_…` id pasted into it.** Spec 33
 * shipped the field kind with no control of its own, so `Control.tsx`'s default
 * branch drew an `<input type="text">` and the field's `help` had to tell an
 * editor where to go and copy an id from — which is a schema author documenting
 * a missing feature, in every host that has a form.
 *
 * The shape is `ReferenceField`'s, deliberately: what is picked, then the two
 * buttons that change it, then a dialog to pick in. Two things differ, and both
 * follow from `forms` being a small bounded table rather than the document tree:
 *
 *  - **The list is fetched here, not searched over a route.** `GET
 *    {base}/api/forms` takes no `q` (`forms-model.ts`'s header says why —
 *    decision 2 bounds a form by what a person will build), so the filter is
 *    client-side over a page of rows, where `DocumentPicker`'s goes to the
 *    server. A site with more forms than one page holds is told so rather than
 *    quietly filtering a subset.
 *  - **What is picked is drawn from that same list, not from the resolution.**
 *    `Resolution.forms` does carry the descriptor — `useResolvedForms` fetches
 *    it for the preview — but a descriptor is what a *visitor* gets, and it has
 *    no `label`: an editor picked "Contact enquiry" and must not then be shown
 *    `contact-enquiry`. Holding the rows also means a pick renders immediately
 *    instead of flashing "not found" until the descriptor lands.
 */

/** One page of rows is the offer. The route clamps at 200 and a person who has
 *  built more forms than that has a Forms screen to find them on. */
const LIMIT = 200

interface FormList {
  rows: readonly FormRow[]
  /** True when the table has more rows than one page holds, so the filter below
   *  is honest about what it is filtering. */
  more: boolean
  loading: boolean
  error?: string
}

/**
 * Every form, once per mount of a form field's control.
 *
 * Not a search-as-you-type: there is nothing to send a query to. The whole page
 * is held and `matchesForm` narrows it, which is also what lets the picked row
 * be named without a second request.
 */
export function useFormList(apiBase: string): FormList {
  const [list, setList] = useState<FormList>({ rows: [], more: false, loading: true })

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/forms?limit=${LIMIT}`)
        if (!res.ok) throw new Error(await messageOf(res))
        const page = (await res.json()) as Page<FormRow>
        if (live) setList({ rows: page.rows, more: page.cursor !== null, loading: false })
      } catch (e) {
        if (live) setList({ rows: [], more: false, loading: false, error: (e as Error).message })
      }
    })()
    return () => {
      live = false
    }
  }, [apiBase])

  return list
}

interface Props {
  id: string
  /** The field's label, for the picker's own title. */
  label: string
  value: Json
  apiBase: string
  editable: boolean
  onChange: (value: Json) => void
}

export function FormField({ id, label, value, apiBase, editable, onChange }: Props) {
  const [picking, setPicking] = useState(false)
  const list = useFormList(apiBase)
  const chosen = typeof value === 'string' && value ? value : null
  const row = chosen ? list.rows.find((form) => form.id === chosen) : undefined

  return (
    <div className={css.stack}>
      {chosen ? <Picked id={chosen} row={row} loading={list.loading} /> : null}
      <div className={css.row}>
        {/* `id` lands on whatever opens the picker, the rule every composite
            control here follows: the label has to name something focusable. */}
        <Button id={id} size="sm" disabled={!editable} onClick={() => setPicking(true)}>
          {chosen ? 'Change…' : 'Choose a form…'}
        </Button>
        {chosen ? (
          <Button size="sm" variant="subtle" disabled={!editable} onClick={() => onChange(null)}>
            Clear
          </Button>
        ) : null}
        {chosen ? null : <span className={css.note}>No form picked yet.</span>}
      </div>
      {picking ? (
        <FormPicker
          label={label}
          list={list}
          chosen={chosen}
          onPick={(picked) => {
            onChange(picked)
            setPicking(false)
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  )
}

/**
 * The picked form, or the bare id when no row answers to it.
 *
 * "Not found" is a real state and is worth the red: a form can be deleted while
 * a page still embeds it — the delete dialog says how many documents that is and
 * then cascades anyway — and the page then renders nothing where the form was.
 * The renderer's silence is right for a visitor and wrong for the editor, the
 * same split `ReferenceField`'s missing entry makes.
 */
function Picked({ id, row, loading }: { id: string; row: FormRow | undefined; loading: boolean }) {
  if (!row) {
    return (
      <div className={`${css.picked} ${loading ? '' : css.missing}`}>
        <span className={css.pickedTitle}>{loading ? 'Loading…' : 'Not found'}</span>
        <span className={css.pickedWhere}>{id}</span>
      </div>
    )
  }
  const status = formStatus(row)
  return (
    <div className={css.picked}>
      <span className={css.pickedTitle}>{row.label || 'Untitled form'}</span>
      {/* The slug and nothing else. The question count is on the picker's own
          rows, where there is width for it: the inspector is 320px and three
          facts plus a badge truncate the third to `3…`, which is worse than
          not saying it. */}
      <span className={css.pickedWhere} title={questionsLabel(row)}>
        {row.name}
      </span>
      <Badge tone={status === 'open' ? 'ok' : 'neutral'} title={statusHint(row)}>
        {status === 'open' ? 'Open' : 'Closed'}
      </Badge>
    </div>
  )
}

/**
 * The dialog. A `Dialog` over rows rather than the `Palette` primitive, for
 * `DocumentPicker`'s reason: these rows carry a value, not a command.
 *
 * A closed form is offered rather than hidden. Closing one is how a campaign
 * ends, and a page that embeds it still renders its `closedMessage` — so a
 * picker that refused to show it would be refusing the ordinary case of
 * building next year's page against last year's form.
 */
function FormPicker({
  label,
  list,
  chosen,
  onPick,
  onClose,
}: {
  label: string
  list: FormList
  chosen: string | null
  onPick: (id: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const rows = list.rows.filter((row) => matchesForm(row, q))

  return (
    <Dialog
      title={`Choose a form for ${label}`}
      description="Built on the Forms screen. A page renders whichever one is picked here."
      size="wide"
      onClose={onClose}
      actions={<Button onClick={onClose}>Cancel</Button>}
    >
      {/* A real label rather than a placeholder, for `DocumentPicker`'s reason:
          a placeholder disappears exactly when a screen reader is asked what
          the control is. */}
      <Field label="Filter forms">
        {(id) => (
          <Input
            id={id}
            type="search"
            value={q}
            placeholder="Label or name"
            onChange={(e) => setQ(e.target.value)}
          />
        )}
      </Field>

      {list.error ? (
        <EmptyState title="Could not list forms" body={list.error} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={list.loading ? 'Loading…' : q ? 'Nothing matches' : 'No forms yet'}
          body={
            list.loading
              ? 'Asking the server.'
              : q
                ? 'Try a shorter filter.'
                : 'Build one on the Forms screen, then come back and pick it.'
          }
        />
      ) : (
        <>
          <ul className={css.pickerRows}>
            {rows.map((row) => {
              const status = formStatus(row)
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    className={`${css.pickerRow} ${row.id === chosen ? css.pickerRowOn : ''}`}
                    onClick={() => onPick(row.id)}
                  >
                    <span className={css.pickedTitle}>{row.label || 'Untitled form'}</span>
                    <span className={css.pickedWhere}>
                      {row.name} · {questionsLabel(row)}
                    </span>
                    <Badge tone={status === 'open' ? 'ok' : 'neutral'} title={statusHint(row)}>
                      {status === 'open' ? 'Open' : 'Closed'}
                    </Badge>
                  </button>
                </li>
              )
            })}
          </ul>
          {list.more ? (
            <p className={css.note}>
              The {LIMIT} most recently changed forms. Older ones are on the Forms screen.
            </p>
          ) : null}
        </>
      )}
    </Dialog>
  )
}
