import { useEffect, useState } from 'react'
import {
  FILE_ACCEPT,
  type FormField,
  type FormFieldKind,
  MAX_FORM_FIELDS,
  shapeOf,
} from '../../../core/forms'
import type { LocaleConfig } from '../../../core/locales'
import type { Form } from '../../../server/forms'
import { canDeleteForms, canEdit, type Me } from '../../me'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { EmptyState } from '../EmptyState'
import { Field, Input, Select, Textarea } from '../Field'
import { ListHeader } from '../List'
import { Menu, type MenuItem } from '../Menu'
import { FormDeleteDialog } from './FormDeleteDialog'
import css from './FormBuilder.module.css'
import {
  addField,
  addOption,
  MAX_FIELDS_REACHED,
  closesAtFromInput,
  closesAtInputValue,
  fieldKindLabel,
  FIELD_KINDS,
  fieldNameRefusal,
  fieldText,
  moveField,
  needsOptions,
  normaliseFieldName,
  optionLabel,
  removeField,
  removeOption,
  renameWarning,
  showLocaleSwitcher,
  type TranslatableKey,
  updateField,
  updateOption,
  withFieldText,
  withOptionLabel,
} from './form-model'
import { Stub } from './Stub'
import { messageOf } from './useContent'
import { useForm } from './useForm'

interface Props {
  apiBase: string
  id: string
  me: Me
  /** `FolioConfig.locales`, when the host declared one. Absent hides the
   *  locale switcher entirely — decision 12: "shown only when
   *  `config.locales` is set." */
  locales?: LocaleConfig
  onNotice: (message: string) => void
  /** Reports the saved label, for the shell's breadcrumb and tab title. */
  onLabel: (label: string) => void
  onOpenResponses: (id: string) => void
  onDeleted: () => void
}

/**
 * The builder — `docs/specs/content-model/forms.md` phase 6, the second of
 * decision 12's three screens.
 *
 * **Local draft, not autosave.** Every other authored thing in Folio is on the
 * mutation log, where a keystroke is a change nobody has to remember to save.
 * A form is a row with an `expectedUpdatedAt` guard instead (decision 18), so
 * this screen holds its own edit in component state and one explicit Save
 * commits it — the guard is only meaningful around a single write, not around
 * every keystroke becoming one.
 *
 * **A 409 replaces the draft with the reloaded form and says so**, rather than
 * retrying or silently keeping the rejected edit: `useForm`'s `save` already
 * reloads on conflict, and the effect that seeds `draft` from `data.form`
 * picks the fresh row up the moment it lands.
 */
export function FormBuilder({
  apiBase,
  id,
  me,
  locales,
  onNotice,
  onLabel,
  onOpenResponses,
  onDeleted,
}: Props) {
  const data = useForm(apiBase, id)
  const [draft, setDraft] = useState<Form | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedInitialName, setSelectedInitialName] = useState<string | null>(null)
  const [locale, setLocale] = useState(locales?.default ?? '')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (data.form) setDraft(data.form)
  }, [data.form])

  // `onLabel` is a fresh closure on every render of the shell around this
  // screen; naming it here would refire this effect — and re-notify the
  // breadcrumb — on every keystroke anywhere above this component. `data.form`
  // (the last *saved* row) is the only real dependency: the tab title and
  // crumb track what was saved, not what is mid-edit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  useEffect(() => {
    if (data.form) onLabel(data.form.label || 'Untitled form')
  }, [data.form])

  if (data.notFound) {
    return (
      <Stub title="No such form">
        This form was deleted, or the link to it is stale. It no longer exists.
      </Stub>
    )
  }

  if (!draft) {
    if (data.error) {
      return (
        <EmptyState
          title="Could not load this form"
          body={data.error}
          action={
            <Button size="sm" onClick={data.reload}>
              Try again
            </Button>
          }
        />
      )
    }
    return (
      <div className={css.screen}>
        <div className={css.loadingSkeleton} aria-hidden="true" />
      </div>
    )
  }

  const editable = canEdit(me)
  const source = locales?.default ?? ''
  const showLocales = showLocaleSwitcher(locales)
  const hasResponses = (data.usage?.responses ?? 0) > 0
  const selectedField = draft.fields.find((f) => f.name === selected) ?? null
  // Decision 7: `version` (and therefore a purge of `form:<id>`) only bumps on
  // a *shape* change — a name, kind, required flag or option values added,
  // removed or retyped — never on a label, help or translation edit.
  // `shapeOf` is the one function that says which, shared with the server so
  // this can never disagree with what actually triggers `formChanged`.
  const structural = data.form ? shapeOf(draft.fields) !== shapeOf(data.form.fields) : false

  const select = (name: string | null) => {
    setSelected(name)
    setSelectedInitialName(name)
  }

  const onAddField = (kind: FormFieldKind) => {
    const next = addField(draft.fields, kind, draft.id)
    setDraft({ ...draft, fields: next })
    select(next[next.length - 1]?.name ?? null)
  }

  const onFieldChange = (name: string, next: FormField) => {
    setDraft({ ...draft, fields: updateField(draft.fields, name, next) })
    if (selected === name) setSelected(next.name)
  }

  const onRemoveField = (name: string) => {
    setDraft({ ...draft, fields: removeField(draft.fields, name) })
    if (selected === name) select(null)
  }

  const onMoveField = (from: number, to: number) => {
    setDraft({ ...draft, fields: moveField(draft.fields, from, to) })
  }

  const save = async () => {
    if (!draft) return
    setSaving(true)
    const result = await data.save({
      label: draft.label,
      name: draft.name,
      fields: draft.fields,
      open: draft.open,
      closesAt: draft.closesAt,
      successMessage: draft.successMessage,
      closedMessage: draft.closedMessage,
      submitLabel: draft.submitLabel,
      redirectTo: draft.redirectTo,
    })
    setSaving(false)
    onNotice(
      result.ok
        ? 'Saved.'
        : result.conflict
          ? `${result.message} Your unsaved change was discarded — the form below is the latest version.`
          : result.message,
    )
  }

  const remove = async () => {
    const res = await fetch(`${apiBase}/forms/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!res.ok) {
      onNotice(await messageOf(res))
      return
    }
    onNotice(`"${draft.label || 'Untitled form'}" and everything it collected are gone.`)
    onDeleted()
  }

  const addMenuItems: MenuItem[] = FIELD_KINDS.map((k) => ({
    id: k.kind,
    label: (
      <span className={css.menuItem}>
        <span className={css.menuItemLabel}>{k.label}</span>
        <span className={css.menuItemHint}>{k.hint}</span>
      </span>
    ),
    run: () => onAddField(k.kind),
  }))
  const atLimit = draft.fields.length >= MAX_FORM_FIELDS

  return (
    <div className={css.screen}>
      <ListHeader
        level={1}
        actions={
          <>
            {showLocales ? (
              <Select
                aria-label="Editing locale"
                value={locale}
                onChange={(e) => setLocale(e.target.value)}
              >
                {locales?.available.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                    {l.code === source ? ' (source)' : ''}
                  </option>
                ))}
              </Select>
            ) : null}
            <Button size="sm" onClick={() => onOpenResponses(id)}>
              Responses
            </Button>
            {canDeleteForms(me) ? (
              <Button size="sm" variant="subtle" onClick={() => setDeleting(true)}>
                Delete
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="primary"
              disabled={!editable || saving}
              reason={!editable ? 'Your role may not edit forms' : undefined}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        {/* A plain `<input>`, not the shared `Input` — that wrapper always
            applies `Field.module.css`'s `.control` and deliberately omits
            `className` (`Field.tsx`), because it exists for the one look a
            labelled field control has. A screen title styled like a form field
            is the wrong look, the same reason `Redirects.tsx`'s search box is
            a bare `<input>` too. */}
        <input
          className={css.titleInput}
          aria-label="Form label"
          value={draft.label}
          disabled={!editable}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
        />
      </ListHeader>

      {structural ? (
        <p className={css.structuralNote}>
          Saving will change this form's shape, which purges every cached page that renders it
          (decision 7) — a label or help-text edit alone does not.
        </p>
      ) : null}

      <div className={css.body}>
        <div className={css.fields}>
          <ol className={css.fieldList}>
            {draft.fields.map((field, i) => (
              <li key={field.name}>
                <button
                  type="button"
                  className={`${css.fieldRow} ${selected === field.name ? css.fieldRowSelected : ''}`}
                  onClick={() => select(field.name)}
                >
                  <span className={css.fieldRowKind}>{fieldKindLabel(field.kind)}</span>
                  <span className={css.fieldRowLabel}>{field.label || field.name}</span>
                  {field.required ? <Badge tone="accent">Required</Badge> : null}
                </button>
                <span className={css.fieldRowActions}>
                  <Button
                    size="sm"
                    variant="subtle"
                    disabled={!editable || i === 0}
                    reason="Already first"
                    aria-label={`Move ${field.label || field.name} up`}
                    onClick={() => onMoveField(i, i - 1)}
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    variant="subtle"
                    disabled={!editable || i === draft.fields.length - 1}
                    reason="Already last"
                    aria-label={`Move ${field.label || field.name} down`}
                    onClick={() => onMoveField(i, i + 1)}
                  >
                    ↓
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={!editable}
                    aria-label={`Remove ${field.label || field.name}`}
                    onClick={() => onRemoveField(field.name)}
                  >
                    ×
                  </Button>
                </span>
              </li>
            ))}
          </ol>
          {draft.fields.length === 0 ? (
            <p className={css.note}>No questions yet. Add the first one below.</p>
          ) : null}
          <Menu
            trigger="Add a question…"
            items={
              atLimit
                ? addMenuItems.map((item) => ({
                    ...item,
                    disabled: true,
                    reason: MAX_FIELDS_REACHED(MAX_FORM_FIELDS),
                  }))
                : addMenuItems
            }
          />
        </div>

        <div className={css.panel}>
          {selectedField ? (
            <FieldPanel
              key={selectedInitialName ?? selectedField.name}
              field={selectedField}
              formId={draft.id}
              otherNames={draft.fields
                .filter((f) => f.name !== selectedField.name)
                .map((f) => f.name)}
              locale={locale || source}
              source={source}
              editable={editable}
              showRenameWarning={hasResponses}
              onChange={(next) => onFieldChange(selectedField.name, next)}
            />
          ) : (
            <FormSettingsPanel
              form={draft}
              editable={editable}
              onChange={(next) => setDraft(next)}
            />
          )}
        </div>
      </div>

      {deleting ? (
        <FormDeleteDialog
          apiBase={apiBase}
          id={id}
          label={draft.label}
          onClose={() => setDeleting(false)}
          onConfirm={() => {
            setDeleting(false)
            void remove()
          }}
        />
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------- field panel --- */

function FieldPanel({
  field,
  formId,
  otherNames,
  locale,
  source,
  editable,
  showRenameWarning,
  onChange,
}: {
  field: FormField
  formId: string
  otherNames: readonly string[]
  locale: string
  source: string
  editable: boolean
  showRenameWarning: boolean
  onChange: (next: FormField) => void
}) {
  const [nameDraft, setNameDraft] = useState(field.name)
  useEffect(() => setNameDraft(field.name), [field.name])

  const text = (key: TranslatableKey) => fieldText(field, key, locale, source)
  const setText = (key: TranslatableKey, value: string) =>
    onChange(withFieldText(field, key, value, locale, source))

  /**
   * What committing `nameDraft` would produce, and what is wrong with it — a
   * *preview*, computed the same way `commitName` commits, so the charset
   * autocorrection (`normaliseFieldName`) never itself reads as an error: a
   * name typed as "First Name" previews as `first_name` and shows nothing
   * wrong, because nothing is. What can still refuse is the one thing this
   * screen alone can catch — a collision with another question's name or with
   * this form's honeypot (decision 9) — and committing over either is refused
   * rather than silently disambiguated, because a silent `_2` suffix is a
   * rename that did not do what it looked like it did.
   */
  const previewName = normaliseFieldName(nameDraft)
  const renamed = previewName !== field.name
  const nameRefusal = renamed ? fieldNameRefusal(previewName, { formId, otherNames }) : null

  const commitName = () => {
    if (nameRefusal) return
    setNameDraft(previewName)
    if (previewName !== field.name) onChange({ ...field, name: previewName })
  }

  return (
    <div className={css.fieldPanel}>
      <div className={css.panelHead}>
        <Badge>{fieldKindLabel(field.kind)}</Badge>
      </div>

      {locale === source ? (
        <Field
          label="Field name"
          help={
            nameRefusal
              ? undefined
              : renamed && showRenameWarning
                ? (renameWarning(true) ?? undefined)
                : "The HTML input's name, the CSV column header, and the key a response is stored under. Lowercase letters, numbers and underscores."
          }
          error={nameRefusal ?? undefined}
        >
          {(id) => (
            <Input
              id={id}
              value={nameDraft}
              disabled={!editable}
              spellCheck={false}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
            />
          )}
        </Field>
      ) : null}

      <Field label="Label" required={locale === source}>
        {(id) => (
          <Input
            id={id}
            value={text('label')}
            placeholder={locale === source ? undefined : field.label}
            disabled={!editable}
            onChange={(e) => setText('label', e.target.value)}
          />
        )}
      </Field>

      {field.kind !== 'hidden' && field.kind !== 'statement' ? (
        <Field label="Help text">
          {(id) => (
            <Input
              id={id}
              value={text('help')}
              placeholder={locale === source ? undefined : field.help}
              disabled={!editable}
              onChange={(e) => setText('help', e.target.value)}
            />
          )}
        </Field>
      ) : null}

      {supportsPlaceholder(field.kind) ? (
        <Field label="Placeholder">
          {(id) => (
            <Input
              id={id}
              value={text('placeholder')}
              placeholder={locale === source ? undefined : field.placeholder}
              disabled={!editable}
              onChange={(e) => setText('placeholder', e.target.value)}
            />
          )}
        </Field>
      ) : null}

      {locale === source && field.kind !== 'hidden' && field.kind !== 'statement' ? (
        <Field label="Required" inline>
          {(id) => (
            <input
              id={id}
              type="checkbox"
              checked={field.required === true}
              disabled={!editable}
              onChange={(e) => onChange({ ...field, required: e.target.checked })}
            />
          )}
        </Field>
      ) : null}

      {locale === source && supportsMax(field.kind) ? (
        <Field label={field.kind === 'number' ? 'Maximum value' : 'Maximum length'}>
          {(id) => (
            <Input
              id={id}
              type="number"
              value={field.max ?? ''}
              disabled={!editable}
              onChange={(e) =>
                onChange({
                  ...field,
                  max: e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
            />
          )}
        </Field>
      ) : null}

      {locale === source && field.kind === 'number' ? (
        <Field label="Minimum value">
          {(id) => (
            <Input
              id={id}
              type="number"
              value={field.min ?? ''}
              disabled={!editable}
              onChange={(e) =>
                onChange({
                  ...field,
                  min: e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
            />
          )}
        </Field>
      ) : null}

      {locale === source && supportsPattern(field.kind) ? (
        <Field
          label="Pattern"
          help="An HTML pattern the input enforces, re-checked on submit. Leave blank for none."
        >
          {(id) => (
            <Input
              id={id}
              value={field.pattern ?? ''}
              disabled={!editable}
              spellCheck={false}
              onChange={(e) =>
                onChange({ ...field, pattern: e.target.value === '' ? undefined : e.target.value })
              }
            />
          )}
        </Field>
      ) : null}

      {needsOptions(field.kind) ? (
        <OptionsEditor
          field={field}
          locale={locale}
          source={source}
          editable={editable}
          onChange={onChange}
        />
      ) : null}

      {locale === source && field.kind === 'file' ? (
        <>
          <Field label="Accepts">
            {(id) => (
              <Select
                id={id}
                value={field.accept ?? 'documents'}
                disabled={!editable}
                onChange={(e) =>
                  onChange({ ...field, accept: e.target.value as FormField['accept'] })
                }
              >
                {(Object.keys(FILE_ACCEPT) as (keyof typeof FILE_ACCEPT)[]).map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Maximum size (bytes)"
            help="Left blank, this uses Folio's own upload limit."
          >
            {(id) => (
              <Input
                id={id}
                type="number"
                value={field.maxBytes ?? ''}
                disabled={!editable}
                onChange={(e) =>
                  onChange({
                    ...field,
                    maxBytes: e.target.value === '' ? undefined : Number(e.target.value),
                  })
                }
              />
            )}
          </Field>
        </>
      ) : null}

      {locale === source && field.kind === 'hidden' ? (
        <Field label="Value" help="The value the host's own markup emits for this input.">
          {(id) => (
            <Input
              id={id}
              value={field.value ?? ''}
              disabled={!editable}
              onChange={(e) => onChange({ ...field, value: e.target.value })}
            />
          )}
        </Field>
      ) : null}

      {field.kind === 'statement' && locale === source ? (
        <Field label="Text" help="Prose between questions. Renders no input and stores nothing.">
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={field.text ?? ''}
              disabled={!editable}
              onChange={(e) => onChange({ ...field, text: e.target.value })}
            />
          )}
        </Field>
      ) : null}
      {field.kind === 'statement' && locale !== source ? (
        // `FormFieldI18n` has no `text` key (only `label`, `help`,
        // `placeholder` and `options`), and `compileField` in
        // `server/forms.ts` confirms why: `out.text = field.text` is written
        // verbatim, with no locale lookup at all. A statement's prose is not
        // translatable today, so saying that plainly beats inventing an editor
        // for a key that would silently do nothing.
        <p className={css.note}>
          Statement text is not translated — every locale shows the source text.
        </p>
      ) : null}
    </div>
  )
}

function OptionsEditor({
  field,
  locale,
  source,
  editable,
  onChange,
}: {
  field: FormField
  locale: string
  source: string
  editable: boolean
  onChange: (next: FormField) => void
}) {
  const options = field.options ?? []
  return (
    <div className={css.options}>
      <span className={css.optionsLabel}>Options</span>
      <ol className={css.optionList}>
        {options.map((option) => (
          <li key={option.value} className={css.optionRow}>
            {locale === source ? (
              <Input
                value={option.value}
                disabled={!editable}
                spellCheck={false}
                aria-label="Option value"
                onChange={(e) =>
                  onChange(
                    updateOption(field, option.value, {
                      value: e.target.value,
                      label: option.label,
                    }),
                  )
                }
              />
            ) : null}
            <Input
              value={optionLabel(field, option.value, locale, source)}
              placeholder={locale === source ? undefined : option.label}
              disabled={!editable}
              aria-label="Option label"
              onChange={(e) =>
                onChange(withOptionLabel(field, option.value, e.target.value, locale, source))
              }
            />
            {locale === source ? (
              <Button
                size="sm"
                variant="danger"
                disabled={!editable || options.length <= 1}
                reason={options.length <= 1 ? 'At least one option is required' : undefined}
                aria-label={`Remove ${option.label || option.value}`}
                onClick={() => onChange(removeOption(field, option.value))}
              >
                ×
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
      {locale === source ? (
        <Button size="sm" disabled={!editable} onClick={() => onChange(addOption(field))}>
          Add option
        </Button>
      ) : null}
    </div>
  )
}

function supportsPlaceholder(kind: FormFieldKind): boolean {
  return (
    kind === 'text' || kind === 'textarea' || kind === 'email' || kind === 'tel' || kind === 'url'
  )
}

function supportsMax(kind: FormFieldKind): boolean {
  return kind === 'text' || kind === 'textarea' || kind === 'number'
}

function supportsPattern(kind: FormFieldKind): boolean {
  return kind === 'text' || kind === 'email' || kind === 'tel' || kind === 'url'
}

/* ------------------------------------------------------------- form settings --- */

function FormSettingsPanel({
  form,
  editable,
  onChange,
}: {
  form: Form
  editable: boolean
  onChange: (next: Form) => void
}) {
  return (
    <div className={css.fieldPanel}>
      <ListHeader level={2}>Settings</ListHeader>

      <Field
        label="Name"
        help="The admin's stable handle for this form — never part of the public action URL, but it rides back on a redirect as `folio_form` so a page carrying two forms can tell which one answered."
      >
        {(id) => (
          <Input
            id={id}
            value={form.name}
            disabled={!editable}
            spellCheck={false}
            onChange={(e) => onChange({ ...form, name: e.target.value })}
          />
        )}
      </Field>

      <Field label="Accepting submissions" inline>
        {(id) => (
          <input
            id={id}
            type="checkbox"
            checked={form.open}
            disabled={!editable}
            onChange={(e) => onChange({ ...form, open: e.target.checked })}
          />
        )}
      </Field>

      <Field
        label="Closes automatically"
        help="Enforced at the route, not only in the markup — a cached page that is still showing the form gets refused once this passes."
      >
        {(id) => (
          <Input
            id={id}
            type="datetime-local"
            value={closesAtInputValue(form.closesAt)}
            disabled={!editable}
            onChange={(e) => onChange({ ...form, closesAt: closesAtFromInput(e.target.value) })}
          />
        )}
      </Field>

      <Field label="Submit button label">
        {(id) => (
          <Input
            id={id}
            value={form.submitLabel}
            disabled={!editable}
            onChange={(e) => onChange({ ...form, submitLabel: e.target.value })}
          />
        )}
      </Field>

      <Field label="Success message" help="Shown on the page a visitor lands on after submitting.">
        {(id) => (
          <Textarea
            id={id}
            rows={2}
            value={form.successMessage}
            disabled={!editable}
            onChange={(e) => onChange({ ...form, successMessage: e.target.value })}
          />
        )}
      </Field>

      <Field label="Closed message" help="Shown in place of the form once it stops accepting.">
        {(id) => (
          <Textarea
            id={id}
            rows={2}
            value={form.closedMessage}
            disabled={!editable}
            onChange={(e) => onChange({ ...form, closedMessage: e.target.value })}
          />
        )}
      </Field>

      <Field
        label="Redirect to"
        help="A path on this site, or a full URL, to send a successful submission to instead of back where it came from. Leave blank to return to the page it was submitted from."
      >
        {(id) => (
          <Input
            id={id}
            value={form.redirectTo ?? ''}
            disabled={!editable}
            spellCheck={false}
            onChange={(e) =>
              onChange({ ...form, redirectTo: e.target.value === '' ? null : e.target.value })
            }
          />
        )}
      </Field>
    </div>
  )
}
