import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Blok } from "../../../../src/core/doc";
import { text } from "../../../../src/core/fields";
import type { SchemaIndex } from "../../../../src/core/schema";
import type { StoryMeta } from "../../../../src/core/story";
import { Inspector, type InspectorProps } from "../../../../src/admin/ui/screens/Inspector";
import { StoryStore } from "../../../../src/admin/store";

/**
 * The linked-data card in the inspector (`platform/admin-extensions.md` decision 21), in **form
 * mode** as well: a record, the commerce product, is edited as a form and is where a panel is
 * wanted. The browser pass found it drawn only beside the preview.
 */

const schema: SchemaIndex = {
  productRecord: {
    name: "productRecord",
    label: "Product",
    fields: { name: text({ label: "Name" }) },
  },
  child: { name: "child", label: "Child", fields: { name: text({ label: "Name" }) } },
};

const root: Blok = {
  uid: "r0",
  type: "productRecord",
  parent: null,
  slot: null,
  order: "a0",
  data: { name: "Classic tee" },
};
const child: Blok = { ...root, uid: "c0", type: "child", parent: "r0", slot: "body" };

const story = {
  id: "sty_p",
  type: "product",
  title: "Classic tee",
  path: null,
} as unknown as StoryMeta;

function props(over: Partial<InspectorProps>): InspectorProps {
  return {
    store: new StoryStore("sty_p", "/folio/api"),
    schema,
    types: [],
    apiBase: "/folio/api",
    mount: "/folio",
    locales: undefined,
    locale: "en",
    isSourceLocale: true,
    resolution: {} as never,
    blok: root,
    readOnly: false,
    blocks: {} as never,
    story,
    routed: false,
    isRootBlok: true,
    globalHint: null,
    onEditGlobal: () => {},
    onNotice: () => {},
    form: true,
    panel: { label: "Shop" },
    ...over,
  };
}

const answer = {
  status: "ok",
  at: 1,
  summary: { items: [{ label: "Variants", value: "6" }], note: "On sale." },
};
const asked: string[] = [];
function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify(answer), { status: 200 });
    }),
  );
}
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

afterEach(() => {
  asked.length = 0;
  vi.unstubAllGlobals();
});

describe("Inspector's linked-data panel", () => {
  it("draws on a record's root in form mode, above the fields", async () => {
    stub();
    const { container } = render(<Inspector {...props({ form: true })} />);
    await settle();
    expect(asked).toEqual(["/folio/api/stories/sty_p/panel"]);
    const card = screen.getByRole("region", { name: "Shop" });
    expect(screen.getByText("On sale.")).not.toBeNull();
    const field = container.querySelector("input");
    // Context first, then the form.
    expect(
      card.compareDocumentPosition(field as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("draws beside the preview too (not form mode)", async () => {
    stub();
    render(<Inspector {...props({ form: false })} />);
    await settle();
    expect(screen.getByRole("region", { name: "Shop" })).not.toBeNull();
  });

  it("is read-only for a viewer: the card is shown and the fields are disabled", async () => {
    stub();
    const { container } = render(<Inspector {...props({ readOnly: true })} />);
    await settle();
    expect(screen.getByRole("region", { name: "Shop" })).not.toBeNull();
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
  });

  it("is not drawn for a type with no panel, nor on a nested block", async () => {
    stub();
    const { rerender } = render(<Inspector {...props({ panel: undefined })} />);
    await settle();
    expect(screen.queryByRole("region", { name: "Shop" })).toBeNull();
    rerender(<Inspector {...props({ blok: child })} />);
    await settle();
    expect(screen.queryByRole("region", { name: "Shop" })).toBeNull();
    expect(asked).toEqual([]);
  });
});
