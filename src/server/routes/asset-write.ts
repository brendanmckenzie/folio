/**
 * What every route that writes an asset or a folder shares for asset access
 * (`asset-access.md` decision 11): the brand's domain, a value off a body or a query
 * checked against it, and the follow-up a write owes once its batch has committed.
 * One copy, because the admin's routes and `{base}/api/v1`'s are two surfaces over the
 * same services and a second copy of the refusal is a second place for it to drift.
 */
import type { Context } from "hono";
import type { Json } from "../../core/doc";
import {
  type AccessChangeContext,
  type AssetGating,
  afterAccessChange,
  newGating,
  parseAccessQuery,
  validateAccessValue,
} from "../asset-access";
import type { AssetAccessDomain } from "../gate";
import { FolioError } from "../errors";
import { actorString } from "../auth/roles";
import { brandIdOf, hookCtx } from "../middleware";
import type { FolioRuntime } from "../runtime";
import type { FolioEnv } from "../types";
import { brandOf } from "./stories";

/** The request's brand's asset domain, or null when its scope does not gate files. */
export function assetDomainOf<Env>(c: Context<FolioEnv<Env>>): AssetAccessDomain | null {
  return brandOf(c).gate?.assets ?? null;
}

/** A fresh gating for a write, or null when the scope does not gate files. */
export function gatingOf<Env>(c: Context<FolioEnv<Env>>): AssetGating | null {
  const domain = assetDomainOf(c);
  return domain ? newGating(domain) : null;
}

function refuseUngated(): never {
  throw new FolioError("unsupported", "This site does not gate files");
}

/**
 * An `access` off a body: absent leaves it alone, `null` inherits, a value is validated
 * against the brand's gate field. A scope that does not gate files refuses all three
 * (`400 unsupported`, the shape `describe` uses for an unconfigured feature).
 */
export function accessInput<Env>(
  c: Context<FolioEnv<Env>>,
  raw: string | number | boolean | null | undefined,
): Json | null | undefined {
  if (raw === undefined) return undefined;
  const domain = assetDomainOf(c);
  if (!domain) return refuseUngated();
  return raw === null ? null : validateAccessValue(domain, raw);
}

/** `?access=` on an upload: typed by `gate.public`'s primitive (decision 11). Absent is undefined. */
export function accessQuery<Env>(c: Context<FolioEnv<Env>>): Json | undefined {
  const raw = c.req.query("access");
  if (raw === undefined) return undefined;
  const domain = assetDomainOf(c);
  if (!domain) return refuseUngated();
  return parseAccessQuery(domain, raw);
}

/** The context `afterAccessChange` needs, off the request. */
export function accessContext<Env>(
  c: Context<FolioEnv<Env>>,
  rt: FolioRuntime,
  site: string,
): AccessChangeContext {
  return {
    db: c.var.bindings().db,
    ...(rt.assetPurgeCapability ? { capability: rt.assetPurgeCapability } : {}),
    logger: rt.logger,
    hooks: rt.hookRunner(hookCtx(c), brandIdOf(c)),
    waitUntil: (p) => c.executionCtx.waitUntil(p),
    site,
    actor: actorString(c.var.actor),
  };
}

/**
 * Everything an asset write owes after its batch: the drain, the hook, the best-effort
 * tags. Called after **every** asset write on a scope that gates files, an access change
 * or not, so a purge owed from an earlier failure gets another attempt (decision 10).
 * Answers `{ purge: { pending } }` to spread into the response, and `{}` on a scope that
 * does not gate files, so its responses are byte for byte what they were.
 */
export async function settleAssetWrite<Env>(
  c: Context<FolioEnv<Env>>,
  rt: FolioRuntime,
  site: string,
  gating: AssetGating | null,
  opts: { final?: boolean } = {},
): Promise<{ purge?: { pending: number } }> {
  if (!gating) return {};
  const { pending } = await afterAccessChange(accessContext(c, rt, site), gating, opts);
  return { purge: { pending } };
}
