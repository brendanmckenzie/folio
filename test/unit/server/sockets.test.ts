import { describe, expect, it, vi } from "vitest";
import type { FolioDb } from "../../../src/server/db";
import { liveSession, SESSION_RECHECK_MS, type SocketSession } from "../../../src/server/sockets";

describe("liveSession", () => {
  it("keeps the socket open and logs a warning, not an error, when the D1 re-check throws", async () => {
    const cause = new Error("D1_ERROR: network connection lost");
    const db = {
      prepare: () => {
        throw cause;
      },
    } as unknown as FolioDb;
    const now = Date.now();
    const a: SocketSession = {
      verified: true,
      session: "s1",
      expiresAt: now + 3_600_000,
      checkedAt: now - SESSION_RECHECK_MS - 1,
    };
    const close = vi.fn();
    const ws = { close, serializeAttachment: vi.fn() } as unknown as WebSocket;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const kept = await liveSession(db, ws, a, "space-do");

    expect(kept).not.toBeNull();
    expect(kept?.checkedAt).toBeGreaterThanOrEqual(now);
    expect(close).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "space-do: could not re-check a session; keeping the socket open",
      cause,
    );
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });
});
