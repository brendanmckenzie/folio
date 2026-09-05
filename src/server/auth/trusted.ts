/**
 * A host that already knows who this is hands Folio the answer.
 *
 * The `trusted` kind exists for the deployment that authenticates people
 * somewhere else — behind Cloudflare Access, behind a proxy that sets a header,
 * behind the host's own membership system — and wants those people to *be*
 * someone in the editor rather than to sign in twice
 * (`../../../docs/specs/foundation/auth-providers.md` decision 4).
 *
 * What the host supplies is one function, and what it answers is deliberately a
 * three-way:
 *
 *   - **an identity** — this request carries one, and the host has verified it;
 *   - **`null`** — this request carries none, which is not an error: it is the
 *     ordinary case for a browser that has not been through the upstream gate,
 *     and the login page renders as it would anywhere else;
 *   - **a throw** — this request carries something that does not verify. That is
 *     a *provider* error, not "nobody": a spoofed header, an expired assertion,
 *     an unreachable JWKS. It is logged and the page says so, because silently
 *     treating a bad credential as an absent one is how a broken gate goes
 *     unnoticed for a month.
 *
 * **`resolve` is the whole trust boundary.** Whatever it returns is signed in,
 * with no second check anywhere: Folio cannot tell a verified assertion from a
 * string somebody typed into `curl`. A resolver that reads a header without
 * verifying a signature over it — see `cloudflare-access.ts`, which does verify
 * one — is an authentication bypass for anything that can reach the Worker
 * without passing through the gate, and the `workers.dev` route of a deployment
 * behind Access is exactly such a thing.
 *
 * Everything after the identity is Folio's and is not a knob: `completeSignIn`
 * finds or provisions the user, enforces the domain map, stamps the provider and
 * appends the audit row. The route is `GET {base}/login`, implicitly, and
 * `GET {base}/login/<id>` explicitly (decision 4 again — nowhere else, and in
 * particular not inside `resolveActor`, which four callers depend on and which
 * must not read D1 for an anonymous request).
 */
import type { Provisioning, RoleMapper, TrustedProvider, VerifiedIdentity } from './config'

export interface TrustedOptions<Env> {
  /** The provider id: the URL segment `{base}/login/<id>`, the `users.provider`
   * stamp, and what `sessions.provider` records. */
  id: string
  /** Button label, shown on the page after a sign-out. */
  label: string
  /**
   * Who this request is, or `null` for "nobody here". **Throws** for a
   * credential that is present and does not verify.
   *
   * May answer synchronously: a header read needs no `await`, and a host that
   * writes one should not have to say `async` to satisfy a signature.
   */
  resolve: (env: Env, req: Request) => Promise<VerifiedIdentity | null> | VerifiedIdentity | null
  /** What happens to an identity this provider verified that matches no user
   * row. `'refuse'` by default, as everywhere else. */
  provision?: Provisioning
  /** Maps the identity's claims to a role. */
  roleFrom?: RoleMapper
  /** Email domains this provider is the only door for. */
  domains?: readonly string[]
  /**
   * Where "sign out" sends the browser after Folio's session is revoked.
   *
   * Omitting it is the honest answer for a proxy header, which Folio cannot
   * un-set: sign-out then lands on `{base}/login?signedout=1`, a page that does
   * *not* resolve and offers a button instead — so the person sees that they
   * signed out rather than being signed straight back in by the next request.
   */
  signOutUrl?: string
}

/**
 * A trusted-identity provider from a host's own resolver.
 *
 * Thin on purpose: it exists so a host writes an object literal with a
 * discriminant it cannot misspell, the same service `magicLink()` and `oidc()`
 * do for their kinds. The `async` wrapper is the one behaviour it adds, so a
 * synchronous resolver's throw arrives as a rejected promise like every other
 * failure on this path.
 */
export function trusted<Env>(options: TrustedOptions<Env>): TrustedProvider<Env> {
  if (typeof options?.resolve !== 'function') {
    throw new Error('folio: trusted({ resolve }) needs a `resolve` function')
  }
  if (typeof options.id !== 'string' || options.id === '') {
    throw new Error('folio: trusted({ id }) needs an id — it is the URL segment and the stamp')
  }
  return {
    kind: 'trusted',
    id: options.id,
    label: options.label,
    ...(options.provision ? { provision: options.provision } : {}),
    ...(options.roleFrom ? { roleFrom: options.roleFrom } : {}),
    ...(options.domains ? { domains: options.domains } : {}),
    ...(options.signOutUrl ? { signOutUrl: options.signOutUrl } : {}),
    async resolve(env, req) {
      return options.resolve(env, req)
    },
  }
}
