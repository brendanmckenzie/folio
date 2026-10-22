import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useServerResolution } from "../../../../src/admin/hooks/useServerResolution";
import type { Doc } from "../../../../src/core/doc";
import type { BlockSchema, SchemaIndex } from "../../../../src/core/schema";

/**
 * When the editor asks the server for its resolution. The server resolves its own
 * copy of the draft, so the claims are about *timing*: never while this client has
 * transactions the server has not acknowledged, once when it has, and not again for
 * an unchanged id set however often `idle` flips (every keystroke flips it).
 */

const linky: BlockSchema = {
  name: "linky",
  label: "Linky",
  fields: { title: { kind: "text" }, author: { kind: "reference" } },
};
const schema: SchemaIndex = { linky };

const docWith = (data: Record<string, unknown>): Doc => ({
  root: "r",
  bloks: {
    r: {
      uid: "r",
      type: "linky",
      parent: null,
      slot: null,
      order: "a0",
      data: data as Doc["bloks"][string]["data"],
    },
  },
});

const RESOLUTION = { stories: {}, assetBase: "/folio/asset" };

function stubFetch() {
  const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(RESOLUTION)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

const props = (over: Partial<Parameters<typeof useServerResolution>[0]> = {}) => ({
  apiBase: "/folio/~shared/api",
  site: "alpha",
  idle: true,
  storyId: "sty_1",
  doc: docWith({ title: "a" }),
  schema,
  locale: undefined,
  localeCtx: undefined,
  place: "p",
  ...over,
});

describe("useServerResolution", () => {
  it("asks on the admin's own mount and names the pane site", async () => {
    const fetchMock = stubFetch();
    const { result } = renderHook((p) => useServerResolution(p), { initialProps: props() });
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/folio/~shared/api/story/sty_1/resolution?site=alpha",
    );
  });

  it("waits for the server to acknowledge a pending edit, then asks once", async () => {
    const fetchMock = stubFetch();
    const first = docWith({ title: "a" });
    const { result, rerender } = renderHook((p) => useServerResolution(p), {
      initialProps: props({ doc: first }),
    });
    await waitFor(() => expect(result.current).not.toBeNull());
    fetchMock.mockClear();

    // A reference is picked and the transaction is still in flight.
    const picked = docWith({ title: "a", author: "sty_2" });
    rerender(props({ doc: picked, idle: false }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(fetchMock).not.toHaveBeenCalled();

    // The object acknowledges it: now the server's draft holds the id.
    rerender(props({ doc: picked, idle: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("does not ask again when only a text value changes and idle flips", async () => {
    const fetchMock = stubFetch();
    const { result, rerender } = renderHook((p) => useServerResolution(p), {
      initialProps: props(),
    });
    await waitFor(() => expect(result.current).not.toBeNull());
    fetchMock.mockClear();

    rerender(props({ doc: docWith({ title: "ab" }), idle: false }));
    rerender(props({ doc: docWith({ title: "ab" }), idle: true }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry a refusal at the next pause, only when the signature moves", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = renderHook((p) => useServerResolution(p), { initialProps: props() });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender(props({ idle: false }));
    rerender(props({ idle: true }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rerender(props({ doc: docWith({ title: "a", author: "sty_2" }) }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
