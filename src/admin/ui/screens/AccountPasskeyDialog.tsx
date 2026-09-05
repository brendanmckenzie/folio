import { useState } from 'react'
import { base64url, fromBase64url } from '../../../server/auth/jwt'
import { MAX_PASSKEY_NAME } from '../../../server/auth/passkeys'
import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from '../../../server/auth/webauthn'
import { Button } from '../Button'
import { Dialog } from '../Dialog'
import { Field, Input } from '../Field'
import css from './Account.module.css'
import { messageOf } from './useContent'

interface Props {
  apiBase: string
  onClose: () => void
  /** Fires once the credential is stored, with the row the route answered — the
   * caller reloads the list from it rather than this dialog holding a second
   * copy of the passkeys state. */
  onEnrolled: () => void
}

/**
 * "Add a passkey" — decision 6's one write on this screen, and the one dialog
 * on it. `POST {base}/api/me/passkeys/options`, `navigator.credentials.create`,
 * `POST {base}/api/me/passkeys`, close.
 *
 * **The whole ceremony runs from the confirm button's click handler**, `await`s
 * and all — the same shape `pages.tsx`'s `LOGIN_PASSKEY_SCRIPT` uses for
 * `navigator.credentials.get` (decision 4): a browser's rule is "sticky
 * activation", not literally synchronous, and this codebase already leans on
 * that once. Auto-starting on mount was rejected: a WebAuthn prompt appearing
 * the instant a dialog opens, with no gesture behind it at all, is the one
 * browsers are least likely to allow and the one a person is least likely to
 * expect.
 *
 * **No `toJSON()` / `parseCreationOptionsFromJSON`** (out of scope, decision 3's
 * sibling): both directions are converted by hand, thirty lines, the same
 * discipline the login script keeps.
 */
export function AccountPasskeyDialog({ apiBase, onClose, onEnrolled }: Props) {
  const [name, setName] = useState(() => `Passkey · ${window.location.hostname}`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const enrol = async () => {
    setBusy(true)
    setError(null)
    try {
      const optionsRes = await fetch(`${apiBase}/me/passkeys/options`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      if (!optionsRes.ok) throw new Error(await messageOf(optionsRes))
      const { publicKey } = (await optionsRes.json()) as {
        publicKey: PublicKeyCredentialCreationOptionsJSON
      }

      const created = await navigator.credentials.create({
        publicKey: {
          ...publicKey,
          // Spread into a fresh, mutable array: the wire type declares
          // `pubKeyCredParams` `readonly` (it is JSON, not a DOM object), and the
          // browser's own type wants `PublicKeyCredentialParameters[]`.
          pubKeyCredParams: [...publicKey.pubKeyCredParams],
          challenge: fromBase64url(publicKey.challenge),
          user: { ...publicKey.user, id: fromBase64url(publicKey.user.id) },
          excludeCredentials: publicKey.excludeCredentials.map((cred) => ({
            ...cred,
            id: fromBase64url(cred.id),
            // The wire shape declares `transports` as `readonly string[]` — it is
            // JSON off the network, not a DOM object — while the browser's own
            // type wants a mutable `AuthenticatorTransport[]`. A cast, not a
            // second array: nothing here mutates it, and the values are exactly
            // what `getTransports()` reported when this credential was made.
            transports: cred.transports as AuthenticatorTransport[] | undefined,
          })),
        },
      })
      if (!created) throw new Error('No passkey was created.')
      const credential = created as PublicKeyCredential
      const response = credential.response as AuthenticatorAttestationResponse

      const body: RegistrationResponseJSON = {
        id: credential.id,
        rawId: base64url(new Uint8Array(credential.rawId)),
        type: credential.type,
        response: {
          clientDataJSON: base64url(new Uint8Array(response.clientDataJSON)),
          attestationObject: base64url(new Uint8Array(response.attestationObject)),
          ...(response.getTransports ? { transports: response.getTransports() } : {}),
        },
      }

      const createRes = await fetch(`${apiBase}/me/passkeys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credential: body, name: name.trim() || undefined }),
      })
      if (!createRes.ok) throw new Error(await messageOf(createRes))
      onEnrolled()
    } catch (e) {
      // `NotAllowedError` covers both a person cancelling the prompt and the
      // browser refusing outright (an excluded credential, no available
      // authenticator) — WebAuthn does not distinguish them, on purpose, so
      // this dialog does not invent a distinction the platform declined to
      // make.
      const err = e as Error
      setError(err.name === 'NotAllowedError' ? 'Cancelled.' : err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Add a passkey"
      description="Your browser will ask for your fingerprint, face or PIN."
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void enrol()} disabled={busy}>
            {busy ? 'Waiting for your device…' : 'Continue'}
          </Button>
        </>
      }
    >
      <Field label="Name" help="So you can tell this device apart from your others later.">
        {(id) => (
          <Input
            id={id}
            value={name}
            maxLength={MAX_PASSKEY_NAME}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      {error ? <p className={css.dialogError}>{error}</p> : null}
    </Dialog>
  )
}
