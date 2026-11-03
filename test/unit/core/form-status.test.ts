import { describe, expect, it } from "vitest";
import {
  DEFAULT_STATUS_MESSAGES,
  readSubmitStatus,
  statusLocation,
  SUBMIT_STATUSES,
} from "../../../src/core/form-status";

const form = {
  name: "contact",
  fields: [{ name: "email" }, { name: "phone" }] as { name: string }[],
};

describe("readSubmitStatus", () => {
  it("answers null with no status", () => {
    expect(readSubmitStatus(form as never, "")).toBeNull();
    expect(readSubmitStatus(form as never, "?utm_source=x")).toBeNull();
  });

  it("reads every status", () => {
    for (const kind of SUBMIT_STATUSES) {
      expect(
        readSubmitStatus(form as never, `?folio_status=${kind}&folio_form=contact`)?.kind,
      ).toBe(kind);
    }
  });

  it("turns an unknown status into error", () => {
    expect(readSubmitStatus(form as never, "folio_status=wat")).toEqual({
      kind: "error",
      invalid: [],
      reason: null,
    });
  });

  it("belongs to another form when it names one, and to every form when it names none", () => {
    expect(readSubmitStatus(form as never, "folio_status=ok&folio_form=other")).toBeNull();
    expect(readSubmitStatus(form as never, "folio_status=error")?.kind).toBe("error");
  });

  it("keeps only invalid names that are this form's questions, and only for invalid", () => {
    const read = readSubmitStatus(
      form as never,
      "folio_status=invalid&folio_invalid=email,ghost,phone,email",
    );
    expect(read?.invalid).toEqual(["email", "phone"]);
    expect(
      readSubmitStatus(form as never, "folio_status=rate&folio_invalid=email")?.invalid,
    ).toEqual([]);
  });

  it("keeps a reason shaped like <action>.<code>, only for refused", () => {
    const base = "folio_status=refused&folio_reason=";
    expect(readSubmitStatus(form as never, `${base}trip-code.unknown_code`)?.reason).toBe(
      "trip-code.unknown_code",
    );
    for (const bad of ["Trip.code", "trip-code", "a.B", "<script>.x", ".x", "a.".padEnd(60, "x")]) {
      expect(
        readSubmitStatus(form as never, `${base}${encodeURIComponent(bad)}`)?.reason,
      ).toBeNull();
    }
    expect(
      readSubmitStatus(form as never, "folio_status=error&folio_reason=a.b")?.reason,
    ).toBeNull();
  });

  it("accepts URLSearchParams", () => {
    expect(readSubmitStatus(form as never, new URLSearchParams({ folio_status: "ok" }))?.kind).toBe(
      "ok",
    );
  });
});

describe("statusLocation", () => {
  const base = "https://example.com/contact?a=1";

  it("resolves the target against the base and sets the status first", () => {
    expect(statusLocation("/thanks", base, { kind: "ok", form: "contact" })).toBe(
      "https://example.com/thanks?folio_status=ok&folio_form=contact",
    );
  });

  it("carries invalid names and a refusal reason, and only where they apply", () => {
    expect(statusLocation("/c", base, { kind: "invalid", form: "f", invalid: ["a", "b"] })).toBe(
      "https://example.com/c?folio_status=invalid&folio_form=f&folio_invalid=a%2Cb",
    );
    expect(statusLocation("/c", base, { kind: "refused", form: "f", reason: "x.y" })).toBe(
      "https://example.com/c?folio_status=refused&folio_form=f&folio_reason=x.y",
    );
    expect(statusLocation("/c", base, { kind: "rate", reason: "x.y" })).toBe(
      "https://example.com/c?folio_status=rate",
    );
  });

  it("keeps the target's own query and replaces a stale status", () => {
    expect(statusLocation("/c?utm=1&folio_status=ok", base, { kind: "error", form: "f" })).toBe(
      "https://example.com/c?utm=1&folio_status=error&folio_form=f",
    );
  });

  it("round-trips through readSubmitStatus", () => {
    const url = new URL(
      statusLocation("/c", base, { kind: "invalid", form: "contact", invalid: ["email"] }),
    );
    expect(readSubmitStatus(form as never, url.search)).toEqual({
      kind: "invalid",
      invalid: ["email"],
      reason: null,
    });
  });
});

describe("DEFAULT_STATUS_MESSAGES", () => {
  it("has a sentence for every status but ok", () => {
    expect(Object.keys(DEFAULT_STATUS_MESSAGES).sort()).toEqual(
      SUBMIT_STATUSES.filter((s) => s !== "ok").sort(),
    );
  });
});
