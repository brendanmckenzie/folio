import { describe, expect, it } from "vitest";
import type { FormActionInfo } from "../../../src/core/form-actions";
import type { FormField } from "../../../src/core/forms";
import {
  attentionLines,
  canRetryDelivery,
  DELIVERY_ATTEMPTS,
  type DeliveryRow,
  deliveryBadges,
  deliveryDetail,
  deliveryStatusText,
  failedBanner,
  failureText,
  isNarrowed,
  nextAttemptText,
  OVERDUE_BANNER,
  parseResponsesUrl,
  responsesBanners,
  responsesParams,
  responsesQuery,
  retryHref,
  retryNotice,
} from "../../../src/admin/ui/screens/responses-model";

/**
 * Deliveries on the Responses screen (`form-actions.md` decisions 15 and 21): the
 * status and category phrasing, what the drawer may show of an action's words, when
 * Retry is offered, the filter and the three banners.
 */

const NOW = Date.UTC(2026, 10, 3, 12);
const row = (over: Partial<DeliveryRow> = {}): DeliveryRow => ({
  action: "jambo",
  status: "failed",
  attempts: 1,
  nextAt: null,
  reference: null,
  failure: "threw",
  detail: null,
  createdAt: NOW - 1000,
  updatedAt: NOW,
  ...over,
});

describe("status text", () => {
  it("reads each state in the cell's words", () => {
    expect(deliveryStatusText({ status: "delivered", attempts: 1 })).toBe("Delivered");
    expect(deliveryStatusText({ status: "failed", attempts: 8 })).toBe("Failed");
    expect(deliveryStatusText({ status: "skipped", attempts: 1 })).toBe("Skipped");
    expect(deliveryStatusText({ status: "cancelled", attempts: 0 })).toBe("Cancelled");
    expect(deliveryStatusText({ status: "pending", attempts: 3 })).toBe(
      `Retrying (3 of ${DELIVERY_ATTEMPTS})`,
    );
    expect(deliveryStatusText({ status: "pending", attempts: 0 })).toBe("Queued");
  });

  it("names the action in a badge only when there are several", () => {
    const label = (a: string) => (a === "jambo" ? "File in Jambo" : a);
    const one = deliveryBadges([{ action: "jambo", status: "delivered", attempts: 1 }], label);
    expect(one[0]?.text).toBe("Delivered");
    expect(one[0]?.title).toBe("File in Jambo: Delivered");
    const two = deliveryBadges(
      [
        { action: "jambo", status: "failed", attempts: 8 },
        { action: "mailer", status: "delivered", attempts: 1 },
      ],
      label,
    );
    expect(two.map((b) => b.text)).toEqual(["File in Jambo: Failed", "mailer: Delivered"]);
    expect(two.map((b) => b.tone)).toEqual(["danger", "ok"]);
    expect(deliveryBadges(undefined, label)).toEqual([]);
  });
});

describe("category phrasing never shows a thrown message", () => {
  it("phrases a thrown failure as a pointer to the logs", () => {
    expect(failureText("threw")).toBe(
      "The action threw an error. Details are in the Worker's logs.",
    );
  });

  it("refuses a detail on a thrown, timed-out or malformed failure, even if one is present", () => {
    const leaked = "fetch failed: https://api.vendor.example/v1?key=SECRET";
    for (const failure of ["threw", "timeout", "malformed", "gave_up", "no_brand"] as const) {
      expect(deliveryDetail(row({ failure, detail: leaked }))).toBeNull();
    }
    expect(deliveryDetail(row({ status: "pending", failure: "threw", detail: leaked }))).toBeNull();
  });

  it("shows the action's own words for a refusal and for a skip", () => {
    expect(deliveryDetail(row({ failure: "refused", detail: "List id 9 is closed" }))).toBe(
      "List id 9 is closed",
    );
    expect(
      deliveryDetail(row({ status: "skipped", failure: null, detail: "Not a production host" })),
    ).toBe("Not a production host");
    expect(deliveryDetail(row({ status: "skipped", failure: null, detail: "" }))).toBeNull();
  });

  it("phrases every category and an unknown one without echoing it", () => {
    for (const c of [
      "threw",
      "timeout",
      "malformed",
      "refused",
      "not_registered",
      "incomplete",
      "predates_mapping",
      "no_brand",
      "gave_up",
    ] as const) {
      expect(failureText(c)?.length).toBeGreaterThan(10);
    }
    expect(failureText(null)).toBeNull();
    expect(failureText("secret-token" as never)).toBe("The delivery failed.");
  });
});

describe("Retry", () => {
  it("is offered for failed and skipped, and for a pending row that is due", () => {
    expect(canRetryDelivery(row(), NOW)).toBe(true);
    expect(canRetryDelivery(row({ status: "skipped", failure: null }), NOW)).toBe(true);
    expect(canRetryDelivery(row({ status: "pending", nextAt: NOW - 1 }), NOW)).toBe(true);
  });

  it("is not offered while backing off, once delivered or cancelled, or for predates_mapping", () => {
    expect(canRetryDelivery(row({ status: "pending", nextAt: NOW + 60_000 }), NOW)).toBe(false);
    expect(canRetryDelivery(row({ status: "delivered", failure: null }), NOW)).toBe(false);
    expect(canRetryDelivery(row({ status: "cancelled", failure: null }), NOW)).toBe(false);
    expect(canRetryDelivery(row({ failure: "predates_mapping" }), NOW)).toBe(false);
  });

  it("posts to the route, encoding both ids", () => {
    expect(retryHref("/folio/api", "frm_1", "res_2", "file-in-jambo")).toBe(
      "/folio/api/forms/frm_1/responses/res_2/deliveries/file-in-jambo/retry",
    );
    expect(retryHref("/a", "f/1", "r 2", "x")).toBe(
      "/a/forms/f%2F1/responses/r%202/deliveries/x/retry",
    );
  });

  it("says how the inline attempt went, never quoting a failure", () => {
    expect(retryNotice("Jambo", row({ status: "delivered", failure: null }))).toBe(
      "Jambo: delivered.",
    );
    expect(retryNotice("Jambo", row({ status: "pending" }))).toContain("tried again");
    expect(retryNotice("Jambo", row({ failure: "threw" }))).toContain(
      "Details are in the Worker's logs.",
    );
  });

  it("times the next attempt", () => {
    expect(nextAttemptText(row({ status: "pending", nextAt: NOW + 5 * 60_000 }), NOW)).toBe(
      "in 5m",
    );
    expect(nextAttemptText(row({ status: "pending", nextAt: NOW - 1 }), NOW)).toBe("due now");
    expect(nextAttemptText(row({ status: "pending", nextAt: NOW + 3 * 3_600_000 }), NOW)).toBe(
      "in 3h",
    );
    expect(nextAttemptText(row(), NOW)).toBeNull();
  });
});

describe("the delivery filter", () => {
  it("round trips through the URL and the request", () => {
    const url = parseResponsesUrl({ delivery: "failed", q: "ada" });
    expect(url.delivery).toBe("failed");
    expect(responsesQuery(url).delivery).toBe("failed");
    expect(responsesParams(url, { limit: 50 }).get("delivery")).toBe("failed");
    expect(isNarrowed(url)).toBe(true);
  });

  it("drops a value the route would refuse", () => {
    const url = parseResponsesUrl({ delivery: "delivered" });
    expect(url.delivery).toBeUndefined();
    expect(responsesParams(url, { limit: 50 }).has("delivery")).toBe(false);
    expect(isNarrowed(url)).toBe(false);
  });
});

describe("banners", () => {
  it("counts failed deliveries, singular and plural, and says nothing for none", () => {
    expect(failedBanner(0)).toBeNull();
    expect(failedBanner(undefined)).toBeNull();
    expect(failedBanner(1)).toBe("1 delivery failed.");
    expect(failedBanner(3)).toBe("3 deliveries failed.");
  });

  it("hides the failed banner once the list is already filtered to failed", () => {
    const base = { failedDeliveries: 3, overdueDeliveries: 0, attention: [] };
    expect(responsesBanners({ ...base, filter: undefined }).map((b) => b.kind)).toEqual(["failed"]);
    expect(responsesBanners({ ...base, filter: "failed" })).toEqual([]);
  });

  it("says retries are not running when any are overdue", () => {
    const out = responsesBanners({
      failedDeliveries: 0,
      overdueDeliveries: 2,
      filter: undefined,
      attention: [],
    });
    expect(out).toEqual([{ kind: "overdue", text: OVERDUE_BANNER }]);
    expect(OVERDUE_BANNER).toContain("folio.runSchedules()");
  });

  it("names an attachment that needs attention, with its problem, and skips an unregistered one", () => {
    const info: FormActionInfo = {
      id: "jambo",
      label: "File in Jambo",
      inputs: [{ name: "email", kind: "email", label: "Email", required: true }],
      settings: {},
      codes: [],
      check: true,
      deliver: true,
    };
    const infos = new Map([[info.id, info]]);
    const fields = [
      { name: "email", kind: "email", label: "Email", required: true },
    ] as FormField[];
    expect(
      attentionLines([{ action: "jambo", map: { email: "email" } }], infos, fields, {}),
    ).toEqual([]);
    const lines = attentionLines([{ action: "jambo" }, { action: "gone" }], infos, fields, {});
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain("File in Jambo needs attention: Email needs a question");
    expect(lines[0]?.text).toContain("Visitors are being refused");
    expect(
      responsesBanners({
        failedDeliveries: 0,
        overdueDeliveries: 0,
        filter: undefined,
        attention: lines,
      })[0]?.kind,
    ).toBe("attention");
  });
});
