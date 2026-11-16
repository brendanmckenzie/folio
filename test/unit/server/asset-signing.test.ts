import { describe, expect, it } from "vitest";
import {
  assetKeyOfSrc,
  MAX_SIGN_SECONDS,
  signAssetUrl,
  verifyAssetSignature,
} from "../../../src/server/asset-signing";

/** `docs/specs/platform/asset-access.md` decision 9: the signature is the credential. */

const K1 = "k1-0123456789abcdef0123456789abcdef";
const K2 = "k2-0123456789abcdef0123456789abcdef";
const NOW = 1_800_000_000_000;
const KEY = "ast_0123456789ab-report.pdf";
const SRC = `/folio/asset/${KEY}`;

const parts = (url: string) => {
  const u = new URL(url, "https://x.test");
  return { exp: u.searchParams.get("exp"), sig: u.searchParams.get("sig") };
};

describe("signAssetUrl and verifyAssetSignature", () => {
  it("round-trips, and a transform query does not change the signature's validity", async () => {
    const url = await signAssetUrl([K1], `${SRC}?w=300&f=webp`, 60, NOW);
    expect(url).toContain("w=300");
    const { exp, sig } = parts(url);
    expect(Number(exp)).toBe(NOW / 1000 + 60);
    expect(await verifyAssetSignature([K1], KEY, exp, sig, NOW)).toBe(true);
    expect(await verifyAssetSignature([K1], KEY, exp, sig, NOW + 59_000)).toBe(true);
  });

  it("is refused once expired", async () => {
    const { exp, sig } = parts(await signAssetUrl([K1], SRC, 60, NOW));
    expect(await verifyAssetSignature([K1], KEY, exp, sig, NOW + 61_000)).toBe(false);
  });

  it("is refused for a different file, a changed exp, or a changed signature", async () => {
    const { exp, sig } = parts(await signAssetUrl([K1], SRC, 60, NOW));
    expect(await verifyAssetSignature([K1], "ast_ffffffffffff-x.pdf", exp, sig, NOW)).toBe(false);
    expect(await verifyAssetSignature([K1], KEY, String(Number(exp) + 1), sig, NOW)).toBe(false);
    const flipped = sig!.slice(0, -1) + (sig!.endsWith("A") ? "B" : "A");
    expect(await verifyAssetSignature([K1], KEY, exp, flipped, NOW)).toBe(false);
    expect(await verifyAssetSignature([K1], KEY, exp, "short", NOW)).toBe(false);
    expect(await verifyAssetSignature([K1], KEY, null, sig, NOW)).toBe(false);
    expect(await verifyAssetSignature([K1], KEY, exp, null, NOW)).toBe(false);
  });

  it("is refused for an exp beyond the cap plus a minute, even when correctly signed", async () => {
    // A signer that skipped the cap: sign by hand through a far future `now`.
    const far = await signAssetUrl([K1], SRC, MAX_SIGN_SECONDS, NOW + 3 * 86_400_000);
    const { exp, sig } = parts(far);
    expect(await verifyAssetSignature([K1], KEY, exp, sig, NOW)).toBe(false);
    // The cap itself is honoured at signing time.
    const capped = parts(await signAssetUrl([K1], SRC, 10 * MAX_SIGN_SECONDS, NOW));
    expect(Number(capped.exp)).toBe(NOW / 1000 + MAX_SIGN_SECONDS);
    expect(await verifyAssetSignature([K1], KEY, capped.exp, capped.sig, NOW)).toBe(true);
  });

  it("rotates: the first key signs and every key verifies", async () => {
    const old = parts(await signAssetUrl([K2], SRC, 60, NOW));
    expect(await verifyAssetSignature([K1, K2], KEY, old.exp, old.sig, NOW)).toBe(true);
    const fresh = parts(await signAssetUrl([K1, K2], SRC, 60, NOW));
    expect(await verifyAssetSignature([K1], KEY, fresh.exp, fresh.sig, NOW)).toBe(true);
    expect(await verifyAssetSignature([K1], KEY, old.exp, old.sig, NOW)).toBe(false);
  });

  it("refuses a key under 32 characters: signing throws and no signature verifies", async () => {
    await expect(signAssetUrl(["too-short"], SRC, 60, NOW)).rejects.toThrow(/32 characters/);
    const { exp, sig } = parts(await signAssetUrl([K1], SRC, 60, NOW));
    await expect(verifyAssetSignature(["too-short"], KEY, exp, sig, NOW)).rejects.toThrow();
    // A short key beside a good one poisons the list: every signature is invalid.
    await expect(verifyAssetSignature([K1, "too-short"], KEY, exp, sig, NOW)).rejects.toThrow();
    await expect(verifyAssetSignature([], KEY, exp, sig, NOW)).rejects.toThrow();
  });

  it("refuses a URL that is not an asset URL, and defaults to five minutes", async () => {
    await expect(signAssetUrl([K1], "/somewhere/else", 60, NOW)).rejects.toThrow();
    expect(Number(parts(await signAssetUrl([K1], SRC, undefined, NOW)).exp)).toBe(NOW / 1000 + 300);
    await expect(signAssetUrl([K1], SRC, 0, NOW)).rejects.toThrow();
  });

  it("reads the key off an encoded src", () => {
    expect(assetKeyOfSrc("/folio/asset/ast_1-a%20b.pdf?w=1")).toBe("ast_1-a b.pdf");
    expect(assetKeyOfSrc("https://h.test/folio/asset/k#x")).toBe("k");
    expect(assetKeyOfSrc("/folio/other")).toBeNull();
  });
});
