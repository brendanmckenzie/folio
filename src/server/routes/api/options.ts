/**
 * `GET {base}/api/v1/options/:block/:field` (`platform/admin-extensions.md` decisions 18 and 20):
 * the choices a sourced `select` offers, so an agent or a script writes a value the field will
 * accept instead of guessing. The same list `patch_fields` and `write_content` check against.
 */
import { Hono } from "hono";
import { isKnownLocale } from "../../../core/locales";
import { fieldOptions } from "../../../core/option-sources";
import { READ } from "../../auth/roles";
import { FolioError } from "../../errors";
import { hookCtx, requireAccess } from "../../middleware";
import { effectiveSettings, previewHostList } from "../../option-sources";
import type { FolioRuntime } from "../../runtime";
import { brandOf } from "../stories";
import type { FolioEnv } from "../../types";
import { localeQuery } from "../../validate";

/** A refresh for a missing or stale list may take this long before the route answers what it has. */
export const OPTIONS_REFRESH_MS = 10_000;

export function optionRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>();

  app.get("/options/:block/:field", requireAccess<Env>(rt, READ), async (c) => {
    const brand = brandOf(c);
    const block = brand.schema[c.req.param("block")];
    if (!block) throw new FolioError("not_found", `No block '${c.req.param("block")}'`);
    const field = block.fields[c.req.param("field")];
    if (!field) {
      throw new FolioError("not_found", `'${block.name}' has no field '${c.req.param("field")}'`);
    }
    if (field.kind !== "select" || !field.optionsFrom) {
      throw new FolioError(
        "bad_request",
        `${block.name}.${c.req.param("field")} does not take its options from a source`,
      );
    }
    const source = brand.fieldSources.get(field.optionsFrom.source);
    if (!source) throw new FolioError("not_found", "That option source is not registered");

    const asked = c.req.query("locale");
    let locale = "";
    if (asked !== undefined) {
      const code = localeQuery(asked);
      if (!isKnownLocale(rt.locales, code)) {
        throw new FolioError("unsupported", `Unknown locale: ${code}`);
      }
      // A source that is not localised has one list, the source locale's.
      if (source.localised && code !== rt.locales?.default) locale = code;
    }
    const settings = effectiveSettings(source, field.optionsFrom.settings);
    // `referenced: true`: a field's list is a row the cron keeps (decision 18), so a missing
    // or stale one is refreshed through the lease and the row it writes is the page's too.
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
    return c.json({
      source: source.id,
      status: preview.status,
      loadedAt: preview.loadedAt,
      ...(preview.failure ? { failure: preview.failure } : {}),
      options: fieldOptions(preview.options, field.options),
    });
  });

  return app;
}
