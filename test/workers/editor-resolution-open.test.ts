import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { defineBlock, text } from "../../src/core";
import type { Doc } from "../../src/core/doc";
import type { Resolution } from "../../src/core/resolve";
import type { FolioBindings } from "../../src/server";
import { createFolio } from "../../src/server";

/**
 * `?site=` under `auth: 'open'` on a deployment with `sites` (#77). There is no caller
 * to ask `mayPreviewDrafts` about and every route is open, so the named site must be
 * honoured, as the other call sites of that rule do (`rt.auth.mode === "session"`).
 * The pane's fetch 404ing here would leave the preview on its bootstrap for good.
 */

const page = defineBlock({
  name: "eroPage",
  label: "Page",
  fields: { title: text() },
  render: () => null,
});

const folio = createFolio<Cloudflare.Env>({
  blocks: [page],
  types: [{ name: "eroPage", label: "Page", kind: "page", root: "eroPage", default: true }],
  bindings: (e): FolioBindings => ({ db: e.DB, story: e.STORY, media: e.MEDIA, images: e.IMAGES }),
  basePath: "/folio",
  assets: { admin: "/folio-admin.js", preview: "/folio-preview.js" },
  auth: "open",
  route: (p) => (p ? `/${p}` : "/"),
  sites: { admin: "https://cms.example" },
});

describe("resolution with sites and open auth", () => {
  it("honours ?site= with no caller to authorise", async () => {
    await env.DB.prepare(
      `insert into sites (id, kind, name, group_id, status, preview_origin, created_at, updated_at)
       values ('eroalpha', 'site', 'Alpha', null, 'live', 'https://preview.eroalpha.example', 0, 0)`,
    ).run();
    await env.DB.prepare(
      `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id)
       values ('sty_ero_a', 'eroPage', null, 'a', 'a', 'a0', 'A', 1, 'eroalpha')`,
    ).run();
    const doc: Doc = {
      root: "r0",
      bloks: {
        r0: {
          uid: "r0",
          type: "eroPage",
          parent: null,
          slot: null,
          order: "a0",
          data: { title: "A" },
        },
      },
    };
    await runInDurableObject(env.STORY.get(env.STORY.idFromName("sty_ero_a")), (i) =>
      i.getOrInit(doc),
    );
    const res = await folio.handle(
      new Request(
        "https://cms.example/folio/~eroalpha/api/story/sty_ero_a/resolution?site=eroalpha",
      ),
      env,
      createExecutionContext(),
    );
    expect(res?.status).toBe(200);
    expect(((await res!.json()) as Resolution).site?.id).toBe("eroalpha");
  });
});
