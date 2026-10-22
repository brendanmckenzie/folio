import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { defineBlock, form, multilink, reference, text } from "../../src/core";
import type { Doc, Json } from "../../src/core/doc";
import type { Resolution } from "../../src/core/resolve";
import type { DocumentType } from "../../src/core/schema";
import type { FolioBindings } from "../../src/server";
import { createFolio } from "../../src/server";

/**
 * `GET {base}/api/story/:id/resolution` (#77): the resolution the editor's preview is
 * given, built by the same `brand.resolve` the server's own preview page bootstraps
 * from. The admin used to assemble a lesser copy by hand and post it over the
 * server's on every `ready`, so everything it did not assemble vanished on the first
 * frame: a link inside a referenced card (pass three), the breadcrumb's ancestors, a
 * form inside a referenced card.
 *
 * Asserted against the **bootstrap in the preview HTML** rather than against a
 * hand-written expectation, because "the two agree" is the whole claim: a second
 * assembly that happens to be right today is the bug's own shape.
 */

const ORIGIN = "https://folio.test";

const erPage = defineBlock({
  name: "erPage",
  label: "Page",
  summary: "title",
  fields: {
    title: text({ required: true }),
    link: multilink(),
    ref: reference(),
    signup: form(),
  },
  render: () => null,
});

const pageType: DocumentType = {
  name: "erPageType",
  label: "Page",
  kind: "page",
  root: "erPage",
  default: true,
};

const folio = createFolio<Cloudflare.Env>({
  blocks: [erPage],
  types: [pageType],
  bindings: (e): FolioBindings => ({ db: e.DB, story: e.STORY, media: e.MEDIA, images: e.IMAGES }),
  basePath: "/folio",
  assets: { admin: "/folio-admin.js", preview: "/folio-preview.js" },
  auth: "open",
  route: (p) => (p ? `/${p}` : "/"),
});

const call = (path: string): Promise<Response | null> =>
  folio.handle(new Request(`${ORIGIN}${path}`), env, createExecutionContext());

const docOf = (uid: string, data: Record<string, Json>): Doc => ({
  root: uid,
  bloks: { [uid]: { uid, type: "erPage", parent: null, slot: null, order: "a0", data } },
});

async function seed(
  id: string,
  path: string,
  parent: string | null,
  title: string,
  doc: Doc,
): Promise<void> {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at)
     values (?, 'erPageType', ?, ?, ?, 'a0', ?, ?, ?)`,
  )
    .bind(id, parent, path.split("/").pop(), path, title, Date.now(), Date.now())
    .run();
  const stub = env.STORY.get(env.STORY.idFromName(id));
  await runInDurableObject(stub, (instance) => instance.getOrInit(doc));
}

/** The resolution a preview page embeds for itself, out of the HTML. */
function bootstrapResolution(html: string): Resolution {
  const match = html.match(/window\.__FOLIO__=([\s\S]*?)<\/script>/);
  expect(match, "no __FOLIO__ bootstrap in the preview").not.toBeNull();
  return (JSON.parse(match![1]!) as { resolution: Resolution }).resolution;
}

const FORM = "frm_erres0000001";

/**
 * parent `erp` > child `erp/erc`. The child references `err`, whose card links to
 * `ert` (a link only pass three reaches) and embeds a form (which only the nested
 * form read reaches).
 */
async function fixture() {
  await env.DB.prepare(
    `insert into forms (id, name, label, fields, version, open, created_at, updated_at)
     values (?, 'er-signup', 'Signup', '[]', 1, 1, ?, ?)`,
  )
    .bind(FORM, Date.now(), Date.now())
    .run();
  await seed("sty_erp", "erp", null, "Parent", docOf("p0", { title: "Parent" }));
  await seed("sty_ert", "ert", null, "Third", docOf("t0", { title: "Third" }));
  await seed(
    "sty_err",
    "err",
    null,
    "Referenced",
    docOf("r0", { title: "Referenced", link: { kind: "story", id: "sty_ert" }, signup: FORM }),
  );
  await seed(
    "sty_erc",
    "erp/erc",
    "sty_erp",
    "Child",
    docOf("c0", { title: "Child", ref: "sty_err" }),
  );
}

describe("GET /api/story/:id/resolution", () => {
  it("answers what the server's own preview bootstraps, pass three and all", async () => {
    await fixture();
    const res = await call("/folio/api/story/sty_erc/resolution");
    expect(res?.status).toBe(200);
    expect(res?.headers.get("cache-control")).toBe("private, no-store");
    const served = (await res!.json()) as Resolution;

    // What the hand-built copy lacked, named so a failure says which one went.
    expect(Object.keys(served.stories)).toContain("sty_ert"); // pass three: a link inside a referenced doc
    expect(Object.keys(served.stories)).toContain("sty_erp"); // the breadcrumb's ancestor
    expect(Object.keys(served.docs ?? {})).toContain("sty_err");
    expect(Object.keys(served.forms ?? {})).toContain(FORM); // a form inside a referenced doc

    const page = await call("/erp/erc?_folio=preview");
    expect(page?.status).toBe(200);
    expect(served).toEqual(bootstrapResolution(await page!.text()));
  });

  it("is a 404 for a story that does not exist, before anything is read for it", async () => {
    const res = await call("/folio/api/story/sty_ernone/resolution");
    expect(res?.status).toBe(404);
  });

  it("refuses a locale the site never declared", async () => {
    await seed("sty_erl", "erl", null, "Lonely", docOf("l0", { title: "Lonely" }));
    const res = await call("/folio/api/story/sty_erl/resolution?locale=zz");
    expect(res?.status).toBe(501);
  });
});
