/**
 * The submit round trip's vocabulary, in core so the route that writes it and the
 * code that reads it cannot drift (`../../docs/specs/content-model/form-steps.md`
 * decision 10).
 *
 * Six tokens plus success, because a host has something different and true to say
 * about each: a closed form is not a validation error, a rate limit is not a captcha
 * failure, and telling a genuine visitor behind a shared NAT that their message was
 * "invalid" is the one wrong answer available. `folio_status`, `folio_form`,
 * `folio_invalid` and `folio_reason` name nothing personal, which is what keeps a
 * redirect target a cacheable page.
 */
import { DEFAULT_ERROR_MESSAGE } from "./form-actions";
import type { ResolvedForm } from "./forms";

export const SUBMIT_STATUSES = [
  "ok",
  "invalid",
  "closed",
  "rate",
  "verify",
  "error",
  "refused",
] as const;

export type SubmitStatus = (typeof SUBMIT_STATUSES)[number];

/** The English sentences the submit route answers a JSON refusal with, and a host's
 *  fallback when it writes none of its own. `refused` does not tell a visitor to
 *  retry something that will be refused again. */
export const DEFAULT_STATUS_MESSAGES: Readonly<Record<Exclude<SubmitStatus, "ok">, string>> = {
  invalid: "Some answers need another look.",
  closed: "This form is closed.",
  rate: "Too many submissions from this address. Try again later.",
  verify: "We could not verify that submission.",
  error: DEFAULT_ERROR_MESSAGE,
  refused: "We could not accept that submission.",
};

export interface SubmitStatusRead {
  kind: SubmitStatus;
  /** Questions on this form the server refused. `invalid` only. */
  invalid: readonly string[];
  /** `<action>.<code>`. `refused` only, and only if it is shaped like one. */
  reason: string | null;
}

/** spec 36's `ACTION_ID` and `ACTION_CODE`, joined: the shape of a `folio_reason`. */
const REASON = /^[a-z][a-z0-9-]{0,47}\.[a-z][a-z0-9_]{0,31}$/;

const isStatus = (value: string): value is SubmitStatus =>
  (SUBMIT_STATUSES as readonly string[]).includes(value);

/**
 * What the page's query string says happened to a submission of `form`, or `null`.
 *
 * A status naming another form belongs to that form. A status with no `folio_form`
 * belongs to every form on the page: the route omits it only when it could not
 * identify the form at all, and a deleted form should say something. An unknown
 * `folio_status` is `error`. Nothing here is echoed: `invalid` is filtered to names
 * that are questions on this form, and `reason` to the shape of an identifier pair.
 */
export function readSubmitStatus(
  form: Pick<ResolvedForm, "name" | "fields">,
  search: string | URLSearchParams,
): SubmitStatusRead | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const raw = params.get("folio_status");
  if (!raw) return null;
  const named = params.get("folio_form");
  if (named && named !== form.name) return null;

  const kind = isStatus(raw) ? raw : "error";
  let invalid: string[] = [];
  if (kind === "invalid") {
    const known = new Set(form.fields.map((f) => f.name));
    invalid = [
      ...new Set((params.get("folio_invalid") ?? "").split(",").filter((n) => known.has(n))),
    ];
  }
  const reason = params.get("folio_reason");
  return {
    kind,
    invalid,
    reason: kind === "refused" && reason !== null && REASON.test(reason) ? reason : null,
  };
}

/**
 * The absolute URL a native submission lands on: `target` resolved against `base`,
 * with `folio_status`, then `folio_form`, then `folio_invalid` and `folio_reason`
 * when present. The submit route's 303 and a script's own navigation after a JSON
 * success build it here, so the two transports cannot land on different ones.
 */
export function statusLocation(
  target: string,
  base: string,
  result: { kind: SubmitStatus; form?: string; invalid?: readonly string[]; reason?: string },
): string {
  const url = new URL(target, base);
  url.searchParams.set("folio_status", result.kind);
  if (result.form) url.searchParams.set("folio_form", result.form);
  if (result.invalid?.length) url.searchParams.set("folio_invalid", result.invalid.join(","));
  // The reason is identifiers from code, never text or a per-submission value, so a
  // refused page stays as cacheable as `?folio_status=ok`.
  if (result.kind === "refused" && result.reason) {
    url.searchParams.set("folio_reason", result.reason);
  }
  return url.toString();
}
