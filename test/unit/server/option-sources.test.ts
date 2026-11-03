import { describe, expect, it } from "vitest";
import { defineBlock, select, text } from "../../../src/core";
import { MAX_SOURCED_OPTIONS } from "../../../src/core/option-sources";
import type { FormField } from "../../../src/core/forms";
import type { DocumentType } from "../../../src/core/schema";
import { toSchemaIndex } from "../../../src/core/block";
import { FolioError } from "../../../src/server/errors";
import { validateForms } from "../../../src/server/form-responses";
import {
  checkOptionSources,
  digestOptions,
  listStatus,
  type OptionListRow,
  type RefreshResult,
  refreshKeys,
  screenItems,
} from "../../../src/server/option-sources";

const load = () => [{ value: "a" }];

describe("screenItems", () => {
  it("keeps the first of a duplicate value and falls back to the value for a label", () => {
    const out = screenItems([
      { value: "a", label: "First" },
      { value: "a", label: "Second" },
      { value: "b" },
    ]);
    expect(out).toEqual({
      ok: true,
      truncated: false,
      options: [
        { value: "a", label: "First" },
        { value: "b", label: "b" },
      ],
    });
  });

  it("drops over-length, empty, non-string and unprintable values", () => {
    const out = screenItems([
      { value: "x".repeat(121) },
      { value: "" },
      { value: 4 },
      { value: "bad\u0000value" },
      { value: "‮flip" },
      { value: " padded " },
      null,
      "str",
      { value: "ok" },
    ]);
    expect(out).toMatchObject({ ok: true, options: [{ value: "ok", label: "ok" }] });
  });

  it("trims a label, truncates it at 200 and replaces an unprintable one with the value", () => {
    const out = screenItems([
      { value: "a", label: `  ${"y".repeat(300)}  ` },
      { value: "b", label: "bad\u0007label" },
    ]);
    if (!out.ok) throw new Error("expected ok");
    expect([...out.options[0]!.label]).toHaveLength(200);
    expect(out.options[0]!.label.endsWith("…")).toBe(true);
    expect(out.options[1]!.label).toBe("b");
  });

  it("truncates at the cap and says so", () => {
    const items = Array.from({ length: MAX_SOURCED_OPTIONS + 25 }, (_, i) => ({ value: `v${i}` }));
    const out = screenItems(items);
    expect(out).toMatchObject({ ok: true, truncated: true });
    if (out.ok) expect(out.options).toHaveLength(MAX_SOURCED_OPTIONS);
  });

  it("treats an empty list, a non-array and an all-invalid list as failures", () => {
    expect(screenItems([])).toEqual({ ok: false, failure: "empty" });
    expect(screenItems(null)).toEqual({ ok: false, failure: "malformed" });
    expect(screenItems({ value: "a" })).toEqual({ ok: false, failure: "malformed" });
    expect(screenItems([{ value: "" }, 3])).toEqual({ ok: false, failure: "malformed" });
  });
});

describe("digestOptions", () => {
  it("is stable across key order and changes with the list", async () => {
    const a = await digestOptions([{ value: "a", label: "A" }]);
    const b = await digestOptions([{ label: "A", value: "a" }]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await digestOptions([{ value: "a", label: "B" }])).not.toBe(a);
  });
});

describe("listStatus", () => {
  const row = (over: Partial<OptionListRow>): OptionListRow => ({
    brand: "",
    source: "s",
    key: "k",
    options: [{ value: "a", label: "A" }],
    digest: "d",
    loadedAt: 1000,
    attemptedAt: 1000,
    failures: 0,
    failure: null,
    ...over,
  });
  it("is never-loaded without a row or without options", () => {
    expect(listStatus(null, 60, 5)).toBe("never-loaded");
    expect(listStatus(row({ options: null, loadedAt: null }), 60, 5)).toBe("never-loaded");
  });
  it("is stale at exactly loaded_at + ttl and fresh a millisecond before", () => {
    expect(listStatus(row({}), 60, 1000 + 60_000 - 1)).toBe("fresh");
    expect(listStatus(row({}), 60, 1000 + 60_000)).toBe("stale");
  });
  it("keeps a failing row's options usable", () => {
    expect(listStatus(row({ failures: 3, failure: "threw" }), 60, 2000)).toBe("fresh");
  });
});

describe("validateForms: sources", () => {
  const src = (over: Record<string, unknown> = {}) => ({ label: "S", load, ...over });
  const make = (sources: Record<string, unknown>) => validateForms({ sources: sources as never });

  it("defaults ttl and localised and keys the registry by id", () => {
    const forms = make({ countries: src() })!;
    const one = forms.sources.get("countries")!;
    expect(one).toMatchObject({ id: "countries", ttl: 3600, localised: false });
    expect(typeof one.load).toBe("function");
    expect(validateForms({})!.sources.size).toBe(0);
  });

  it("refuses an id that is not a source id", () => {
    for (const id of ["Countries", "1abc", "has_underscore", "a".repeat(49), ""]) {
      expect(() => make({ [id]: src() }), id).toThrow(/not a valid source id/);
    }
  });

  it("refuses the reserved id content", () => {
    expect(() => make({ content: src() })).toThrow(/reserved/);
  });

  it("refuses a load that is not a function, and a missing label", () => {
    expect(() => make({ a: src({ load: "x" }) })).toThrow(/load must be a function/);
    expect(() => make({ a: src({ load: undefined }) })).toThrow(/load must be a function/);
    expect(() => make({ a: src({ label: "" }) })).toThrow(/label/);
  });

  it("refuses a ttl outside 60 to 604800 or not whole", () => {
    for (const ttl of [59, 604_801, 1.5, "60", Number.NaN]) {
      expect(() => make({ a: src({ ttl }) }), String(ttl)).toThrow(/ttl/);
    }
    expect(make({ a: src({ ttl: 60 }) })!.sources.get("a")!.ttl).toBe(60);
    expect(make({ a: src({ ttl: 604_800 }) })!.sources.get("a")!.ttl).toBe(604_800);
  });

  it("refuses a non-boolean localised", () => {
    expect(() => make({ a: src({ localised: "yes" }) })).toThrow(/localised must be a boolean/);
    expect(make({ a: src({ localised: true }) })!.sources.get("a")!.localised).toBe(true);
  });

  it("refuses a setting of any kind but text, number, boolean or select", () => {
    expect(() => make({ a: src({ settings: { img: { kind: "asset" } } }) })).toThrow(
      /settings\.img/,
    );
    expect(() => make({ a: src({ settings: { n: null } }) })).toThrow(/settings\.n/);
    expect(
      make({
        a: src({
          settings: {
            t: text(),
            s: select({ options: [{ value: "x", label: "X" }] }),
            b: { kind: "boolean" },
            n: { kind: "number" },
          },
        }),
      }),
    ).not.toBeNull();
  });

  it("refuses an unknown forms key still, and sources that are not an object", () => {
    expect(() => validateForms({ source: {} } as never)).toThrow(/unknown `forms` key/);
    expect(() => validateForms({ sources: [] as never })).toThrow(/object/);
  });
});

describe("refreshKeys", () => {
  const loaded: RefreshResult = { status: "loaded", options: [], changed: false };
  const tick = () => new Promise<void>((r) => setTimeout(r, 5));

  it("never has more than four in flight", async () => {
    let inFlight = 0;
    let widest = 0;
    const out = await refreshKeys(
      Array.from({ length: 12 }, (_, i) => i),
      async () => {
        widest = Math.max(widest, ++inFlight);
        await tick();
        inFlight--;
        return loaded;
      },
      { deadlineMs: 5000 },
    );
    expect(widest).toBe(4);
    expect(out.results).toHaveLength(12);
    expect(out.unattempted).toEqual([]);
  });

  it("hands each load the time left to the shared deadline", async () => {
    let clock = 0;
    const seen: number[] = [];
    await refreshKeys(
      [1, 2, 3],
      async (_t, timeoutMs) => {
        seen.push(timeoutMs);
        clock += 10;
        return loaded;
      },
      { concurrency: 1, deadlineMs: 100, now: () => clock },
    );
    expect(seen).toEqual([100, 90, 80]);
  });

  it("abandons what it has not started at the deadline", async () => {
    let clock = 0;
    const out = await refreshKeys(
      ["a", "b", "c", "d"],
      async () => {
        clock += 40;
        return loaded;
      },
      { concurrency: 1, deadlineMs: 100, now: () => clock },
    );
    expect(out.results.map((r) => r.target)).toEqual(["a", "b", "c"]);
    expect(out.unattempted).toEqual(["d"]);
  });

  it("does not let one thrown refresh take the rest down", async () => {
    const out = await refreshKeys(
      [1, 2, 3],
      async (n) => {
        if (n === 2) throw new Error("db down");
        return loaded;
      },
      { deadlineMs: 1000 },
    );
    expect(out.results.map((r) => r.result.status).sort()).toEqual(["failed", "loaded", "loaded"]);
  });
});

describe("checkOptionSources", () => {
  const trip = defineBlock({
    name: "trip",
    label: "Trip",
    fields: {
      title: text({ indexed: true }),
      region: select({ indexed: true, options: [{ value: "x", label: "X" }] }),
      notes: text(),
    },
    render: () => null,
  });
  const page = defineBlock({
    name: "page",
    label: "Page",
    fields: { title: text() },
    render: () => null,
  });
  const site = defineBlock({
    name: "site",
    label: "Site",
    fields: { title: text() },
    render: () => null,
  });
  const types: DocumentType[] = [
    { name: "page", label: "Page", kind: "page", root: "page", default: true },
    { name: "trip", label: "Trip", kind: "record", root: "trip" },
    { name: "site", label: "Site", kind: "singleton", root: "site" },
  ];
  const schema = toSchemaIndex({ trip, page, site } as never);
  const forms = validateForms({
    sources: {
      countries: {
        label: "Countries",
        load,
        settings: {
          region: select({
            options: [{ value: "oceania", label: "Oceania" }],
            required: true,
          }),
          limit: { kind: "number", min: 1, max: 10 },
          pretty: { kind: "boolean" },
          tag: { kind: "text", default: "base" },
        },
      },
      plain: { label: "Plain", load },
    },
  });
  const brand = { forms, types, schema };

  const q = (optionsFrom: FormField["optionsFrom"]): FormField => ({
    name: "q",
    kind: "select",
    label: "Pick one",
    optionsFrom,
  });
  const refusal = (optionsFrom: FormField["optionsFrom"]) => {
    try {
      checkOptionSources([q(optionsFrom)], brand);
    } catch (err) {
      expect(err).toBeInstanceOf(FolioError);
      expect((err as FolioError).code).toBe("bad_request");
      return (err as FolioError).message;
    }
    return null;
  };

  it("accepts a registered host source with valid settings, and an unsourced field", () => {
    expect(refusal({ source: "countries", settings: { region: "oceania", limit: 3 } })).toBeNull();
    expect(refusal({ source: "plain" })).toBeNull();
    expect(() =>
      checkOptionSources([{ name: "n", kind: "text", label: "N" }], brand),
    ).not.toThrow();
  });

  it("refuses an unknown source, naming the question by label and slug", () => {
    const message = refusal({ source: "nope" });
    expect(message).toContain("Pick one");
    expect(message).toContain("(q)");
    expect(message).toContain("nope");
  });

  it("refuses an unknown source on a brand that registers none", () => {
    expect(() =>
      checkOptionSources([q({ source: "countries" })], { ...brand, forms: null }),
    ).toThrow(FolioError);
  });

  it("refuses an undeclared setting key", () => {
    expect(refusal({ source: "countries", settings: { region: "oceania", color: "red" } })).toMatch(
      /color/,
    );
  });

  it("refuses a value of the wrong kind", () => {
    expect(refusal({ source: "countries", settings: { region: 4 } })).toMatch(/region/);
    expect(refusal({ source: "countries", settings: { region: "oceania", limit: "3" } })).toMatch(
      /limit/,
    );
    expect(
      refusal({ source: "countries", settings: { region: "oceania", pretty: "yes" } }),
    ).toMatch(/pretty/);
    expect(refusal({ source: "countries", settings: { region: "oceania", tag: 5 } })).toMatch(
      /tag/,
    );
    expect(refusal({ source: "countries", settings: { region: "oceania", limit: 99 } })).toMatch(
      /range/,
    );
  });

  it("refuses a select value that is not among its options", () => {
    expect(refusal({ source: "countries", settings: { region: "atlantis" } })).toMatch(/options/);
  });

  it("refuses a missing required setting", () => {
    expect(refusal({ source: "countries" })).toMatch(/region/);
    expect(refusal({ source: "countries", settings: {} })).toMatch(/region/);
  });

  it("lets a default fill an absent setting", () => {
    expect(refusal({ source: "countries", settings: { region: "oceania" } })).toBeNull();
  });

  it("refuses a content type that does not exist or is a singleton", () => {
    expect(refusal({ source: "content", settings: { type: "ghost" } })).toMatch(/ghost/);
    expect(refusal({ source: "content", settings: { type: "site" } })).toMatch(/site/);
  });

  it("accepts a page or record type", () => {
    expect(refusal({ source: "content", settings: { type: "trip" } })).toBeNull();
    expect(refusal({ source: "content", settings: { type: "page" } })).toBeNull();
  });

  it("refuses a where or order field not indexed on the type's root", () => {
    expect(
      refusal({
        source: "content",
        settings: { type: "trip", where: [{ field: "notes", op: "eq", value: "x" }] },
      }),
    ).toMatch(/notes/);
    expect(
      refusal({
        source: "content",
        settings: { type: "trip", order: { field: "notes", dir: "asc" } },
      }),
    ).toMatch(/notes/);
    expect(
      refusal({
        source: "content",
        settings: { type: "trip", where: [{ field: "region", op: "eq", value: "x" }] },
      }),
    ).toBeNull();
    expect(
      refusal({
        source: "content",
        settings: { type: "trip", order: { field: "title", dir: "desc" } },
      }),
    ).toBeNull();
  });

  it("refuses content settings with no type", () => {
    expect(refusal({ source: "content", settings: {} })).toMatch(/type/);
  });
});
