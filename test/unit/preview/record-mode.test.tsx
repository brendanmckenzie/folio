// @vitest-environment happy-dom
import { act } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineBlock, reference, text, toRegistry } from "../../../src/core";
import type { Doc } from "../../../src/core/doc";
import { recordResolution } from "../../../src/core/resolution-merge";
import { type Resolution, resolveReference } from "../../../src/core/resolve";
import { mountPreview } from "../../../src/preview/mount";
import { FolioDoc } from "../../../src/preview/Render";

/**
 * A record previewed in the context of a host page (`previewPath` on a record type):
 * the page is drawn, the record rides in `resolution.docs[id]`, and the bundle has to
 * hydrate what the server drew and then keep both the page's content and the record's
 * edits across every frame.
 */

const hostPage = defineBlock({
  name: "hostPage",
  label: "Host page",
  fields: { heading: text() },
  // The host's block: draws the record from the resolution, as the docs say to.
  render: ({ heading }, resolution) => {
    const rec = resolveReference(resolution.record, resolution);
    return (
      <main>
        <h1>{heading}</h1>
        <p data-testid="record">{rec ? String(rec.data.name ?? "") : "no record"}</p>
        <p data-testid="title">{resolution.stories[resolution.record ?? ""]?.title ?? "no ref"}</p>
        <p data-testid="link">{resolution.stories.pal?.title ?? "no link"}</p>
      </main>
    );
  },
});
const person = defineBlock({
  name: "person",
  label: "Person",
  fields: { name: text(), friend: reference({ types: ["person"] }) },
  render: () => null,
});

const blok = (uid: string, type: string, data: Record<string, string>): Doc => ({
  root: uid,
  bloks: { [uid]: { uid, type, parent: null, slot: null, order: "a0", data } },
});
const pageDoc = blok("p0000001", "hostPage", { heading: "Authors" });
const recordDoc = blok("r0000001", "person", { name: "Ada" });

const pageResolution: Resolution = {
  assetBase: "/folio/asset",
  stories: {
    pal: { id: "pal", path: "pal", url: "/pal", title: "Pal page", type: "x", routable: true },
  },
};
const recordOwn: Resolution = {
  assetBase: "/folio/asset",
  stories: {
    rec: { id: "rec", path: "", url: "", title: "Ada", type: "person", routable: false },
  },
};

const registry = toRegistry([hostPage, person]);

/** What the server sends: the page rendered around the merged resolution. */
function serve(resolution: Resolution) {
  const html = renderToString(
    <FolioDoc doc={pageDoc} registry={registry} mode="off" resolution={resolution} />,
  );
  document.body.innerHTML = `<div id="folio-root">${html}</div>`;
  window.__FOLIO__ = {
    doc: recordDoc,
    resolution,
    editing: { record: "rec", page: pageDoc },
  };
}

function frame(data: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: "folio-admin", ...data },
        origin: window.location.origin,
        source: window.parent,
      }),
    );
  });
}

const text$ = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent;

async function boot(resolution: Resolution) {
  serve(resolution);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () => mountPreview([hostPage, person]));
  return errors;
}

afterEach(() => {
  vi.restoreAllMocks();
  window.__FOLIO__ = undefined;
  document.body.innerHTML = "";
});

/**
 * `previewRoot`: the page is a blank instance of a block, minted by the server per
 * request (hex uids, every field at its default) and carried in `editing.page`, so
 * the client hydrates it without ever building it.
 */
describe("a record previewed in a synthetic root", () => {
  it("hydrates a one-blok synthetic page without a mismatch", async () => {
    const recordFrame = defineBlock({
      name: "recordFrame",
      label: "Frame",
      fields: { caption: text({ default: "Caption" }) },
      render: ({ caption }, resolution) => {
        const rec = resolveReference(resolution.record, resolution);
        return (
          <main>
            <h1>{caption}</h1>
            <p data-testid="record">{rec ? String(rec.data.name ?? "") : "no record"}</p>
          </main>
        );
      },
    });
    const syntheticPage = blok("96cf6e93227e7bb5", "recordFrame", { caption: "Caption" });
    const merged = recordResolution(
      { assetBase: "/folio/asset", stories: {} },
      recordOwn,
      "rec",
      recordDoc,
    );
    const html = renderToString(
      <FolioDoc
        doc={syntheticPage}
        registry={toRegistry([recordFrame, person])}
        mode="off"
        resolution={merged}
      />,
    );
    document.body.innerHTML = `<div id="folio-root">${html}</div>`;
    window.__FOLIO__ = {
      doc: recordDoc,
      resolution: merged,
      editing: { record: "rec", page: syntheticPage },
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = document.getElementById("folio-root")?.innerHTML;
    expect(before).toContain("Caption");
    await act(async () => mountPreview([recordFrame, person]));
    expect(errors).not.toHaveBeenCalled();
    expect(document.getElementById("folio-root")?.innerHTML).toBe(before);

    frame({
      type: "apply",
      mutations: [{ t: "set", uid: "r0000001", field: "name", value: "Grace" }],
    });
    expect(text$("record")).toBe("Grace");
  });
});

describe("a record previewed in context", () => {
  it("hydrates the server's markup without a mismatch", async () => {
    const merged = recordResolution(pageResolution, recordOwn, "rec", recordDoc);
    serve(merged);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = document.getElementById("folio-root")?.innerHTML;
    expect(before).toContain("Ada");
    await act(async () => mountPreview([hostPage, person]));
    expect(errors).not.toHaveBeenCalled();
    expect(document.getElementById("folio-root")?.innerHTML).toBe(before);
  });

  it("updates the record per keystroke and leaves the page's own content alone", async () => {
    await boot(recordResolution(pageResolution, recordOwn, "rec", recordDoc));
    expect(text$("record")).toBe("Ada");

    frame({
      type: "apply",
      mutations: [{ t: "set", uid: "r0000001", field: "name", value: "Ada Lovelace" }],
    });
    expect(text$("record")).toBe("Ada Lovelace");
    expect(text$("link")).toBe("Pal page");
  });

  it("merges a posted resolution over the page's and never in place of it", async () => {
    await boot(recordResolution(pageResolution, recordOwn, "rec", recordDoc));

    // The admin posts the *record's* resolution, which knows nothing of the page's link.
    frame({ type: "resolve", resolution: { ...recordOwn, stories: {} } });
    expect(text$("link")).toBe("Pal page");
    expect(text$("record")).toBe("Ada");

    // `replace` swaps the record's document, not the page.
    frame({ type: "replace", doc: blok("r0000001", "person", { name: "Grace" }) });
    expect(text$("record")).toBe("Grace");
    expect(text$("link")).toBe("Pal page");
  });

  it("shows a rename of the open record, which the admin posts as the record's own ref", async () => {
    await boot(recordResolution(pageResolution, recordOwn, "rec", recordDoc));
    expect(text$("title")).toBe("Ada");
    frame({
      type: "resolve",
      resolution: {
        ...recordOwn,
        stories: {
          rec: { id: "rec", path: "", url: "", title: "Renamed", type: "person", routable: false },
        },
      },
    });
    expect(text$("title")).toBe("Renamed");
    expect(text$("link")).toBe("Pal page");
  });
});
