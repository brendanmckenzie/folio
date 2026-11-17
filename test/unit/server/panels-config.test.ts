import { describe, expect, it } from "vitest";
import {
  DEFAULT_PANEL_TIMEOUT_MS,
  type FolioPanel,
  validatePanels,
} from "../../../src/server/panels-config";

/**
 * `validatePanels` (`platform/admin-extensions.md` decision 21): every refusal names the key.
 */

const types = ["page", "product"];
const panel = (extra: Record<string, unknown> = {}): FolioPanel<unknown> =>
  ({ label: "Shop", load: () => null, ...extra }) as FolioPanel<unknown>;
const build = (panels: unknown) => () =>
  validatePanels(panels as Record<string, FolioPanel<unknown>>, types);

describe("validatePanels", () => {
  it("answers nothing for no panels", () => {
    expect(validatePanels(undefined, types).size).toBe(0);
    expect(validatePanels({}, types).size).toBe(0);
  });

  it("applies the defaults and binds load to its panel", () => {
    const state = { hits: 0 };
    const resolved = validatePanels(
      {
        product: {
          label: "Shop",
          load() {
            (this as unknown as { x?: number }).x = 1;
            state.hits++;
            return null;
          },
        },
      },
      types,
    ).get("product")!;
    expect(resolved).toMatchObject({
      type: "product",
      label: "Shop",
      role: "viewer",
      timeoutMs: DEFAULT_PANEL_TIMEOUT_MS,
    });
    resolved.load({} as never, {});
    expect(state.hits).toBe(1);
  });

  it("keeps a declared role and timeout", () => {
    const got = validatePanels({ product: panel({ role: "publisher", timeoutMs: 500 }) }, types);
    expect(got.get("product")).toMatchObject({ role: "publisher", timeoutMs: 500 });
    expect(
      validatePanels({ product: panel({ timeoutMs: 10_000 }) }, types).get("product")?.timeoutMs,
    ).toBe(10_000);
  });

  it("refuses a type that is not declared, naming what is", () => {
    expect(build({ nope: panel() })).toThrow(
      /`panels.nope` names a document type that is not declared \(declared: page, product\)/,
    );
  });

  it.each([
    [{ label: "" }, /panels.product`.label must be a string of 1 to 40 characters/],
    [{ label: "x".repeat(41) }, /label must be a string of 1 to 40/],
    [{ label: 3 }, /label must be a string/],
    [{ load: "nope" }, /panels.product`.load must be a function/],
    [{ load: undefined }, /load must be a function/],
    [{ role: "owner" }, /role must be one of viewer, editor, publisher, admin/],
    [{ timeoutMs: 499 }, /timeoutMs is 499/],
    [{ timeoutMs: 10_001 }, /timeoutMs is 10001/],
    [{ timeoutMs: 1500.5 }, /timeoutMs is 1500.5/],
    [{ timeoutMs: "3000" }, /timeoutMs is "3000"/],
    [{ cache: true }, /unknown key `panels.product`.cache/],
  ])("refuses %j", (extra, message) => {
    expect(build({ product: panel(extra) })).toThrow(message);
  });

  it("refuses a panel that is not an object, and panels that are not a map", () => {
    expect(build({ product: null })).toThrow(/must be an object/);
    expect(build({ product: [] })).toThrow(/must be an object/);
    expect(build([])).toThrow(/`panels` must be an object keyed by document type name/);
    expect(build("x")).toThrow(/`panels` must be an object/);
  });
});
