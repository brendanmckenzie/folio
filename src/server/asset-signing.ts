/**
 * Signed URLs for gated media-library files
 * (`../../docs/specs/platform/asset-access.md` decision 9).
 *
 * A signed URL is the stable URL plus `exp` (Unix seconds) and `sig`:
 * `base64url(HMAC-SHA256(key, "folio-asset\n" + assetKey + "\n" + exp))`. It covers the
 * key and the expiry and **not** the transform query, so one signature serves every
 * `srcFor` variant of a file (each still clamped by `parseTransform`).
 *
 * **Verification is `crypto.subtle.verify`, never a string comparison.** The WebCrypto
 * HMAC verify is constant-time, so a signature cannot be recovered a byte at a time from
 * response timing. A signature that is malformed, expired, wrong, made with a key not in
 * the list, or carrying an `exp` further ahead than the lifetime cap plus a minute of
 * clock skew **verifies as false**, and the route then asks the host exactly as it would
 * for the unsigned URL.
 */

/** The seconds a URL stays valid when `expiresIn` is not given. */
export const DEFAULT_SIGN_SECONDS = 300;
/** The longest `expiresIn`, which bounds how long a leaked link is useful. */
export const MAX_SIGN_SECONDS = 86_400;
/** Clock skew allowed between the signer and the verifier on `exp`. */
export const SIGN_SKEW_SECONDS = 60;
/** The shortest key that will sign or verify. */
export const MIN_KEY_LENGTH = 32;

const PREFIX = "folio-asset\n";
const encoder = new TextEncoder();

/** The keys, refusing a list that is empty or holds one under 32 characters. */
function checkedKeys(keys: readonly string[]): readonly string[] {
  if (keys.length === 0) throw new Error("folio: assetSigning.keys returned no key");
  for (const key of keys) {
    if (typeof key !== "string" || key.length < MIN_KEY_LENGTH) {
      throw new Error(`folio: an assetSigning key must be at least ${MIN_KEY_LENGTH} characters`);
    }
  }
  return keys;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Null for anything that is not unpadded base64url of exactly 32 bytes (43 characters). */
function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return null;
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=");
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

const message = (assetKey: string, exp: string) => encoder.encode(`${PREFIX}${assetKey}\n${exp}`);

/** The R2 key a stable asset URL names: its last path segment, after `/asset/`. */
export function assetKeyOfSrc(src: string): string | null {
  const match = /\/asset\/([^/?#]+)(?:[?#]|$)/.exec(src);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

/**
 * `src` with `exp` and `sig` appended (any it already carried are replaced), signed with
 * the first key. `expiresIn` is seconds, default 300, capped at 86 400. Throws on a key
 * under 32 characters, or when `src` is not an asset URL, so a host's bug is a failure
 * rather than an unsigned link handed out as if it were signed.
 */
export async function signAssetUrl(
  keys: readonly string[],
  src: string,
  expiresIn: number | undefined,
  now: number,
): Promise<string> {
  const [first] = checkedKeys(keys);
  const assetKey = assetKeyOfSrc(src);
  if (assetKey === null)
    throw new Error("folio: signAsset was given a URL that is not an asset URL");
  const seconds = expiresIn ?? DEFAULT_SIGN_SECONDS;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("folio: signAsset expiresIn must be a positive number of seconds");
  }
  const exp = String(Math.floor(now / 1000) + Math.min(Math.floor(seconds), MAX_SIGN_SECONDS));
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(first!, "sign"),
    message(assetKey, exp),
  );

  const at = src.indexOf("#");
  const fragment = at === -1 ? "" : src.slice(at);
  const withoutFragment = at === -1 ? src : src.slice(0, at);
  const q = withoutFragment.indexOf("?");
  const path = q === -1 ? withoutFragment : withoutFragment.slice(0, q);
  const params = new URLSearchParams(q === -1 ? "" : withoutFragment.slice(q + 1));
  params.set("exp", exp);
  params.set("sig", toBase64Url(new Uint8Array(mac)));
  return `${path}?${params.toString()}${fragment}`;
}

/**
 * Is `sig` a live signature of `assetKey` and `exp` by any of `keys`. Throws only for a
 * key list the route must treat as "every signature is invalid" (a short key), which it
 * catches and logs once; every bad *signature* answers false.
 */
export async function verifyAssetSignature(
  keys: readonly string[],
  assetKey: string,
  exp: string | null,
  sig: string | null,
  now: number,
): Promise<boolean> {
  if (exp === null || sig === null) return false;
  const secrets = checkedKeys(keys);
  if (!/^[1-9][0-9]{0,11}$/.test(exp)) return false;
  const nowSeconds = Math.floor(now / 1000);
  const expiry = Number(exp);
  if (expiry <= nowSeconds) return false;
  if (expiry > nowSeconds + MAX_SIGN_SECONDS + SIGN_SKEW_SECONDS) return false;
  const signature = fromBase64Url(sig);
  if (!signature) return false;
  const data = message(assetKey, exp);
  for (const secret of secrets) {
    if (await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), signature, data)) {
      return true;
    }
  }
  return false;
}
