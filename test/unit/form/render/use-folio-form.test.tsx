import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedForm } from "../../../../src/core/forms";
import type { FolioForm } from "../../../../src/form";
import { baseForm, Host, rf, steppedForm } from "./fixture";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Scope = Pick<HTMLElement, "querySelector" | "querySelectorAll">;
const q = (c: Scope, sel: string) => c.querySelector(sel) as HTMLElement;
const input = (c: Scope, name: string) => q(c, `[name="${name}"]`) as HTMLInputElement;

function fill(c: Scope, name: string, value: string) {
  const el = input(c, name);
  el.value = value;
  fireEvent.input(el);
}
function pick(c: Scope, name: string, value: string) {
  fireEvent.click(q(c, `[name="${name}"][value="${value}"]`));
}
function mount(form: ResolvedForm, options = {}, gate = false) {
  let f!: FolioForm;
  const r = render(<Host form={form} options={options} gate={gate} expose={(x) => (f = x)} />);
  return { ...r, hook: () => f };
}
const hiddenSteps = (c: Scope) =>
  [...c.querySelectorAll("[data-folio-step]")].filter((e) => e.hasAttribute("hidden"));

/** Completes step one, so the rest of the form can be walked. */
function finishAbout(c: Scope, who = "solo") {
  fill(c, "email", "a@b.co");
  pick(c, "travelling", who);
}

describe("hydration", () => {
  it("matches the server render, then pages", async () => {
    expect(process.env.NODE_ENV).not.toBe("production");
    const form = steppedForm();
    const html = renderToString(<Host form={form} />);
    // No script: one page.
    const server = document.createElement("div");
    server.innerHTML = html;
    expect(server.querySelectorAll("[hidden]").length).toBe(0);
    expect(server.querySelector("form")?.hasAttribute("novalidate")).toBe(false);
    expect(server.querySelectorAll("[data-folio-current]").length).toBe(0);
    expect(server.querySelectorAll('[data-testid="submit"]').length).toBe(1);
    expect(
      server.querySelector('[name="interests"][value="birds"]')?.hasAttribute("required"),
    ).toBe(false);

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const recoverable = vi.fn();
    const errors: unknown[][] = [];
    console.error = (...a: unknown[]) => void errors.push(a);
    let root!: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, <Host form={form} />, { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
    expect(hiddenSteps(container).map((e) => e.getAttribute("data-folio-step"))).toEqual(["trip"]);
    expect(q(container, "form").hasAttribute("novalidate")).toBe(true);
    expect(q(container, "[data-folio-current]").getAttribute("data-folio-step")).toBe("about");
    act(() => root.unmount());
    container.remove();
  });
});

describe("a step cannot be left incomplete", () => {
  it("refuses Next, focuses the summary, links to controls, then advances on Enter", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container, hook } = mount(steppedForm());
    fill(container, "phone", "abc");
    act(() => {
      expect(hook().next()).toBe(false);
    });
    expect(hook().current).toBe("about");
    expect(hook().errorFor("phone")?.token).toBe("invalid");
    expect(hook().errorFor("email")?.token).toBe("required");
    expect(document.activeElement).toBe(q(container, '[data-testid="summary"]'));
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => {
      fireEvent.click(q(container, '[data-testid="summary"] a'));
    });
    expect(document.activeElement).toBe(input(container, "email"));

    fill(container, "phone", "0400 000 000");
    fill(container, "email", "a@b.co");
    pick(container, "travelling", "solo");
    fireEvent.keyDown(input(container, "email"), { key: "Enter" });
    expect(hook().current).toBe("trip"); // group is unreachable for a solo traveller
    expect(document.activeElement?.textContent).toBe("Your trip");
    expect(hiddenSteps(container).map((e) => e.getAttribute("data-folio-step"))).toEqual(["about"]);
  });

  it("advances on Enter while the submit button is disabled, and never from a textarea", () => {
    const { container, hook } = mount(steppedForm(), {}, true);
    finishAbout(container);
    fireEvent.keyDown(input(container, "email"), { key: "Enter" });
    expect(hook().current).toBe("trip");
    expect(hook().isLast).toBe(true);
    fireEvent.keyDown(input(container, "notes"), { key: "Enter" });
    expect(hook().current).toBe("trip");
  });

  it("goes back, and refuses goTo for an unavailable step", () => {
    const { container, hook } = mount(steppedForm());
    finishAbout(container);
    act(() => {
      expect(hook().next()).toBe(true);
    });
    act(() => hook().back());
    expect(hook().current).toBe("about");
    expect(document.activeElement?.textContent).toBe("About you");
    act(() => {
      expect(hook().goTo("group")).toBe(false);
      expect(hook().goTo("nope")).toBe(false);
    });
    expect(hook().current).toBe("about");
    act(() => {
      expect(hook().goTo("trip")).toBe(true);
    });
    expect(hook().current).toBe("trip");
  });

  it("refuses to jump past an incomplete step", () => {
    const { container, hook } = mount(steppedForm());
    fill(container, "phone", "0400 000 000");
    act(() => {
      expect(hook().goTo("trip")).toBe(false);
    });
    expect(hook().current).toBe("about");
    expect(document.activeElement).toBe(q(container, '[data-testid="summary"]'));
  });
});

describe("rows", () => {
  it("keeps a row's input value when a condition hides the row's first cell", () => {
    const form = baseForm({
      fields: [
        rf("travelling", 0, {
          kind: "radio",
          options: [
            { value: "group", label: "G" },
            { value: "solo", label: "S" },
          ],
        }),
        rf("company", 1, { showIf: { field: "travelling", eq: "group" } }),
        rf("phone", 1),
      ],
    });
    const { container } = mount(form);
    pick(container, "travelling", "group");
    fill(container, "phone", "12345678");
    pick(container, "travelling", "solo");
    expect(input(container, "company")).toBeNull();
    expect(input(container, "phone").value).toBe("12345678");
  });
});

describe("the current step is always rendered", () => {
  const emptied = () =>
    steppedForm({
      steps: [
        { name: "about", label: "About you" },
        { name: "trip", label: "Your trip" },
      ],
      fields: [
        rf("pick", 0, {
          kind: "select",
          step: "about",
          showIf: { any: [] },
          options: [{ value: "a", label: "A" }],
          optionsFrom: { source: "content" },
        }),
        rf("notes", 1, { kind: "textarea", step: "trip" }),
      ],
    });

  it("lands on step two when step one holds nothing asked", () => {
    const { container, hook } = mount(emptied());
    expect(hook().current).toBe("trip");
    expect(hiddenSteps(container)).toHaveLength(0);
    expect(q(container, '[data-testid="step-trip"]').hasAttribute("hidden")).toBe(false);
  });

  it("moves to the nearest earlier step when the descriptor drops the current one", () => {
    const form = steppedForm();
    let f!: FolioForm;
    const r = render(<Host form={form} expose={(x) => (f = x)} />);
    finishAbout(r.container);
    act(() => {
      f.next();
    });
    expect(f.current).toBe("trip");
    const replaced = steppedForm({
      steps: form.steps?.filter((s) => s.name !== "trip"),
      fields: form.fields.filter((x) => x.step !== "trip"),
    });
    r.rerender(<Host form={replaced} expose={(x) => (f = x)} />);
    expect(f.current).toBe("about");
  });
});

describe("the native round trip", () => {
  it("marks the question on the server render and lands on its step after mount", async () => {
    const search = "folio_status=invalid&folio_form=apply&folio_invalid=trip_date";
    const html = renderToString(<Host form={steppedForm()} options={{ search }} />);
    expect(html).toContain('aria-invalid="true"');
    const { container, hook } = mount(steppedForm(), { search });
    expect(hook().current).toBe("trip");
    expect(document.activeElement).toBe(q(container, '[data-testid="summary"]'));
  });

  it("never lands on a step the layout dropped, and still lists the problem", () => {
    const { hook } = mount(steppedForm(), {
      search: "folio_status=invalid&folio_form=apply&folio_invalid=group_size",
    });
    expect(hook().current).toBe("about");
    expect(hook().problems).toEqual([
      expect.objectContaining({ name: "group_size", step: null, token: "invalid" }),
    ]);
  });

  it("reads statuses and the editor's refusal text", () => {
    const form = steppedForm({
      refusals: {
        "trip-code.unknown_trip": "We do not know that trip.",
        "trip-code.error": "Try later.",
      },
    });
    expect(
      mount(form, {
        search: "folio_status=refused&folio_form=apply&folio_reason=trip-code.unknown_trip",
      }).hook().status?.message,
    ).toBe("We do not know that trip.");
    cleanup();
    expect(
      mount(form, {
        search: "folio_status=refused&folio_form=apply&folio_reason=trip-code.gone",
      }).hook().status?.message,
    ).toBe("Try later.");
    cleanup();
    expect(mount(form, { search: "folio_status=rate&folio_form=other" }).hook().status).toBeNull();
    cleanup();
    expect(mount(form, { search: "folio_status=error" }).hook().status?.kind).toBe("error");
  });
});

describe("fetch transport", () => {
  const reply = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  async function submitAll(form = steppedForm(), options = {}) {
    const m = mount(form, options);
    finishAbout(m.container);
    fill(m.container, "notes", "typed on step three");
    pick(m.container, "interests", "birds");
    act(() => {
      m.hook().goTo("trip");
    });
    return m;
  }
  const send = async (c: Scope) => {
    await act(async () => {
      fireEvent.submit(q(c, "form"));
    });
  };

  it("keeps answers and returns to the refused step on a 422, focusing the summary", async () => {
    const fetchMock = reply(422, {
      error: { code: "invalid", message: "Some answers need another look." },
      status: "invalid",
      fields: { email: "invalid" },
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container, hook } = await submitAll();
    expect(hook().current).toBe("trip");
    await send(container);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((call.headers as Record<string, string>).accept).toBe("application/json");
    expect(call.body).toBeInstanceOf(URLSearchParams);
    expect(hook().current).toBe("about");
    expect(hook().problems.map((p) => p.name)).toEqual(["email"]);
    expect(document.activeElement).toBe(q(container, '[data-testid="summary"]'));
    expect(input(container, "notes").value).toBe("typed on step three");
    expect(input(container, "email").value).toBe("a@b.co");
    expect(hook().attempt).toBe(1);
  });

  it("answers ok, focuses the status container, and keeps the redirect's status params", async () => {
    const fetchMock = reply(200, { ok: true, status: "ok", id: "rsp_1" });
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      href: "http://localhost/apply",
      assign,
    } as unknown as Location);
    const onSubmitted = vi.fn();
    const { container, hook } = await submitAll(steppedForm({ redirectTo: "/thanks" }), {
      onSubmitted,
    });
    await send(container);
    expect(hook().status?.kind).toBe("ok");
    expect(hook().status?.message).toBe("Thanks, we got it.");
    expect(q(container, '[data-testid="status"]').getAttribute("role")).toBe("status");
    expect(document.activeElement).toBe(q(container, '[data-testid="status"]'));
    expect(onSubmitted).toHaveBeenCalledWith({ ok: true, id: "rsp_1" });
    expect(assign).toHaveBeenCalledWith("http://localhost/thanks?folio_status=ok&folio_form=apply");
  });

  it("focuses an alert on 429 and shows the server's message on a refusal", async () => {
    vi.stubGlobal(
      "fetch",
      reply(429, { error: { code: "rate", message: "Slow down." }, status: "rate" }),
    );
    const a = await submitAll();
    await send(a.container);
    expect(a.hook().status?.kind).toBe("rate");
    expect(q(a.container, '[data-testid="status"]').getAttribute("role")).toBe("alert");
    expect(document.activeElement).toBe(q(a.container, '[data-testid="status"]'));
    cleanup();

    vi.stubGlobal(
      "fetch",
      reply(422, {
        error: { code: "refused", message: "Not that trip." },
        status: "refused",
        reason: "trip-code.unknown_trip",
      }),
    );
    const b = await submitAll();
    await send(b.container);
    expect(b.hook().status).toMatchObject({
      kind: "refused",
      message: "Not that trip.",
      reason: "trip-code.unknown_trip",
    });
    expect(b.hook().current).toBe("trip"); // form-level: stays where it was
    expect(input(b.container, "notes").value).toBe("typed on step three");
  });

  it("reports a source_unavailable 503 with its code and message", async () => {
    vi.stubGlobal(
      "fetch",
      reply(503, {
        error: { code: "source_unavailable", message: "The list is unavailable." },
        status: "error",
      }),
    );
    const { container, hook } = await submitAll();
    await send(container);
    expect(hook().status).toMatchObject({
      kind: "error",
      code: "source_unavailable",
      message: "The list is unavailable.",
    });
  });

  it("turns a network failure into error and never resubmits", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("offline");
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container, hook } = await submitAll();
    await send(container);
    expect(hook().status?.kind).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hook().pending).toBe(false);
  });

  it("does not send when the client check fails", async () => {
    const fetchMock = reply(200, { ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const { container, hook } = mount(
      steppedForm({
        steps: undefined,
        fields: steppedForm().fields.map(({ step: _s, ...f }) => f),
      }),
    );
    await send(container);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hook().problems.length).toBeGreaterThan(0);
  });

  it("never lets an unavailable sourced list block the client", async () => {
    const fetchMock = reply(200, { ok: true, status: "ok", id: "r" });
    vi.stubGlobal("fetch", fetchMock);
    const form = baseForm({
      fields: [
        rf("pick", 0, {
          kind: "select",
          required: true,
          options: [{ value: "a", label: "A" }],
          optionsFrom: { source: "content", unavailable: true },
        }),
      ],
    });
    const { container, hook } = mount(form);
    await send(container);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hook().problems).toEqual([]);
  });
});

describe("native transport", () => {
  it("lets a passing submit through and stops a failing one", () => {
    const m = mount(
      steppedForm({
        steps: undefined,
        fields: steppedForm().fields.map(({ step: _s, ...f }) => f),
      }),
      {
        transport: "native",
      },
    );
    const form = q(m.container, "form");
    const failing = new Event("submit", { bubbles: true, cancelable: true });
    act(() => void form.dispatchEvent(failing));
    expect(failing.defaultPrevented).toBe(true);
    expect(m.hook().problems.length).toBeGreaterThan(0);

    finishAbout(m.container);
    fill(m.container, "phone", "0400 000 000");
    fill(m.container, "group_size", "2");
    pick(m.container, "interests", "birds");
    const passing = new Event("submit", { bubbles: true, cancelable: true });
    act(() => void form.dispatchEvent(passing));
    expect(passing.defaultPrevented).toBe(false);
  });
});

describe("degradation", () => {
  const throwing = () => {
    const bad = steppedForm();
    const field = bad.fields[1];
    if (!field) throw new Error("fixture");
    Object.defineProperty(field, "showIf", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    return bad;
  };

  it("falls back to the server render when the engine throws at mount", () => {
    const logged: unknown[][] = [];
    console.error = (...a: unknown[]) => void logged.push(a);
    const { container, hook } = mount(throwing());
    expect(hook().degraded).toBe(true);
    expect(logged).toHaveLength(1);
    expect(String(logged[0]?.[0])).toContain("folio/form");
    expect(hook().stepped).toBe(false);
    expect(container.querySelectorAll("[hidden]")).toHaveLength(0);
    expect(container.querySelectorAll("[data-folio-current]")).toHaveLength(0);
    expect(q(container, "form").hasAttribute("novalidate")).toBe(false);
    const ev = new Event("submit", { bubbles: true, cancelable: true });
    act(() => void q(container, "form").dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(false); // the browser posts
  });

  it("degrades and re-submits natively when the engine throws inside onSubmit", () => {
    const form = steppedForm();
    const { container, hook } = mount(form);
    expect(hook().degraded).toBe(false);
    const field = form.fields[0];
    if (!field) throw new Error("fixture");
    const el = q(container, "form") as HTMLFormElement;
    const requestSubmit = vi.fn(() => {
      // The now-inert handler lets this second submit through.
      const second = new Event("submit", { bubbles: true, cancelable: true });
      el.dispatchEvent(second);
      expect(second.defaultPrevented).toBe(false);
    });
    el.requestSubmit = requestSubmit;
    // The descriptor goes bad after mount, so the next read throws.
    Object.defineProperty(field, "kind", {
      get() {
        throw new Error("late boom");
      },
    });
    console.error = vi.fn();
    const first = new Event("submit", { bubbles: true, cancelable: true });
    act(() => void el.dispatchEvent(first));
    expect(first.defaultPrevented).toBe(true);
    expect(requestSubmit).toHaveBeenCalledTimes(1);
    expect(hook().degraded).toBe(true);
  });
});
