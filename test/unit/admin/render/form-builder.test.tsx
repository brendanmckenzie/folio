/**
 * The form builder with logic in it (`docs/specs/content-model/form-logic.md`
 * phase 4): the fixture's form has a conditional question and a conditional
 * section, so this mounts the rule editors rather than only their models.
 *
 * The smoke layer (`screens.test.tsx`) already asserts the screen mounts without a
 * React warning; this asserts the logic is actually drawn.
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { mountAt, resetServed, serve } from "./fixture";

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

describe("FormBuilder with steps", () => {
  const steppedForm = {
    id: "frm_one",
    name: "contact",
    label: "Contact",
    fields: [
      { name: "a", kind: "text", label: "Alpha", step: "s1" },
      { name: "b", kind: "text", label: "Bravo", step: "s1" },
      { name: "c", kind: "text", label: "Charlie", step: "s2" },
    ],
    layout: {
      steps: [
        { name: "s1", label: "About you" },
        { name: "s2", label: "Your trip", showIf: { field: "a", isSet: true } },
      ],
    },
    open: true,
    closesAt: null,
    successMessage: "",
    closedMessage: "",
    submitLabel: "",
    redirectTo: null,
    version: 1,
    updatedAt: 1,
    createdAt: 1,
  };

  afterEach(() => {
    cleanup();
    resetServed();
  });

  it("words Required as whenever shown for a question on a conditional step", async () => {
    serve({
      form: {
        ...steppedForm,
        fields: steppedForm.fields.map((f) => (f.name === "c" ? { ...f, required: true } : f)),
      },
    });
    await mountAt("/folio/form/frm_one");
    await waitFor(() => expect(screen.getByText("Charlie")).not.toBeNull());
    fireEvent.click(screen.getByText("Charlie"));
    expect(screen.getByRole("option", { name: "Whenever it is shown" })).not.toBeNull();
  });

  it("draws a header row per step and opens the step panel", async () => {
    serve({ form: steppedForm });
    await mountAt("/folio/form/frm_one");
    await waitFor(() => expect(screen.getByText("About you")).not.toBeNull());
    expect(screen.getByText("Step 1")).not.toBeNull();
    expect(screen.getByText("Step 2")).not.toBeNull();
    fireEvent.click(screen.getByText("Your trip"));
    expect(screen.getByLabelText("Show this step")).toHaveProperty("value", "when");
    expect(screen.getByRole("button", { name: "Merge with previous step" })).not.toBeNull();
    // Removing every step asks first.
    fireEvent.click(screen.getByRole("button", { name: "Remove steps" }));
    expect(screen.getByRole("button", { name: /Remove all 2 steps/ })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep steps" }));
    expect(screen.queryByRole("button", { name: /Remove all/ })).toBeNull();
  });

  it("offers no merge or condition on the first step", async () => {
    serve({ form: steppedForm });
    await mountAt("/folio/form/frm_one");
    await waitFor(() => expect(screen.getByText("About you")).not.toBeNull());
    fireEvent.click(screen.getByText("About you"));
    expect(screen.queryByRole("button", { name: "Merge with previous step" })).toBeNull();
    expect(screen.queryByLabelText("Show this step")).toBeNull();
  });

  it("offers Start a new step on a question that is not first in its step", async () => {
    serve({ form: steppedForm });
    await mountAt("/folio/form/frm_one");
    await waitFor(() => expect(screen.getByText("Bravo")).not.toBeNull());
    fireEvent.click(screen.getByText("Bravo"));
    fireEvent.click(screen.getByRole("button", { name: "Start a new step here" }));
    await waitFor(() => expect(screen.getByText("New step")).not.toBeNull());
    fireEvent.click(screen.getByText("Alpha"));
    expect(screen.queryByRole("button", { name: "Start a new step here" })).toBeNull();
  });
});
