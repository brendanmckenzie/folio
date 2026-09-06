/**
 * The Forms list screen's arithmetic (`docs/specs/content-model/forms.md` phase
 * 6): what a row's status reads as, how its counts read, and the "new form"
 * dialog's own draft and refusal.
 *
 * Pure functions over plain data, for the admin's testing convention — no admin
 * test mounts a component (`vitest.config.ts` runs the unit project under
 * `environment: 'node'`), so a screen's *logic* has to live somewhere a Node
 * test can reach it. `redirects-model.ts` is the pattern.
 *
 * **There is no URL state to parse here**, unlike `redirects-model.ts`'s
 * `RedirectsUrl`. `GET {base}/api/forms` takes no filter — decision 2 bounds a
 * form by "what a person will build" (`MAX_FORM_FIELDS`), and the routes table
 * gives this list exactly the keyset plus two opt-in aggregates — so a search
 * box here would be a control with nothing to send it to.
 */
import type { FormSummary } from '../../../server/forms'
import { when } from './content-rows'

/** The row `GET {base}/api/forms?counts=1` answers with, unchanged — a count
 *  rather than the field array (`FormSummary`'s own header), which is why the
 *  builder reads a different shape entirely (`form-model.ts`'s `FormDetail`). */
export type FormRow = FormSummary

/**
 * Open, closed by the editor's switch, or closed by the clock having passed
 * `closesAt` — the same two facts `server/forms.ts`'s `isOpen` combines for the
 * full `Form` row, restated here for the *summary* shape the list reads
 * (`FormSummary` carries `open`/`closesAt` but not the rest of `Form`, so the two
 * cannot share one function without widening `isOpen`'s parameter to something
 * that no longer names what it needs).
 */
export type FormStatus = 'open' | 'closed'

export function formStatus(
  row: Pick<FormRow, 'open' | 'closesAt'>,
  now: number = Date.now(),
): FormStatus {
  if (!row.open) return 'closed'
  if (row.closesAt !== null && row.closesAt <= now) return 'closed'
  return 'open'
}

/** The status badge's `title` — the same three states, in a sentence a person
 *  did not have to infer from a colour. */
export function statusHint(
  row: Pick<FormRow, 'open' | 'closesAt'>,
  now: number = Date.now(),
): string {
  if (!row.open) return 'Switched off in the builder.'
  const date = row.closesAt === null ? null : new Date(row.closesAt).toLocaleDateString()
  if (row.closesAt !== null && row.closesAt <= now) return `Closed automatically on ${date}.`
  if (date) return `Accepting submissions until it closes automatically on ${date}.`
  return 'Accepting submissions.'
}

export function questionsLabel(row: Pick<FormRow, 'questions'>): string {
  return `${row.questions} ${row.questions === 1 ? 'question' : 'questions'}`
}

/**
 * `—` rather than `0` when the caller did not ask `?counts=1` (`responses` is
 * optional on `FormRow` for exactly that reason) — "not asked" and "asked and
 * the answer was zero" are different facts, and the list always asks, so this
 * is really only reached while the first page is still loading.
 */
export function responsesLabel(row: Pick<FormRow, 'responses'>): string {
  if (row.responses === undefined) return '—'
  return `${row.responses} ${row.responses === 1 ? 'response' : 'responses'}`
}

/**
 * When the row was last saved, relative and coarse — `content-rows.ts`'s
 * `when`, with `draftUpdatedAt: null`: a form has no draft state at all
 * (decision 7), so `updatedAt` is simply the honest answer, the same posture
 * `redirects-model.ts`'s `createdLabel` takes for a table with one timestamp.
 */
export function updatedLabel(row: Pick<FormRow, 'updatedAt'>, now?: number): string {
  return when({ updatedAt: row.updatedAt, draftUpdatedAt: null }, now)
}

/* -------------------------------------------------------------- creating --- */

export interface FormDraft {
  label: string
  /** The editor's own override. Blank lets the server derive one from `label`
   *  (`formSlug`) — see `createFormBody`. */
  name: string
}

export const BLANK_FORM_DRAFT: FormDraft = { label: '', name: '' }

/**
 * The client-side refusal, and it goes exactly as far as being useful — the
 * same posture `redirects-model.ts`'s `draftRefusal` states. The one refusal
 * answerable without a request is a blank label; a slug collision is the
 * server's to catch (`createForm` throws `conflict`, naming the existing form),
 * because answering it here would mean holding a copy of every form's name.
 */
export function formDraftRefusal(draft: FormDraft): string | null {
  if (draft.label.trim() === '') return 'Type a label for this form.'
  return null
}

/**
 * The body `POST {base}/api/forms` receives. `name` rides along only when the
 * editor actually typed one, so an empty override never shadows the
 * label-derived slug `createForm` would otherwise mint.
 */
export function createFormBody(draft: FormDraft): { label: string; name?: string } {
  const label = draft.label.trim()
  const name = draft.name.trim()
  return name ? { label, name } : { label }
}
