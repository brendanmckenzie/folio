/**
 * The form builder with logic in it (`docs/specs/content-model/form-logic.md`
 * phase 4): the fixture's form has a conditional question and a conditional
 * section, so this mounts the rule editors rather than only their models.
 *
 * The smoke layer (`screens.test.tsx`) already asserts the screen mounts without a
 * React warning; this asserts the logic is actually drawn.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mountAt } from "./fixture";

describe("FormBuilder with conditions and a section", () => {
  it("lists the rule under the question and the section above its members", async () => {
    await mountAt("/folio/form/frm_one");
    await waitFor(() => expect(screen.getByText("Tell us more")).not.toBeNull());
    expect(screen.getByText(/Shown when "How did you hear about us\?" is "Other"/)).not.toBeNull();
    expect(screen.getByText("Postal address")).not.toBeNull();
    expect(screen.getByText("Conditional")).not.toBeNull();
  });

  it("opens the rule editor for a conditional question", async () => {
    await mountAt("/folio/form/frm_one");
    await waitFor(() => expect(screen.getByText("Tell us more")).not.toBeNull());
    fireEvent.click(screen.getByText("Tell us more"));
    expect(screen.getByLabelText("Show this question")).toHaveProperty("value", "when");
    expect(screen.getByLabelText("Question")).toHaveProperty("value", "heard");
    expect(screen.getByLabelText("Value")).toHaveProperty("value", "other");
    // Stored as required, shown conditionally: "Whenever it is shown".
    expect(screen.getByRole("option", { name: "Whenever it is shown" })).not.toBeNull();
  });

  it("opens a section's panel with its own rule", async () => {
    await mountAt("/folio/form/frm_one");
    await waitFor(() => expect(screen.getByText("Postal address")).not.toBeNull());
    fireEvent.click(screen.getByText("Postal address"));
    expect(screen.getByLabelText("Show this section")).toHaveProperty("value", "when");
    expect(screen.getByRole("button", { name: /Remove section/ })).not.toBeNull();
  });
});
