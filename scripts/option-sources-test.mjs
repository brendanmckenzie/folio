// Exercises content-model/form-option-sources.md end to end against a live dev server:
// an editor gives a form's questions their choices from published People (the built-in
// `content` source) and from the demo's host `countries` source, a stranger answers
// them, and the host's vendor then goes down.
//
// What `pnpm test` cannot see, and this can: the demo Worker's real `load`, a real
// background refresh after a PATCH, and an outage that the demo's `/dev/option-source`
// switch (localhost only, like `/dev/last-signin`) produces on demand.
//
// Four things, in order:
//   1. the saved form resolves to the published options, and only those;
//   2. an unpublished id is refused as `invalid`, a published one is stored with the
//      label the visitor read;
//   3. through an outage, a stale list still accepts and a never-loaded key answers
//      `source_unavailable`;
//   4. a sourced question gated on another sourced question stores both answers.
import "./lib/ts-resolve.mjs";
import { signInGlobally } from "./lib/auth.mjs";

const { realFetch } = await signInGlobally();

const { PROTOCOL_VERSION } = await import(new URL("../src/core/protocol.ts", import.meta.url));

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

/** A visitor's JSON submission: no session, so `realFetch`. */
const submitJson = (formId, body) =>
  realFetch(`${BASE}/f/${formId}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });

/** The demo's vendor switch. `stale=1` ages every stored list past its ttl and lease. */
const dev = (query) => json(`${HTTP}/dev/option-source?${query}`);

/** A real WebSocket to a story's sync endpoint, as the other scripts use. */
function client(storyId) {
  const ws = new WebSocket(`ws://localhost:5199/folio/api/story/${storyId}/socket`);
  const inbox = [];
  const waiters = [];
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(msg)) waiters.splice(i, 1)[0].resolve(msg);
    }
  });
  return {
    ws,
    async hello() {
      await new Promise((r) => ws.addEventListener("open", r, { once: true }));
      this.send({
        type: "hello",
        lastSyncId: 0,
        identity: { actor: "e2e", name: "e2e", colour: "#0090ff" },
      });
      return (await this.expect((m) => m.type === "bootstrap")).doc;
    },
    // Every frame carries the wire version, not only `hello`.
    send: (m) => ws.send(JSON.stringify({ ...m, v: PROTOCOL_VERSION })),
    async tx(txId, mutations) {
      this.send({ type: "tx", txId, mutations });
      await this.expect((m) => m.type === "delta" && m.txId === txId);
      await wait(120);
    },
    expect(match, ms = 4000) {
      const hit = inbox.find(match);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        waiters.push({ match, resolve });
        setTimeout(() => reject(new Error("timeout waiting on socket message")), ms);
      });
    },
  };
}

/** A person record with a name, published or not. */
async function person(fullName, publish) {
  const story = await post("/stories", { title: fullName, type: "person" });
  const c = client(story.id);
  const doc = await c.hello();
  await c.tx(`p${story.id}`, [
    { t: "set", uid: doc.root, field: "fullName", value: fullName },
    { t: "set", uid: doc.root, field: "role", value: "Guide" },
  ]);
  c.ws.close();
  if (publish) await post(`/story/${story.id}/publish`, {});
  return story;
}

/** The compiled descriptor of a form, as a page would carry it. */
const resolved = async (formId) => (await json(`${API}/forms/resolved?ids=${formId}`))[formId];

/** Polls until `ready(descriptor)` holds: the load after a save runs in the background. */
async function until(formId, ready, ms = 8000) {
  const stop = Date.now() + ms;
  let last;
  while (Date.now() < stop) {
    last = await resolved(formId);
    if (last && ready(last)) return last;
    await wait(250);
  }
  return last;
}

await dev("fail=0");

/* --- the demo's /dev switch is localhost only ----------------------------- */

check(
  "the /dev switch answers on localhost",
  (await realFetch(`${HTTP}/dev/option-source`).then((r) => r.status)) === 200,
);

/* --- two published people and one draft ----------------------------------- */

const ada = await person("Ada Guide", true);
const grace = await person("Grace Guide", true);
const draft = await person("Draft Guide", false);

/* --- a form with a content question and a gated host question ------------- */

const created = await post("/forms", { label: "Option Sources E2E" });
const FIELDS = [
  {
    name: "country",
    kind: "select",
    label: "Country",
    required: true,
    optionsFrom: { source: "countries", settings: { region: "all" } },
  },
  {
    name: "guide",
    kind: "select",
    label: "Guide",
    optionsFrom: { source: "content", settings: { type: "person" } },
    showIf: { field: "country", eq: "au" },
  },
];
const saved = await patch(`/forms/${created.id}`, {
  expectedUpdatedAt: created.updatedAt,
  fields: FIELDS,
});
const form = await saved.json();
check("a form with sourced questions saves", saved.status === 200, `status=${saved.status}`);

const descriptor = await until(
  form.id,
  (d) => d.fields.find((f) => f.name === "country")?.options?.length > 0,
);
const guideOptions = descriptor?.fields.find((f) => f.name === "guide")?.options ?? [];
const countryField = descriptor?.fields.find((f) => f.name === "country");
check(
  "the host list loads in the background after the save, without a render calling load",
  countryField?.options?.length === 5 && !countryField.optionsFrom?.unavailable,
  `${countryField?.options?.length} options`,
);
check(
  "the content question resolves to the published people, labelled by name, and not the draft",
  guideOptions.length === 2 &&
    guideOptions.some((o) => o.value === ada.id && o.label === "Ada Guide") &&
    guideOptions.some((o) => o.value === grace.id && o.label === "Grace Guide") &&
    !guideOptions.some((o) => o.value === draft.id),
  JSON.stringify(guideOptions),
);

/* --- an unpublished id is refused; a published one is stored with its label - */

const crafted = await submitJson(form.id, { country: "au", guide: draft.id });
const craftedBody = await crafted.json();
check(
  "an unpublished id is refused as invalid, naming the question",
  crafted.status === 422 &&
    craftedBody.error?.code === "invalid" &&
    Object.keys(craftedBody.fields ?? {}).join() === "guide",
  `${crafted.status} ${JSON.stringify(craftedBody.fields)}`,
);

const good = await submitJson(form.id, { country: "au", guide: ada.id });
check("a published id is accepted", good.status === 200, `status=${good.status}`);
const rows = (await json(`${API}/forms/${form.id}/responses`)).rows;
const stored = rows.find((r) => r.data.guide === ada.id);
check(
  "both gated answers are stored, and the response keeps the label the visitor read",
  stored?.data.country === "au" &&
    stored.optionLabels?.guide?.[ada.id] === "Ada Guide" &&
    stored.optionLabels?.country?.au === "Australia",
  JSON.stringify({ data: stored?.data, labels: stored?.optionLabels }),
);

const csv = await fetch(`${API}/forms/${form.id}/responses.csv`).then((r) => r.text());
check(
  "the CSV carries the label in the question's column and the value in a :value column",
  csv.includes("guide:value") && csv.includes("Ada Guide") && csv.includes(ada.id),
  csv.split("\n")[0],
);

const notAsked = await submitJson(form.id, { country: "nz", guide: grace.id });
check("a gated question that was not asked is dropped, not refused", notAsked.status === 200);
const notAskedRow = (await json(`${API}/forms/${form.id}/responses`)).rows.find(
  (r) => r.data.country === "nz",
);
check(
  "and the row records it was never asked",
  notAskedRow && !("guide" in notAskedRow.data) && notAskedRow.unasked.includes("guide"),
  JSON.stringify({ data: notAskedRow?.data, unasked: notAskedRow?.unasked }),
);

/* --- an outage ------------------------------------------------------------ */

// A key nothing has loaded: the africa-only list. Saved while the vendor is down, so
// its background load fails and the key stays never-loaded.
await dev("fail=1");
const second = await post("/forms", { label: "Option Sources Outage" });
const africaSaved = await patch(`/forms/${second.id}`, {
  expectedUpdatedAt: second.updatedAt,
  fields: [
    {
      name: "africa",
      kind: "select",
      label: "African country",
      required: true,
      optionsFrom: { source: "countries", settings: { region: "africa" } },
    },
  ],
});
check("a form naming an unloadable list still saves", africaSaved.status === 200);
await wait(1500);
const down = await resolved(second.id);
check(
  "the question compiles unavailable and the page is not edge-cached",
  down?.fields[0]?.optionsFrom?.unavailable === true && !down.fields[0].options?.length,
  JSON.stringify(down?.fields[0]?.optionsFrom),
);
const refused = await submitJson(second.id, { africa: "ke" });
const refusedBody = await refused.json();
check(
  "a never-loaded key answers 503 source_unavailable, not invalid",
  refused.status === 503 && refusedBody.error?.code === "source_unavailable",
  `${refused.status} ${JSON.stringify(refusedBody.error ?? refusedBody)}`,
);

// The first form's list loaded before the outage; age it past its ttl.
await dev("fail=1&stale=1");
const throughOutage = await submitJson(form.id, { country: "ke" });
check(
  "a stale list still accepts a value it held while the vendor is down",
  throughOutage.status === 200,
  `status=${throughOutage.status}`,
);
const unknownValue = await submitJson(form.id, { country: "xx" });
check(
  "and still refuses a value it never held",
  unknownValue.status === 422,
  `status=${unknownValue.status}`,
);

await dev("fail=0");

/* --- clean up -------------------------------------------------------------- */

for (const id of [form.id, second.id]) {
  await fetch(`${API}/forms/${id}`, { method: "DELETE" });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
