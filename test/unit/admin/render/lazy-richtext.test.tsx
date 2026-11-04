/**
 * A rich-text chunk that fails to load (a stale tab after a deploy, a dropped
 * connection) is contained to its own field: the rest of the admin stays mounted, the
 * field says what happened, and Retry asks for the chunk again rather than replaying
 * `React.lazy`'s cached rejection.
 */
import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LazyRichText } from "../../../../src/admin/ui/screens/fields/LazyRichText";

const Stub = () => <div data-testid="editor" />;
const props = {} as Parameters<typeof LazyRichText>[0];

describe("LazyRichText", () => {
  it("contains a rejected import to the field, and Retry re-issues it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("Unable to preload CSS"))
      .mockResolvedValueOnce({ RichTextField: Stub });
    const view = render(
      <div>
        <input aria-label="Title" />
        <LazyRichText {...props} load={load} />
      </div>,
    );
    const alert = await view.findByRole("alert");
    expect(alert.textContent).toContain("could not be loaded");
    expect(view.getByLabelText("Title")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(view.getByTestId("editor")).toBeTruthy());
    expect(load).toHaveBeenCalledTimes(2);
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.getByLabelText("Title")).toBeTruthy();
  });
});
