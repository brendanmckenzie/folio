import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formAction } from "../../src/server";
import { ipHash } from "../../src/server/form-responses";
import { honeypotName } from "../../src/core/forms";
import {
  CODE,
  count,
  deliveries,
  EMAIL,
  insertForm,
  makeFolio,
  makeLogger,
  post,
  reasonOf,
  statusOf,
  wipe,
} from "./form-actions-fixture";

/**
 * `POST {base}/f/:id` with form actions (`docs/specs/content-model/form-actions.md`
 * phase 4, decisions 2, 3, 9, 13, 17, 23 and 24).
 *
 * Every test here is a threat-model test: the route is the one an anonymous stranger
 * may write through, and a check is the host's code running on that path. The shapes
 * that matter are the silent ones: a check that fails open, a rate limit that does not
 * count refusals, a duplicate check that runs after the checks.
 */

/** What the `trip` check does next; swapped by each test. */
let behaviour: () => unknown = () => ({ ok: true });
let checkCalls = 0;

const trip = formAction({
  id: "trip-code",
  label: "Check the trip code",
  codes: { unknown_trip: { label: "Unknown trip", message: "Unknown trip." } },
  inputs: { code: { kind: "text", label: "Trip code", required: true } },
  check(): never {
    checkCalls += 1;
    return behaviour() as never;
  },
});

const deliverCalls: { inputs: unknown; host: string; key: string }[] = [];
const notify = formAction({
  id: "notify",
  label: "Notify",
  inputs: { email: { kind: "email", label: "Email", required: true } },
  deliver(ctx) {
    deliverCalls.push({ inputs: ctx.inputs, host: ctx.host, key: ctx.key });
  },
});
const archive = formAction({
  id: "archive",
  label: "Archive",
  deliver() {},
});

const { logger, log } = makeLogger();
const { folio } = makeFolio({ actions: [trip, notify, archive] }, { logger });

const TRIP_ATTACHMENT = {
  action: "trip-code",
  map: { code: "code" },
  messages: { unknown_trip: "We do not recognise that trip code" },
  i18n: { fr: { messages: { unknown_trip: "Nous ne reconnaissons pas ce code" } } },
};
const NOTIFY_ATTACHMENT = { action: "notify", map: { email: "email" }, delivers: true as const };

beforeEach(async () => {
  await wipe();
  behaviour = () => ({ ok: true });
  checkCalls = 0;
  deliverCalls.length = 0;
  log.warn.length = 0;
  log.error.length = 0;
});
afterEach(() => vi.useRealTimers());

const refusing = () => ({ ok: false, code: "unknown_trip" });

describe("a check refuses with the editor's words", () => {
  it("answers a native POST with a cacheable 303 that names two identifiers", async () => {
    behaviour = refusing;
    const id = await insertForm([EMAIL, CODE], [TRIP_ATTACHMENT]);
    const res = await post(folio, id, { email: "a@example.com", code: "X9" });
    expect(res.status).toBe(303);
    expect(statusOf(res)).toBe("refused");
    expect(reasonOf(res)).toBe("trip-code.unknown_trip");
    const url = new URL(res.headers.get("location")!);
    expect(url.searchParams.get("folio_form")).toBe(`f-${id}`);
    // Nothing personal and no text in the URL.
    expect(url.search).not.toContain("a%40example.com");
    expect(url.search).not.toContain("recognise");
    expect(await count("form_responses")).toBe(0);
    expect(await count("form_deliveries")).toBe(0);
    expect(await count("form_refusals")).toBe(1);
  });

  it("answers JSON 422 with the French text when the submission was French", async () => {
    behaviour = refusing;
    const id = await insertForm([EMAIL, CODE], [TRIP_ATTACHMENT]);
    const res = await post(
      folio,
      id,
      { email: "a@example.com", code: "X9", _folio_locale: "fr" },
      { json: true },
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: { code: "refused", message: "Nous ne reconnaissons pas ce code" },
      status: "refused",
      reason: "trip-code.unknown_trip",
    });
  });

  it("falls back to the editor's source text, then the developer's declared one", async () => {
    behaviour = refusing;
    const id = await insertForm([EMAIL, CODE], [TRIP_ATTACHMENT]);
    const english = await post(folio, id, { email: "a@example.com", code: "X9" }, { json: true });
    expect(((await english.json()) as { error: { message: string } }).error.message).toBe(
      "We do not recognise that trip code",
    );
    const bare = await insertForm([EMAIL, CODE], [{ action: "trip-code", map: { code: "code" } }]);
    const declared = await post(
      folio,
      bare,
      { email: "a@example.com", code: "X9" },
      { json: true },
    );
    expect(((await declared.json()) as { error: { message: string } }).error.message).toBe(
      "Unknown trip.",
    );
  });

  it("gives the check the mapped inputs and not the raw body's other keys", async () => {
    let seen: unknown;
    const spy = formAction({
      id: "spy",
      label: "Spy",
      inputs: { code: { kind: "text", label: "Code", required: true } },
      check(ctx) {
        seen = { inputs: ctx.inputs, host: ctx.host, site: ctx.site, locale: ctx.locale };
        return { ok: true };
      },
    });
    const { folio: f } = makeFolio({ actions: [spy] });
    const id = await insertForm([EMAIL, CODE], [{ action: "spy", map: { code: "code" } }]);
    await post(f, id, { email: "a@example.com", code: "X9" }, { host: "example.com" });
    expect(seen).toEqual({
      inputs: { code: "X9" },
      host: "example.com",
      site: "default",
      locale: "",
    });
  });
});

describe("refused attempts count against the rate limit before the check runs", () => {
  it("the 11th post is `rate`, and the check ran exactly 10 times", async () => {
    behaviour = refusing;
    const id = await insertForm([EMAIL, CODE], [TRIP_ATTACHMENT]);
    const seen: (string | null)[] = [];
    for (let i = 0; i < 11; i++) {
      seen.push(statusOf(await post(folio, id, { email: "a@example.com", code: `X${i}` })));
    }
    expect(seen).toEqual([...Array(10).fill("refused"), "rate"]);
    expect(checkCalls).toBe(10);
    expect(await count("form_refusals")).toBe(10);
  });

  it("holds for `invalid` answers too, and the check never runs", async () => {
    const id = await insertForm([EMAIL, CODE], [TRIP_ATTACHMENT]);
    const seen: (string | null)[] = [];
    for (let i = 0; i < 11; i++) seen.push(statusOf(await post(folio, id, { code: "X" })));
    expect(seen).toEqual([...Array(10).fill("invalid"), "rate"]);
    expect(checkCalls).toBe(0);
  });

  it("counts the previous hour's refusals as well, so it does not reset at the top of the hour", async () => {
    const id = await insertForm([EMAIL, CODE], [TRIP_ATTACHMENT]);
    const now = Date.now();
    const hash = await ipHash("203.0.113.9", id, now - 3_600_000);
    for (let i = 0; i < 10; i++) {
      await env.DB.prepare(
        "insert into form_refusals (ip_hash, form_id, created_at) values (?, ?, ?)",
      )
        .bind(hash, id, now - 180_000)
        .run();
    }
    expect(statusOf(await post(folio, id, { email: "a@example.com", code: "X" }))).toBe("rate");
    expect(checkCalls).toBe(0);
  });

  it("records nothing for a request with no address, a closed form, a honeypot or a limit of 0", async () => {
    behaviour = refusing;
    const open = await insertForm([EMAIL, CODE], [TRIP_ATTACHMENT]);
    await post(folio, open, { email: "a@example.com", code: "X" }, { ip: null });
    expect(await count("form_refusals")).toBe(0);

    const closed = await insertForm([EMAIL, CODE], [TRIP_ATTACHMENT], { open: 0 });
    await post(folio, closed, { email: "a@example.com", code: "X" });
    expect(await count("form_refusals")).toBe(0);

    const decoy = honeypotName(
      open,
      [EMAIL, CODE].map((f) => f.name),
    );
    await post(folio, open, { email: "a@example.com", code: "X", [decoy]: "bot" });
    expect(await count("form_refusals")).toBe(0);

    const { folio: unlimited } = makeFolio({ actions: [trip], ratePerHour: 0 } as never);
    await post(unlimited, open, { email: "a@example.com", code: "X" });
    expect(await count("form_refusals")).toBe(0);
  });
});

describe("a check fails closed", () => {
  const cases: [string, () => unknown][] = [
    [
      "throws",
      () => {
        throw new Error("vendor down https://api.example.com/?key=SECRET");
      },
    ],
    ["answers a code it did not declare", () => ({ ok: false, code: "undeclared" })],
    ["answers nothing", () => undefined],
    ["answers a refusal with no code", () => ({ ok: false })],
    ["answers a truthy non-result", () => "ok"],
    ["answers ok as a string", () => ({ ok: "true" })],
  ];
  for (const [name, run] of cases) {
    it(`refuses as <action>.error when it ${name}`, async () => {
      behaviour = run;
      const id = await insertForm([EMAIL, CODE], [TRIP_ATTACHMENT]);
      const res = await post(folio, id, { email: "a@example.com", code: "X9" });
      expect(reasonOf(res)).toBe("trip-code.error");
      expect(statusOf(res)).toBe("refused");
      expect(await count("form_responses")).toBe(0);
      expect(await count("form_refusals")).toBe(1);
      expect(log.error.some((e) => e.message.includes('"trip-code"'))).toBe(true);
    });
  }

  it("refuses as <action>.error when it never settles within its deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let started: () => void = () => {};
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    behaviour = () => {
      started();
      return new Promise(() => {});
    };
    const id = await insertForm([EMAIL, CODE], [TRIP_ATTACHMENT]);
    const pending = post(folio, id, { email: "a@example.com", code: "X9" });
    await begun;
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await pending;
    expect(reasonOf(res)).toBe("trip-code.error");
    expect(await count("form_responses")).toBe(0);
    expect(log.error.some((e) => e.message.includes("timed out"))).toBe(true);
  });

  it("keeps a thrown message out of the reply", async () => {
    behaviour = () => {
      throw new Error("https://api.example.com/?key=SECRET");
    };
    const id = await insertForm([EMAIL, CODE], [TRIP_ATTACHMENT]);
    const res = await post(folio, id, { email: "a@example.com", code: "X9" }, { json: true });
    expect(await res.text()).not.toContain("SECRET");
  });

  it("refuses as <action>.error when the attachment no longer satisfies its action", async () => {
    const id = await insertForm([EMAIL, CODE], [{ action: "trip-code", map: {} }]);
    const res = await post(folio, id, { email: "a@example.com", code: "X9" });
    expect(reasonOf(res)).toBe("trip-code.error");
    expect(checkCalls).toBe(0);
  });

  it("lets an action return its implicit `error` code deliberately", async () => {
    behaviour = () => ({ ok: false, code: "error" });
    const id = await insertForm([EMAIL, CODE], [TRIP_ATTACHMENT]);
    expect(reasonOf(await post(folio, id, { email: "a@example.com", code: "X9" }))).toBe(
      "trip-code.error",
    );
  });
});

describe("the duplicate check runs before the checks", () => {
  it("a double-click is answered ok without calling the check a second time", async () => {
    const id = await insertForm([EMAIL, CODE], [TRIP_ATTACHMENT]);
    const body = { email: "a@example.com", code: "X9" };
    const first = await post(folio, id, body);
    expect(statusOf(first)).toBe("ok");
    expect(checkCalls).toBe(1);
    // The check would now refuse (the trip is booked by the first click).
    behaviour = refusing;
    const second = await post(folio, id, body);
    expect(statusOf(second)).toBe("ok");
    expect(checkCalls).toBe(1);
    expect(await count("form_responses")).toBe(1);
  });

  it("answers the pre-check duplicate with no `actions`", async () => {
    behaviour = () => ({ ok: true, reply: { tripName: "Serengeti" } });
    const id = await insertForm([EMAIL, CODE], [TRIP_ATTACHMENT]);
    const body = { email: "a@example.com", code: "X9" };
    const first = (await (await post(folio, id, body, { json: true })).json()) as {
      actions?: unknown;
    };
    expect(first.actions).toEqual({ "trip-code": { tripName: "Serengeti" } });
    const second = (await (await post(folio, id, body, { json: true })).json()) as {
      actions?: unknown;
    };
    expect(second.actions).toBeUndefined();
  });
});

describe("reply values", () => {
  it("returns screened values in JSON only, and never to a native POST", async () => {
    behaviour = () => ({
      ok: true,
      reply: {
        tripName: "Serengeti, July 2027",
        seats: 4,
        BadKey: "x",
        long: "y".repeat(201),
        nan: Number.NaN,
      },
    });
    const id = await insertForm([EMAIL, CODE], [TRIP_ATTACHMENT]);
    const json = (await (
      await post(folio, id, { email: "a@example.com", code: "X9" }, { json: true })
    ).json()) as { ok: boolean; actions: unknown };
    expect(json.actions).toEqual({ "trip-code": { tripName: "Serengeti, July 2027", seats: 4 } });
    expect(log.warn.some((w) => w.includes('"trip-code"') && w.includes("dropped"))).toBe(true);

    const native = await post(folio, id, { email: "b@example.com", code: "X9" });
    expect(native.headers.get("location")).not.toContain("Serengeti");
  });

  it("keeps at most eight keys", async () => {
    behaviour = () => ({
      ok: true,
      reply: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i])),
    });
    const id = await insertForm([EMAIL, CODE], [TRIP_ATTACHMENT]);
    const json = (await (
      await post(folio, id, { email: "a@example.com", code: "X9" }, { json: true })
    ).json()) as { actions: { "trip-code": Record<string, number> } };
    expect(Object.keys(json.actions["trip-code"])).toHaveLength(8);
  });

  it("stores nothing of a reply and discards a passing check's values when a later one refuses", async () => {
    behaviour = () => ({ ok: true, reply: { tripName: "x" } });
    const second = formAction({
      id: "second",
      label: "Second",
      codes: { no: { label: "No", message: "No." } },
      check: () => ({ ok: false, code: "no" }),
    });
    const { folio: g } = makeFolio({ actions: [trip, second] });
    const id = await insertForm([EMAIL, CODE], [TRIP_ATTACHMENT, { action: "second" }]);
    const res = await post(g, id, { email: "a@example.com", code: "X9" }, { json: true });
    expect(res.status).toBe(422);
    expect(await res.text()).not.toContain("tripName");
  });
});

describe("code and attachments disagree", () => {
  it("does not run a check whose action is no longer registered, and warns", async () => {
    const id = await insertForm([EMAIL, CODE], [{ action: "gone", map: {} }]);
    const res = await post(folio, id, { email: "a@example.com", code: "X9" });
    expect(statusOf(res)).toBe("ok");
    expect(await count("form_responses")).toBe(1);
    expect(await count("form_deliveries")).toBe(0);
    expect(log.warn.some((w) => w.includes('"gone"'))).toBe(true);
  });

  it("files a failed not_registered delivery for an attachment that delivered", async () => {
    const id = await insertForm([EMAIL, CODE], [{ action: "gone", delivers: true }]);
    await post(folio, id, { email: "a@example.com", code: "X9" });
    const [row] = await deliveries();
    expect(row).toMatchObject({
      action: "gone",
      status: "failed",
      failure: "not_registered",
      next_at: null,
      inputs_map: null,
      attempts: 0,
    });
  });

  it("files a failed incomplete delivery when the attachment no longer satisfies its action", async () => {
    const id = await insertForm([EMAIL, CODE], [{ action: "notify", map: {}, delivers: true }]);
    await post(folio, id, { email: "a@example.com", code: "X9" });
    const [row] = await deliveries();
    expect(row).toMatchObject({ action: "notify", status: "failed", failure: "incomplete" });
    expect(deliverCalls).toHaveLength(0);
  });
});

describe("a delivery and its response commit together", () => {
  it("two identical submissions leave one response and exactly one row per delivering action", async () => {
    const id = await insertForm(
      [EMAIL, CODE],
      [NOTIFY_ATTACHMENT, { action: "archive", delivers: true }],
    );
    const body = { email: "a@example.com", code: "X9" };
    await post(folio, id, body);
    await post(folio, id, body);
    expect(await count("form_responses")).toBe(1);
    const rows = await deliveries();
    expect(rows.map((r) => r.action)).toEqual(["archive", "notify"]);
  });

  it("stores the host and the mapping snapshot, and attempts once after the reply", async () => {
    const id = await insertForm([EMAIL, CODE], [NOTIFY_ATTACHMENT]);
    const res = await post(
      folio,
      id,
      { email: "a@example.com", code: "X9" },
      { host: "example.com" },
    );
    expect(statusOf(res)).toBe("ok");
    const [row] = await deliveries();
    expect(row).toMatchObject({
      status: "delivered",
      attempts: 1,
      host: "example.com",
      form_id: id,
      failure: null,
      detail: null,
    });
    expect(JSON.parse(row!.inputs_map!)).toEqual({ email: "email" });
    expect(deliverCalls).toHaveLength(1);
    expect(deliverCalls[0]).toMatchObject({
      inputs: { email: "a@example.com" },
      host: "example.com",
      key: `${row!.response_id}:notify`,
    });
  });

  it("does not wait for the delivery to answer the visitor", async () => {
    let release: () => void = () => {};
    const slow = formAction({
      id: "slow",
      label: "Slow",
      deliver: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const { folio: f } = makeFolio({ actions: [slow] });
    const id = await insertForm([EMAIL], [{ action: "slow", delivers: true }]);
    // `wait: false`: the reply must come back while the delivery is still running.
    const res = await post(f, id, { email: "a@example.com" }, { wait: false });
    expect(statusOf(res)).toBe("ok");
    const [pending] = await deliveries();
    expect(pending!.status).toBe("pending");
    release();
  });

  it("creates no delivery rows when the check refuses", async () => {
    behaviour = refusing;
    const id = await insertForm([EMAIL, CODE], [TRIP_ATTACHMENT, NOTIFY_ATTACHMENT]);
    await post(folio, id, { email: "a@example.com", code: "X9" });
    expect(await count("form_deliveries")).toBe(0);
  });

  it("still fires hooks.submitted for a stored row, and not for a refused one", async () => {
    const submitted: string[] = [];
    const { folio: f } = makeFolio(
      { actions: [trip, notify] },
      {
        hooks: {
          submitted: (p: { response: { id: string } }) => void submitted.push(p.response.id),
        },
      },
    );
    const id = await insertForm([EMAIL, CODE], [TRIP_ATTACHMENT, NOTIFY_ATTACHMENT]);
    expect(statusOf(await post(f, id, { email: "a@example.com", code: "X9" }))).toBe("ok");
    expect(submitted).toHaveLength(1);
    behaviour = refusing;
    await post(f, id, { email: "b@example.com", code: "X9" });
    expect(submitted).toHaveLength(1);
  });
});

describe("a form with no actions", () => {
  it("issues one insert, no batch, no delivery statement and a rate check reading two tables", async () => {
    const sql: string[] = [];
    let batches = 0;
    const record = <T extends object>(target: T): T =>
      new Proxy(target, {
        get(t, prop) {
          const value = Reflect.get(t, prop);
          if (prop === "prepare") {
            return (text: string) => {
              sql.push(text);
              return record((t as unknown as D1Database).prepare(text));
            };
          }
          if (prop === "bind") {
            return (...args: unknown[]) =>
              record((t as unknown as D1PreparedStatement).bind(...args));
          }
          if (prop === "batch") {
            return (statements: D1PreparedStatement[]) => {
              batches += 1;
              return (t as unknown as D1Database).batch(statements);
            };
          }
          if (prop === "withSession") {
            return (arg?: string) => record((t as unknown as D1Database).withSession(arg));
          }
          return typeof value === "function" ? value.bind(t) : value;
        },
      });
    const { folio: f } = makeFolio(
      { actions: [trip] },
      {
        bindings: (e) => ({
          db: record(e.DB),
          story: e.STORY,
          media: e.MEDIA,
          images: e.IMAGES,
        }),
      },
    );
    const id = await insertForm([EMAIL], []);
    sql.length = 0;
    expect(statusOf(await post(f, id, { email: "a@example.com" }))).toBe("ok");
    expect(batches).toBe(0);
    expect(sql.filter((s) => /insert into form_responses/i.test(s))).toHaveLength(1);
    expect(sql.filter((s) => /form_deliveries/.test(s))).toHaveLength(0);
    const rate = sql.filter((s) => /form_refusals/.test(s));
    expect(rate).toHaveLength(1);
    expect(rate[0]).toMatch(/form_responses/);
  });
});
