/**
 * The length counter is a **description** of the control, never part of its name
 * (`docs/specs/content-model/authoring-guidance.md` decision 14; review finding 3).
 * Inside the `<label>` it would be announced with the field's name and change on every
 * keystroke ("Heading 42 / 60"), so it sits beside the label and the control points at
 * it with `aria-describedby`.
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Field, Input } from "../../../../src/admin/ui/Field";

describe("Field's length counter", () => {
  it("is outside the label, and is the control's description rather than its name", () => {
    const view = render(
      <Field label="Heading" count={{ text: "42 / 60", over: false }}>
        {(id, describedBy) => <Input id={id} aria-describedby={describedBy} />}
      </Field>,
    );
    const input = view.getByRole("textbox", { name: "Heading" });
    const label = view.container.querySelector("label");
    expect(label?.textContent).toBe("Heading");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(view.container.querySelector(`[id="${describedBy}"]`)?.textContent).toBe("42 / 60");
  });

  it("hands no description id to a field with no counter", () => {
    let seen: string | undefined = "unset";
    render(
      <Field label="Heading">
        {(id, describedBy) => {
          seen = describedBy;
          return <Input id={id} />;
        }}
      </Field>,
    );
    expect(seen).toBeUndefined();
  });
});
