/**
 * A field over its `length` limit says so to assistive technology, not only in red
 * (`docs/specs/content-model/authoring-guidance.md` decision 14; the v1.4.0 browser
 * check). The sentence under the control is part of the control's description, after
 * the counter, and the control is `aria-invalid`. */
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Blok } from "../../../../src/core/doc";
import type { Field as FieldDef } from "../../../../src/core/fields";
import type { FieldEnv } from "../../../../src/admin/ui/screens/fields/Control";
import { FieldRow } from "../../../../src/admin/ui/screens/fields/FieldRow";

const env = {
  apiBase: "/folio/api",
  mount: "/folio",
  schema: {},
  types: [],
  resolution: { stories: {} },
} as unknown as FieldEnv;

const hero = (data: Blok["data"]): Blok => ({
  uid: "b1",
  type: "hero",
  parent: null,
  slot: null,
  order: "a0",
  data,
});

function row(field: FieldDef, value: string) {
  const blok: Blok = hero({ heading: value });
  return render(
    <FieldRow
      blok={blok}
      name="heading"
      field={field}
      isSourceLocale
      locale="en"
      sourceLabel="English"
      readOnly={false}
      peers={[]}
      env={env}
      expanded={false}
      onExpand={() => {}}
      onChange={() => {}}
      onFocusField={() => {}}
      focusedField={null}
    />,
  );
}

/** The text of every element the control's `aria-describedby` names, in order. */
function description(control: HTMLElement): string[] {
  const ids = (control.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? `<missing ${id}>`);
}

const heading: FieldDef = { kind: "text", label: "Heading", length: { max: 60 } };
const body: FieldDef = { kind: "textarea", label: "Body", length: { max: 10 } };

describe("a field over its length limit", () => {
  it("describes a text input by its counter and then the over-limit sentence", () => {
    const view = row(heading, "x".repeat(82));
    const input = view.getByRole("textbox", { name: "Heading" });
    expect(description(input)).toEqual(["82 / 60", "Heading is 82 characters; the limit is 60."]);
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("does the same for a textarea", () => {
    const view = row(body, "x".repeat(12));
    const input = view.getByRole("textbox", { name: "Body" });
    expect(description(input)).toEqual(["12 / 10", "Body is 12 characters; the limit is 10."]);
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("does the same for a richtext prose surface, and clears both back under the limit", async () => {
    const prose = (text: string) => ({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });
    const intro: FieldDef = { kind: "richtext", label: "Intro", length: { max: 10 } };
    const blok = (text: string) => hero({ heading: prose(text) });
    const props = {
      name: "heading",
      field: intro,
      isSourceLocale: true,
      locale: "en",
      sourceLabel: "English",
      readOnly: false,
      peers: [],
      env,
      expanded: false,
      onExpand: () => {},
      onChange: () => {},
      onFocusField: () => {},
      focusedField: null,
    };
    const view = render(<FieldRow blok={blok("x".repeat(12))} {...props} />);
    const surface = await waitFor(() => {
      const el = view.container.querySelector<HTMLElement>("[data-folio-prose]");
      if (!el) throw new Error("no prose surface yet");
      return el;
    });
    expect(description(surface)).toEqual(["12 / 10", "Intro is 12 characters; the limit is 10."]);
    expect(surface.getAttribute("aria-invalid")).toBe("true");
    expect(surface.getAttribute("role")).toBe("textbox");

    // The warning comes and goes on the mounted surface, not only at build.
    view.rerender(<FieldRow blok={blok("x".repeat(4))} {...props} />);
    await waitFor(() => expect(surface.hasAttribute("aria-invalid")).toBe(false));
    expect(description(surface)).toEqual(["4 / 10"]);
    expect(surface.getAttribute("role")).toBe("textbox");
  });

  it("is neither invalid nor described by a sentence within the limit", () => {
    const view = row(heading, "x".repeat(42));
    const input = view.getByRole("textbox", { name: "Heading" });
    expect(description(input)).toEqual(["42 / 60"]);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  it("names the required warning too, without calling the field invalid", () => {
    const view = row({ ...heading, required: true }, "");
    const input = view.getByRole("textbox", { name: "Heading" });
    expect(description(input)).toEqual(["0 / 60", "Required — this is still empty."]);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });
});
