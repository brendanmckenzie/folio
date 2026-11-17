/**
 * The choices a sourced `select` offers (`platform/admin-extensions.md` decisions 18 to 20):
 * `GET {base}/api/v1/options/:block/:field`, so an agent or a script writes a value the field
 * will accept instead of guessing (the same list `patch_fields` and `write_content` check
 * against), and `GET {base}/api/field-options`, which the inspector's picker reads and which
 * can also label the retired values a document stores.
 */
import { type Context, Hono } from "hono";
import type { Doc } from "../../../core/doc";
import { isKnownLocale } from "../../../core/locales";
import { fieldOptions } from "../../../core/option-sources";
import { READ } from "../../auth/roles";
import { FolioError } from "../../errors";
import { hookCtx, inFence, requireAccess } from "../../middleware";
import {
  effectiveSettings,
  type HostPreview,
  lookupLabels,
  MAX_LOOKUP_VALUES,
  previewHostList,
} from "../../option-sources";
import type { FolioRuntime, BrandRuntime } from "../../runtime";
import { storyById } from "../../stories";
import { brandOf, draftOf } from "../stories";
import type { FolioEnv } from "../../types";
import { idParam, localeQuery } from "../../validate";

/** A refresh for a missing or stale list may take this long before the route answers what it has. */
export const OPTIONS_REFRESH_MS = 10_000;

/** What both routes answer, before the admin's `missing`. */
interface Sourced {
  brand: BrandRuntime;
  source: NonNullable<ReturnType<BrandRuntime["fieldSources"]["get"]>>;
  block: string;
  extras: readonly { value: string; label: string }[];
  settings: ReturnType<typeof effectiveSettings>;
  locale: string;
  preview: HostPreview;
}

/**
 * Resolves `block.field` to its source and refreshes a missing or stale list through the
 * lease (`referenced: true`: a field's list is a row the cron keeps, decision 18). **The
 * settings come from the schema and never from the caller**, so a source registered only for
 * fields runs only with the settings the code declared.
 */
async function sourcedList<Env>(
  c: Context<FolioEnv<Env>>,
  rt: FolioRuntime,
  blockName: string,
  fieldName: string,
  askedLocale: string | undefined,
): Promise<Sourced> {
  const brand = brandOf(c);
  const block = brand.schema[blockName];
  if (!block) throw new FolioError("not_found", `No block '${blockName}'`);
  const field = block.fields[fieldName];
  if (!field) throw new FolioError("not_found", `'${block.name}' has no field '${fieldName}'`);
  if (field.kind !== "select" || !field.optionsFrom) {
    throw new FolioError(
      "bad_request",
      `${block.name}.${fieldName} does not take its options from a source`,
    );
  }
  const source = brand.fieldSources.get(field.optionsFrom.source);
  if (!source) throw new FolioError("not_found", "That option source is not registered");

  let locale = "";
  if (askedLocale !== undefined) {
    const code = localeQuery(askedLocale);
    if (!isKnownLocale(rt.locales, code)) {
      throw new FolioError("unsupported", `Unknown locale: ${code}`);
    }
    // A source that is not localised has one list, the source locale's.
    if (source.localised && code !== rt.locales?.default) locale = code;
  }
  const settings = effectiveSettings(source, field.optionsFrom.settings);
  const preview = await previewHostList(
    {
      db: c.var.bindings().db,
      env: c.env,
      brand: brand.brand,
      source,
      logger: rt.logger,
      ...(rt.formPurgeCapability ? { purgeCapability: rt.formPurgeCapability } : {}),
      waitUntil: hookCtx(c).waitUntil,
    },
    { settings, locale },
    true,
    OPTIONS_REFRESH_MS,
  );
  return { brand, source, block: block.name, extras: field.options, settings, locale, preview };
}

const answerOf = (s: Sourced) => ({
  source: s.source.id,
  // The source's own label, which the admin names in "No longer offered by Products".
  label: s.source.label,
  status: s.preview.status,
  loadedAt: s.preview.loadedAt,
  ...(s.preview.failure ? { failure: s.preview.failure } : {}),
  options: fieldOptions(s.preview.options, s.extras),
});

/** `GET {base}/api/v1/options/:block/:field`: a public, versioned read (decision 20). */
export function optionRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>();
  app.get("/options/:block/:field", requireAccess<Env>(rt, READ), async (c) => {
    const sourced = await sourcedList(
      c,
      rt,
      c.req.param("block"),
      c.req.param("field"),
      c.req.query("locale"),
    );
    return c.json(answerOf(sourced));
  });
  return app;
}

/**
 * Every distinct non-empty value `doc` stores in `blockName.fieldName`, in every blok of the
 * type: the source data and each locale's override.
 */
function storedValues(doc: Doc, blockName: string, fieldName: string): string[] {
  const seen = new Set<string>();
  for (const blok of Object.values(doc.bloks)) {
    if (blok.type !== blockName) continue;
    const candidates = [
      blok.data[fieldName],
      ...Object.values(blok.i18n ?? {}).map((map) => map[fieldName]),
    ];
    for (const value of candidates) {
      if (typeof value === "string" && value !== "") seen.add(value);
    }
  }
  return [...seen];
}

/**
 * `GET {base}/api/field-options?block&field&locale[&story]`: internal to the admin, scoped,
 * `READ` (decision 19). With `story` (fenced to the chain like every id route) it also names the
 * values that document stores which the list no longer offers, with `lookup`'s label where the
 * source has one, else `null`.
 *
 * **`lookup` is asked only about values a document actually stores**, at most 20, so this is no
 * label oracle for arbitrary ids: it answers labels only for ids an editor has already put in
 * a document the caller may read. Nothing is cached, because a retired product's label is rarely
 * asked twice and a cache would be a fourth copy of the host's data with no purge.
 */
export function fieldOptionRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>();
  app.get("/field-options", requireAccess<Env>(rt, READ), async (c) => {
    const block = c.req.query("block");
    const field = c.req.query("field");
    if (!block || !field) {
      throw new FolioError("bad_request", "block and field are required");
    }
    const sourced = await sourcedList(c, rt, block, field, c.req.query("locale"));
    const body = answerOf(sourced);

    const storyId = c.req.query("story");
    if (storyId === undefined) return c.json(body);
    const story = await storyById(c.var.bindings().db, idParam("story", storyId));
    if (!story || !(await inFence(c, rt, story, "read"))) {
      throw new FolioError("not_found", "Unknown story");
    }
    const offered = new Set(body.options.map((o) => o.value));
    const retired = storedValues(await draftOf(c, rt)(story), block, field)
      .filter((value) => !offered.has(value))
      .slice(0, MAX_LOOKUP_VALUES);
    if (retired.length === 0) return c.json(body);
    const labels = await lookupLabels(
      {
        env: c.env,
        brand: sourced.brand.brand,
        source: sourced.source,
        logger: rt.logger,
      },
      sourced.settings,
      sourced.locale,
      retired,
    );
    return c.json({
      ...body,
      missing: retired.map((value) => ({ value, label: labels.get(value) ?? null })),
    });
  });
  return app;
}
