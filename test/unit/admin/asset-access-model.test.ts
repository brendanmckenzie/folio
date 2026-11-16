/**
 * **The admin half of visitor access to files** that needs no DOM
 * (`docs/specs/platform/asset-access.md`, phase 7): decoding what the access routes
 * answer, the `gated` filter's trip through the URL and back, the labels an inherit
 * option carries, and the counts a move confirmation shows.
 *
 * Every function here answers nothing without the manifest's `assetAccess`, which is
 * how a deployment that does not gate files keeps drawing what it drew before; the
 * "without it" cases are as much of the contract as the with ones.
 */
import { describe, expect, it } from "vitest";
import type { AssetFolder } from "../../../src/core/assets";
import type { Doc } from "../../../src/core/doc";
import type { ManifestAssetAccess, SchemaIndex } from "../../../src/core/schema";
import {
  accessChoices,
  accessKeysQuery,
  accessLabel,
  accessSource,
  accessSummary,
  type AssetRow,
  type AssetsUrl,
  assetInheritLabel,
  assetLock,
  assetsParams,
  assetsQuery,
  capturedFilter,
  decodeAccessMap,
  decodePurges,
  folderIdForPath,
  folderInheritLabel,
  inheritLabel,
  isGatedValue,
  isNarrowed,
  isPublicPage,
  lockLabel,
  MAX_ACCESS_KEYS,
  moveImpact,
  moveImpactText,
  NO_FILTERS,
  parseAccessInput,
  parseAssetsUrl,
  publicLabel,
  purgeNotice,
  rowGated,
  type Ticked,
  withFilter,
} from "../../../src/admin/ui/screens/assets-model";

const SELECT: ManifestAssetAccess = {
  field: "access",
  public: "public",
  options: [
    { value: "public", label: "Everyone" },
    { value: "members", label: "Members" },
    { value: "premium", label: "Premium" },
  ],
};
const BOOLEAN: ManifestAssetAccess = { field: "membersOnly", public: false };
const NUMBER: ManifestAssetAccess = { field: "tier", public: 0 };
const TEXT: ManifestAssetAccess = { field: "audience", public: "all" };

const row = (id: string, extra: Partial<AssetRow> = {}): AssetRow => ({
  id,
  key: `${id}.png`,
  filename: `${id}.png`,
  contentType: "image/png",
  size: 1,
  width: null,
  height: null,
  alt: "",
  createdAt: 1,
  folderId: null,
  description: "",
  altAuto: "",
  descriptionAuto: "",
  describedAt: null,
  describeError: null,
  tags: [],
  ...extra,
});

const folder = (
  id: string,
  parentId: string | null,
  access: AssetFolder["access"],
  effectiveAccess: AssetFolder["effectiveAccess"],
  name = id,
): AssetFolder => ({
  id,
  parentId,
  name,
  path: parentId ? `${parentId}/${id}` : id,
  createdAt: 1,
  access,
  effectiveAccess,
});

const url = (extra: Partial<AssetsUrl> = {}): AssetsUrl => ({
  ...parseAssetsUrl({}, { view: "grid" }),
  ...extra,
});

const picked = (...ids: string[]): Ticked => ({ all: false, ids: new Set(ids) });

describe("what is gated", () => {
  it("is a value that is not the public one, compared strictly", () => {
    expect(isGatedValue("members", SELECT)).toBe(true);
    expect(isGatedValue("public", SELECT)).toBe(false);
    expect(isGatedValue(null, SELECT)).toBe(false);
    expect(isGatedValue(undefined, SELECT)).toBe(false);
    // `0` is a value like any other: a tier gate with `public: 0` gates tier 1, and a
    // gate that made `0` public by truthiness would gate nothing.
    expect(isGatedValue(1, NUMBER)).toBe(true);
    expect(isGatedValue(0, NUMBER)).toBe(false);
    expect(isGatedValue(true, BOOLEAN)).toBe(true);
    expect(isGatedValue(false, BOOLEAN)).toBe(false);
    // `"0"` is not `0`: strict, as the server's `isUngated` is.
    expect(isGatedValue("0", NUMBER)).toBe(true);
  });

  it("is nothing at all without the manifest's assetAccess", () => {
    expect(isGatedValue("members", undefined)).toBe(false);
    expect(rowGated(row("a", { effectiveAccess: "members" }), undefined)).toBe(false);
    expect(lockLabel(row("a", { effectiveAccess: "members" }), undefined)).toBeNull();
  });

  it("reads a row by its effective value, never its own", () => {
    // Own value public inside a gated folder cannot happen (an own value wins), but own
    // null inheriting a gated folder is the common case, and it is the effective one.
    expect(rowGated(row("a", { access: null, effectiveAccess: "members" }), SELECT)).toBe(true);
    expect(rowGated(row("a", { access: "members", effectiveAccess: null }), SELECT)).toBe(false);
    expect(rowGated(row("a"), SELECT)).toBe(false);
  });

  it("names a lock by the gate field's own label", () => {
    expect(lockLabel(row("a", { effectiveAccess: "premium" }), SELECT)).toBe("Premium");
    expect(lockLabel(row("a", { effectiveAccess: "everyone-else" }), SELECT)).toBe("everyone-else");
    expect(lockLabel(row("a", { effectiveAccess: "public" }), SELECT)).toBeNull();
  });
});

describe("labels", () => {
  it("names the public value from its option, else Public", () => {
    expect(publicLabel(SELECT)).toBe("Everyone");
    expect(publicLabel(TEXT)).toBe("Public");
    expect(accessLabel(null, SELECT)).toBe("Everyone");
    expect(accessLabel("members", SELECT)).toBe("Members");
    expect(accessLabel(3, NUMBER)).toBe("3");
    expect(accessLabel("staff", TEXT)).toBe("staff");
    expect(accessLabel("all", TEXT)).toBe("Public");
  });

  it("offers a select's options, a boolean's two values, and a typed value otherwise", () => {
    expect(accessChoices(SELECT)).toEqual({
      kind: "options",
      options: [
        { value: "public", label: "Everyone" },
        { value: "members", label: "Members" },
        { value: "premium", label: "Premium" },
      ],
    });
    const bool = accessChoices(BOOLEAN);
    expect(bool.kind === "options" && bool.options.map((o) => o.value)).toEqual([false, true]);
    expect(accessChoices(NUMBER)).toEqual({ kind: "number" });
    expect(accessChoices(TEXT)).toEqual({ kind: "text" });
  });

  it("parses a typed value by the gate's primitive", () => {
    expect(parseAccessInput(NUMBER, " 2 ")).toEqual({ ok: true, value: 2 });
    expect(parseAccessInput(NUMBER, "two")).toEqual({ ok: false, error: "Enter a number" });
    expect(parseAccessInput(NUMBER, "")).toEqual({ ok: false, error: "Enter a value first" });
    expect(parseAccessInput(TEXT, " staff ")).toEqual({ ok: true, value: "staff" });
    expect(parseAccessInput(TEXT, "x".repeat(201)).ok).toBe(false);
  });
});

describe("the inherit option names what it resolves to, and from where", () => {
  const folders = [
    folder("press", null, null, null, "Press"),
    folder("members", null, "members", "members", "Member downloads"),
    folder("reports", "members", null, "members", "Reports"),
    folder("opened", "members", "public", "public", "Open reports"),
  ];

  it("says Members, from Member downloads, for a file filed below a gated folder", () => {
    expect(inheritLabel("members", { name: "Member downloads" }, SELECT)).toBe(
      "Inherit (Members, from Member downloads)",
    );
    // A file in the nested "Reports" folder takes the value from its ancestor, and the
    // label names that ancestor rather than the folder the file is in.
    expect(assetInheritLabel({ folderId: "reports" }, folders, SELECT)).toBe(
      "Inherit (Members, from Member downloads)",
    );
    expect(assetInheritLabel({ folderId: "members" }, folders, SELECT)).toBe(
      "Inherit (Members, from Member downloads)",
    );
  });

  it("has no source for an unfiled file or a folder with no value above it", () => {
    expect(assetInheritLabel({ folderId: null }, folders, SELECT)).toBe("Inherit (Everyone)");
    expect(assetInheritLabel({ folderId: "press" }, folders, SELECT)).toBe("Inherit (Everyone)");
  });

  it("names an explicit public value as the source too", () => {
    expect(assetInheritLabel({ folderId: "opened" }, folders, SELECT)).toBe(
      "Inherit (Everyone, from Open reports)",
    );
  });

  it("labels a folder's inherit by its parent, not by itself", () => {
    expect(folderInheritLabel({ parentId: "members" }, folders, SELECT)).toBe(
      "Inherit (Members, from Member downloads)",
    );
    expect(folderInheritLabel({ parentId: null }, folders, SELECT)).toBe("Inherit (Everyone)");
    // A folder's own value is not what it inherits: "reports" has none, "members" does,
    // and the source of "reports"'s parent is "members" itself.
    expect(accessSource(folders, "reports")?.id).toBe("members");
    expect(accessSource(folders, null)).toBeNull();
  });

  it("does not hang on a parent loop in bad data", () => {
    const loop = [folder("a", "b", null, null), folder("b", "a", null, null)];
    expect(accessSource(loop, "a")).toBeNull();
  });

  it("summarises a file as set on it, inherited, or public", () => {
    const own = row("a", { access: "premium", effectiveAccess: "premium", folderId: "members" });
    expect(accessSummary(own, folders, SELECT)).toBe("Premium, set on this file");
    const inherited = row("b", { access: null, effectiveAccess: "members", folderId: "reports" });
    expect(accessSummary(inherited, folders, SELECT)).toBe(
      "Members, inherited from Member downloads",
    );
    expect(accessSummary(row("c", { access: null, effectiveAccess: null }), folders, SELECT)).toBe(
      "Everyone",
    );
  });

  it("files an upload in the open folder, and in none for a path it cannot find", () => {
    expect(folderIdForPath(folders, "members/reports")).toBe("reports");
    expect(folderIdForPath(folders, undefined)).toBeUndefined();
    expect(folderIdForPath(folders, "gone")).toBeUndefined();
  });
});

describe("the Gated filter", () => {
  it("round-trips the URL", () => {
    const parsed = parseAssetsUrl({ gated: "1" }, { view: "grid" });
    expect(parsed.gated).toBe(true);
    expect(assetsQuery(parsed).gated).toBe("1");
    // Off, it leaves the address bar rather than sitting in it.
    expect(assetsQuery(url()).gated).toBeUndefined();
    expect(parseAssetsUrl({ gated: "0" }, { view: "grid" }).gated).toBe(false);
  });

  it("is sent to the list route only when on", () => {
    expect(assetsParams(url({ gated: true }), { limit: 10 }).get("gated")).toBe("1");
    expect(assetsParams(url(), { limit: 10 }).has("gated")).toBe(false);
  });

  it("narrows the screen, is cleared by Clear filters, and combines with the others", () => {
    const narrowed = url({ gated: true });
    expect(isNarrowed(narrowed)).toBe(true);
    expect(withFilter(narrowed, NO_FILTERS).gated).toBe(false);
    // Exclusive with nothing: a folder or a tag does not clear it.
    expect(withFilter(narrowed, { folder: "members" }).gated).toBe(true);
    expect(withFilter(narrowed, { tags: ["logo"] }).gated).toBe(true);
  });

  it("rides in a select-all capture", () => {
    expect(capturedFilter(url({ gated: true })).gated).toBe(true);
    expect("gated" in capturedFilter(url())).toBe(false);
  });
});

describe("move confirmations count the files that change", () => {
  const rows = [
    row("gated1", { access: null, effectiveAccess: "members" }),
    row("gated2", { access: null, effectiveAccess: "members" }),
    row("owned", { access: "members", effectiveAccess: "members" }),
    row("open1", { access: null, effectiveAccess: null }),
    row("open2", { access: null, effectiveAccess: null }),
  ];

  it("counts gated to public against a public destination", () => {
    const impact = moveImpact(rows, picked("gated1", "gated2", "open1"), null, SELECT);
    expect(impact).toEqual({ toPublic: 2, toGated: 0, complete: true });
  });

  it("counts public to gated against a gated destination", () => {
    const impact = moveImpact(rows, picked("open1", "open2", "gated1"), "members", SELECT);
    expect(impact).toEqual({ toPublic: 0, toGated: 2, complete: true });
  });

  it("leaves a file with a value of its own where it is, wherever it goes", () => {
    expect(moveImpact(rows, picked("owned"), null, SELECT)).toEqual({
      toPublic: 0,
      toGated: 0,
      complete: true,
    });
    expect(moveImpact(rows, picked("owned"), "premium", SELECT).toGated).toBe(0);
  });

  it("counts both directions at once, and gated to gated as no change", () => {
    const impact = moveImpact(rows, picked("gated1", "open1"), "members", SELECT);
    expect(impact).toEqual({ toPublic: 0, toGated: 1, complete: true });
    const mixed = moveImpact(rows, picked("gated1", "open1"), "public", SELECT);
    expect(mixed).toEqual({ toPublic: 1, toGated: 0, complete: true });
  });

  it("counts a captured select-all from the rows in hand and says it is partial", () => {
    const all: Ticked = { all: true, filter: {}, expected: 40, exclude: new Set(["open2"]) };
    const impact = moveImpact(rows, all, null, SELECT);
    expect(impact.toPublic).toBe(2);
    expect(impact.complete).toBe(false);
  });

  it("is zero without the manifest's assetAccess", () => {
    expect(moveImpact(rows, picked("gated1"), null, undefined)).toEqual({
      toPublic: 0,
      toGated: 0,
      complete: true,
    });
  });

  it("words the counts, singular and plural, and says so when partial", () => {
    expect(moveImpactText({ toPublic: 0, toGated: 0, complete: true })).toBeNull();
    expect(moveImpactText({ toPublic: 1, toGated: 0, complete: true })).toBe(
      "1 file will change from gated to public.",
    );
    expect(moveImpactText({ toPublic: 2, toGated: 3, complete: true })).toBe(
      "2 files will change from gated to public, and 3 files will change from public to gated.",
    );
    expect(moveImpactText({ toPublic: 2, toGated: 0, complete: false })).toBe(
      "Of the files shown here, 2 files will change from gated to public. Files not shown on this page are not counted.",
    );
  });
});

describe("decoding what the access routes answer", () => {
  it("reads the pending-purge answer, and an unreadable one as nothing owed", () => {
    expect(decodePurges({ pending: 4, oldest: 99 })).toEqual({ pending: 4, oldest: 99 });
    expect(decodePurges({ pending: 0, oldest: 99 })).toEqual({ pending: 0, oldest: null });
    expect(decodePurges({ pending: "4" })).toEqual({ pending: 0, oldest: null });
    expect(decodePurges({ pending: -2 })).toEqual({ pending: 0, oldest: null });
    expect(decodePurges(null)).toEqual({ pending: 0, oldest: null });
    expect(decodePurges("nope")).toEqual({ pending: 0, oldest: null });
  });

  it("shows the notice while the count is non-zero and not otherwise", () => {
    expect(purgeNotice({ pending: 0, oldest: null })).toBeNull();
    expect(purgeNotice({ pending: 1, oldest: 1 })).toBe(
      "1 file may still be served from the edge cache; Folio is retrying.",
    );
    expect(purgeNotice({ pending: 1200, oldest: 1 })).toBe(
      "1,200 files may still be served from the edge cache; Folio is retrying.",
    );
  });

  it("reads the gated-keys map and drops anything that is not a value", () => {
    expect(decodeAccessMap({ "a.png": "members", "b.png": 2, "c.png": null })).toEqual({
      "a.png": "members",
      "b.png": 2,
    });
    expect(decodeAccessMap([])).toEqual({});
    expect(decodeAccessMap(null)).toEqual({});
    expect(decodeAccessMap("members")).toEqual({});
  });

  it("asks for each key once, repeated, and never past the route's cap", () => {
    const params = accessKeysQuery(["a.png", "b.png", "a.png"]);
    expect(params.getAll("key")).toEqual(["a.png", "b.png"]);
    const many = Array.from({ length: MAX_ACCESS_KEYS + 25 }, (_, i) => `k${i}.png`);
    expect(accessKeysQuery(many).getAll("key")).toHaveLength(MAX_ACCESS_KEYS);
    expect(accessKeysQuery([]).toString()).toBe("");
  });
});

describe("the inspector's lock and warning (decision 14)", () => {
  const gated = { "hero.png": "members", "report.pdf": "members", "open.png": "public" };
  const image = { key: "hero.png", filename: "hero.png", contentType: "image/png", alt: "" };
  const pdf = {
    key: "report.pdf",
    filename: "report.pdf",
    contentType: "application/pdf",
    alt: "",
  };

  it("warns for a gated image on a public page", () => {
    expect(assetLock(image as never, gated, SELECT, true)).toEqual({
      label: "Members",
      warning: "Members: most visitors will see a broken image",
    });
  });

  it("locks without warning on a gated page, and for a file that is not an image", () => {
    expect(assetLock(image as never, gated, SELECT, false)).toEqual({
      label: "Members",
      warning: null,
    });
    expect(assetLock(pdf as never, gated, SELECT, true)).toEqual({
      label: "Members",
      warning: null,
    });
  });

  it("draws nothing for a file the route did not list, or whose value is public", () => {
    const other = { ...image, key: "other.png" };
    expect(assetLock(other as never, gated, SELECT, true)).toBeNull();
    expect(assetLock({ ...image, key: "open.png" } as never, gated, SELECT, true)).toBeNull();
    // An external url has no key and so no library row.
    expect(
      assetLock({ filename: "x.png", url: "https://x/x.png" } as never, gated, SELECT, true),
    ).toBeNull();
  });

  describe("which pages are public", () => {
    const schema = {
      pageRoot: { name: "pageRoot", label: "Page", fields: { access: { kind: "select" } } },
      plainRoot: { name: "plainRoot", label: "Plain", fields: { title: { kind: "text" } } },
    } as unknown as SchemaIndex;
    const doc = (type: string, data: Record<string, unknown>): Doc =>
      ({
        root: "r",
        bloks: { r: { uid: "r", type, data, slots: {} } },
      }) as unknown as Doc;

    it("is public when the root holds the public value or does not declare the field", () => {
      expect(isPublicPage(doc("pageRoot", { access: "public" }), schema, SELECT)).toBe(true);
      expect(isPublicPage(doc("plainRoot", {}), schema, SELECT)).toBe(true);
    });

    it("is not public when gated, and a declared field with no value fails closed", () => {
      expect(isPublicPage(doc("pageRoot", { access: "members" }), schema, SELECT)).toBe(false);
      expect(isPublicPage(doc("pageRoot", {}), schema, SELECT)).toBe(false);
    });

    it("is never public without the manifest's assetAccess, or without a document", () => {
      expect(isPublicPage(doc("plainRoot", {}), schema, undefined)).toBe(false);
      expect(isPublicPage(null, schema, SELECT)).toBe(false);
    });
  });
});
