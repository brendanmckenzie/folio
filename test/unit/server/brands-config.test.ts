import { describe, expect, it } from "vitest";
import { defineBlock, text } from "../../../src/core";
import type { Migration } from "../../../src/core/migrate";
import type { DocumentType } from "../../../src/core/schema";
import type { Registry as SiteRegistry, SiteRef } from "../../../src/core/sites";
import type { FolioBindings, FolioBrand, FolioConfig } from "../../../src/server";
import { createRuntime } from "../../../src/server/runtime";

/**
 * `createFolio({ brands })` at construction (`docs/specs/foundation/multi-brand.md`
 * decision 3): one test per refusal in the decision's list, the per-brand runtime
 * (decision 6) — two brands that declare the same block and type names, each with
 * its own — and the old `rt.*` members, which answer on a single-brand runtime
 * exactly as they always did and throw on a branded one rather than answer the
 * first brand.
 */

type Env = Record<string, never>;

/** Two brands that collide on `pageRoot`, `prose` and `page`, with different fields. */
const atlRoot = defineBlock({
  name: "pageRoot",
  label: "Page",
  fields: { title: text(), strap: text() },
  render: () => null,
});
const atlProse = defineBlock({
  name: "prose",
  label: "Prose",
  fields: { body: text() },
  render: () => null,
});
const atlSettings = defineBlock({
  name: "atlSettings",
  label: "Settings",
  fields: { colour: text() },
  render: () => null,
});
const hbrRoot = defineBlock({
  name: "pageRoot",
  label: "Page",
  fields: { heading: text() },
  render: () => null,
});
const hbrProse = defineBlock({
  name: "prose",
  label: "Prose",
  fields: { copy: text(), lede: text() },
  render: () => null,
});

const atlTypes: DocumentType[] = [
  { name: "page", label: "Page", kind: "page", root: "pageRoot", default: true },
  { name: "atlSettings", label: "Settings", kind: "singleton", root: "atlSettings" },
];
const hbrTypes: DocumentType[] = [
  { name: "page", label: "Page", kind: "page", root: "pageRoot", default: true },
];

const migration = (id: string): Migration => ({
  id,
  description: `migration ${id}`,
  up: () => [],
});

const atl = (): FolioBrand<Env> => ({
  label: "Atlas Guides",
  blocks: [atlRoot, atlProse, atlSettings],
  types: atlTypes,
  settings: "atlSettings",
  globals: ["atlSettings"],
  previewCss: ["/atl.css"],
});
const hbr = (): FolioBrand<Env> => ({
  label: "Harbour Travel",
  blocks: [hbrRoot, hbrProse],
  types: hbrTypes,
  migrations: [migration("harbour/0001-fifty-fifty-to-feature")],
});

const bindings = () => ({}) as unknown as FolioBindings;

const route = (p: string, _l?: string, site?: SiteRef) =>
  site ? `https://${site.id}.example/${p}` : `/${p}`;

/** A valid two-brand config; `over` replaces keys, `undefined` removes one. */
function brandedConfig(over: Record<string, unknown> = {}): FolioConfig<Env> {
  return {
    brands: { atlas: atl(), harbour: hbr() },
    sites: { admin: "https://cms.example" },
    assets: {
      admin: "/folio-admin.js",
      brands: {
        atlas: { preview: "/folio-preview-atlas.js", previewCss: ["/p-a.css"] },
        harbour: { preview: "/folio-preview-harbour.js" },
      },
    },
    bindings,
    auth: "open",
    route,
    logger: { warn: () => {}, error: () => {} },
    ...over,
  } as FolioConfig<Env>;
}

const build =
  (over: Record<string, unknown> = {}) =>
  () =>
    createRuntime(brandedConfig(over));

describe("construction refuses each misuse of brands (decision 3)", () => {
  it("constructs a valid two-brand config", () => {
    expect(build()).not.toThrow();
  });

  it("refuses brands without sites", () => {
    expect(build({ sites: undefined })).toThrow(/'brands' needs 'sites'/);
  });

  it("refuses an empty brands", () => {
    expect(build({ brands: {} })).toThrow(/'brands' is empty/);
  });

  it("refuses a brand id that does not follow the site id rule", () => {
    expect(build({ brands: { Take_Off: hbr() } })).toThrow(/brand id 'Take_Off'/);
    expect(build({ brands: { "-hbr": hbr() } })).toThrow(/brand id '-hbr'/);
  });

  it("refuses a brand with no label", () => {
    expect(build({ brands: { harbour: { ...hbr(), label: " " } } })).toThrow(
      /'brands.harbour.label'/,
    );
  });

  it.each([
    ["blocks", [atlRoot]],
    ["root", "pageRoot"],
    ["types", atlTypes],
    ["globals", ["atlSettings"]],
    ["previewCss", ["/x.css"]],
    ["previewWrap", () => null],
    ["gate", { field: "x", public: true, allow: () => true }],
    ["forms", { ratePerHour: 5 }],
    ["describe", { fn: async () => ({}) }],
    ["migrations", [migration("0001-x")]],
  ])("refuses a top-level %s beside brands, naming the key", (key, value) => {
    expect(build({ [key]: value })).toThrow(
      new RegExp(`'${key}' belongs to a brand beside 'brands'`),
    );
  });

  it("refuses sites.settings beside brands", () => {
    expect(build({ sites: { admin: "https://cms.example", settings: "atlSettings" } })).toThrow(
      /'sites.settings' belongs to a brand/,
    );
  });

  it("refuses an assets.brands that differs from brands, missing or extra", () => {
    const one = { admin: "/a.js", brands: { atlas: { preview: "/p.js" } } };
    expect(build({ assets: one })).toThrow(/'assets.brands' must name exactly/);
    const extra = {
      admin: "/a.js",
      brands: {
        atlas: { preview: "/p.js" },
        harbour: { preview: "/t.js" },
        nobody: { preview: "/n.js" },
      },
    };
    expect(build({ assets: extra })).toThrow(/'assets.brands' must name exactly/);
    expect(build({ assets: { admin: "/a.js" } })).toThrow(/it names none/);
  });

  it("refuses an assets.preview at the top", () => {
    const assets = {
      admin: "/a.js",
      preview: "/p.js",
      brands: { atlas: { preview: "/p.js" }, harbour: { preview: "/t.js" } },
    };
    expect(build({ assets })).toThrow(/'assets.preview' belongs to a brand/);
  });

  it("refuses a brand migration id that does not carry its brand", () => {
    const bare = { ...hbr(), migrations: [migration("0001-fifty-fifty-to-feature")] };
    expect(build({ brands: { atlas: atl(), harbour: bare } })).toThrow(
      /brand 'harbour': migration id '0001-fifty-fifty-to-feature' must start with its brand, 'harbour\/'/,
    );
  });

  it("refuses a migration id carrying another brand, the declaring brand’s prefix only", () => {
    const theirs = { ...atl(), migrations: [migration("harbour/0001-x")] };
    expect(build({ brands: { atlas: theirs, harbour: hbr() } })).toThrow(
      /brand 'atlas': migration id 'harbour\/0001-x'/,
    );
  });

  it("runs the single-brand migration rules below the prefix", () => {
    const mixed = {
      ...hbr(),
      migrations: [migration("harbour/0001-a"), migration("harbour/2-b")],
    };
    expect(build({ brands: { atlas: atl(), harbour: mixed } })).toThrow(
      /brand 'harbour': .*numeric prefix of the same width/,
    );
  });

  it("runs every single-brand check per brand, naming the brand", () => {
    const twice = { ...hbr(), types: [...hbrTypes, ...hbrTypes] };
    expect(build({ brands: { atlas: atl(), harbour: twice } })).toThrow(
      /brand 'harbour': duplicate document type 'page'/,
    );
    const repeated = { ...hbr(), blocks: [hbrRoot, hbrProse, hbrProse] };
    expect(build({ brands: { atlas: atl(), harbour: repeated } })).toThrow(
      /brand 'harbour': duplicate block 'prose'/,
    );
    const unknownGlobal = { ...hbr(), globals: ["nav"] };
    expect(build({ brands: { atlas: atl(), harbour: unknownGlobal } })).toThrow(
      /brand 'harbour': .*nav/,
    );
    const settings = { ...hbr(), settings: "page" };
    expect(build({ brands: { atlas: atl(), harbour: settings } })).toThrow(
      /brand 'harbour': 'settings' names 'page', which is not a singleton type/,
    );
  });
});

describe("one BrandRuntime per brand (decision 6)", () => {
  const rt = createRuntime(brandedConfig());
  const atlRt = rt.brands.get("atlas")!;
  const hbrRt = rt.brands.get("harbour")!;

  it("keeps both brands’ blocks and types under their own names", () => {
    expect([...rt.brands.keys()]).toEqual(["atlas", "harbour"]);
    expect(Object.keys(atlRt.schema.pageRoot!.fields)).toEqual(["title", "strap"]);
    expect(Object.keys(hbrRt.schema.pageRoot!.fields)).toEqual(["heading"]);
    expect(Object.keys(hbrRt.schema.prose!.fields)).toEqual(["copy", "lede"]);
    expect(atlRt.typeOf("atlSettings")?.kind).toBe("singleton");
    expect(hbrRt.typeOf("atlSettings")).toBeUndefined();
  });

  it("carries each brand’s ref, settings, globals, layered and migrations", () => {
    expect(atlRt.brand).toEqual({ id: "atlas", label: "Atlas Guides" });
    expect(atlRt.settings).toBe("atlSettings");
    expect(atlRt.layered).toEqual(["atlSettings"]);
    expect(hbrRt.layered).toEqual([]);
    expect(hbrRt.schemaId).toBe("harbour/0001-fifty-fifty-to-feature");
    expect(atlRt.schemaId).toBeNull();
  });

  it("answers a manifest per brand, with brand and settings", () => {
    expect(atlRt.manifest.brand).toEqual({ id: "atlas", label: "Atlas Guides" });
    expect(atlRt.manifest.settings).toBe("atlSettings");
    expect(atlRt.manifest.blocks.map((b) => b.name)).toEqual(["pageRoot", "prose", "atlSettings"]);
    expect(hbrRt.manifest.brand).toEqual({ id: "harbour", label: "Harbour Travel" });
    expect("settings" in hbrRt.manifest).toBe(false);
    expect(hbrRt.manifest.blocks.map((b) => b.name)).toEqual(["pageRoot", "prose"]);
  });

  it("answers each brand’s own preview bundle and stylesheets", () => {
    expect(atlRt.page("preview")).toEqual({
      entries: ["/folio-preview-atlas.js"],
      stylesheets: ["/atl.css", "/p-a.css"],
    });
    expect(hbrRt.page("preview")).toEqual({
      entries: ["/folio-preview-harbour.js"],
      stylesheets: [],
    });
    expect(rt.page("admin")).toEqual({ entries: ["/folio-admin.js"], stylesheets: [] });
    expect(() => rt.page("preview")).toThrow(/rt.page\('preview'\) has no brand/);
  });

  it("seeds from its own schema", () => {
    const doc = hbrRt.seed(hbrRt.typeOf("page"), "Hi");
    expect(Object.keys(doc.bloks[doc.root]?.data ?? {})).toEqual(["heading"]);
  });
});

describe("forScope: the brand of a scope, never a default", () => {
  const rt = createRuntime(brandedConfig());
  const row = (id: string, brand: string | null, group: string | null = null): SiteRef => ({
    id,
    name: id,
    group,
    status: "live",
    hosts: [],
    preview: null,
    brand,
  });
  const registry: SiteRegistry = {
    sites: [row("default", "atlas"), row("harbour", "harbour", "tg")],
    groups: [{ id: "tg", name: "TG", brand: "harbour" }],
    shared: false,
  };

  it("answers a site’s and a group’s brand", () => {
    expect(rt.forScope(registry, "default")?.brand?.id).toBe("atlas");
    expect(rt.forScope(registry, "harbour")?.brand?.id).toBe("harbour");
    expect(rt.forScope(registry, "tg")?.brand?.id).toBe("harbour");
  });

  it("answers null for no scope, shared, an unknown scope and a row of no brand", () => {
    expect(rt.forScope(registry, null)).toBeNull();
    expect(rt.forScope(registry, "shared")).toBeNull();
    expect(rt.forScope(registry, "zulu")).toBeNull();
    const unbranded = { ...registry, sites: [row("orphan", null), row("ghost", "retired")] };
    expect(rt.forScope(unbranded, "orphan")).toBeNull();
    expect(rt.forScope(unbranded, "ghost")).toBeNull();
  });
});

describe("the old rt.* members", () => {
  it("are absent from a branded runtime, requiring access through rt.brands", () => {
    const rt = createRuntime(brandedConfig());
    // The schema, types, registry and other brand-specific members are no longer
    // on the runtime itself; they're accessed through rt.brands.
    expect("schema" in rt).toBe(false);
    expect("registry" in rt).toBe(false);
    expect("types" in rt).toBe(false);
    expect("manifest" in rt).toBe(false);
    expect("globals" in rt).toBe(false);
    expect("migrations" in rt).toBe(false);
    expect("gate" in rt).toBe(false);
    expect("describe" in rt).toBe(false);
    expect("forms" in rt).toBe(false);
    // rt.sites.settings is undefined on a branded runtime (one per brand)
    expect(rt.sites?.settings).toBeUndefined();
    // Everything that is the deployment's still answers.
    expect(rt.base).toBe("/folio");
    expect(rt.sites?.brands).toEqual(["atlas", "harbour"]);
    expect(rt.sites?.admin).toBe("https://cms.example");
  });

  it("answer on a single-brand runtime from its one brand through rt.brands", () => {
    const rt = createRuntime<Env>({
      blocks: [atlRoot, atlProse, atlSettings],
      types: atlTypes,
      globals: ["atlSettings"],
      bindings,
      auth: "open",
      assets: { admin: "/folio-admin.js", preview: "/folio-preview.js", previewCss: ["/p.css"] },
      previewCss: ["/host.css"],
    });
    const one = rt.brands.get(null)!;
    expect([...rt.brands.keys()]).toEqual([null]);
    expect(one.brand).toBeNull();
    expect(rt.forScope({ sites: [], groups: [], shared: true }, "anything")).toBe(one);
    // The brand-specific members are accessed through the brand, not on rt directly
    expect(one.schema).toBeDefined();
    expect(one.registry).toBeDefined();
    expect(one.types).toBe(atlTypes);
    expect(one.manifest).toEqual({
      types: atlTypes,
      blocks: one.manifest.blocks,
      root: "pageRoot",
      globals: ["atlSettings"],
    });
    expect("brand" in one.manifest).toBe(false);
    expect(rt.page("preview")).toEqual({
      entries: ["/folio-preview.js"],
      stylesheets: ["/host.css", "/p.css"],
    });
    expect(rt.page("admin")).toEqual({ entries: ["/folio-admin.js"], stylesheets: [] });
    expect(rt.sites).toBeNull();
  });

  it("answer rt.sites.settings on a single-brand multi-site runtime, as before", () => {
    const rt = createRuntime<Env>({
      blocks: [atlRoot, atlProse, atlSettings],
      types: atlTypes,
      bindings,
      auth: "open",
      route,
      sites: { admin: "https://cms.example", settings: "atlSettings" },
      logger: { warn: () => {}, error: () => {} },
    });
    expect(rt.sites?.settings).toBe("atlSettings");
  });
});
