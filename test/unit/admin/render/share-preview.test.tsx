/**
 * "Share a preview" as a person meets it: the button's three states in the editor's
 * top bar, and the dialog's one-time display of the link.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";
import type { Me } from "../../../../src/admin/me";
import { OneTimeSecretDialog } from "../../../../src/admin/ui/screens/OneTimeSecretDialog";
import { SharePreview } from "../../../../src/admin/ui/screens/SharePreview";
import { ADMIN, API, mountAt, OPEN, VIEWER } from "./fixture";

const EDITOR: Me = { ...ADMIN, actor: { ...ADMIN.actor, role: "editor" } as Me["actor"] };

const button = () => screen.getByRole("button", { name: "Share a preview" }) as HTMLButtonElement;

describe("the Share a preview button", () => {
  it("is enabled on a routed page for someone who may publish", async () => {
    await mountAt("/folio/edit/sty_home", ADMIN);
    expect(button().disabled).toBe(false);
  });

  it("is enabled with no accounts at all", async () => {
    await mountAt("/folio/edit/sty_home", OPEN);
    expect(button().disabled).toBe(false);
  });

  it("is disabled for an editor, and says they may not publish", async () => {
    await mountAt("/folio/edit/sty_home", EDITOR);
    expect(button().disabled).toBe(true);
    expect(button().title).toBe("Your role (editor) may not publish");
  });

  it("is disabled for a viewer with the same reason", async () => {
    await mountAt("/folio/edit/sty_home", VIEWER);
    expect(button().disabled).toBe(true);
    expect(button().title).toMatch(/may not publish/);
  });

  it("is disabled on a document with no page, and says so", async () => {
    await mountAt("/folio/edit/sng_header", ADMIN);
    expect(button().disabled).toBe(true);
    expect(button().title).toMatch(/no page/);
  });
});

/** A fetch that answers the share list and the create route, and records calls. */
function serveShares(url: string) {
  const asked: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    asked.push(`${init?.method ?? "GET"} ${path}${init?.body ? ` ${init.body}` : ""}`);
    const body = init?.method === "POST" ? { url, share: {} } : { shares: [], cursor: null };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: init?.method === "POST" ? 201 : 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return asked;
}

const flush = async () => {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

describe("the share dialog", () => {
  const URL_ONCE = "https://preview.example/folio/share?t=abc123";

  it("creates through the scoped base and shows the link once, with a copy button", async () => {
    const asked = serveShares(URL_ONCE);
    const scoped = "/folio/~alpha/api";
    render(
      <SharePreview
        apiBase={scoped}
        story={{ id: "sty_home", title: "Home" }}
        selfId="usr_a"
        onClose={() => {}}
        onNotice={() => {}}
      />,
    );
    await flush();
    // The list is read through the scoped base, filtered to this story's live links.
    expect(asked[0]).toBe(`GET ${scoped}/shares?limit=50&count=1&story=sty_home&state=live`);
    // Nothing shows the link before it is made.
    expect(screen.queryByText(URL_ONCE)).toBeNull();

    fireEvent.change(screen.getByLabelText("Note"), { target: { value: "For Rachel" } });
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await flush();

    expect(asked).toContain(
      `POST ${scoped}/story/sty_home/share {"expiresInDays":7,"note":"For Rachel"}`,
    );
    expect(screen.getByText(URL_ONCE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(screen.getByText(/cannot be shown again/)).toBeTruthy();

    // Done closes it for good: the link is not in the list that comes back.
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await flush();
    expect(screen.queryByText(URL_ONCE)).toBeNull();
    expect(screen.getByRole("button", { name: "Create link" })).toBeTruthy();
  });

  it("refuses a day count outside 1 to 90 before asking the server", async () => {
    const asked = serveShares(URL_ONCE);
    render(
      <SharePreview
        apiBase={API}
        story={{ id: "sty_home", title: "Home" }}
        selfId={null}
        onClose={() => {}}
        onNotice={() => {}}
      />,
    );
    await flush();
    fireEvent.change(screen.getByLabelText("Works for (days)"), { target: { value: "120" } });
    const create = screen.getByRole("button", { name: "Create link" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(asked.filter((a) => a.startsWith("POST"))).toEqual([]);
  });
});

describe("OneTimeSecretDialog", () => {
  it("shows the secret and what it is for, and Done dismisses it", async () => {
    let closed = false;
    render(
      <OneTimeSecretDialog title="Copy this now" secret="s3cret" onClose={() => (closed = true)}>
        <p>About it</p>
      </OneTimeSecretDialog>,
    );
    expect(screen.getByText("s3cret")).toBeTruthy();
    expect(screen.getByText("About it")).toBeTruthy();
    expect(screen.getByText("This is the only time it is shown.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(closed).toBe(true);
  });
});
