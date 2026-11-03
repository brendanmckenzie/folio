// Exercises content-model/form-actions.md end to end against a live dev server: a
// publisher attaches the demo's two actions to a form, a stranger is refused by the
// `demo-guard` check and then accepted, the `demo-webhook` delivery fails and is retried
// from Responses, a rename carries the mapping, and deleting the response takes its
// delivery with it.
//
// What `pnpm test` cannot see, and this can: the demo Worker's real `formAction`
// definitions, the real registry route the builder reads, a native `<form>` POST landing
// on `folio_status=refused&folio_reason=...`, and a first delivery attempt made on the
// submit path with `waitUntil` in a real Worker.
//
// In order:
//   1. the registry lists both actions, with a `blocked` code and the implicit `error`;
//   2. attaching them needs the mapping (an unmapped required input is a 400);
//   3. a blocked address is refused with a code and stores nothing; a clean one is accepted;
//   4. the accepted response has one pending delivery that `threw`, with no detail;
//   5. turning `fail` off and pressing Retry delivers it;
//   6. renaming the mapped question moves the mapping with it;
//   7. deleting the response deletes its delivery.
//
// No socket is opened. `signInGlobally()` is the editor; every visitor request goes
// through `realFetch`, which carries no cookie.
import "./lib/ts-resolve.mjs";
import { signInGlobally } from "./lib/auth.mjs";

const { realFetch } = await signInGlobally();

const HTTP = "http://localhost:5199";
const BASE = `${HTTP}/folio`;
const API = `${BASE}/api`;

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (url, init) => fetch(url, init).then((r) => r.json());
const post = (path, body) =>
  json(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const patch = (path, body) =>
  fetch(`${API}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** A native `<form>` POST from a stranger: a 303 whose query is the whole answer. */
const submit = (formId, fields) =>
  realFetch(`${BASE}/f/${formId}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html,application/xhtml+xml",
    },
    body: new URLSearchParams(fields).toString(),
  });
const statusOf = (res) => new URL(res.headers.get("location"), HTTP).searchParams;

/** Polls until `ready(value)` holds; the first delivery runs after the reply. */
async function until(read, ready, ms = 8000) {
  const stop = Date.now() + ms;
  let last;
  while (Date.now() < stop) {
    last = await read();
    if (ready(last)) return last;
    await wait(200);
  }
  return last;
}

/* --- the registry --------------------------------------------------------- */

const registry = await json(`${API}/forms/registry`);
const guardInfo = registry.actions?.find((a) => a.id === "demo-guard");
const hookInfo = registry.actions?.find((a) => a.id === "demo-webhook");
check(
  "the registry lists the demo's two actions, JSON only",
  Boolean(guardInfo && hookInfo) && !JSON.stringify(registry).includes("function"),
  registry.actions?.map((a) => a.id).join(),
);
check(
  "a check's codes are its own plus the implicit error",
  guardInfo?.codes
    ?.map((c) => c.code)
    .sort()
    .join() === "blocked,error",
  JSON.stringify(guardInfo?.codes),
);

/* --- a form, and attaching the actions ------------------------------------ */

const created = await post("/forms", { label: "Actions E2E" });
const built = await patch(`/forms/${created.id}`, {
  expectedUpdatedAt: created.updatedAt,
  fields: [
    { name: "name", kind: "text", label: "Your name", required: true, max: 80 },
    { name: "email", kind: "email", label: "Email", required: true },
  ],
}).then((r) => r.json());

const unmapped = await patch(`/forms/${created.id}`, {
  expectedUpdatedAt: built.updatedAt,
  actions: [{ action: "demo-guard", map: {}, messages: { blocked: "Not that address." } }],
});
const unmappedBody = await unmapped.json();
check(
  "attaching an action with a required input unmapped is refused",
  unmapped.status === 400,
  `${unmapped.status} ${JSON.stringify(unmappedBody.error?.message ?? unmappedBody)}`,
);

const attachedRes = await patch(`/forms/${created.id}`, {
  expectedUpdatedAt: built.updatedAt,
  actions: [
    {
      action: "demo-guard",
      map: { email: "email" },
      messages: { blocked: "Not that address." },
    },
    {
      action: "demo-webhook",
      map: { email: "email", name: "name" },
      settings: { fail: true },
    },
  ],
});
const attached = await attachedRes.json();
check(
  "mapping every required input lets both actions attach",
  attachedRes.status === 200 && attached.actions?.length === 2,
  `status=${attachedRes.status}`,
);
check(
  "the server stamps that the webhook delivers, and the guard does not",
  attached.actions?.find((a) => a.action === "demo-webhook")?.delivers === true &&
    !attached.actions?.find((a) => a.action === "demo-guard")?.delivers,
);

const descriptor = (await json(`${API}/forms/resolved?ids=${created.id}`))[created.id];
check(
  "the page-facing descriptor carries the editor's refusal text and never the mapping",
  descriptor?.refusals?.["demo-guard.blocked"] === "Not that address." &&
    !JSON.stringify(descriptor).includes("demo-webhook"),
  JSON.stringify(descriptor?.refusals),
);

/* --- a blocked address is refused, a clean one accepted --------------------- */

const blocked = await submit(created.id, { name: "Mallory", email: "mallory@blocked.example" });
const blockedQuery = statusOf(blocked);
check(
  "a blocked address is refused with the action's own code",
  blocked.status === 303 &&
    blockedQuery.get("folio_status") === "refused" &&
    blockedQuery.get("folio_reason") === "demo-guard.blocked",
  blocked.headers.get("location"),
);
check(
  "the redirect names no address and no message text",
  !blocked.headers.get("location").includes("mallory") &&
    !blocked.headers.get("location").includes("Not+that"),
);
const afterBlocked = await json(`${API}/forms/${created.id}/responses?count=1`);
check(
  "a refused attempt stores no response",
  afterBlocked.rows.length === 0,
  `${afterBlocked.rows.length} row(s)`,
);

const clean = await submit(created.id, { name: "Ada", email: "ada@example.com" });
check(
  "a clean address is accepted",
  clean.status === 303 && statusOf(clean).get("folio_status") === "ok",
  clean.headers.get("location"),
);

/* --- the delivery ----------------------------------------------------------- */

const rows = await json(`${API}/forms/${created.id}/responses`).then((p) => p.rows);
const row = rows[0];
check("the accepted submission is the only stored response", rows.length === 1);

const detail = await until(
  () => json(`${API}/forms/${created.id}/responses/${row.id}`),
  (d) => d.deliveries?.[0]?.failure === "threw",
);
const delivery = detail.deliveries?.[0];
check(
  "the response has one pending delivery that threw, with no detail to show",
  detail.deliveries?.length === 1 &&
    delivery.action === "demo-webhook" &&
    delivery.status === "pending" &&
    delivery.failure === "threw" &&
    delivery.attempts === 1 &&
    !delivery.detail,
  JSON.stringify(delivery),
);
check("the thrown message reaches no editor", !JSON.stringify(detail).includes("set to fail"));

const waiting = await json(`${API}/forms/${created.id}/responses?count=1&delivery=pending`);
check(
  "Responses filters to the waiting retry, and it is not yet a failure",
  waiting.rows.length === 1 && waiting.failedDeliveries === 0,
  JSON.stringify({ failed: waiting.failedDeliveries }),
);

/* --- turn the failure off and Retry ------------------------------------------ */

const current = await json(`${API}/forms/${created.id}`);
const fixed = await patch(`/forms/${created.id}`, {
  expectedUpdatedAt: current.updatedAt,
  actions: current.actions.map((a) =>
    a.action === "demo-webhook" ? { ...a, settings: { ...a.settings, fail: false } } : a,
  ),
});
check("the Fail setting turns off", fixed.status === 200, `status=${fixed.status}`);

const retried = await fetch(
  `${API}/forms/${created.id}/responses/${row.id}/deliveries/demo-webhook/retry`,
  { method: "POST" },
);
const retriedBody = await retried.json();
check(
  "Retry makes one inline attempt with the fixed setting, and it is delivered",
  retried.status === 200 && retriedBody.delivery?.status === "delivered",
  `${retried.status} ${JSON.stringify(retriedBody.delivery)}`,
);

const again = await fetch(
  `${API}/forms/${created.id}/responses/${row.id}/deliveries/demo-webhook/retry`,
  { method: "POST" },
);
check("a delivered row cannot be retried again", again.status === 409, `status=${again.status}`);

const unknown = await fetch(
  `${API}/forms/${created.id}/responses/${row.id}/deliveries/demo-guard/retry`,
  { method: "POST" },
);
check(
  "an action that never delivered has no row to retry",
  unknown.status === 404,
  `status=${unknown.status}`,
);

const anon = await realFetch(
  `${API}/forms/${created.id}/responses/${row.id}/deliveries/demo-webhook/retry`,
  { method: "POST" },
);
check(
  "an anonymous Retry is refused",
  anon.status === 401 || anon.status === 403,
  `status=${anon.status}`,
);

/* --- a rename carries the mapping -------------------------------------------- */

const beforeRename = await json(`${API}/forms/${created.id}`);
const renamed = await patch(`/forms/${created.id}`, {
  expectedUpdatedAt: beforeRename.updatedAt,
  fields: beforeRename.fields.map((f) => (f.name === "email" ? { ...f, name: "contact" } : f)),
  actions: beforeRename.actions.map((a) => ({
    ...a,
    map: Object.fromEntries(
      Object.entries(a.map ?? {}).map(([input, q]) => [input, q === "email" ? "contact" : q]),
    ),
  })),
});
const renamedBody = await renamed.json();
check(
  "renaming the mapped question saves with the mapping moved onto it",
  renamed.status === 200 &&
    renamedBody.actions?.every((a) => a.map?.email === "contact") &&
    renamedBody.fields?.some((f) => f.name === "contact"),
  `status=${renamed.status} ${JSON.stringify(renamedBody.actions?.map((a) => a.map))}`,
);

const stale = await patch(`/forms/${created.id}`, {
  expectedUpdatedAt: renamedBody.updatedAt,
  fields: renamedBody.fields.filter((f) => f.name !== "contact"),
});
check(
  "deleting a question an action reads is refused",
  stale.status === 400,
  `status=${stale.status}`,
);

/* --- deleting the response deletes its delivery ----------------------------- */

const removed = await fetch(`${API}/forms/${created.id}/responses/${row.id}`, { method: "DELETE" });
check("the response deletes", removed.status === 200, `status=${removed.status}`);
const gone = await fetch(`${API}/forms/${created.id}/responses/${row.id}`);
check("the response is gone", gone.status === 404, `status=${gone.status}`);
const goneRetry = await fetch(
  `${API}/forms/${created.id}/responses/${row.id}/deliveries/demo-webhook/retry`,
  { method: "POST" },
);
check(
  "and its delivery with it: nothing left to retry",
  goneRetry.status === 404,
  `status=${goneRetry.status}`,
);
const remaining = await json(`${API}/forms/${created.id}/responses?count=1`);
check(
  "and the needs-attention count drops back to zero",
  (remaining.failedDeliveries ?? -1) === 0 && (remaining.overdueDeliveries ?? -1) === 0,
  JSON.stringify({ failed: remaining.failedDeliveries, overdue: remaining.overdueDeliveries }),
);

await fetch(`${API}/forms/${created.id}`, { method: "DELETE" });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
