/**
 * `folio preview block <name>`: render one block through the running server, so an
 * agent can see what it made.
 *
 * One scratch draft per block (spec 41 decision 12): wait for the block to reach
 * the served schema (the dev server reloads the Worker after the file changes),
 * put one instance of it in an unpublished top-level page with slug
 * `folio-scratch-<name>` (creating it, or replacing the content of the one a
 * previous run kept), ask MCP `preview_document` for it, save the PNG or the HTML
 * under the OS temp directory, and delete the draft unless `--keep`.
 *
 * Writes go through the token's own v1 routes (`content:write`); MCP is used only
 * for the one call that has no v1 route. Deleting through MCP `delete_document`
 * would need `admin`.
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rpc } from "./mcp.mjs";

export const PREVIEW_SCHEMA = "folio.preview-block/1";

/** A preview that could not be made: exit 1, with what to do instead. */
export class PreviewError extends Error {
  constructor(message, fix = []) {
    super(message);
    this.name = "PreviewError";
    this.fix = fix;
  }
}

/**
 * @param {{ url: string, base?: string, site?: string | null, token?: string | null,
 *   name: string, into?: string | null, fields?: Record<string, unknown> | null,
 *   viewport?: { width: number, height: number } | null, keep?: boolean,
 *   fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>, timeoutMs?: number,
 *   pollMs?: number, dir?: string, note?: (line: string) => void }} opts
 */
export async function previewBlock(opts) {
  const {
    name,
    keep = false,
    fetch = globalThis.fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    timeoutMs = 60_000,
    pollMs = 1000,
    dir = tmpdir(),
    note = () => {},
  } = opts;
  if (!opts.token) {
    throw new PreviewError("preview needs FOLIO_TOKEN in the environment.", [
      {
        kind: "manual",
        text: "Mint a token with content:read, content:read:draft and content:write in the admin (Settings, Tokens) and export it as FOLIO_TOKEN.",
      },
    ]);
  }
  const base = opts.base ?? "/folio";
  const prefix = `${opts.url.replace(/\/+$/, "")}${base}${opts.site ? `/~${opts.site}` : ""}`;
  const auth = { authorization: `Bearer ${opts.token}` };
  const api = async (method, p, body) => {
    let res;
    try {
      res = await fetch(`${prefix}/api/v1${p}`, {
        method,
        headers: {
          ...auth,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new PreviewError(
        `Nothing answers at ${opts.url}: ${err?.cause?.message ?? err?.message ?? err}`,
        [{ kind: "manual", text: "Start your dev server, then pass its origin as --url." }],
      );
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text };
  };
  const refused = (what, res) => {
    const code = res.json?.error?.code;
    if (code === "site_required") {
      return new PreviewError(`${what}: this deployment has many sites.`, [
        { kind: "manual", text: "Pass --site <id>." },
      ]);
    }
    if (res.status === 401 || res.status === 403) {
      return new PreviewError(`${what}: the token was refused (${res.status}).`, [
        {
          kind: "manual",
          text: "FOLIO_TOKEN needs content:read, content:read:draft and content:write on this deployment.",
        },
      ]);
    }
    return new PreviewError(
      `${what} answered ${res.status}: ${res.json?.error?.message ?? res.text.slice(0, 300)}`,
    );
  };

  // 1. Wait for the server to have reloaded the blocks module.
  note(`· waiting for ${name} in ${prefix}/api/v1/schema`);
  let manifest = null;
  for (let waited = 0; ; waited += pollMs) {
    const res = await api("GET", "/schema");
    if (res.status !== 200) throw refused("Reading the schema", res);
    if (res.json?.blocks?.some((b) => b.name === name)) {
      manifest = res.json;
      break;
    }
    if (waited >= timeoutMs) {
      throw new PreviewError(
        `${name} did not appear in the served schema within ${Math.round(timeoutMs / 1000)} seconds: the server has not reloaded the blocks module.`,
        [{ kind: "manual", text: "Restart the dev server, then run preview again." }],
      );
    }
    await sleep(pollMs);
  }

  // 2. A page type whose root has a blocks field allowing it.
  const into = opts.into ? opts.into.split(".") : null;
  const blocksByName = new Map(manifest.blocks.map((b) => [b.name, b]));
  let target = null;
  for (const type of manifest.types ?? []) {
    if (type.kind !== "page") continue;
    if (into && type.root !== into[0]) continue;
    const root = blocksByName.get(type.root);
    for (const [field, def] of Object.entries(root?.fields ?? {})) {
      if (into && field !== into[1]) continue;
      if (def?.kind === "blocks" && def.allow?.includes(name)) {
        target = { type, field };
        break;
      }
    }
    if (target) break;
  }
  if (!target) {
    throw new PreviewError(
      `No page type's root block has a blocks field${into ? ` ${opts.into}` : ""} allowing ${name}, so there is nowhere to put it.`,
      [
        {
          kind: "manual",
          text: `Make it insertable first: folio add block's --into, or add "${name}" to a root's blocks({ allow }).`,
        },
      ],
    );
  }

  // 3. The scratch draft: one instance of the block.
  const block = blocksByName.get(name);
  const fields = opts.fields ?? sampleFields(block);
  const instance = { type: name, fields };
  const slug = `folio-scratch-${name}`;
  const found = await api("GET", `/search?q=${encodeURIComponent(slug)}`);
  if (found.status !== 200) throw refused("Searching for an earlier scratch draft", found);
  const existing = (found.json?.rows ?? []).find(
    (r) => r.path === slug || r.path?.endsWith(`/${slug}`),
  );
  let id;
  if (existing) {
    id = existing.id;
    const doc = await api("GET", `/documents/${id}?status=draft`);
    if (doc.status !== 200) throw refused("Reading the scratch draft", doc);
    const put = await api("PUT", `/documents/${id}/content`, {
      content: { uid: doc.json.content.uid, fields: { [target.field]: [instance] } },
    });
    if (put.status !== 200) throw refused("Writing the scratch draft", put);
  } else {
    const made = await api("POST", "/documents", {
      type: target.type.name,
      title: `Scratch: ${block?.label ?? name}`,
      slug,
      content: { fields: { [target.field]: [instance] } },
    });
    if (made.status !== 201) throw refused("Creating the scratch draft", made);
    id = made.json.id;
  }

  // 4. Render it, and always tidy up unless asked not to.
  try {
    note(`· preview_document ${id}`);
    const answer = await rpc({
      endpoint: `${prefix}/mcp`,
      method: "tools/call",
      params: {
        name: "preview_document",
        arguments: { id, ...(opts.viewport ? { viewport: opts.viewport } : {}) },
      },
      token: opts.token,
      fetch,
      timeoutMs: 120_000,
    });
    const result = answer.json?.result;
    if (!result || answer.json?.error) {
      throw new PreviewError(
        `preview_document failed: ${answer.json?.error?.message ?? `HTTP ${answer.status}`}`,
      );
    }
    const content = result.content ?? [];
    const texts = content.filter((c) => c.type === "text").map((c) => c.text);
    const image = content.find((c) => c.type === "image");
    const stamp = `${name}-${Date.now()}`;
    let imagePath = null;
    let htmlPath = null;
    if (image) {
      imagePath = path.join(dir, `folio-preview-${stamp}.png`);
      writeFileSync(imagePath, Buffer.from(image.data, "base64"));
    } else if (texts.length >= 2) {
      htmlPath = path.join(dir, `folio-preview-${stamp}.html`);
      writeFileSync(htmlPath, texts.slice(1).join("\n"));
    } else {
      throw new PreviewError(`preview_document rendered nothing: ${texts[0] ?? "no content"}`);
    }
    const url = /URL: (\S+)/.exec(texts.join("\n"))?.[1] ?? null;
    return { documentId: id, url, image: imagePath, html: htmlPath, kept: keep };
  } finally {
    if (!keep) {
      const gone = await api("DELETE", `/documents/${id}?redirect=false`);
      if (gone.status !== 200) note(`! could not delete the scratch draft ${id} (${gone.status})`);
    }
  }
}

/** Without `--fields`: each `text` and `textarea` field holds its own label. */
export function sampleFields(block) {
  const out = {};
  for (const [name, def] of Object.entries(block?.fields ?? {})) {
    if (def?.kind === "text" || def?.kind === "textarea") out[name] = def.label ?? name;
  }
  return out;
}

/** `1280x800` → `{ width: 1280, height: 800 }`, or `null` when it is not that shape. */
export function parseViewport(text) {
  const m = /^(\d+)x(\d+)$/.exec(text ?? "");
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}
