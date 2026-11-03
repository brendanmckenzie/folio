import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { formLayout } from "../../../../src/core";
import type { ResolvedForm, ResolvedFormField } from "../../../../src/core/forms";

/**
 * A host keys each layout row on `row.key` and renders uncontrolled inputs. When a
 * condition hides the row's first question the key must not move, or React remounts
 * the sibling and drops what the visitor typed (spec 38 decision 15).
 */

const rf = (
  name: string,
  row: number,
  extra: Partial<ResolvedFormField> = {},
): ResolvedFormField => ({
  name,
  kind: "text",
  label: name,
  required: false,
  row,
  grow: 1,
  ...extra,
});

const form: ResolvedForm = {
  id: "frm_test0000ab",
  name: "test",
  action: "/f/frm_test0000ab",
  method: "post",
  enctype: "application/x-www-form-urlencoded",
  version: 1,
  open: true,
  fields: [
    rf("travelling", 0, {
      kind: "radio",
      options: [
        { value: "group", label: "Group" },
        { value: "solo", label: "Solo" },
      ],
    }),
    rf("company", 1, { showIf: { field: "travelling", eq: "group" } }),
    rf("phone", 1, { beside: true } as Partial<ResolvedFormField>),
  ],
  sections: [],
  hidden: [],
  honeypot: "company_website",
  submitLabel: "Send",
  successMessage: "",
  closedMessage: "",
  redirectTo: null,
};

let setTravelling: (v: string) => void = () => {};

function Host() {
  const [travelling, set] = useState("group");
  setTravelling = set;
  const view = formLayout(form, { travelling });
  return (
    <form>
      {view.sections.flatMap((s) =>
        s.rows.map((row) => (
          <div key={row.key}>
            {row.cells.map((c) => (
              <input key={c.field.name} name={c.field.name} />
            ))}
          </div>
        )),
      )}
    </form>
  );
}

let host: HTMLElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
});

describe("a host keying rows on LayoutRow.key", () => {
  it("keeps a typed answer in the sibling when its row-mate is hidden", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<Host />));
    const phone = host.querySelector<HTMLInputElement>('input[name="phone"]')!;
    phone.value = "0400 000 000";

    await act(async () => setTravelling("solo"));

    expect(host.querySelector('input[name="company"]')).toBeNull();
    const after = host.querySelector<HTMLInputElement>('input[name="phone"]')!;
    expect(after).toBe(phone);
    expect(after.value).toBe("0400 000 000");
    await act(async () => root.unmount());
  });
});
