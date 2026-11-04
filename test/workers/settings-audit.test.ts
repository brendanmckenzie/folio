import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { defineBlock, richtext, text, toRegistry, toSchemaIndex } from "../../src/core";
import type { Doc, Json } from "../../src/core/doc";
import type { Registry } from "../../src/core/sites";
import { auditSettings } from "../../src/server/audit";

/**
 * `required-setting` and the one blank rule (`docs/specs/content-model/authoring-guidance.md`
 * decision 15; review finding 4), over real D1.
 *
 * A richtext whose only node is an image or an embed holds no text, and is still
 * content: Folio's editor cannot make one, but an importer (a Storyblok `image` or
 * `blok` node) can, and reporting it as an empty required setting would be wrong.
 * Rows are written straight into `published_doc`, as an importer's write lands.
 */

const settingsRoot = defineBlock({
  name: "saSettingsRoot",
  label: "Settings",
  fields: {
    siteName: text({ label: "Site name" }),
    footer: richtext({ label: "Footer", required: true }),
  },
  render: () => null,
});

const schema = toSchemaIndex(toRegistry([settingsRoot]));
const types = [
  { name: "saSettings", label: "Settings", kind: "singleton" as const, root: "saSettingsRoot" },
];
const site = (id: string) =>
  ({ id, name: id, group: null, status: "live", hosts: [], preview: null }) as never;
const registry: Registry = {
  sites: [site("sa-image"), site("sa-empty"), site("sa-text")],
  groups: [],
  shared: false,
};

const settingsDoc = (footer: Json): Doc => ({
  root: "r",
  bloks: {
    r: {
      uid: "r",
      type: "saSettingsRoot",
      parent: null,
      slot: null,
      order: "a0",
      data: { footer },
    },
  },
});

async function layer(scope: string, footer: Json) {
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, updated_at, site_id,
                          published_doc, published_at)
     values (?, 'saSettings', null, ?, null, 'a0', 'Settings', 1, ?, ?, 2)`,
  )
    .bind(`sng_saSettings:${scope}`, `sa-${scope}`, scope, JSON.stringify(settingsDoc(footer)))
    .run();
}

describe("required-setting over a required richtext", () => {
  it("counts an image-only or embed-only document as filled, and an empty one as empty", async () => {
    await layer("sa-image", {
      type: "doc",
      content: [
        { type: "image", attrs: { src: "https://cdn.example/logo.png", alt: "Logo" } },
        { type: "blok", attrs: { body: [{ component: "embed" }] } },
      ],
    } as unknown as Json);
    await layer("sa-empty", { type: "doc", content: [{ type: "paragraph" }] } as unknown as Json);
    await layer("sa-text", {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "© 2026" }] }],
    } as unknown as Json);

    const findings = await auditSettings(
      env.DB,
      schema,
      { settings: "saSettings", registry },
      types,
    );
    expect(findings.filter((f) => f.field === "footer").map((f) => f.site)).toEqual(["sa-empty"]);
  });
});
