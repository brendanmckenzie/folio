import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { formAction } from "../../src/server";
import {
  attemptDelivery,
  type DeliveryDeps,
  retryDelivery,
  runDeliveries,
} from "../../src/server/deliveries";
import {
  DELIVERY_BACKOFF_MS,
  DELIVERY_LEASE_MS,
  MAX_DELIVERY_ATTEMPTS,
} from "../../src/server/form-actions";
import {
  deleteResponse,
  deleteResponses,
  listResponses,
  responseById,
} from "../../src/server/form-responses";
import { deleteForm, formById } from "../../src/server/forms";
import { createRuntime } from "../../src/server/runtime";
import {
  count,
  type DeliveryDbRow,
  deliveries,
  EMAIL,
  insertForm,
  makeFolio,
  makeLogger,
  ORIGIN,
  post,
  wipe,
} from "./form-actions-fixture";

/**
 * Form deliveries (`docs/specs/content-model/form-actions.md` phase 4, decisions 9 to
 * 16 and 20): the claim, the token fence, the backoff walk, every outcome and its
 * category, the snapshotted mapping, Retry, the pass's limits and the delete paths.
 *
 * Most rows are seeded straight into D1 so a test owns exactly the state it is about;
 * the submit route's own batch is in `form-submit-actions.test.ts`.
 */

/** What `probe` does on its next call, and every context it was given. */
let next: (ctx: ProbeCtx, call: number) => unknown = () => undefined;
interface ProbeCtx {
  inputs: Record<string, unknown>;
  settings: Record<string, unknown>;
  key: string;
  host: string;
  attempt: number;
  signal: AbortSignal;
}
const seen: ProbeCtx[] = [];

const probe = formAction({
  id: "probe",
  label: "Probe",
  inputs: { email: { kind: "email", label: "Email", required: true } },
  settings: { listId: { kind: "text", label: "List id" } },
  deliver(ctx) {
    seen.push(ctx as unknown as ProbeCtx);
    return next(ctx as unknown as ProbeCtx, seen.length) as never;
  },
});
/** A second action with no inputs, for the per-action skip. */
const other = formAction({
  id: "other",
  label: "Other",
  async deliver() {
    otherCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, otherDelayMs));
  },
});
let otherCalls = 0;
let otherDelayMs = 0;

const { logger, log } = makeLogger();
const { folio, config } = makeFolio({ actions: [probe, other] }, { logger });
const rt = createRuntime(config);

const ATTACH = { action: "probe", map: { email: "email" }, delivers: true as const };

beforeEach(async () => {
  await wipe();
  next = () => undefined;
  seen.length = 0;
  otherCalls = 0;
  otherDelayMs = 0;
  log.warn.length = 0;
  log.error.length = 0;
});

const deps = (over: Partial<DeliveryDeps> = {}, now?: number): DeliveryDeps => ({
  rt,
  env,
  db: env.DB,
  brandFor: async () => rt.brands.get(null)!,
  clock: () => now ?? Date.now(),
  ...over,
});

let n = 0;
/** A response and one delivery row for it, as the submit route's batch would write them. */
async function seed(
  formId: string,
  over: Partial<DeliveryDbRow> & {
    data?: Record<string, unknown>;
    site?: string;
    action?: string;
    skipResponse?: boolean;
  } = {},
): Promise<string> {
  n += 1;
  const rid = `res_${n.toString(16).padStart(12, "0")}`;
  if (!over.skipResponse) {
    await env.DB.prepare(
      `insert into form_responses (id, form_id, version, created_at, data, body_hash, site_id)
       values (?, ?, 1, ?, ?, ?, ?)`,
    )
      .bind(
        rid,
        formId,
        Date.now(),
        JSON.stringify(over.data ?? { email: "ada@example.com" }),
        `h${n}`,
        over.site ?? "default",
      )
      .run();
  }
  await env.DB.prepare(
    `insert into form_deliveries
       (response_id, action, form_id, status, attempts, next_at, claim, host, inputs_map, failure, detail, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
  )
    .bind(
      rid,
      over.action ?? "probe",
      formId,
      over.status ?? "pending",
      over.attempts ?? 0,
      over.next_at === undefined ? 1 : over.next_at,
      over.claim ?? null,
      over.host ?? "example.com",
      over.inputs_map === undefined ? '{"email":"email"}' : over.inputs_map,
      over.failure ?? null,
      over.detail ?? null,
    )
    .run();
  return rid;
}

const rowOf = async (rid: string, action = "probe"): Promise<DeliveryDbRow> =>
  (await env.DB.prepare("select * from form_deliveries where response_id = ? and action = ?")
    .bind(rid, action)
    .first<DeliveryDbRow>())!;

const T0 = 1_000_000;

describe("outcomes and categories", () => {
  it("a void return is delivered, and a reference is stored", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const a = await seed(form);
    next = () => ({ reference: "JAM-1" });
    const report = await runDeliveries(rt, env, env.DB, { now: T0 });
    expect(report).toMatchObject({ due: 1, delivered: 1, skipped: 0, failed: [], dropped: 0 });
    expect(await rowOf(a)).toMatchObject({
      status: "delivered",
      attempts: 1,
      reference: "JAM-1",
      failure: null,
      detail: null,
      next_at: null,
    });
  });

  it("skipped keeps the action's text and is not retried", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const a = await seed(form);
    next = () => ({ skipped: "Not a production host" });
    const report = await runDeliveries(rt, env, env.DB, { now: T0 });
    expect(report.skipped).toBe(1);
    expect(await rowOf(a)).toMatchObject({
      status: "skipped",
      detail: "Not a production host",
      failure: null,
    });
    expect((await runDeliveries(rt, env, env.DB, { now: T0 + 10 ** 9 })).due).toBe(0);
  });

  it("{ failed } is permanent, category refused, with the action's text", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const a = await seed(form);
    next = () => ({ failed: "No such list" });
    const report = await runDeliveries(rt, env, env.DB, { now: T0 });
    expect(report.failed).toEqual([
      {
        responseId: a,
        formId: form,
        action: "probe",
        attempts: 1,
        failure: "refused",
        givenUp: true,
      },
    ]);
    expect(await rowOf(a)).toMatchObject({
      status: "failed",
      failure: "refused",
      detail: "No such list",
      next_at: null,
    });
    expect((await runDeliveries(rt, env, env.DB, { now: T0 + 10 ** 9 })).due).toBe(0);
  });

  it("bounds the action's text to 500 characters", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const a = await seed(form);
    next = () => ({ failed: "x".repeat(900) });
    await runDeliveries(rt, env, env.DB, { now: T0 });
    expect((await rowOf(a)).detail).toHaveLength(500);
  });

  it("a throw is retryable and never stores the thrown message", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const a = await seed(form);
    next = () => {
      throw new Error("fetch failed: https://api.example.com/v1?key=SECRET-KEY");
    };
    await runDeliveries(rt, env, env.DB, { now: T0 });
    const row = await rowOf(a);
    expect(row).toMatchObject({ status: "pending", failure: "threw", detail: null, attempts: 1 });
    expect(JSON.stringify(row)).not.toContain("SECRET-KEY");
    // The log has it, with the response id, the action and the attempt number.
    const line = log.error.find((e) => e.extra.some((x) => String(x).includes("SECRET-KEY")));
    expect(line?.message).toContain(a);
    expect(line?.message).toContain('"probe"');
    expect(line?.message).toContain("attempt 1");
  });

  for (const [name, value] of [
    ["an unexpected object", { foo: 1 }],
    ["a string", "done"],
    ["null", null],
    ["both skipped and failed", { skipped: "a", failed: "b" }],
    ["a non-string reference", { reference: 7 }],
  ] as const) {
    it(`${name} is malformed and retried`, async () => {
      const form = await insertForm([EMAIL], [ATTACH]);
      const a = await seed(form);
      next = () => value;
      await runDeliveries(rt, env, env.DB, { now: T0 });
      expect(await rowOf(a)).toMatchObject({
        status: "pending",
        failure: "malformed",
        detail: null,
      });
    });
  }

  it("no answer within the deadline is a timeout, retried", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const a = await seed(form);
    let aborted = false;
    next = (ctx) => {
      ctx.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise(() => {});
    };
    await runDeliveries(rt, env, env.DB, { now: T0, deliverMs: 30 });
    expect(await rowOf(a)).toMatchObject({ status: "pending", failure: "timeout", detail: null });
    expect(aborted).toBe(true);
  });

  it("cancels a delivery whose attachment was removed from the form", async () => {
    const form = await insertForm([EMAIL], []);
    const a = await seed(form);
    await runDeliveries(rt, env, env.DB, { now: T0 });
    expect(await rowOf(a)).toMatchObject({ status: "cancelled", failure: null, next_at: null });
    expect(seen).toHaveLength(0);
  });

  it("fails an action the code no longer registers as not_registered", async () => {
    const form = await insertForm([EMAIL], [{ action: "gone", delivers: true }]);
    const a = await seed(form, { action: "gone" });
    await runDeliveries(rt, env, env.DB, { now: T0 });
    expect(await rowOf(a, "gone")).toMatchObject({ status: "failed", failure: "not_registered" });
  });

  it("fails an attachment missing a required setting as incomplete", async () => {
    const needs = formAction({
      id: "needs",
      label: "Needs",
      settings: { token: { kind: "text", label: "Token", required: true } },
      deliver: () => {},
    });
    const { config: c } = makeFolio({ actions: [needs] });
    const form = await insertForm([EMAIL], [{ action: "needs", delivers: true }]);
    const a = await seed(form, { action: "needs", inputs_map: "{}" });
    await runDeliveries(createRuntime(c), env, env.DB, { now: T0 });
    expect(await rowOf(a, "needs")).toMatchObject({ status: "failed", failure: "incomplete" });
  });

  it("fails a response whose site no brand serves as no_brand", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const a = await seed(form);
    const outcome = await attemptDelivery(deps({ brandFor: async () => null }, T0), a, "probe");
    expect(outcome).toMatchObject({ kind: "done", status: "failed", failure: "no_brand" });
    expect(seen).toHaveLength(0);
  });

  it("deletes a row whose response is already gone and counts it dropped", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    await seed(form, { skipResponse: true });
    const report = await runDeliveries(rt, env, env.DB, { now: T0 });
    expect(report.dropped).toBe(1);
    expect(await count("form_deliveries")).toBe(0);
  });

  it("gives the action its context", async () => {
    const form = await insertForm([EMAIL], [{ ...ATTACH, settings: { listId: "L1" } }]);
    const a = await seed(form, { host: "staging.example.com" });
    await runDeliveries(rt, env, env.DB, { now: T0 });
    expect(seen[0]).toMatchObject({
      inputs: { email: "ada@example.com" },
      settings: { listId: "L1" },
      key: `${a}:probe`,
      host: "staging.example.com",
      attempt: 1,
    });
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("the claim and the token fence", () => {
  it("lets exactly one of two concurrent runners attempt a row", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const a = await seed(form);
    next = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    const [x, y] = await Promise.all([
      attemptDelivery(deps({}, T0), a, "probe"),
      attemptDelivery(deps({}, T0), a, "probe"),
    ]);
    expect([x.kind, y.kind].sort()).toEqual(["done", "unclaimed"]);
    expect(seen).toHaveLength(1);
    expect((await rowOf(a)).attempts).toBe(1);
  });

  it("does not claim a row that is not due, or not pending", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const later = await seed(form, { next_at: T0 + 1000 });
    // Not pending, whatever `next_at` says: a stale non-null `next_at` on a finished row
    // must not make it claimable.
    const done = await seed(form, { status: "delivered", next_at: 1 });
    const failed = await seed(form, { status: "failed", failure: "refused", next_at: 1 });
    expect((await attemptDelivery(deps({}, T0), later, "probe")).kind).toBe("unclaimed");
    expect((await attemptDelivery(deps({}, T0), done, "probe")).kind).toBe("unclaimed");
    expect((await attemptDelivery(deps({}, T0), failed, "probe")).kind).toBe("unclaimed");
    expect(seen).toHaveLength(0);
  });

  it("a stale runner's late failure writes nothing once a newer claim delivered the row", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const a = await seed(form);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    next = async (_ctx, call) => {
      if (call === 1) {
        started();
        await gate;
        throw new Error("late");
      }
      return { reference: "second" };
    };
    // Runner A claims and hangs.
    const first = attemptDelivery(deps({}, T0), a, "probe");
    await begun;
    // Its lease lapses; the cron (runner B) claims and delivers.
    const lapsed = T0 + DELIVERY_LEASE_MS + 1;
    expect((await attemptDelivery(deps({}, lapsed), a, "probe")).kind).toBe("done");
    expect(await rowOf(a)).toMatchObject({ status: "delivered", reference: "second", attempts: 2 });
    // A now times out / throws: its write matches nothing.
    release();
    expect((await first).kind).toBe("stale");
    expect(await rowOf(a)).toMatchObject({
      status: "delivered",
      reference: "second",
      failure: null,
    });
  });

  it("a Retry delivers while the cron attempt's lease has lapsed; the cron's late write matches nothing", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const a = await seed(form);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    next = async (_ctx, call) => {
      if (call === 1) {
        started();
        await gate;
        return { failed: "late refusal" };
      }
      return { reference: "retry" };
    };
    const cron = attemptDelivery(deps({}, T0), a, "probe");
    await begun;
    const lapsed = T0 + DELIVERY_LEASE_MS + 1;
    const stored = (await formById(env.DB, form))!;
    const retried = await retryDelivery(deps({}, lapsed), stored, a, "probe");
    expect(retried).toMatchObject({
      kind: "ok",
      delivery: { status: "delivered", reference: "retry" },
    });
    release();
    expect((await cron).kind).toBe("stale");
    expect(await rowOf(a)).toMatchObject({
      status: "delivered",
      reference: "retry",
      failure: null,
    });
  });

  it("recovers a row whose runner died: not due until the lease lapses, and the dead attempt counted", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const a = await seed(form);
    // A runner that claimed and was killed: attempts moved, next_at pushed, a token.
    await env.DB.prepare(
      "update form_deliveries set attempts = 1, next_at = ?, claim = 'dead' where response_id = ?",
    )
      .bind(T0 + DELIVERY_LEASE_MS, a)
      .run();
    expect((await runDeliveries(rt, env, env.DB, { now: T0 + 1000 })).due).toBe(0);
    const report = await runDeliveries(rt, env, env.DB, { now: T0 + DELIVERY_LEASE_MS + 1 });
    expect(report.delivered).toBe(1);
    expect(await rowOf(a)).toMatchObject({ status: "delivered", attempts: 2 });
  });
});

describe("the backoff walk", () => {
  it("steps through the table with `now` and gives up on the eighth attempt", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const a = await seed(form, { next_at: T0 });
    next = () => {
      throw new Error("down");
    };
    let now = T0;
    for (let attempt = 1; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
      const report = await runDeliveries(rt, env, env.DB, { now });
      expect(report.failed).toEqual([
        expect.objectContaining({ attempts: attempt, failure: "threw", givenUp: false }),
      ]);
      const row = await rowOf(a);
      expect(row).toMatchObject({ status: "pending", attempts: attempt, failure: "threw" });
      expect(row.next_at).toBe(now + DELIVERY_BACKOFF_MS[attempt - 1]!);
      // Not due a millisecond early.
      expect((await runDeliveries(rt, env, env.DB, { now: row.next_at! - 1 })).due).toBe(0);
      now = row.next_at!;
    }
    const last = await runDeliveries(rt, env, env.DB, { now });
    expect(last.failed).toEqual([
      expect.objectContaining({
        attempts: MAX_DELIVERY_ATTEMPTS,
        failure: "gave_up",
        givenUp: true,
      }),
    ]);
    expect(await rowOf(a)).toMatchObject({
      status: "failed",
      failure: "gave_up",
      attempts: MAX_DELIVERY_ATTEMPTS,
      next_at: null,
      detail: null,
    });
    expect(seen).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    expect((await runDeliveries(rt, env, env.DB, { now: now + 10 ** 10 })).due).toBe(0);
  });

  it("has one entry fewer than the cap, so it is never indexed past its end", () => {
    expect(DELIVERY_BACKOFF_MS).toHaveLength(MAX_DELIVERY_ATTEMPTS - 1);
  });

  it("a submit whose first attempt throws leaves attempts 1, pending, threw, due in a minute", async () => {
    next = () => {
      throw new Error("down");
    };
    const form = await insertForm([EMAIL], [ATTACH]);
    const before = Date.now();
    await post(folio, form, { email: "a@example.com" });
    const [row] = await deliveries();
    expect(row).toMatchObject({ status: "pending", attempts: 1, failure: "threw", detail: null });
    expect(row!.next_at!).toBeGreaterThanOrEqual(before + DELIVERY_BACKOFF_MS[0]!);
    expect(row!.next_at!).toBeLessThan(before + DELIVERY_BACKOFF_MS[0]! + 10_000);
  });
});

describe("the mapping snapshot and settings", () => {
  it("reads the email through the snapshot after the question was renamed", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const a = await seed(form);
    next = (_ctx, call) => {
      if (call === 1) throw new Error("down");
      return { reference: "ok" };
    };
    await runDeliveries(rt, env, env.DB, { now: T0 });
    // A publisher renames `email` to `work_email`; the mapping follows in the same save.
    await env.DB.prepare("update forms set fields = ?, actions = ? where id = ?")
      .bind(
        JSON.stringify([{ ...EMAIL, name: "work_email" }]),
        JSON.stringify([{ ...ATTACH, map: { email: "work_email" } }]),
        form,
      )
      .run();
    const stored = (await formById(env.DB, form))!;
    const result = await retryDelivery(deps({}, T0 + 5), stored, a, "probe");
    expect(result).toMatchObject({ kind: "ok", delivery: { status: "delivered" } });
    // The visitor's own address, found under the name it was stored under.
    expect(seen[1]?.inputs).toEqual({ email: "ada@example.com" });
  });

  it("re-reads settings at every attempt, with the same key", async () => {
    const form = await insertForm([EMAIL], [{ ...ATTACH, settings: { listId: "wrong" } }]);
    const a = await seed(form);
    next = (ctx) => {
      if (ctx.settings.listId === "wrong") throw new Error("bad list");
      return { reference: "fixed" };
    };
    await runDeliveries(rt, env, env.DB, { now: T0 });
    await env.DB.prepare("update forms set actions = ? where id = ?")
      .bind(JSON.stringify([{ ...ATTACH, settings: { listId: "right" } }]), form)
      .run();
    const stored = (await formById(env.DB, form))!;
    const result = await retryDelivery(deps({}, T0 + 5), stored, a, "probe");
    expect(result).toMatchObject({
      kind: "ok",
      delivery: { status: "delivered", reference: "fixed" },
    });
    expect(seen.map((s) => s.settings.listId)).toEqual(["wrong", "right"]);
    expect(seen[0]?.key).toBe(seen[1]?.key);
    expect(seen[1]?.attempt).toBe(1);
  });

  it("fails predates_mapping when a row with no snapshot is retried onto a question it never had", async () => {
    const form = await insertForm(
      [EMAIL, { name: "phone", kind: "text", label: "Phone" }],
      [{ ...ATTACH, map: { email: "phone" } }],
    );
    // Created `failed` (incomplete at submit): no snapshot. The answers hold `email` only.
    const a = await seed(form, {
      status: "failed",
      failure: "incomplete",
      next_at: null,
      inputs_map: null,
    });
    const stored = (await formById(env.DB, form))!;
    const result = await retryDelivery(deps({}, T0), stored, a, "probe");
    expect(result).toMatchObject({
      kind: "ok",
      delivery: { status: "failed", failure: "predates_mapping" },
    });
    expect(seen).toHaveLength(0);
    // And Retry is refused for it from then on.
    const again = await retryDelivery(deps({}, T0 + 1), stored, a, "probe");
    expect(again.kind).toBe("conflict");
    expect(again.kind === "conflict" && again.message).toMatch(/before the current mapping/);
  });

  it("records the current mapping on a row with no snapshot once it resolves", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const a = await seed(form, {
      status: "failed",
      failure: "incomplete",
      next_at: null,
      inputs_map: null,
    });
    const stored = (await formById(env.DB, form))!;
    const result = await retryDelivery(deps({}, T0), stored, a, "probe");
    expect(result).toMatchObject({ kind: "ok", delivery: { status: "delivered" } });
    expect(JSON.parse((await rowOf(a)).inputs_map!)).toEqual({ email: "email" });
  });
});

describe("Retry", () => {
  const retry = async (rid: string, form: string, at = T0) =>
    retryDelivery(deps({}, at), (await formById(env.DB, form))!, rid, "probe");

  it("revives a failed or skipped row from attempt one", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const failed = await seed(form, {
      status: "failed",
      attempts: 8,
      failure: "gave_up",
      next_at: null,
    });
    const skipped = await seed(form, {
      status: "skipped",
      detail: "Not production",
      next_at: null,
    });
    for (const rid of [failed, skipped]) {
      expect(await retry(rid, form)).toMatchObject({
        kind: "ok",
        delivery: { status: "delivered" },
      });
      expect(await rowOf(rid)).toMatchObject({ attempts: 1, failure: null, detail: null });
    }
  });

  it("a Retry that fails resumes the automatic schedule from its first step", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const a = await seed(form, {
      status: "failed",
      attempts: 8,
      failure: "gave_up",
      next_at: null,
    });
    next = () => {
      throw new Error("still down");
    };
    const result = await retry(a, form);
    expect(result).toMatchObject({ kind: "ok", delivery: { status: "pending", attempts: 1 } });
    expect((await rowOf(a)).next_at).toBe(T0 + DELIVERY_BACKOFF_MS[0]!);
  });

  it("refuses while an attempt holds the lease, and starts no second one", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const a = await seed(form, { attempts: 1, next_at: T0 + DELIVERY_LEASE_MS, claim: "held" });
    const result = await retry(a, form, T0 + 1000);
    expect(result).toEqual({ kind: "conflict", message: "An attempt is in progress" });
    expect(seen).toHaveLength(0);
    expect((await rowOf(a)).claim).toBe("held");
  });

  it("refuses a delivered row: resending a lead the third party holds is a duplicate", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const a = await seed(form, { status: "delivered", attempts: 1, next_at: null });
    expect(await retry(a, form)).toEqual({ kind: "conflict", message: "Already delivered" });
    expect(seen).toHaveLength(0);
  });

  it("refuses a cancelled row, a removed attachment and an unregistered action", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const cancelled = await seed(form, { status: "cancelled", next_at: null });
    expect(await retry(cancelled, form)).toEqual({
      kind: "conflict",
      message: "The action is no longer attached",
    });

    const bare = await insertForm([EMAIL], []);
    const orphan = await seed(bare, { status: "failed", failure: "gave_up", next_at: null });
    expect(await retry(orphan, bare)).toEqual({
      kind: "conflict",
      message: "The action is no longer attached",
    });

    const gone = await insertForm([EMAIL], [{ action: "gone", delivers: true }]);
    const unreg = await seed(gone, {
      action: "gone",
      status: "failed",
      failure: "not_registered",
      next_at: null,
    });
    const result = await retryDelivery(
      deps({}, T0),
      (await formById(env.DB, gone))!,
      unreg,
      "gone",
    );
    expect(result).toEqual({ kind: "conflict", message: "The action is no longer registered" });
  });

  it("answers missing for an unknown delivery", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    expect(await retry("res_00000000dead", form)).toEqual({ kind: "missing" });
  });

  it("is a route: 200 with the row, 409 with the reason, 404 for an unknown delivery", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const failed = await seed(form, {
      status: "failed",
      failure: "gave_up",
      attempts: 8,
      next_at: null,
    });
    const delivered = await seed(form, { status: "delivered", next_at: null, attempts: 1 });
    const call = async (rid: string, action = "probe") => {
      const ctx = createExecutionContext();
      const res = await folio.handle(
        new Request(
          `${ORIGIN}/folio/api/forms/${form}/responses/${rid}/deliveries/${action}/retry`,
          {
            method: "POST",
          },
        ),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res!;
    };
    const ok = await call(failed);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { delivery: { status: string } }).delivery.status).toBe(
      "delivered",
    );
    const conflict = await call(delivered);
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { message: string } }).error.message).toBe(
      "Already delivered",
    );
    expect((await call("res_00000000dead")).status).toBe(404);
    expect((await call(failed, "BAD_ID")).status).toBe(400);
  });
});

describe("the pass", () => {
  it("does not attempt an action again in the same pass after it timed out", async () => {
    const form = await insertForm([EMAIL], [ATTACH, { action: "other", delivers: true }]);
    next = () => new Promise(() => {});
    const hung = [];
    for (let i = 0; i < 4; i++) hung.push(await seed(form, { next_at: 10 + i }));
    const fine = await seed(form, { action: "other", inputs_map: "{}", next_at: 20 });
    const report = await runDeliveries(rt, env, env.DB, { now: T0, deliverMs: 40 });
    expect(seen).toHaveLength(1);
    expect(otherCalls).toBe(1);
    expect(report.due).toBe(5);
    expect((await rowOf(hung[0]!)).failure).toBe("timeout");
    // The rest of the hung action's rows were not claimed.
    for (const rid of hung.slice(1))
      expect(await rowOf(rid)).toMatchObject({ attempts: 0, claim: null });
    expect((await rowOf(fine, "other")).status).toBe("delivered");
  });

  it("stops claiming once the wall-clock budget is spent", async () => {
    const form = await insertForm([EMAIL], [{ action: "other", delivers: true }]);
    otherDelayMs = 40;
    for (let i = 0; i < 8; i++)
      await seed(form, { action: "other", inputs_map: "{}", next_at: 10 + i });
    await runDeliveries(rt, env, env.DB, { now: T0, budgetMs: 50 });
    expect(otherCalls).toBeGreaterThanOrEqual(1);
    expect(otherCalls).toBeLessThan(8);
    const untouched = await env.DB.prepare(
      "select count(*) as n from form_deliveries where attempts = 0",
    ).first<{ n: number }>();
    expect(untouched!.n).toBe(8 - otherCalls);
  });

  it("takes at most the batch, oldest first", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await seed(form, { next_at: 100 - i }));
    const report = await runDeliveries(rt, env, env.DB, { now: T0, batch: 2 });
    expect(report.due).toBe(2);
    expect((await rowOf(ids[4]!)).status).toBe("delivered");
    expect((await rowOf(ids[3]!)).status).toBe("delivered");
    expect((await rowOf(ids[0]!)).status).toBe("pending");
  });

  it("a dry run reports how many are due and attempts none", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    for (let i = 0; i < 3; i++) await seed(form);
    const report = await runDeliveries(rt, env, env.DB, { now: T0, dryRun: true });
    expect(report).toMatchObject({ due: 3, delivered: 0 });
    expect(seen).toHaveLength(0);
  });

  it("deletes refusals older than two rate windows and keeps the rest", async () => {
    const window = 60 * 60 * 1000;
    await env.DB.batch([
      env.DB.prepare("insert into form_refusals values ('old', 'f', ?)").bind(T0 - 2 * window - 1),
      env.DB.prepare("insert into form_refusals values ('new', 'f', ?)").bind(T0 - window),
    ]);
    await runDeliveries(rt, env, env.DB, { now: T0 });
    const { results } = await env.DB.prepare("select ip_hash from form_refusals").all<{
      ip_hash: string;
    }>();
    expect(results.map((r) => r.ip_hash)).toEqual(["new"]);
  });
});

describe("folio.runSchedules runs deliveries last, and only at the end of the sweep", () => {
  async function schedule(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await env.DB.prepare(
        `insert into schedules (id, story_id, action, at, status, created_at)
         values (?, ?, 'publish', ?, 'pending', 1)`,
      )
        .bind(`sch_${i.toString(16).padStart(12, "0")}`, `sty_missing_${i}`, 100 + i)
        .run();
    }
  }
  beforeEach(async () => {
    await env.DB.prepare("delete from schedules").run();
  });

  it("attaches the report only to the call that finishes the sweep", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const a = await seed(form, { next_at: 5 });
    await schedule(3);

    const first = await folio.runSchedules(env, { batch: 1, now: T0 });
    expect(first.continueFrom).not.toBeNull();
    expect(first.deliveries).toBeUndefined();
    // Nothing was attempted while a schedule was still owed.
    expect(seen).toHaveLength(0);
    expect((await rowOf(a)).attempts).toBe(0);

    const second = await folio.runSchedules(env, {
      batch: 1,
      now: T0,
      continueFrom: first.continueFrom,
    });
    expect(second.deliveries).toBeUndefined();
    expect(seen).toHaveLength(0);

    const third = await folio.runSchedules(env, {
      batch: 1,
      now: T0,
      continueFrom: second.continueFrom,
    });
    expect(third.continueFrom).toBeNull();
    expect(third.deliveries).toMatchObject({ due: 1, delivered: 1, failed: [] });
    expect(seen).toHaveLength(1);
  });

  it("runs a delivery pass on a tick with nothing scheduled", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    await seed(form, { next_at: 5 });
    const report = await folio.runSchedules(env, { now: T0 });
    expect(report.deliveries).toMatchObject({ due: 1, delivered: 1 });
  });

  it("a dry run attempts none", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    await seed(form, { next_at: 5 });
    const report = await folio.runSchedules(env, { now: T0, dryRun: true });
    expect(report.deliveries).toMatchObject({ due: 1, delivered: 0 });
    expect(seen).toHaveLength(0);
  });

  it("never runs from POST {base}/api/schedules/run", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const a = await seed(form, { next_at: 5 });
    const ctx = createExecutionContext();
    const res = await folio.handle(
      new Request(`${ORIGIN}/folio/api/schedules/run`, { method: "POST" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as Record<string, unknown>).deliveries).toBeUndefined();
    expect(seen).toHaveLength(0);
    expect((await rowOf(a)).attempts).toBe(0);
  });
});

describe("every delete path takes the deliveries with it", () => {
  it("deleteResponse", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const keep = await seed(form);
    const gone = await seed(form);
    expect((await deleteResponse(env.DB, form, gone)).deleted).toBe(true);
    const left = (await deliveries()).map((d) => d.response_id);
    expect(left).toEqual([keep]);
  });

  it("deleteResponse leaves the deliveries of a response the caller cannot see", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const theirs = await seed(form, { site: "bravo" });
    expect(
      (await deleteResponse(env.DB, form, theirs, undefined, undefined, ["alpha"])).deleted,
    ).toBe(false);
    expect(await count("form_deliveries")).toBe(1);
  });

  it("deleteResponses, by ids and by filter", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const ids = [await seed(form), await seed(form)];
    await deleteResponses({ db: env.DB }, form, { ids });
    expect(await count("form_deliveries")).toBe(0);

    const a = await seed(form, { status: "failed", failure: "gave_up", next_at: null });
    await seed(form, { status: "pending" });
    const out = await deleteResponses({ db: env.DB }, form, {
      all: true,
      filter: { delivery: "failed" },
      expected: 1,
    });
    expect(out).toMatchObject({ done: 1 });
    expect((await deliveries()).map((d) => d.response_id)).not.toContain(a);
    expect(await count("form_deliveries")).toBe(1);
  });

  it("deleteForm, and the form's refusals", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const other = await insertForm([EMAIL], [ATTACH]);
    await seed(form);
    await seed(other);
    await env.DB.batch([
      env.DB.prepare("insert into form_refusals values ('h', ?, 1)").bind(form),
      env.DB.prepare("insert into form_refusals values ('h', ?, 1)").bind(other),
    ]);
    await deleteForm(env.DB, form);
    expect((await deliveries()).map((d) => d.form_id)).toEqual([other]);
    expect(await count("form_refusals")).toBe(1);
  });

  it("the next sweep attempts nothing for a deleted response", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const a = await seed(form);
    await deleteResponse(env.DB, form, a);
    const report = await runDeliveries(rt, env, env.DB, { now: T0 });
    expect(report).toMatchObject({ due: 0, delivered: 0 });
    expect(seen).toHaveLength(0);
  });
});

describe("responses read their deliveries inside the site fence", () => {
  it("lists one compact status per delivery, and the full rows on the response", async () => {
    const form = await insertForm([EMAIL], [ATTACH, { action: "other", delivers: true }]);
    const a = await seed(form, { status: "pending", attempts: 3 });
    await env.DB.prepare(
      `insert into form_deliveries (response_id, action, form_id, status, attempts, host, created_at, updated_at, reference)
       values (?, 'other', ?, 'delivered', 1, 'h', 1, 1, 'REF')`,
    )
      .bind(a, form)
      .run();
    const page = await listResponses(env.DB, form);
    expect(page.rows[0]?.deliveries).toEqual([
      { action: "other", status: "delivered", attempts: 1 },
      { action: "probe", status: "pending", attempts: 3 },
    ]);
    const one = await responseById(env.DB, form, a);
    expect(one?.deliveries.map((d) => [d.action, d.status, d.reference])).toEqual([
      ["other", "delivered", "REF"],
      ["probe", "pending", null],
    ]);
  });

  it("filters by delivery status", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const failed = await seed(form, { status: "failed", failure: "gave_up", next_at: null });
    await seed(form, { status: "delivered", next_at: null });
    const page = await listResponses(env.DB, form, { filter: { delivery: "failed" } });
    expect(page.rows.map((r) => r.id)).toEqual([failed]);
  });

  it("counts failed and overdue deliveries only for the sites the reader can see", async () => {
    const form = await insertForm([EMAIL], [ATTACH]);
    const now = Date.now();
    for (const site of ["alpha", "alpha", "bravo", "bravo", "bravo"]) {
      await seed(form, { site, status: "failed", failure: "gave_up", next_at: null });
    }
    await seed(form, { site: "alpha", next_at: now - 20 * 60_000 });
    await seed(form, { site: "bravo", next_at: now - 20 * 60_000 });
    await seed(form, { site: "alpha", next_at: now - 60_000 });

    const alpha = await listResponses(env.DB, form, { count: true, sites: ["alpha"] });
    expect(alpha.failedDeliveries).toBe(2);
    expect(alpha.overdueDeliveries).toBe(1);
    const bravo = await listResponses(env.DB, form, { count: true, sites: ["bravo"] });
    expect(bravo.failedDeliveries).toBe(3);
    const none = await listResponses(env.DB, form, { count: true, sites: ["charlie"] });
    expect(none.failedDeliveries).toBe(0);
    const all = await listResponses(env.DB, form, { count: true });
    expect(all.failedDeliveries).toBe(5);
    expect(all.overdueDeliveries).toBe(2);
  });
});
