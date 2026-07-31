import { useState } from 'react'
import type { DocumentType, SchemaIndex } from '../../../core/schema'
import { Button } from '../Button'
import { Dialog } from '../Dialog'
import { Field, Input } from '../Field'
import css from './CreateDialog.module.css'
import {
  type CreateBody,
  createBody,
  type CreateForm,
  createForm,
  EMPTY_DRAFT,
  pathOf,
  refusalOf,
  slugFieldValue,
  slugOf,
} from './create-model'

/**
 * The name a document is created with — **collected before anything is written**.
 *
 * This exists because the alternative was in production and the owner found it:
 * both New buttons posted `{ title: 'Untitled' }` on click, so the row was in the
 * tree, in search and in every "used by N" count before its author had typed a
 * character. Walk away from the editor and the junk is permanent; do it twice and
 * the database holds `untitled` and `untitled-2`. Cancel here writes nothing,
 * which is the whole feature.
 *
 * **One field, and it is the type's own title field.** For a `person` the dialog
 * asks for a "Full name", because that is what `personRecord` calls it — not
 * "Name", not "Title". The label comes from the root block's field definition and
 * the value goes where that field lives, so the dialog is not a detour around the
 * form: it is the form's first field, asked a moment earlier.
 *
 * **A page is also asked for its slug**, prefilled by slugifying the name and
 * overridable, with the resulting path shown underneath. A page's identity *is*
 * its URL — `createStory` derives `path` from it and `redirects.md` is what a
 * later change to it costs — so asking is meaningful rather than ceremony. A
 * record has no path, so it is asked nothing else.
 *
 * Rejected: **a modal listing every field of the type.** That is the editor, and
 * a second one that can only save all-or-nothing would fight the live document —
 * a create form with a Cancel button cannot also be a multiplayer editing session
 * with per-keystroke sync. One required field is what makes an `Untitled` row
 * unrepresentable; the rest of the document is what the editor is for.
 */
export function CreateDialog({
  type,
  schema,
  parentId = null,
  parentPath,
  pending,
  onClose,
  onCreate,
}: {
  type: DocumentType
  /**
   * The block schema, for the title field's label. Optional because Content is
   * not currently handed one — its dialog then labels the field `Title`, which is
   * right for a page type and a guess for anything else.
   */
  schema?: SchemaIndex
  /** The page this is created under, when the caller knows one. Ignored for an
   * unrouted type, which cannot have a parent. */
  parentId?: string | null
  /** That parent's stored path, for the path preview. Absent is the top level. */
  parentPath?: string
  /** The POST is in flight. Owned by the caller, which owns the fetch. */
  pending: boolean
  onClose: () => void
  /** The finished body. The caller posts it and closes this on success — a failed
   * write leaves the dialog open with what was typed still in it. */
  onCreate: (body: CreateBody) => void
}) {
  const form = createForm(type, schema)
  const [draft, setDraft] = useState(EMPTY_DRAFT)

  const refusal = refusalOf(form, draft)
  const submit = () => {
    const body = createBody(form, draft, parentId)
    if (body) onCreate(body)
  }

  const noun = type.label.toLowerCase()

  return (
    <Dialog
      title={`New ${noun}`}
      description={
        form.routed
          ? 'Nothing is created until you press Create. The slug follows the name, and can be changed.'
          : 'Nothing is created until you press Create.'
      }
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={pending || refusal !== undefined}
            reason={pending ? 'Creating…' : refusal}
            onClick={submit}
          >
            Create
          </Button>
        </>
      }
    >
      {/* A real `<form>`, so Enter submits — which is what a one-field dialog is
          for. `onSubmit` rather than a submit button, because `Dialog` owns the
          footer and its buttons live outside this element. */}
      <form
        className={css.form}
        onSubmit={(e) => {
          e.preventDefault()
          if (!pending) submit()
        }}
      >
        <Field label={form.nameLabel} required help={nameHelp(form, type, noun)}>
          {(id) => (
            <Input
              id={id}
              value={draft.name}
              placeholder={form.nameLabel}
              disabled={pending}
              onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
            />
          )}
        </Field>

        {form.routed ? (
          <Field
            label="Slug"
            help={
              <>
                It will live at <code className={css.path}>{pathOf(draft, parentPath)}</code>
              </>
            }
          >
            {(id) => (
              <Input
                id={id}
                value={slugFieldValue(draft)}
                placeholder={slugOf(draft) || 'page-slug'}
                disabled={pending}
                // `slugEdited` latches on the first keystroke here and never
                // unlatches: a slug somebody chose must not be silently rewritten
                // by the next character of the name.
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, slug: e.target.value, slugEdited: true }))
                }
              />
            )}
          </Field>
        ) : null}
      </form>
    </Dialog>
  )
}

/**
 * What the name field's help line says — and **nothing at all** when the dialog
 * has no schema to answer from.
 *
 * Three cases, not two. Without a `SchemaIndex` the dialog cannot tell a type with
 * no title field from one whose definition it simply has not been handed, and
 * guessing the second wrote *"Page has no title field"* under a `page` — false, and
 * it reads as a broken schema rather than as a missing prop. Silence is the honest
 * third answer, and it is what Content shows until `Prototype.tsx` passes its
 * schema down.
 *
 * The genuinely absent case is still asked for a name and still keeps it: the value
 * lands on the story row, and `runtime.ts`'s `titleFor` falls back to that row
 * rather than to the literal `'Untitled'`, so it survives publishing. Saying so is
 * what stops the field looking like it goes nowhere.
 *
 * Rejected: **keeping the immediate create for a type with no title field.** It
 * would reintroduce exactly the defect this dialog exists to fix, on the types
 * least able to recover from it — a document with no title field has no field to
 * correct the name in afterwards.
 */
function nameHelp(form: CreateForm, type: DocumentType, noun: string): string | undefined {
  if (form.titleField) {
    return `Saved as this ${noun}'s ${form.nameLabel.toLowerCase()}, and editable there afterwards.`
  }
  if (!form.titleFieldKnown) return undefined
  return `${type.label} has no title field, so this names the row only.`
}
