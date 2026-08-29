/**
 * Sign in with a link by email.
 *
 * The division of labour is the whole point (`identity-and-access.md`
 * architecture decision 2): Folio renders the URL, stores the challenge, and
 * owns the session that comes out the other end. It does **not** send the mail,
 * because only the host has the binding and the from-address — and because a
 * library that owned the mail account would have to own a template, a
 * deliverability story and a suppression list too.
 *
 * A host's `send` therefore receives the finished URL and does whatever it does:
 * Cloudflare Email Sending, a third-party API, or — in a test or a local dev
 * server — a `console.log`, which is what makes this provider exercisable with
 * no external credentials at all.
 */
import type { AuthProvider, MagicLinkMail } from './config'

export interface MagicLinkOptions<Env> {
  /**
   * Sends the mail. Anything it returns is awaited by the login route, so a
   * rejected promise is a failed send — reported to the requester as the same
   * generic answer a success gets, since a difference there is an enumeration
   * oracle for whether the address is known.
   */
  send: (env: Env, mail: MagicLinkMail) => unknown
  /** Button label on the login page. */
  label?: string
}

/** The provider id, used in `users.provider` and nowhere in a URL. */
export const MAGIC_LINK_ID = 'magic'

export function magicLink<Env>(options: MagicLinkOptions<Env>): AuthProvider<Env> {
  if (typeof options?.send !== 'function') {
    throw new Error('folio: magicLink({ send }) needs a `send` function — only the host can mail')
  }
  return {
    id: MAGIC_LINK_ID,
    label: options.label ?? 'Email me a sign-in link',
    redirect: false,
    send: options.send,
  }
}
