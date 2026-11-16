/**
 * **Visitor access to files, mounted** (`docs/specs/platform/asset-access.md`, phase 7).
 *
 * The line this file holds is the first acceptance criterion of the feature: a
 * deployment whose brand has no `allowsAsset` has a manifest with no `assetAccess`, and
 * then the Assets screen draws **no** access UI and makes **no** access request. The
 * second half proves the same screen draws all of it when the manifest carries the key,
 * so the first half is not true of a component that never learned to draw it.
 *
 * What each piece decides (labels, counts, the filter) is `asset-access-model.test.ts`'s;
 * what is asserted here is only what a Node test cannot reach: that the markup is there,
 * or is not, and which requests were made.
 */
import { render, screen, within } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Manifest, ManifestAssetAccess } from "../../../../src/core/schema";
import type { AssetValue } from "../../../../src/core/values";
import { AssetDetail } from "../../../../src/admin/ui/screens/AssetDetail";
import { AssetField } from "../../../../src/admin/ui/screens/fields/AssetField";
import { API, MANIFEST, MOUNT, mountAt, resetServed, serve, stubFetch } from "./fixture";

afterEach(resetServed);

const ACCESS: ManifestAssetAccess = {
  field: "access",
  public: "public",
  options: [
    { value: "public", label: "Public" },
    { value: "members", label: "Members" },
  ],
};

const GATING: Manifest = { ...MANIFEST, assetAccess: ACCESS };

const row = (id: string, filename: string, extra: Record<string, unknown> = {}) => ({
  id,
  key: `key-${id}.png`,
  filename,
  contentType: "image/png",
  size: 1024,
  width: 10,
  height: 10,
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

/** The library as a deployment with `allowsAsset` answers it, and as one without does. */
const GATED_ROWS = [
  row("ast_open", "open.png", { access: null, effectiveAccess: null }),
  row("ast_locked", "locked.png", { access: "members", effectiveAccess: "members" }),
];
const PLAIN_ROWS = [row("ast_open", "open.png"), row("ast_locked", "locked.png")];

const asked = (urls: string[], fragment: string) => urls.some((u) => u.includes(fragment));

describe("a deployment that does not gate files", () => {
  it("draws no access UI on the library, in either view", async () => {
    serve({ assetRows: PLAIN_ROWS });
    for (const path of ["/folio/assets", "/folio/assets?view=table"]) {
      const { unmount } = await mountAt(path);
      await screen.findByText("open.png");
      // Nothing is gated, so no lock; and none of the controls exist.
      expect(screen.queryByRole("img", { name: /Gated/ })).toBeNull();
      expect(screen.queryByRole("button", { name: "Gated" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Set access" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Clear cached files" })).toBeNull();
      expect(screen.queryByText(/edge cache/)).toBeNull();
      // The bulk bar is still there: it is the access control that is absent, not the bar.
      expect(screen.getByRole("button", { name: "Move" })).not.toBeNull();
      unmount();
    }
  });

  it("makes no request that only a gating deployment answers", async () => {
    serve({ assetRows: PLAIN_ROWS });
    const first = await mountAt("/folio/assets");
    await screen.findByText("open.png");
    expect(asked(first.asked, `${API}/assets/purges`)).toBe(false);
    expect(asked(first.asked, `${API}/assets/access`)).toBe(false);
    first.unmount();
    // And `?gated=1` in a hand-written link is read as the plain list, not sent to a
    // route that would answer `unsupported`.
    resetServed();
    serve({ assetRows: PLAIN_ROWS });
    const again = await mountAt("/folio/assets?gated=1");
    await screen.findByText("open.png");
    expect(again.asked.some((u) => u.includes("gated=1"))).toBe(false);
  });

  it("an asset field draws no lock and asks for none", async () => {
    const value = { key: "key-ast_locked.png", filename: "locked.png", contentType: "image/png" };
    render(
      <AssetField
        id="hero"
        value={value as never}
        apiBase={API}
        mount="/folio"
        editable
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("locked.png")).not.toBeNull();
    expect(screen.queryByText(/broken image/)).toBeNull();
    expect(screen.queryByTitle(/Gated/)).toBeNull();
  });
});

describe("a deployment that gates files", () => {
  const withManifest = () =>
    serve({
      schemaAt: () => GATING,
      assetRows: GATED_ROWS,
      assetFolders: [],
      purges: { pending: 0, oldest: null },
    });

  it("draws the lock on a gated tile only, the Gated filter and Set access", async () => {
    withManifest();
    await mountAt("/folio/assets");
    await screen.findByText("locked.png");
    const locks = screen.getAllByRole("img", { name: /Gated/ });
    expect(locks.map((el) => el.getAttribute("aria-label"))).toEqual(["Gated: Members"]);
    // The lock sits on the gated file's tile, not the open one's.
    const tile = screen.getByText("locked.png").closest("[data-tile]") as HTMLElement;
    expect(within(tile).getByRole("img", { name: "Gated: Members" })).not.toBeNull();
    const open = screen.getByText("open.png").closest("[data-tile]") as HTMLElement;
    expect(within(open).queryByRole("img", { name: /Gated/ })).toBeNull();

    expect(screen.getByRole("button", { name: "Gated" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(screen.getByRole("button", { name: "Set access" })).not.toBeNull();
  });

  it("draws the lock in the table view too", async () => {
    withManifest();
    await mountAt("/folio/assets?view=table");
    await screen.findByText("locked.png");
    expect(screen.getAllByRole("img", { name: "Gated: Members" })).toHaveLength(1);
  });

  it("filters by gated through the route", async () => {
    withManifest();
    const { asked: urls } = await mountAt("/folio/assets?gated=1");
    await screen.findByText("locked.png");
    expect(screen.getByRole("button", { name: "Gated" }).getAttribute("aria-pressed")).toBe("true");
    expect(urls.some((u) => u.includes(`${API}/assets?`) && u.includes("gated=1"))).toBe(true);
  });

  it("shows the pending-purge notice only while the count is non-zero", async () => {
    serve({
      schemaAt: () => GATING,
      assetRows: GATED_ROWS,
      assetFolders: [],
      purges: { pending: 3, oldest: 1 },
    });
    const { asked: urls } = await mountAt("/folio/assets");
    await screen.findByText("locked.png");
    expect(asked(urls, `${API}/assets/purges`)).toBe(true);
    expect(
      screen.getByText("3 files may still be served from the edge cache; Folio is retrying."),
    ).not.toBeNull();
  });

  it("offers Clear cached files to an administrator", async () => {
    withManifest();
    await mountAt("/folio/assets");
    await screen.findByText("locked.png");
    expect(screen.getByRole("button", { name: "Clear cached files" })).not.toBeNull();
  });

  it("an asset field draws the lock, and the warning only for an image on a public page", async () => {
    const value = { key: "key-ast_locked.png", filename: "locked.png", contentType: "image/png" };
    const locks = (publicPage: boolean) => ({
      gated: { "key-ast_locked.png": "members" },
      config: ACCESS,
      publicPage,
    });
    const field = (publicPage: boolean) => (
      <AssetField
        id="hero"
        value={value as never}
        apiBase={API}
        mount="/folio"
        editable
        onChange={() => {}}
        locks={locks(publicPage)}
      />
    );
    const { rerender } = render(field(true));
    expect(screen.getByTitle("Gated: Members")).not.toBeNull();
    expect(screen.getByText("Members: most visitors will see a broken image")).not.toBeNull();
    await act(async () => {
      rerender(field(false));
    });
    expect(screen.getByTitle("Gated: Members")).not.toBeNull();
    expect(screen.queryByText(/broken image/)).toBeNull();
  });

  it("a non-image in an asset field is a download offer, so it gets a lock and no warning", () => {
    const value: AssetValue = {
      key: "key-ast_locked.pdf",
      filename: "report.pdf",
      contentType: "application/pdf",
      alt: "",
    } as AssetValue;
    render(
      <AssetField
        id="hero"
        value={value as never}
        apiBase={API}
        mount="/folio"
        editable
        onChange={() => {}}
        locks={{ gated: { "key-ast_locked.pdf": "members" }, config: ACCESS, publicPage: true }}
      />,
    );
    expect(screen.getByTitle("Gated: Members")).not.toBeNull();
    expect(screen.queryByText(/broken image/)).toBeNull();
  });
});

describe("the detail panel's folder help", () => {
  const mountDetail = async (assetAccess?: ManifestAssetAccess) => {
    stubFetch();
    const view = render(
      <AssetDetail
        apiBase={API}
        mount={MOUNT}
        row={row("ast_one", "one.png", { access: null, effectiveAccess: null }) as never}
        onClose={() => {}}
        onDelete={() => {}}
        onChanged={() => {}}
        onNotice={() => {}}
        mayWrite
        {...(assetAccess ? { assetAccess } : {})}
      />,
    );
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    return view;
  };

  it("says only that filing is metadata when files are not gated", async () => {
    await mountDetail();
    expect(screen.getByText(/Filing this never changes its URL/)).not.toBeNull();
    expect(screen.queryByText(/decision 1/)).toBeNull();
    expect(screen.queryByText(/follows its folder/)).toBeNull();
  });

  it("adds that access follows the folder when files are gated", async () => {
    await mountDetail(ACCESS);
    expect(
      screen.getByText(/Its access follows its folder unless you set it on the file/),
    ).not.toBeNull();
    expect(screen.queryByText(/decision 1/)).toBeNull();
  });
});
