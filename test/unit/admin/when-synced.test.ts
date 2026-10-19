import { describe, expect, it, vi } from "vitest";
import { whenSynced } from "../../../src/admin/hooks/useVersions";

/** A store stand-in: only the two members `whenSynced` reads. */
function fakeStore(inflight: number) {
  const listeners = new Set<() => void>();
  const state = { inflight };
  return {
    store: {
      getSnapshot: () => state as never,
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    ack: () => {
      state.inflight = 0;
      for (const fn of listeners) fn();
    },
    listeners,
  };
}

describe("whenSynced", () => {
  it("resolves at once when nothing is in flight", async () => {
    await expect(whenSynced(fakeStore(0).store)).resolves.toBeUndefined();
  });

  it("waits for the last acknowledgement, then unsubscribes", async () => {
    const f = fakeStore(2);
    let done = false;
    const p = whenSynced(f.store).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    f.ack();
    await p;
    expect(done).toBe(true);
    expect(f.listeners.size).toBe(0);
  });

  it("gives up after the bound rather than hanging an offline editor", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeStore(1);
      const p = whenSynced(f.store, 5000);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(p).resolves.toBeUndefined();
      expect(f.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
