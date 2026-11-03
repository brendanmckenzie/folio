/**
 * The builder's option-source editor (`form-option-sources.md` phase 6): the source
 * select, the host settings, the preview that runs on commit, the empty-required
 * warning, and the rule editor offering the previewed list.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { mountAt, resetServed, serve } from "./fixture";

const sourced = (over: Record<string, unknown> = {}) => ({
  id: "frm_one",
  name: "contact",
  label: "Contact",
  fields: [
    {
      name: "trip",
      kind: "select",
      label: "Trip",
      required: true,
      optionsFrom: { source: "content", settings: { type: "insight" } },
      ...over,
    },
    {
      name: "note",
      kind: "text",
      label: "Note",
      showIf: { field: "trip", eq: "stry_1" },
    },
  ],
  layout: {},
  open: true,
  closesAt: null,
  successMessage: "",
  closedMessage: "",
  submitLabel: "",
  redirectTo: null,
  version: 1,
  updatedAt: 1,
  createdAt: 1,
});

const COUNTRIES = {
  id: "countries",
  label: "Countries (Jambo)",
  ttl: 3600,
  localised: false,
  settings: {
    region: { kind: "text", label: "Region" },
    sort: { kind: "select", label: "Sort", options: [{ value: "a", label: "A" }] },
  },
};

const previews = (asked: string[]) => asked.filter((a) => a.includes("option-preview"));

afterEach(() => {
  cleanup();
  resetServed();
});

describe("FormBuilder option sources", () => {
  it("offers the host sources and previews the saved list when the question opens", async () => {
    serve({
      form: sourced(),
      registrySources: [COUNTRIES],
      preview: {
        options: [{ value: "stry_1", label: "Serengeti" }],
        total: 1,
        truncated: false,
        status: "fresh",
        loadedAt: null,
      },
    });
    const { asked } = await mountAt("/folio/form/frm_one");
    await waitFor(() => expect(screen.getByText("Trip")).not.toBeNull());
    fireEvent.click(screen.getByText("Trip"));
    await waitFor(() => expect(screen.getByText("Serengeti")).not.toBeNull());
    expect(screen.getByRole("option", { name: "Countries (Jambo)" })).not.toBeNull();
    expect(screen.getByRole("option", { name: "Published content" })).not.toBeNull();
    expect(screen.getByText("Also offer")).not.toBeNull();
    expect(asked.some((a) => a.includes("/forms/registry"))).toBe(true);
  });

  it("warns when a required content question has an empty list and no extras", async () => {
    serve({ form: sourced() });
    await mountAt("/folio/form/frm_one");
    await waitFor(() => expect(screen.getByText("Trip")).not.toBeNull());
    fireEvent.click(screen.getByText("Trip"));
    await waitFor(() =>
      expect(
        screen.getByText(
          /No published documents match\. Until one does, this question is not asked/,
        ),
      ).not.toBeNull(),
    );
  });

  it("does not warn when the question is not required, or has typed extras", async () => {
    serve({ form: sourced({ required: false }) });
    await mountAt("/folio/form/frm_one");
    await waitFor(() => expect(screen.getByText("Trip")).not.toBeNull());
    fireEvent.click(screen.getByText("Trip"));
    await waitFor(() => expect(screen.getByText("0 options")).not.toBeNull());
    expect(screen.queryByText(/No published documents match/)).toBeNull();
    cleanup();
    serve({ form: sourced({ options: [{ value: "x", label: "Something else" }] }) });
    await mountAt("/folio/form/frm_one");
    await waitFor(() => expect(screen.getByText("Trip")).not.toBeNull());
    fireEvent.click(screen.getByText("Trip"));
    await waitFor(() => expect(screen.getByText("0 options")).not.toBeNull());
    expect(screen.queryByText(/No published documents match/)).toBeNull();
  });

  it("previews a text setting on blur, not on every keystroke", async () => {
    serve({
      form: sourced({ optionsFrom: { source: "countries", settings: {} } }),
      registrySources: [COUNTRIES],
    });
    const { asked } = await mountAt("/folio/form/frm_one");
    await waitFor(() => expect(screen.getByText("Trip")).not.toBeNull());
    fireEvent.click(screen.getByText("Trip"));
    const region = await screen.findByLabelText("Region");
    await act(async () => {});
    const before = previews(asked).length;
    for (const v of ["a", "af", "afr"]) fireEvent.change(region, { target: { value: v } });
    await act(async () => {});
    expect(previews(asked).length).toBe(before);
    fireEvent.blur(region);
    await waitFor(() => expect(previews(asked).length).toBe(before + 1));
  });

  it("previews a select setting on change", async () => {
    serve({
      form: sourced({ optionsFrom: { source: "countries", settings: {} } }),
      registrySources: [COUNTRIES],
    });
    const { asked } = await mountAt("/folio/form/frm_one");
    await waitFor(() => expect(screen.getByText("Trip")).not.toBeNull());
    fireEvent.click(screen.getByText("Trip"));
    const sort = await screen.findByLabelText("Sort");
    await act(async () => {});
    const before = previews(asked).length;
    fireEvent.change(sort, { target: { value: "a" } });
    await waitFor(() => expect(previews(asked).length).toBe(before + 1));
  });

  it("offers the previewed list as the value menu of a rule on the sourced question", async () => {
    serve({
      form: sourced(),
      preview: {
        options: [
          { value: "stry_1", label: "Serengeti" },
          { value: "stry_2", label: "Kilimanjaro" },
        ],
        total: 2,
        truncated: false,
        status: "fresh",
        loadedAt: null,
      },
    });
    await mountAt("/folio/form/frm_one");
    await waitFor(() => expect(screen.getByText("Note")).not.toBeNull());
    fireEvent.click(screen.getByText("Note"));
    await waitFor(() => expect(screen.getByRole("option", { name: "Kilimanjaro" })).not.toBeNull());
  });

  it("previews a content filter on blur and the sort on change, not per keystroke", async () => {
    serve({
      form: sourced({ optionsFrom: { source: "content", settings: { type: "person" } } }),
    });
    const { asked } = await mountAt("/folio/form/frm_one");
    await waitFor(() => expect(screen.getByText("Trip")).not.toBeNull());
    fireEvent.click(screen.getByText("Trip"));
    const filter = await screen.findByLabelText("Full name");
    await act(async () => {});
    const before = previews(asked).length;
    for (const v of ["a", "al"]) fireEvent.change(filter, { target: { value: v } });
    await act(async () => {});
    expect(previews(asked).length).toBe(before);
    fireEvent.blur(filter);
    await waitFor(() => expect(previews(asked).length).toBe(before + 1));
    fireEvent.change(screen.getByLabelText("Sort by"), { target: { value: "fullName:asc" } });
    await waitFor(() => expect(previews(asked).length).toBe(before + 2));
  });
});
