import { useState } from 'react'
import type { Role } from '../../../server/auth/roles'
import { Button } from '../Button'
import { Dialog } from '../Dialog'
import { Field, Input, Select } from '../Field'
import css from './Access.module.css'
import { ROLE_MEANING, ROLE_OPTIONS } from './access-model'

/**
 * Giving somebody access.
 *
 * **No mail is sent, and that is the design rather than a shortcut**: the row *is*
 * the invitation, and the person signs in through whichever provider the site has
 * configured. `server/routes/access.ts` says why — a library that mailed an
 * invitation would be back to owning a from-address, which
 * `server/auth/magic-link.ts` deliberately refuses to do. So the dialog says
 * "they can sign in" rather than "we have emailed them", because the second would
 * be a lie a person would then wait on.
 *
 * A dialog rather than the inline three-control form the old rail used
 * (`admin/Access.tsx`), for one reason that is about this screen specifically:
 * the roles need explaining. `publisher` is not a word whose powers anybody
 * guesses, and the difference between it and `editor` is the one that matters most
 * — a form squeezed into a rail had nowhere to put that, and a full-width table
 * has nowhere either. A dialog does.
 */
export function AccessInviteDialog({
  onClose,
  onInvite,
}: {
  onClose: () => void
  onInvite: (body: { email: string; name?: string; role: Role }) => Promise<void>
}) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('editor')
  const [pending, setPending] = useState(false)

  // The server's own rule, stated here only so the button can explain itself
  // before the click: `UserCreateBody`'s `EMAIL` requires an address, and a 400 for
  // an empty field is a worse answer than a disabled button that says what is
  // missing.
  const refusal = email.trim() ? undefined : 'Enter an email address'

  const submit = async () => {
    if (refusal) return
    setPending(true)
    try {
      await onInvite({ email: email.trim(), ...(name.trim() ? { name: name.trim() } : {}), role })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      title="Give someone access"
      description="No email is sent. They sign in with whichever provider this site uses."
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={pending || refusal !== undefined}
            reason={pending ? 'Adding…' : refusal}
            onClick={() => void submit()}
          >
            Give access
          </Button>
        </>
      }
    >
      {/* A real `<form>`, so Enter submits — which is what a two-field dialog is
          for. `onSubmit` rather than a submit button, because `Dialog` owns the
          footer and its buttons live outside this element. */}
      <form
        className={css.form}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Field label="Email" help="Stored lowercased. One account per address." required>
          {(id) => (
            <Input
              id={id}
              type="email"
              value={email}
              placeholder="name@example.com"
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>

        <Field label="Name" help="Optional. Defaults to the part before the @, and can be changed.">
          {(id) => (
            <Input
              id={id}
              value={name}
              placeholder="Ada Lovelace"
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>

        <Field label="Role" help={ROLE_MEANING[role]}>
          {(id) => (
            <Select id={id} value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </form>
    </Dialog>
  )
}
