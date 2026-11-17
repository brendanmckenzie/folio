import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FieldOptionsAnswer } from "../../../../src/admin/ui/screens/fields/sourced-select-model";
import { SourcedSelect } from "../../../../src/admin/ui/screens/fields/SourcedSelect";

/**
 * The inspector's sourced select, mounted (`platform/admin-extensions.md` decision 19): the
 * list from the route, a retired value kept and explained, and a list that never loaded as a
 * disabled control with its reason and a Retry.
 */

const base: FieldOptionsAnswer = {
  source: "products",
  label: "Products",
  status: "fresh",
  loadedAt: 1,
  options: [
    { value: "prod_1", label: "Classic tee" },
    { value: "prod_2", label: "Hoodie" },
  ],
};

const asked: string[] = [];
const pick = () => screen.getByRole("combobox") as unknown as HTMLSelectElement;
function answerWith(...answers: FieldOptionsAnswer[]) {
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      asked.push(url);
      const body = answers[Math.min(n++, answers.length - 1)];
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

async function mount(value: string, editable = true, onChange = vi.fn()) {
  const view = render(
    <SourcedSelect
      id="f"
      apiBase="/folio/api"
      block="productPage"
      name="product"
      story="sty_1"
      value={value}
      editable={editable}
      onChange={onChange}
    />,
  );
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return { ...view, onChange };
}

afterEach(() => {
  asked.length = 0;
  vi.unstubAllGlobals();
});

describe("SourcedSelect", () => {
  it("lists the host's options and writes the chosen id", async () => {
    answerWith(base);
    const { onChange } = await mount("");
    expect(asked).toEqual(["/folio/api/field-options?block=productPage&field=product&story=sty_1"]);
    const select = pick();
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "None",
      "Classic tee",
      "Hoodie",
    ]);
    fireEvent.change(select, { target: { value: "prod_2" } });
    expect(onChange).toHaveBeenCalledWith("prod_2");
  });

  it("keeps a retired value, labelled, and says who no longer offers it", async () => {
    answerWith({ ...base, missing: [{ value: "prod_9", label: "Archived tee" }] });
    await mount("prod_9");
    const select = pick();
    expect(select.value).toBe("prod_9");
    expect([...select.options].map((o) => o.textContent)).toContain("Archived tee");
    expect(screen.getByText("No longer offered by Products")).not.toBeNull();
  });

  it("draws the raw value for a retired one with no label", async () => {
    answerWith({ ...base, missing: [{ value: "prod_9", label: null }] });
    await mount("prod_9");
    expect([...pick().options].map((o) => o.textContent)).toContain("prod_9");
  });

  it("is a disabled control with the reason and a Retry when the list never loaded", async () => {
    answerWith(
      { ...base, status: "never-loaded", loadedAt: null, failure: "timeout", options: [] },
      base,
    );
    await mount("");
    const select = pick();
    expect(select.disabled).toBe(true);
    expect(screen.getByText(/Products could not be loaded \(timed out\)/)).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(pick().disabled).toBe(false);
    expect(asked).toHaveLength(2);
  });

  it("uses a stale list as it is, with no complaint", async () => {
    answerWith({ ...base, status: "stale" });
    await mount("prod_1");
    expect(pick().disabled).toBe(false);
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });

  it("is read-only when the field is not editable", async () => {
    answerWith(base);
    await mount("prod_1", false);
    expect(pick().disabled).toBe(true);
  });

  it("filters a list past twenty options", async () => {
    answerWith({
      ...base,
      options: Array.from({ length: 25 }, (_, i) => ({ value: `p${i}`, label: `Product ${i}` })),
    });
    await mount("p3");
    const box = screen.getByRole("searchbox");
    await act(async () => {
      fireEvent.change(box, { target: { value: "Product 2" } });
    });
    const labels = [...pick().options].map((o) => o.textContent);
    // The stored value stays listed whatever the filter says.
    expect(labels).toContain("Product 3");
    expect(labels).toContain("Product 20");
    expect(labels).not.toContain("Product 7");
  });

  it("offers a Retry when the request itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 500 })),
    );
    await mount("prod_1");
    expect(screen.getByText(/could not be loaded/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();
  });
});
