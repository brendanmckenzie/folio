/**
 * Form actions in the admin (`form-actions.md` phase 5): the Actions section of the
 * builder, read-only below a publisher, and Responses' Delivery column, drawer, Retry,
 * filter and banners. Mounted through the shell, so the props are the ones `screenFor`
 * really hands each screen.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Me } from "../../../../src/admin/me";
import { ADMIN, mountAt, resetServed, serve } from "./fixture";

const EDITOR: Me = { ...ADMIN, actor: { ...ADMIN.actor, role: "editor" } as Me["actor"] };
const PUBLISHER: Me = { ...ADMIN, actor: { ...ADMIN.actor, role: "publisher" } as Me["actor"] };

const JAMBO = {
  id: "jambo",
  label: "File in Jambo",
  description: "Creates a lead.",
  inputs: [{ name: "email", kind: "email", label: "Email", required: true }],
  settings: { pipeline: { kind: "text", label: "Pipeline", default: "sales" } },
  codes: [{ code: "error", label: "Could not process", message: "Sorry." }],
  check: true,
  deliver: true,
};
const MAILER = {
  id: "mailer",
  label: "Email responses",
  inputs: [],
  settings: {},
  codes: [],
  check: false,
  deliver: true,
};

const form = (actions: unknown[] = []) => ({
  id: "frm_one",
  name: "contact",
  label: "Contact",
  fields: [
    { name: "email", kind: "email", label: "Email", required: true },
    { name: "note", kind: "text", label: "Note" },
  ],
  layout: {},
  actions,
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

const attachment = {
  action: "jambo",
  map: { email: "email" },
  settings: { pipeline: "sales" },
  delivers: true,
};

const ROW = {
  id: "res_1",
  formId: "frm_one",
  version: 1,
  createdAt: 1_000,
  data: { email: "ada@example.com" },
  locale: "",
  page: "",
  files: [],
  unasked: [],
  optionLabels: {},
  deliveries: [{ action: "jambo", status: "failed", attempts: 8 }],
};
const FULL = {
  action: "jambo",
  status: "failed",
  attempts: 8,
  nextAt: null,
  reference: null,
  failure: "threw",
  detail: "fetch failed: https://vendor.example/?key=SECRET",
  createdAt: 1,
  updatedAt: 2,
};

afterEach(() => {
  cleanup();
  resetServed();
});

describe("the builder's Actions section", () => {
  it("offers an action not yet attached, and not one that is", async () => {
    serve({ form: form([attachment]), registryActions: [JAMBO, MAILER] });
    await mountAt("/folio/form/frm_one", PUBLISHER);
    await waitFor(() => expect(screen.getByText("Where responses go")).not.toBeNull());
    expect(screen.getAllByText("File in Jambo").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Add an action/ }));
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Email responses" })).not.toBeNull(),
    );
    expect(screen.queryByRole("menuitem", { name: "File in Jambo" })).toBeNull();
  });

  it("shows the problem in place when the attachment no longer fits", async () => {
    serve({ form: form([{ action: "jambo", delivers: true }]), registryActions: [JAMBO] });
    await mountAt("/folio/form/frm_one", PUBLISHER);
    await waitFor(() => expect(screen.getByText("Email needs a question")).not.toBeNull());
  });

  it("holds Save back when the draft makes an attachment worse, and not otherwise", async () => {
    serve({ form: form([attachment]), registryActions: [JAMBO] });
    await mountAt("/folio/form/frm_one", PUBLISHER);
    await waitFor(() => expect(screen.getByText("Where responses go")).not.toBeNull());
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(/Email/, { selector: "select" }), {
      target: { value: "" },
    });
    await waitFor(() => expect(save.disabled).toBe(true));
    expect(screen.getAllByText(/File in Jambo: Email needs a question/).length).toBeGreaterThan(0);
  });

  it("lets an already-incomplete attachment save", async () => {
    serve({ form: form([{ action: "jambo", delivers: true }]), registryActions: [JAMBO] });
    await mountAt("/folio/form/frm_one", PUBLISHER);
    await waitFor(() => expect(screen.getByText("Email needs a question")).not.toBeNull());
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("is read-only below a publisher", async () => {
    serve({ form: form([attachment]), registryActions: [JAMBO, MAILER] });
    await mountAt("/folio/form/frm_one", EDITOR);
    await waitFor(() =>
      expect(screen.getByText("Only a publisher can change where responses go.")).not.toBeNull(),
    );
    expect(screen.queryByRole("button", { name: /Add an action/ })).toBeNull();
    const remove = screen.getByRole("button", {
      name: "Remove File in Jambo",
    }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(
      (screen.getByLabelText(/Email/, { selector: "select" }) as unknown as HTMLSelectElement)
        .disabled,
    ).toBe(true);
  });

  it("refuses to remove a question an action reads, naming the action", async () => {
    serve({ form: form([attachment]), registryActions: [JAMBO] });
    await mountAt("/folio/form/frm_one", PUBLISHER);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove Email" })).not.toBeNull(),
    );
    const button = screen.getByRole("button", { name: "Remove Email" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title") ?? button.textContent).toBeDefined();
  });

  it("locks the name of a question an action reads for an editor", async () => {
    serve({ form: form([attachment]), registryActions: [JAMBO] });
    await mountAt("/folio/form/frm_one", EDITOR);
    await waitFor(() => expect(screen.getAllByText("Email").length).toBeGreaterThan(0));
    fireEvent.click(within(screen.getByRole("list")).getByText("Email"));
    await waitFor(() => expect(screen.getByLabelText("Field name")).not.toBeNull());
    expect((screen.getByLabelText("Field name") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("Responses deliveries", () => {
  const page = (rows: unknown[], extra: Record<string, unknown> = {}) => ({
    rows,
    cursor: null,
    hasMore: false,
    total: rows.length,
    oldest: 1_000,
    ...extra,
  });

  it("draws the Delivery column, the failed banner and the filter", async () => {
    serve({
      form: form([attachment]),
      registryActions: [JAMBO],
      responses: page([ROW], { failedDeliveries: 3 }),
    });
    await mountAt("/folio/responses/frm_one", PUBLISHER);
    await waitFor(() => expect(screen.getByText("3 deliveries failed.")).not.toBeNull());
    expect(screen.getByRole("columnheader", { name: "Delivery" })).not.toBeNull();
    expect(screen.getByTitle("File in Jambo: Failed")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Show them" })).not.toBeNull();
    expect(screen.getByLabelText("Delivery")).not.toBeNull();
  });

  it("says retries are not running when the server counts overdue ones", async () => {
    serve({
      form: form([attachment]),
      registryActions: [JAMBO],
      responses: page([ROW], { overdueDeliveries: 1 }),
    });
    await mountAt("/folio/responses/frm_one", PUBLISHER);
    await waitFor(() => expect(screen.getByText(/Retries are not running/)).not.toBeNull());
  });

  it("explains a form whose action needs attention, linking to the builder", async () => {
    serve({
      form: form([{ action: "jambo", delivers: true }]),
      registryActions: [JAMBO],
      responses: page([]),
    });
    await mountAt("/folio/responses/frm_one", PUBLISHER);
    await waitFor(() => expect(screen.getByText(/File in Jambo needs attention/)).not.toBeNull());
    expect(screen.getByRole("button", { name: "Open the builder" })).not.toBeNull();
  });

  it("shows a form with no delivering action exactly as before", async () => {
    serve({ form: form([]), responses: page([{ ...ROW, deliveries: [] }]) });
    await mountAt("/folio/responses/frm_one", PUBLISHER);
    await waitFor(() => expect(screen.getByText("ada@example.com")).not.toBeNull());
    expect(screen.queryByRole("columnheader", { name: "Delivery" })).toBeNull();
    expect(screen.queryByLabelText("Delivery")).toBeNull();
  });

  it("opens the drawer with the category, never the thrown text, and Retry calls the route and refreshes", async () => {
    serve({
      form: form([attachment]),
      registryActions: [JAMBO],
      responses: page([ROW]),
      deliveries: [FULL],
      retried: {
        ...FULL,
        status: "delivered",
        failure: null,
        detail: null,
        attempts: 1,
        reference: "lead-9",
      },
    });
    const { asked } = await mountAt("/folio/responses/frm_one", PUBLISHER);
    await waitFor(() => expect(screen.getByText("ada@example.com")).not.toBeNull());
    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0] as HTMLElement);
    await waitFor(() =>
      expect(
        screen.getByText("The action threw an error. Details are in the Worker's logs."),
      ).not.toBeNull(),
    );
    expect(document.body.textContent).not.toContain("SECRET");
    const listReads = asked.filter(
      (a) => a.startsWith("GET") && a.includes("/forms/frm_one/responses?"),
    ).length;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await waitFor(() =>
      expect(
        asked.some(
          (a) => a.startsWith("POST") && a.endsWith("/responses/res_1/deliveries/jambo/retry"),
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.getByText("lead-9")).not.toBeNull());
    // The list's compact status is stale after a Retry, so the page is read again.
    await waitFor(() =>
      expect(
        asked.filter((a) => a.startsWith("GET") && a.includes("/forms/frm_one/responses?")).length,
      ).toBeGreaterThan(listReads),
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows the drawer's deliveries without Retry below a publisher", async () => {
    serve({
      form: form([attachment]),
      registryActions: [JAMBO],
      responses: page([ROW]),
      deliveries: [FULL],
    });
    await mountAt("/folio/responses/frm_one", EDITOR);
    await waitFor(() => expect(screen.getByText("ada@example.com")).not.toBeNull());
    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0] as HTMLElement);
    await waitFor(() => expect(screen.getByText(/threw an error/)).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
