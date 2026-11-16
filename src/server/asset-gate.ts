/**
 * Who may open a gated media-library file
 * (`../../docs/specs/platform/asset-access.md` decisions 5, 7 and 8).
 *
 * `routes/assets.ts` runs today's code, verbatim, when the deployment gates no files; it
 * reaches this module only when `rt.assetGating`. The order of the questions is the
 * design and each answer is cheaper than the one below it:
 *
 * 1. one indexed read of the row (no row is a 404: an orphaned object must never go out
 *    `public, immutable`);
 * 2. is the file gated at all (a null effective value, or `gate.public`, serves as it
 *    always did, with no host call);
 * 3. a signature, then a Folio credential, then a share, then the host's own
 *    `visitor` and `allowsAsset`, stopping at the first yes.
 *
 * **The brand is the asset's own scope's, never the request's.** The request's scope is
 * null on a site host and may be anything on the admin origin, and a file is governed by
 * the brand that owns it. Nothing here reads `c.var.scope`.
 */
import type { Context } from "hono";
import { ANY_ASSET_TAG, assetTag, NO_STORE } from "../core/cache-tags";
import type { Json } from "../core/doc";
import { isUngated } from "../core/gate";
import { assetKeys } from "../core/refs";
import { ALL_SCOPES, chain, type Registry } from "../core/sites";
import { type AssetAccessRow, assetAccessByKey, decodeAccess } from "./asset-access";
import { CSP } from "./assets";
import { hasDraftCookie, shareCookieTokens } from "./auth/cookie";
import {
  allows,
  effectiveRole,
  hasScope,
  mayPreviewDrafts,
  READ,
  tokenScopesOn,
} from "./auth/roles";
import { readShareByToken } from "./auth/shares";
import type { BrandRuntime, FolioRuntime } from "./runtime";
import { storyById } from "./stories";
import type { FolioAssetGateContext, FolioEnv } from "./types";

/** What the route does with a request once the gate has looked at it. */
export type AssetDecision =
  | { kind: "public"; tags: string }
  | { kind: "granted" }
  | { kind: "respond"; response: Response };

const BARE_HEADERS = {
  "cache-control": NO_STORE,
  "x-content-type-options": "nosniff",
  "content-security-policy": CSP,
};

/** The bare `403` of decision 7: empty body, never cacheable. */
export function denied(): Response {
  return new Response(null, { status: 403, headers: BARE_HEADERS });
}

/**
 * The share cookie's (share id, asset key set) memo, per isolate, for 30 seconds
 * (decision 8). Only the key set is remembered: whether the share is still live is
 * asked on every request, so revoking one takes effect at once.
 */
const SHARE_KEYS_TTL_MS = 30_000;
const SHARE_KEYS_MAX = 200;
const shareKeys = new Map<string, { keys: Set<string>; until: number }>();

/** Test seam: forget what shares have been read. */
export function clearShareKeyMemo(): void {
  shareKeys.clear();
}

/** The tags a public-mode response carries when the deployment gates files (decision 10). */
export function assetTags(key: string): string {
  // The id is the key's `ast_<12 hex>` prefix, so no D1 read is needed for it.
  return `${assetTag(key.slice(0, 16))},${ANY_ASSET_TAG}`;
}

/**
 * Signature verification (decision 9) answers "absent" until phase 8: a request is never
 * admitted by one here.
 */
async function signatureAdmits(): Promise<boolean> {
  return false;
}

export async function decideAsset<Env>(
  c: Context<FolioEnv<Env>>,
  rt: FolioRuntime,
  key: string,
): Promise<AssetDecision> {
  const row = await assetAccessByKey(c.var.bindings().db, key);
  if (!row) {
    // The same body as today's missing-object 404, and never cacheable.
    return {
      kind: "respond",
      response: c.json({ error: { code: "not_found", message: "No such asset" } }, 404, {
        "cache-control": NO_STORE,
      }),
    };
  }
  const tags = assetTags(key);
  if (row.effectiveAccess === null) return { kind: "public", tags };

  const registry = rt.sites ? await rt.sites.registry(c.env) : null;
  const brand = registry ? rt.forScope(registry, row.siteId) : (rt.brands.get(null) ?? null);
  // A gated file whose scope resolves to no brand serves nothing, and there is no
  // brand to take the host's hook from.
  if (!brand) return { kind: "respond", response: denied() };
  const gate = brand.gate;
  // The sanctioned fail-open: the host switched the feature off for this brand.
  if (!gate?.assets) return { kind: "public", tags };

  const value = decodeAccess(row.effectiveAccess, rt.logger);
  if (value !== undefined && isUngated(value, gate.config.public)) return { kind: "public", tags };

  const gatedSite = c.var.site?.id;
  const site =
    registry && gatedSite !== undefined
      ? (registry.sites.find((s) => s.id === gatedSite) ?? null)
      : null;
  const ctx: FolioAssetGateContext = {
    asset: {
      id: row.id,
      key,
      filename: row.filename,
      contentType: row.contentType,
      size: row.size,
      folderId: row.folderId,
    },
    scope: row.siteId,
    site,
    inherited: row.access === null,
  };

  if (await signatureAdmits()) return { kind: "granted" };
  if (credentialAdmits(c, rt, row, registry)) return { kind: "granted" };
  if (await shareAdmits(c, rt, row, key, brand, registry)) return { kind: "granted" };

  const config = gate.config;
  let allowed = false;
  try {
    const who = await config.visitor(c.req.raw, c.env);
    try {
      allowed = Boolean(await config.allowsAsset?.(who, value, ctx));
    } catch (err) {
      rt.logger.error("folio: gate.allowsAsset threw; denying", err);
    }
  } catch (err) {
    rt.logger.error("folio: gate.visitor threw; denying asset", err);
  }
  if (allowed) return { kind: "granted" };

  return { kind: "respond", response: await denial(c, rt, config, ctx, value ?? null) };
}

/** Decision 7: the host's `assetDenied`, rebuilt `private, no-store`, else the bare 403. */
async function denial<Env>(
  c: Context<FolioEnv<Env>>,
  rt: FolioRuntime,
  config: NonNullable<BrandRuntime["gate"]>["config"],
  ctx: FolioAssetGateContext,
  value: Json,
): Promise<Response> {
  if (!config.assetDenied) return denied();
  try {
    const res = await config.assetDenied(c.req.raw, c.env, { ...ctx, value });
    if (!res) return denied();
    // Rebuilt: a redirect's headers are immutable, and the answer varies by visitor.
    const headers = new Headers(res.headers);
    headers.set("cache-control", NO_STORE);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  } catch (err) {
    rt.logger.error("folio: gate.assetDenied threw", err);
    return denied();
  }
}

/** Decision 8: one rule per actor kind. */
function credentialAdmits<Env>(
  c: Context<FolioEnv<Env>>,
  rt: FolioRuntime,
  row: AssetAccessRow,
  registry: Registry | null,
): boolean {
  if (rt.auth.mode !== "session") {
    // `auth: 'open'` has no actor; the draft cookie alone is the authority, as it is
    // for a page (`editorAdmits`).
    return hasDraftCookie(c.req.raw.headers.get("cookie"));
  }
  const actor = c.var.actor;
  if (!actor) return false;
  if (actor.kind === "grant") {
    const site = c.var.site?.id;
    return (
      registry !== null &&
      site !== undefined &&
      mayPreviewDrafts(actor, registry, site) &&
      chain(registry, site).includes(row.siteId)
    );
  }
  if (actor.kind === "token") {
    if (!registry) return allows(actor, READ);
    const scopes = tokenScopesOn(actor.scopes, actor.site ?? null, registry, row.siteId);
    return hasScope(scopes ?? [], READ.scope);
  }
  if (!registry) return allows(actor, READ);
  return effectiveRole(actor.grants ?? { [ALL_SCOPES]: actor.role }, registry, row.siteId) !== null;
}

/**
 * A share cookie admits a file its story's draft uses, in a scope the story's chain holds
 * (decision 8). `readShareByToken` stamps no view, and runs on every request.
 */
async function shareAdmits<Env>(
  c: Context<FolioEnv<Env>>,
  rt: FolioRuntime,
  row: AssetAccessRow,
  key: string,
  brand: BrandRuntime,
  registry: Registry | null,
): Promise<boolean> {
  const tokens = shareCookieTokens(c.req.raw.headers.get("cookie"));
  if (tokens.length === 0) return false;
  // A link redeems only on the site it was issued for.
  const gated = c.var.site?.id;
  if (rt.sites && gated === undefined) return false;
  const bindings = c.var.bindings();
  const now = Date.now();
  for (const token of tokens) {
    const share = await readShareByToken(bindings.db, token, now, gated);
    if (!share) continue;
    const story = await storyById(bindings.db, share.storyId);
    if (!story) continue;
    if (registry && !chain(registry, story.site ?? "").includes(row.siteId)) continue;

    let memo = shareKeys.get(share.id);
    if (!memo || memo.until <= now) {
      const doc = await brand.draftFor(bindings, story, registry ?? undefined);
      memo = { keys: new Set(assetKeys(doc, brand.schema)), until: now + SHARE_KEYS_TTL_MS };
      if (shareKeys.size >= SHARE_KEYS_MAX) {
        shareKeys.delete(shareKeys.keys().next().value as string);
      }
      shareKeys.set(share.id, memo);
    }
    if (memo.keys.has(key)) return true;
  }
  return false;
}
