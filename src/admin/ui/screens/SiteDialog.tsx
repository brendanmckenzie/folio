import { useState } from 'react'
import type { GroupRef } from '../../../core/sites'
import { Button } from '../Button'
import { Dialog } from '../Dialog'
import { Field, Input, Select, Textarea } from '../Field'
import css from './Sites.module.css'
import { formRefusal, ROUTING_NOTE, STATUS_OPTIONS, type SiteForm } from './sites-model'

/**
 * Creating or editing one registry row: a site or a group
 * (`multi-site.md` decision 1).
 *
 * The shared `Dialog`, so this is the one focus trap and the one portal that
 * re-declares `scoped()` — nothing here portals on its own, and
 * `ui-scope-render.test.tsx` mounts this to say so. **No `autoFocus`**: React
 * applies it during commit, before the trap reads `activeElement` to remember the
 * opener, and the two fight (`Dialog`'s header).
 *
 * An id is fixed once written (the server refuses a change), so it is a field on
 * create and a fact on edit. A group has no status, preview origin or hostnames —
 * it is never served — so those fields are absent for one rather than disabled.
 */
export function SiteDialog({
  mode,
  initial,
  groups,
  onClose,
  onSave,
}: {
  mode: 'create' | 'edit'
  initial: SiteForm
  /** The groups a site may join. */
  groups: readonly GroupRef[]
  onClose: () => void
  onSave: (form: SiteForm) => Promise<void>
}) {
  const [form, setForm] = useState<SiteForm>(initial)
  const [pending, setPending] = useState(false)
  const set = <K extends keyof SiteForm>(key: K, value: SiteForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const refusal = formRefusal(form, mode)
  const noun = form.kind === 'group' ? 'group' : 'site'

  const submit = async () => {
    if (refusal) return
    setPending(true)
    try {
      await onSave(form)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      title={mode === 'create' ? `New ${noun}` : `Edit ${form.name || form.id}`}
      description={
        form.kind === 'group'
          ? 'A group holds content and settings for a region. Sites in it inherit both.'
          : 'A site has its own hostnames, pages and editors.'
      }
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={pending || refusal !== undefined}
            reason={pending ? 'Saving…' : refusal}
            onClick={() => void submit()}
          >
            {mode === 'create' ? `Create ${noun}` : 'Save'}
          </Button>
        </>
      }
    >
      <form
        className={css.form}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {mode === 'create' ? (
          <Field
            label="Id"
            help="Lowercase letters, digits and hyphens. It is in every URL and cannot be changed."
            required
          >
            {(id) => (
              <Input
                id={id}
                value={form.id}
                placeholder="north"
                onChange={(e) => set('id', e.target.value.toLowerCase())}
              />
            )}
          </Field>
        ) : null}

        <Field label="Name" required>
          {(id) => (
            <Input id={id} value={form.name} onChange={(e) => set('name', e.target.value)} />
          )}
        </Field>

        {form.kind === 'site' ? (
          <>
            <Field label="Group" help="Optional. A site inherits its group’s pages and settings.">
              {(id) => (
                <Select id={id} value={form.group} onChange={(e) => set('group', e.target.value)}>
                  <option value="">No group</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field
              label="Status"
              help={STATUS_OPTIONS.find((option) => option.value === form.status)?.help}
            >
              {(id) => (
                <Select
                  id={id}
                  value={form.status}
                  onChange={(e) => set('status', e.target.value as SiteForm['status'])}
                >
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field
              label="Preview origin"
              help="Where drafts are shown, as https://preview.example. Without one, preview, draft mode and shares are unavailable."
            >
              {(id) => (
                <Input
                  id={id}
                  type="url"
                  value={form.preview}
                  placeholder="https://preview.example"
                  onChange={(e) => set('preview', e.target.value)}
                />
              )}
            </Field>

            <Field label="Hostnames" help={`One to a line. ${ROUTING_NOTE}`}>
              {(id) => (
                <Textarea
                  id={id}
                  value={form.hosts}
                  rows={3}
                  placeholder="www.example.com"
                  onChange={(e) => set('hosts', e.target.value)}
                />
              )}
            </Field>
          </>
        ) : null}
      </form>
    </Dialog>
  )
}
