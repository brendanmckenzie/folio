import { createExecutionContext, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  asset,
  collection,
  defineBlock,
  multiasset,
  multilink,
  resolveAsset,
  resolveLink,
  select,
  text,
} from "../../src/core";
import type { Doc, Json } from "../../src/core/doc";
import type { DocumentType } from "../../src/core/schema";
import type { ContentCheckReport, FolioConfig, FolioGate } from "../../src/server";
import { createFolio } from "../../src/server";
import { gatedScopeOf } from "../../src/server/asset-access";

/**
 * What a render knows about gated files (`docs/specs/platform/asset-access.md` decisions
 * 12 and 14, phase 5): `Resolution.gatedAssets`, the `access` a host draws a lock from,
 * its statement budget, and `gated-asset-embedded`. Against real D1.
 */

const page = defineBlock({
  name: "arPage",
  label: "Page",
  summary: "title",
  fields: {
    title: text(),
    access: select({
      options: [
        { label: "Everyone", value: "public" },
        { label: "Members", value: "members" },
      ],
      indexed: true,
    }),
    hero: asset({ label: "Hero" }),
    gallery: multiasset({ label: "Gallery" }),
    download: multilink({ label: "Download" }),
    list: collection({ type: "arPageType" }),
  },
  render: () => null,
});
const types: DocumentType[] = [
  { name: "arPageType", label: "Page", kind: "page", root: "arPage", default: true },
];

const gate: FolioGate<Cloudflare.Env> = {
  field: "access",
  public: "public",
  visitor: () => null,
  allows: () => false,
  allowsAsset: () => false,
};

/** One entry per statement: when it left, when it answered. */
const events: string[] = [];
let prepares = 0;
function spied(real: D1Database): D1Database {
  const statement = (stmt: D1PreparedStatement, tag: string): D1PreparedStatement =>
    new Proxy(stmt, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver);
        if (prop === "bind") {
          return (...a: unknown[]) =>
            statement((value as (...x: unknown[]) => D1PreparedStatement).apply(t, a), tag);
        }
        if (prop !== "first" && prop !== "all" && prop !== "run") return value;
        return async (...a: unknown[]) => {
          events.push(`send ${tag}`);
          const out = await (value as (...x: unknown[]) => Promise<unknown>).apply(t, a);
          events.push(`recv ${tag}`);
          return out;
        };
      },
    });
  const watch = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver);
        if (prop === "prepare") {
          return (sql: string) => {
            prepares++;
            const tag = sql.includes("effective_access is not null") ? "gated" : "other";
            return statement((value as (s: string) => D1PreparedStatement).call(t, sql), tag);
          };
        }
        if (prop === "withSession") {
          return (...a: unknown[]) => watch((value as (...x: unknown[]) => object).apply(t, a));
        }
        return typeof value === "function"
          ? (value as (...x: unknown[]) => unknown).bind(t)
          : value;
      },
    });
  return watch(real);
}

function config(withGate: FolioGate<Cloudflare.Env> | false): FolioConfig<Cloudflare.Env> {
  return {
    blocks: [page],
    types,
    bindings: (e) => ({ db: spied(e.DB), story: e.STORY, media: e.MEDIA, images: e.IMAGES }),
    basePath: "/folio",
    auth: "open",
    route: (p) => (p ? `/${p}` : "/"),
    ...(withGate ? { gate: withGate } : {}),
  };
}
const gated = createFolio<Cloudflare.Env>(config(gate));
const plain = createFolio<Cloudflare.Env>(config(false));
// A gate with no `allowsAsset`: files are not gated on this deployment.
const pageGateOnly = createFolio<Cloudflare.Env>(
  config({ field: "access", public: "public", visitor: () => null, allows: () => false }),
);

let n = 0;
async function seedFile(
  effective: string | null,
  contentType = "image/png",
  site = "default",
): Promise<string> {
  n += 1;
  const id = `ast_${(0xb00000 + n).toString(16).padStart(12, "0")}`;
  const key = `${id}-f${n}`;
  await env.DB.prepare(
    `insert into assets (id, key, filename, content_type, size, created_at, site_id, effective_access)
     values (?, ?, 'f', ?, 1, 1, ?, ?)`,
  )
    .bind(id, key, contentType, site, effective)
    .run();
  return key;
}
const file = (key: string, contentType = "image/png"): Json =>
  ({ key, filename: "f", contentType, size: 1, alt: "" }) as Json;

function doc(data: Record<string, Json>): Doc {
  return {
    root: "r",
    bloks: { r: { uid: "r", type: "arPage", parent: null, slot: null, order: "a0", data } },
  };
}

beforeEach(async () => {
  events.length = 0;
  prepares = 0;
  await env.DB.prepare("delete from assets").run();
});

describe("Resolution.gatedAssets", () => {
  it("holds the stored value of gated files only, and the host reads `access` from it", async () => {
    const secret = await seedFile('"members"');
    const open = await seedFile('"public"');
    const unset = await seedFile(null);
    const d = doc({
      access: "public",
      hero: file(secret),
      gallery: [file(open), file(unset)],
      download: { kind: "asset", asset: file(secret, "application/pdf") },
    });
    const resolution = await gated.resolve(env, d);
    expect(resolution.gatedAssets).toEqual({ [secret]: "members" });
    expect(resolveAsset(d.bloks.r!.data.hero, resolution)?.access).toBe("members");
    const [a, b] = [open, unset].map((k) => resolveAsset(file(k), resolution));
    expect(a && "access" in a).toBe(false);
    expect(b && "access" in b).toBe(false);
    // A link to a gated file carries it too, and one to a public file does not.
    expect(resolveLink(d.bloks.r!.data.download, resolution)).toMatchObject({
      kind: "asset",
      access: "members",
    });
    expect(resolveLink({ kind: "asset", asset: file(open) }, resolution)).not.toHaveProperty(
      "access",
    );
    // The owning scope rides beside it for page.signAsset, not inside it.
    expect(gatedScopeOf(resolution, secret)).toBe("default");
    expect(JSON.stringify(resolution)).not.toContain("default");
  });

  it("is absent, and the payload byte-identical, when no file is gated or the deployment does not gate files", async () => {
    const open = await seedFile('"public"');
    const secret = await seedFile('"members"');
    const noGated = doc({ access: "public", hero: file(open) });
    const withGatedFile = doc({ access: "public", hero: file(secret) });

    const control = await plain.resolve(env, noGated);
    const same = await gated.resolve(env, noGated);
    expect(same).not.toHaveProperty("gatedAssets");
    expect(JSON.stringify(same)).toBe(JSON.stringify(control));

    // `allowsAsset` is the whole switch: a gated row is invisible without it.
    const off = await pageGateOnly.resolve(env, withGatedFile);
    expect(off).not.toHaveProperty("gatedAssets");
    expect(JSON.stringify(off)).toBe(JSON.stringify(await plain.resolve(env, withGatedFile)));
  });

  it("costs one more statement, only with asset keys on a deployment that gates files", async () => {
    const secret = await seedFile('"members"');
    const withKeys = doc({ access: "public", hero: file(secret) });
    const withoutKeys = doc({ access: "public" });
    const count = async (folio: typeof gated, d: Doc) => {
      prepares = 0;
      await folio.resolve(env, d);
      return prepares;
    };
    const base = await count(plain, withKeys);
    expect(await count(gated, withoutKeys)).toBe(await count(plain, withoutKeys));
    expect(await count(gated, withKeys)).toBe(base + 1);
    expect(await count(pageGateOnly, withKeys)).toBe(base);
  });

  it("is sent in the same Promise.all as the collection queries, not after them", async () => {
    const secret = await seedFile('"members"');
    const d = doc({ access: "public", hero: file(secret) });
    await gated.resolve(env, d);
    // The collection field has run a query, so the two overlapped: some other
    // statement was in flight when the gated read left, or left while it was.
    const inflight = new Map<string, number>();
    let overlapped = false;
    let count = 0;
    for (const e of events) {
      const [kind, tag] = e.split(" ") as [string, string];
      const others = [...inflight].filter(([t, c]) => t !== tag && c > 0).length > 0;
      if (kind === "send") {
        count += 1;
        // The gated read left while another was out, or another left while it was.
        if (tag === "gated" ? others : (inflight.get("gated") ?? 0) > 0) overlapped = true;
      }
      inflight.set(tag, (inflight.get(tag) ?? 0) + (kind === "send" ? 1 : -1));
    }
    expect(count).toBeGreaterThan(1);
    expect(overlapped).toBe(true);
  });
});

/* ------------------------------------------------------------ the check --- */

const API = "https://folio.test/folio/api/v1";
let pageN = 0;
async function checked(d: Doc): Promise<ContentCheckReport["findings"]> {
  pageN += 1;
  const id = `ar_${String(pageN).padStart(4, "0")}`;
  await env.DB.prepare(
    `insert into stories (id, type, parent_id, slug, path, ord, title, created_at, updated_at,
                          published_doc, published_at)
     values (?, 'arPageType', null, ?, ?, 'a0', 'Page', 1, 1, ?, 1)`,
  )
    .bind(id, id, id, JSON.stringify(d))
    .run();
  const res = await gated.handle(
    new Request(`${API}/documents/${id}/check?status=published`),
    env,
    createExecutionContext(),
  );
  return ((await res!.json()) as ContentCheckReport).findings.filter(
    (f) => f.check === "gated-asset-embedded",
  );
}

describe("gated-asset-embedded", () => {
  it("warns for a gated image in an asset or multiasset field on a public page", async () => {
    const secret = await seedFile('"members"');
    const secret2 = await seedFile('"members"');
    const findings = await checked(
      doc({ access: "public", hero: file(secret), gallery: [file(secret2)] }),
    );
    expect(findings.map((f) => [f.field, f.severity, f.fix, f.detail])).toEqual([
      ["hero", "warning", "patch_fields", { key: secret, access: "members" }],
      ["gallery", "warning", "patch_fields", { key: secret2, access: "members" }],
    ]);
  });

  it("does not warn for a link, a non-image, a public image or a gated page", async () => {
    const secret = await seedFile('"members"');
    const pdf = await seedFile('"members"', "application/pdf");
    const open = await seedFile('"public"');
    expect(
      await checked(
        doc({
          access: "public",
          download: { kind: "asset", asset: file(secret) },
          hero: file(pdf, "application/pdf"),
          gallery: [file(open)],
        }),
      ),
    ).toEqual([]);
    expect(await checked(doc({ access: "members", hero: file(secret) }))).toEqual([]);
  });
});
