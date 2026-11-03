import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { defineBlock, text } from "../../src/core";
import type { LocaleConfig } from "../../src/core/locales";
import {
  createFolio,
  type FolioBindings,
  type FolioConfig,
  type FolioForms,
} from "../../src/server";

/**
 * Shared by the form-action workers tests (`form-submit-actions.test.ts`,
 * `form-deliveries.test.ts`): a Folio with `forms.actions`, forms inserted straight
 * into D1, and the public submit route driven through `folio.handle` so a test owns
 * the execution context and can wait for the delivery `waitUntil`.
 */

export const ORIGIN = "https://example.com";

const page = defineBlock({
  name: "faxPage",
  label: "Page",
  fields: { title: text() },
  render: () => null,
});

export const LOCALES: LocaleConfig = {
  default: "en",
  available: [
    { code: "en", label: "English" },
    { code: "fr", label: "Francais" },
  ],
};

export interface Logged {
  warn: string[];
  error: { message: string; extra: unknown[] }[];
}

export function makeLogger(): { logger: NonNullable<FolioConfig<unknown>["logger"]>; log: Logged } {
  const log: Logged = { warn: [], error: [] };
  return {
    log,
    logger: {
      ...console,
      warn: (message: string) => {
        log.warn.push(String(message));
      },
      error: (message: unknown, ...extra: unknown[]) => {
        log.error.push({ message: String(message), extra });
      },
    } as never,
  };
}

export function makeFolio(
  forms: FolioForms<Cloudflare.Env>,
  extra: {
    logger?: NonNullable<FolioConfig<unknown>["logger"]>;
    bindings?: (e: Cloudflare.Env) => FolioBindings;
    hooks?: unknown;
  } = {},
) {
  const bindings =
    extra.bindings ??
    ((e: Cloudflare.Env): FolioBindings => ({
      db: e.DB,
      story: e.STORY,
      media: e.MEDIA,
      images: e.IMAGES,
    }));
  const config = {
    blocks: [page],
    types: [{ name: "faxPage", label: "Page", kind: "page", root: "faxPage", default: true }],
    bindings,
    basePath: "/folio",
    auth: "open",
    locales: LOCALES,
    route: (p: string, locale?: string) => `${locale && locale !== "en" ? `/${locale}` : ""}/${p}`,
    logger: extra.logger ?? { ...console, error: () => {}, warn: () => {} },
    forms,
    ...(extra.hooks ? { hooks: extra.hooks } : {}),
  } as unknown as FolioConfig<Cloudflare.Env>;
  return { folio: createFolio<Cloudflare.Env>(config), config };
}

type Folio = ReturnType<typeof makeFolio>["folio"];

export async function wipe(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("delete from form_deliveries"),
    env.DB.prepare("delete from form_refusals"),
    env.DB.prepare("delete from form_responses"),
    env.DB.prepare("delete from forms"),
  ]);
}

export const EMAIL = { name: "email", kind: "email", label: "Email", required: true };
export const FIRST = { name: "first_name", kind: "text", label: "First name", required: true };
export const CODE = { name: "code", kind: "text", label: "Trip code", required: true };

let counter = 0;
export function formId(): string {
  counter += 1;
  return `frm_${counter.toString(16).padStart(12, "0")}`;
}

export async function insertForm(
  fields: unknown[],
  actions: unknown[] = [],
  over: { open?: number; id?: string; site?: string } = {},
): Promise<string> {
  const id = over.id ?? formId();
  await env.DB.prepare(
    `insert into forms (id, name, label, fields, actions, open, site_id, created_at, updated_at)
     values (?, ?, 'Enquiry', ?, ?, ?, ?, 1000, 1000)`,
  )
    .bind(
      id,
      `f-${id}`,
      JSON.stringify(fields),
      JSON.stringify(actions),
      over.open ?? 1,
      over.site ?? "default",
    )
    .run();
  return id;
}

export interface Posted {
  res: Response;
  /** Waits for the execution context, so the delivery `waitUntil` has finished. */
  settled: () => Promise<void>;
}

/** The public submit route, native (urlencoded, `accept: text/html`) or JSON. */
export async function post(
  folio: Folio,
  id: string,
  values: Record<string, string>,
  opts: { json?: boolean; ip?: string | null; host?: string; wait?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = opts.json
    ? { "content-type": "application/json" }
    : {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html,application/xhtml+xml",
      };
  const ip = opts.ip === undefined ? "203.0.113.9" : opts.ip;
  if (ip) headers["cf-connecting-ip"] = ip;
  const ctx = createExecutionContext();
  const res = await folio.handle(
    new Request(`https://${opts.host ?? "example.com"}/folio/f/${id}`, {
      method: "POST",
      redirect: "manual",
      headers,
      body: opts.json ? JSON.stringify(values) : new URLSearchParams(values).toString(),
    }),
    env,
    ctx,
  );
  if (opts.wait !== false) await waitOnExecutionContext(ctx);
  if (!res) throw new Error("handle() answered null for the submit route");
  return res;
}

export const reasonOf = (res: Response): string | null =>
  new URL(res.headers.get("location") ?? "https://x.invalid/").searchParams.get("folio_reason");
export const statusOf = (res: Response): string | null =>
  new URL(res.headers.get("location") ?? "https://x.invalid/").searchParams.get("folio_status");

export async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`select count(*) as n from ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

export interface DeliveryDbRow {
  response_id: string;
  action: string;
  form_id: string;
  status: string;
  attempts: number;
  next_at: number | null;
  claim: string | null;
  host: string;
  inputs_map: string | null;
  reference: string | null;
  failure: string | null;
  detail: string | null;
  created_at: number;
  updated_at: number;
}

export async function deliveries(): Promise<DeliveryDbRow[]> {
  const { results } = await env.DB.prepare(
    "select * from form_deliveries order by response_id, action",
  ).all<DeliveryDbRow>();
  return results;
}
