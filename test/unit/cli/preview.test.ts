import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { lib } from "./load";

type Preview = {
  documentId: string;
  url: string | null;
  image: string | null;
  html: string | null;
  kept: boolean;
};
const { previewBlock, PreviewError, sampleFields } = await lib<{
  previewBlock: (opts: Record<string, unknown>) => Promise<Preview>;
  PreviewError: new (...a: unknown[]) => Error & { fix: { text?: string }[] };
  sampleFields: (block: unknown) => Record<string, unknown>;
}>("preview");

const dir = mkdtempSync(path.join(tmpdir(), "folio-preview-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const manifest = (withHero = true) => ({
  types: [
    { name: "settings", kind: "singleton", root: "settings" },
    { name: "page", kind: "page", root: "page" },
  ],
  blocks: [
    { name: "settings", label: "Settings", fields: {} },
    {
      name: "page",
      label: "Page",
      fields: {
        title: { kind: "text", label: "Title" },
        body: { kind: "blocks", label: "Body", allow: withHero ? ["hero", "prose"] : ["prose"] },
      },
    },
    ...(withHero
      ? [
          {
            name: "hero",
            label: "Hero",
            fields: {
              heading: { kind: "text", label: "Heading" },
              sub: { kind: "textarea", label: "Subheading" },
              tone: { kind: "select", label: "Tone" },
            },
          },
        ]
      : []),
  ],
});

/** A fake Folio: records each request, answers like the v1 routes and MCP do. */
function server(
  opts: { schemaAfter?: number; existing?: boolean; image?: boolean; schemaStatus?: number } = {},
) {
  const calls: { method: string; url: string; body: unknown; auth: string | null }[] = [];
  let schemaReads = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fakeFetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url, body, auth: new Headers(init.headers).get("authorization") });
    const p = new URL(url).pathname + new URL(url).search;
    if (p.endsWith("/api/v1/schema")) {
      if (opts.schemaStatus) {
        return json(
          { error: { code: "site_required", message: "Name the site" } },
          opts.schemaStatus,
        );
      }
      schemaReads++;
      return json(manifest(schemaReads > (opts.schemaAfter ?? 0)));
    }
    if (p.includes("/api/v1/search")) {
      return json({
        rows: opts.existing ? [{ id: "sty_old", path: "folio-scratch-hero" }] : [],
        cursor: null,
      });
    }
    if (method === "GET" && p.includes("/api/v1/documents/sty_old")) {
      return json({ id: "sty_old", content: { uid: "root-uid", type: "page", fields: {} } });
    }
    if (method === "PUT") return json({ changed: 1, transactions: 1, syncId: 2 });
    if (method === "POST" && p.endsWith("/api/v1/documents")) return json({ id: "sty_new" }, 201);
    if (method === "DELETE") return json({ deleted: [p.split("/").at(-1)?.split("?")[0]] });
    if (p.endsWith("/mcp")) {
      const content = opts.image
        ? [{ type: "image", data: Buffer.from("png!").toString("base64"), mimeType: "image/png" }]
        : [
            {
              type: "text",
              text: "No `browser` binding is configured.\n\nURL: http://localhost:1/folio-scratch-hero?_folio=draft",
            },
            { type: "text", text: '<section class="hero"><h1>Heading</h1></section>' },
          ];
      return json({ jsonrpc: "2.0", id: body.id, result: { content } });
    }
    return json({ error: { code: "not_found" } }, 404);
  }) as typeof globalThis.fetch;
  return { fetch: fakeFetch, calls };
}

const run = (fake: ReturnType<typeof server>, extra: Record<string, unknown> = {}) =>
  previewBlock({
    url: "http://localhost:1",
    token: "tok",
    name: "hero",
    fetch: fake.fetch,
    sleep: async () => {},
    dir,
    ...extra,
  });

describe("preview block", () => {
  it("creates one scratch draft, previews it through MCP, saves the HTML and deletes the draft", async () => {
    const fake = server();
    const got = await run(fake);
    expect(got).toMatchObject({ documentId: "sty_new", kept: false, image: null });
    expect(got.url).toBe("http://localhost:1/folio-scratch-hero?_folio=draft");
    expect(readFileSync(got.html as string, "utf8")).toContain('<section class="hero">');
    const create = fake.calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/api/v1/documents"),
    );
    expect(create?.body).toEqual({
      type: "page",
      title: "Scratch: Hero",
      slug: "folio-scratch-hero",
      content: {
        fields: { body: [{ type: "hero", fields: { heading: "Heading", sub: "Subheading" } }] },
      },
    });
    const mcp = fake.calls.find((c) => c.url.endsWith("/folio/mcp"));
    expect(mcp?.body).toMatchObject({
      method: "tools/call",
      params: { name: "preview_document", arguments: { id: "sty_new" } },
    });
    expect(fake.calls.at(-1)).toMatchObject({
      method: "DELETE",
      url: "http://localhost:1/folio/api/v1/documents/sty_new?redirect=false",
    });
    for (const c of fake.calls) expect(c.auth).toBe("Bearer tok");
  });

  it("keeps the draft with --keep, and saves a PNG when the server has a browser", async () => {
    const fake = server({ image: true });
    const got = await run(fake, { keep: true });
    expect(got.kept).toBe(true);
    expect(readFileSync(got.image as string, "utf8")).toBe("png!");
    expect(fake.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("replaces the content of a kept scratch draft rather than making a second", async () => {
    const fake = server({ existing: true });
    await run(fake);
    expect(fake.calls.some((c) => c.method === "POST" && c.url.endsWith("/documents"))).toBe(false);
    const put = fake.calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("/documents/sty_old/content");
    expect(put?.body).toMatchObject({
      content: { uid: "root-uid", fields: { body: [{ type: "hero" }] } },
    });
  });

  it("waits for the dev server to reload the block, and gives up after the timeout", async () => {
    const fake = server({ schemaAfter: 3 });
    await run(fake);
    expect(fake.calls.filter((c) => c.url.endsWith("/schema"))).toHaveLength(4);

    const never = server({ schemaAfter: 1000 });
    const err = await run(never, { timeoutMs: 3000, pollMs: 1000 }).catch((e) => e);
    expect(err).toBeInstanceOf(PreviewError);
    expect(err.message).toMatch(/has not reloaded the blocks module/);
    expect(JSON.stringify(err.fix)).toContain("Restart the dev server");
  });

  it("names --site on site_required, and refuses without a token", async () => {
    const err = await run(server({ schemaStatus: 400 })).catch((e) => e);
    expect(err).toBeInstanceOf(PreviewError);
    expect(JSON.stringify(err.fix)).toContain("--site");
    const none = await run(server(), { token: null }).catch((e) => e);
    expect(none.message).toMatch(/FOLIO_TOKEN/);
  });

  it("reads and writes under ~<site>", async () => {
    const fake = server();
    await run(fake, { site: "acme", base: "/cms" });
    for (const c of fake.calls) expect(c.url).toMatch(/^http:\/\/localhost:1\/cms\/~acme\//);
  });

  it("refuses --into a root field that does not allow the block", async () => {
    const err = await run(server(), { into: "page.title" }).catch((e) => e);
    expect(err).toBeInstanceOf(PreviewError);
  });
});

describe("sample fields", () => {
  it("fills text and textarea with their labels and leaves the rest absent", () => {
    expect(
      sampleFields({
        fields: {
          a: { kind: "text", label: "A" },
          b: { kind: "textarea", label: "B" },
          c: { kind: "richtext", label: "C" },
        },
      }),
    ).toEqual({ a: "A", b: "B" });
  });
});
