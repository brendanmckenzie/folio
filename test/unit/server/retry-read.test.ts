import { afterEach, describe, expect, it, vi } from "vitest";
import { retryRead } from "../../../src/server/db";

const internal = () => new Error("D1_ERROR: internal error; reference = abc123");

describe("retryRead", () => {
  afterEach(() => vi.restoreAllMocks());

  it("answers the retry's result when the first attempt hits an internal error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const read = vi.fn().mockRejectedValueOnce(internal()).mockResolvedValueOnce("rows");
    await expect(retryRead(read, { delayMs: 1 })).resolves.toBe("rows");
    expect(read).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("matches an internal error carried on the cause", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("D1 failed", { cause: internal() }))
      .mockResolvedValueOnce(1);
    await expect(retryRead(read, { delayMs: 1 })).resolves.toBe(1);
  });

  it("retries exactly once, then rejects", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const read = vi.fn().mockRejectedValue(internal());
    await expect(retryRead(read, { delayMs: 1 })).rejects.toThrow("internal error");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([
    "D1_ERROR: UNIQUE constraint failed: stories.id",
    "D1_ERROR: too many SQL variables",
    'D1_ERROR: near "selec": syntax error',
  ])("does not retry a deterministic error: %s", async (message) => {
    const read = vi.fn().mockRejectedValue(new Error(message));
    await expect(retryRead(read, { delayMs: 1 })).rejects.toThrow(message);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not delay a success", async () => {
    const read = vi.fn().mockResolvedValue("ok");
    await expect(retryRead(read)).resolves.toBe("ok");
    expect(read).toHaveBeenCalledTimes(1);
  });
});
