/**
 * `passkeys()` — the provider a host lists to turn passkeys on.
 *
 * `../../../docs/specs/foundation/passkeys.md` decision 1. Listing it in
 * `auth.providers` is the whole of the opt-in: it is what renders the button and
 * the script on the login page, mounts `/login/passkey/*` and
 * `/api/me/passkeys*`, and lists it on Settings. Nothing here is a function,
 * because unlike every other kind the flow belongs to Folio — a passkey is
 * verified by `webauthn.ts` against a row in `passkeys`, not by a host's
 * callback.
 *
 * **Rejected: `AuthConfig.passkeys: true` beside `providers`.** It is a sign-in
 * method: it renders in the provider list, it stamps `sessions.provider =
 * 'passkey'`, and Settings describes it in the providers table. A flag would be
 * a fifth kind hiding as a boolean, and every place that switches on `kind`
 * would grow an `|| passkeys`.
 *
 * **Rejected: always-on for every session-mode deployment.** A host with
 * strictly enforced SSO has already said passkeys are not a door for
 * `@client.com`; making them appear anyway is a second place to say no. And the
 * "works without JavaScript" property is easier to hold when the JavaScript is
 * something a host chose to add.
 *
 * `resolveAuth` (`config.ts`) refuses a provider list that is *only* this one:
 * enrolment needs a session and a session needs a first sign-in, so a
 * passkey-only deployment is one nobody could ever enrol on.
 */
import type { PasskeyProvider } from './config'

export interface PasskeyOptions {
  /** Button label on the login page. */
  label?: string
  /**
   * The human-readable relying-party name a browser shows during enrolment
   * ("Sign in to …"). Defaults to the request host — there is deliberately no
   * `rpId` to go with it (decision 5): the relying-party *id* is always the
   * request host, so a passkey enrolled on a preview never works on production
   * and there is no key to misconfigure.
   */
  rpName?: string
}

export function passkeys(opts: PasskeyOptions = {}): PasskeyProvider {
  return {
    kind: 'passkey',
    // Fixed, not configurable: `sessions.provider` and `users.provider` store
    // it, the enforced-domain map compares against it, and a per-deployment id
    // would make "signed in with a passkey" a string only that deployment can
    // read. `resolveAuth` refuses any other value.
    id: 'passkey',
    label: opts.label ?? 'Sign in with a passkey',
    // Spread rather than `rpName: opts.rpName`, so an omitted option leaves the
    // key absent and the route's `?? host` default is reached.
    ...(opts.rpName ? { rpName: opts.rpName } : {}),
  }
}
