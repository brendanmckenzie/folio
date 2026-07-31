import { useState } from 'react'
import type { Json } from '../../../../core/doc'
import type { StoryRef } from '../../../../core/resolve'
import { asStoryIds } from '../../../../core/values'
import { Button } from '../../Button'
import { candidateHint, type Candidate } from './candidates'
import { candidateOf, DocumentPicker } from './DocumentPicker'
import css from './fields.module.css'

interface Common {
  id: string
  /** The field's label, for the picker's own title. */
  label: string
  types?: readonly string[]
  /** Every id this document points at, already resolved. See `candidateOf`. */
  stories: Readonly<Record<string, StoryRef>>
  apiBase: string
  editable: boolean
  onChange: (value: Json) => void
}

/* --------------------------------------------------------------- singular --- */

/**
 * A `reference`: one document, resolved at render time.
 *
 * The control is *what is picked* plus two buttons, where the old one was a
 * `<select>` over every document on the site. The list moved into
 * `DocumentPicker`, for the reason `candidates.ts` gives; what is worth noting here
 * is what did **not** change — `types` still narrows the offer, and it is still only
 * half the enforcement, because `resolveReference` re-checks it server-side for
 * content that arrived from an importer or over the API
 * (`document-types.md` decision 5).
 */
export function ReferenceField({
  id,
  label,
  types,
  stories,
  apiBase,
  editable,
  value,
  onChange,
}: Common & { value: Json }) {
  const [picking, setPicking] = useState(false)
  const chosen = typeof value === 'string' && value ? value : null
  const resolved = chosen ? candidateOf(stories, chosen) : undefined

  return (
    <div className={css.stack}>
      {chosen ? <Picked id={chosen} resolved={resolved} /> : null}
      <div className={css.row}>
        {/* `id` lands on the control the field's label points at, which for a
            composite is whatever opens the picker: the label has to name something
            focusable, and this is the only thing here that always exists. */}
        <Button id={id} size="sm" disabled={!editable} onClick={() => setPicking(true)}>
          {chosen ? 'Change…' : 'Choose a document…'}
        </Button>
        {chosen ? (
          <Button size="sm" variant="subtle" disabled={!editable} onClick={() => onChange(null)}>
            Clear
          </Button>
        ) : null}
      </div>
      {picking ? (
        <DocumentPicker
          apiBase={apiBase}
          label={label}
          // A reference *may* point at a record — pulling a person's details into a
          // card is the whole point — so nothing is excluded for being unrouted.
          routed={false}
          {...(types ? { types } : {})}
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

/* ----------------------------------------------------------------- plural --- */

/**
 * A `references`: a hand-picked, **ordered** list of documents
 * (`data-documents.md` decision 3) — "these three people, in this order".
 *
 * Every change writes the whole array back as one value, so a reorder is one
 * ordinary `set` mutation and therefore one undo step, consistent with how every
 * array-valued field in Folio behaves. Both guards on an add are carried over
 * unchanged: `max` is what "a fourth pick beyond max is refused by the input" means,
 * and the duplicate check keeps the stored value in step with `asStoryIds`, which
 * drops repeats on the way out.
 *
 * `min` is deliberately **not** here — it is a warning, computed by
 * `inspector-model.ts`'s `fieldWarning` and drawn by the row above, because
 * `required` is declared-and-ignored across the whole field system and this field
 * has no business inventing its own enforcement ahead of the rest.
 */
export function ReferencesField({
  id,
  label,
  types,
  stories,
  apiBase,
  editable,
  value,
  max,
  onChange,
}: Common & { value: Json; max?: number }) {
  const [picking, setPicking] = useState(false)
  const ids = asStoryIds(value)
  const full = max !== undefined && ids.length >= max

  const write = (next: readonly string[]) => onChange([...next] as unknown as Json)

  const move = (from: number, to: number) => {
    if (to < 0 || to >= ids.length) return
    const next = [...ids]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved!)
    write(next)
  }

  return (
    <div className={css.stack}>
      <ul className={css.list}>
        {ids.map((entry, i) => {
          const resolved = candidateOf(stories, entry)
          // `↑`, `↓` and `×` have no accessible name of their own, and three of each
          // in a list of five means fifteen buttons called nothing. Named by the
          // document rather than by its id: `sty_9f2c…` is not something anybody can
          // act on, and the title is what is on screen beside the button.
          const what = resolved?.title || entry
          return (
            <li key={entry}>
              <Picked
                id={entry}
                resolved={resolved}
                ord={i + 1}
                actions={
                  <>
                    <Button
                      size="sm"
                      variant="subtle"
                      disabled={!editable || i === 0}
                      reason="Already first"
                      aria-label={`Move ${what} up`}
                      onClick={() => move(i, i - 1)}
                    >
                      ↑
                    </Button>
                    <Button
                      size="sm"
                      variant="subtle"
                      disabled={!editable || i === ids.length - 1}
                      reason="Already last"
                      aria-label={`Move ${what} down`}
                      onClick={() => move(i, i + 1)}
                    >
                      ↓
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={!editable}
                      aria-label={`Remove ${what}`}
                      onClick={() => write(ids.filter((_, j) => j !== i))}
                    >
                      ×
                    </Button>
                  </>
                }
              />
            </li>
          )
        })}
      </ul>

      <div className={css.row}>
        <Button
          id={id}
          size="sm"
          disabled={!editable || full}
          reason={full ? `Limit of ${max} reached` : undefined}
          onClick={() => setPicking(true)}
        >
          Add a document…
        </Button>
        {ids.length === 0 ? <span className={css.note}>Nothing picked yet.</span> : null}
      </div>

      {picking ? (
        <DocumentPicker
          apiBase={apiBase}
          label={label}
          routed={false}
          {...(types ? { types } : {})}
          exclude={ids}
          onPick={(picked) => {
            if (!full && !ids.includes(picked)) write([...ids, picked])
            setPicking(false)
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------- shared --- */

/**
 * One picked document, or the bare id when the resolution does not hold it.
 *
 * Named, not merely counted: the *renderer* drops an unresolvable entry — which is
 * what stops a page rendering an empty card — but the editor has to show it or the
 * list silently gets shorter and nobody can say why. That split is the same one
 * `multilink`'s `broken` flag makes.
 */
function Picked({
  id,
  resolved,
  ord,
  actions,
}: {
  id: string
  resolved: Candidate | undefined
  ord?: number
  actions?: React.ReactNode
}) {
  return (
    <div className={`${css.picked} ${resolved ? '' : css.missing}`}>
      {ord === undefined ? null : <span className={css.ord}>{ord}</span>}
      <span className={css.pickedTitle}>
        {resolved ? resolved.title || 'Untitled' : 'not found'}
      </span>
      <span className={css.pickedWhere}>{resolved ? candidateHint(resolved) : id}</span>
      {actions ? <span className={css.row}>{actions}</span> : null}
    </div>
  )
}
