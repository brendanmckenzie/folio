/**
 * A rich-text chunk that fails to load (a stale tab after a deploy, a dropped
 * connection) is contained to its own field: the rest of the admin stays mounted and
 * the field offers a reload. There is no in-place retry, because a browser caches a
 * failed dynamic import in its module map and never re-requests it.
 */
import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LazyRichText } from "../../../../src/admin/ui/screens/fields/LazyRichText";

const props = {} as Parameters<typeof LazyRichText>[0];

afterEach(() => vi.unstubAllGlobals());

describe("LazyRichText", () => {
  it("contains a rejected import to the field and offers a reload", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    const load = vi.fn().mockRejectedValue(new Error("Unable to preload CSS"));
    const view = render(
      <div>
        <input aria-label="Title" />
        <LazyRichText {...props} load={load} />
      </div>,
    );
    const alert = await view.findByRole("alert");
    expect(alert.textContent).toContain("could not be loaded");
    expect(view.getByLabelText("Title")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Reload the page" }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
