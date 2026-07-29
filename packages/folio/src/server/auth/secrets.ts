/**
 * The one way a bearer secret is minted and the one way it is stored.
 *
 * Every credential in this feature — a session cookie, a sign-in link's token,
 * an API token — is 32 bytes from `crypto.getRandomValues`, handed out once in
 * the clear and kept only as a SHA-256 (`identity-and-access.md` architecture
 * decision 1). There is no HMAC secret to configure, rotate or leak; a leaked
 * database yields no usable credentials; and revocation is a `delete` rather
 * than a blocklist a stateless token would need.
 */

/** Bytes of entropy behind every credential. 256 bits: unguessable, and short
 * enough that the hex form is a reasonable cookie value. */
const TOKEN_BYTES = 32

const HEX = '0123456789abcdef'

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 15]!
  return out
}

/**
 * A fresh secret, in the clear. The caller hands it to exactly one place — a
 * `Set-Cookie`, an email, an HTTP response body — and stores `hashToken` of it.
 */
export function mintSecret(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)))
}

/** An API token as it is presented: `Authorization: Bearer folio_<hex>`. */
export function mintApiToken(): string {
  return `folio_${mintSecret()}`
}

/**
 * The stored form of a presented secret: lowercase hex SHA-256.
 *
 * Lookup is by primary key on this value, which is what makes a timing-safe
 * comparison unnecessary: nothing here compares two secrets, it hashes the
 * presented one and asks the index whether that row exists.
 */
export async function hashToken(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return toHex(new Uint8Array(digest))
}

/** A minted row id, matching the `sty_`/`ver_`/`ast_` convention elsewhere. */
export function mintId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}
