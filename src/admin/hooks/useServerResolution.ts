import { useEffect, useMemo, useRef, useState } from "react";
import type { Doc } from "../../core/doc";
import type { LocaleContext } from "../../core/locales";
import { collectionQueries } from "../../core/query";
import { formIds, linkedIds, referencedIdsAllLocales } from "../../core/refs";
import { previewParamsOf, type Resolution } from "../../core/resolve";
import type { SchemaIndex } from "../../core/schema";

/** How long the id set has to hold still before it is asked about. Long enough that
 * the server's draft has taken the edit that changed it (the socket and this fetch are
 * two connections), short enough that a freshly picked link resolves at once. */
const SETTLE_MS = 300;

/** Statuses that are the server's settled word on a request, as opposed to a hiccup. */
const DEFINITIVE: ReadonlySet<number> = new Set([400, 401, 403, 404, 501]);

/**
 * Everything in the open document that decides what the server's resolution holds,
 * as one string: the ids its links, references and forms point at, its collection
 * queries, the locale, and the page's own place in the tree.
 *
 * **It is a signature and not the ids to fetch.** The server walks the draft itself
 * (pass three, ancestors, nested forms, globals), so the client does not have to
 * guess what to ask for; it only has to know *when the answer may have changed*. An
 * unchanged set is an unchanged string however the document was edited around it,
 * which is what keeps a keystroke in a text field from reaching the network.
 *
 * Pure and exported so the "never per keystroke" claim is a test and not a reading.
 */
export function resolutionSignature(
  doc: Doc | null,
  schema: SchemaIndex,
  extra: { locale?: LocaleContext; place?: string } = {},
): string {
  if (!doc) return "";
  const sorted = (ids: Iterable<string>) => [...new Set(ids)].sort().join(",");
  return [
    sorted(linkedIds(doc, schema)),
    sorted(referencedIdsAllLocales(doc, schema)),
    sorted(formIds(doc, schema)),
    [...collectionQueries(doc, schema, undefined, extra.locale)]
      .map(([key]) => key)
      .sort()
      .join("|"),
    extra.locale?.code ?? "",
    extra.place ?? "",
    // Block types come and go as an editor adds them, and each may declare params.
    JSON.stringify(previewParamsOf(doc, schema) ?? null),
  ].join(";");
}

/**
 * The URL the resolution is fetched from. Always the admin's **own** mount, with the
 * site the pane previews named as `?site=`: asking on the pane site's mount instead
 * refuses a caller whose only role is on `shared`, who may preview there all the same.
 * The server treats the site as context and narrows the chain to what the caller's
 * own scope may read. Pure and exported so the URL is a test and not a network tab.
 */
export function resolutionUrl(
  apiBase: string,
  storyId: string,
  opts: { locale?: string; site?: string } = {},
): string {
  const query = new URLSearchParams();
  if (opts.locale) query.set("locale", opts.locale);
  if (opts.site) query.set("site", opts.site);
  const tail = query.size > 0 ? `?${query}` : "";
  return `${apiBase}/story/${encodeURIComponent(storyId)}/resolution${tail}`;
}

/**
 * The resolution the server builds for the open story's draft
 * (`GET {base}/api/story/:id/resolution`), or null until one has arrived.
 *
 * **Null is load-bearing.** The preview iframe is bootstrapped with the server's own
 * resolution, and the bridge used to post a hand-built one over it on every `ready`,
 * which dropped everything the admin did not assemble (pass-three links, breadcrumb
 * ancestors, forms in referenced cards, `site` and `path`). While this is null the
 * bridge posts no resolution at all, so the first frame is never emptier than the
 * server's.
 *
 * Refetched when `resolutionSignature` changes, after it has held still for
 * `SETTLE_MS` **and the server has every edit this client sent** (`idle`). The server
 * resolves its own copy of the draft, so a link picked while the socket is slow or
 * reconnecting would otherwise be asked about before the server could know it, and
 * nothing would ask again. A signature already answered is not asked twice, so the
 * idle flag flickering on each keystroke fetches nothing; never per keystroke. A failed fetch keeps what was held. A held
 * resolution belongs to the story and locale it was fetched for, and is not handed
 * out for any other.
 */
export function useServerResolution(opts: {
  /** `{base}/api` on the admin's own mount. */
  apiBase: string;
  /** The site the pane previews, on a deployment with `sites`. */
  site: string | undefined;
  /** The store has no unacknowledged transactions: the server's draft is current. */
  idle: boolean;
  storyId: string;
  doc: Doc | null;
  schema: SchemaIndex;
  /** The locale code being edited, or undefined for the source. */
  locale: string | undefined;
  localeCtx: LocaleContext | undefined;
  /** Moves when the story's place in the tree does (its path). */
  place: string | undefined;
}): Resolution | null {
  const { apiBase, site, idle, storyId, doc, schema, locale, localeCtx, place } = opts;
  const [held, setHeld] = useState<{ key: string; resolution: Resolution } | null>(null);
  const signature = useMemo(
    () => resolutionSignature(doc, schema, { locale: localeCtx, place }),
    [doc, schema, localeCtx, place],
  );
  // Whether there is a document at all is the one thing `signature` cannot say for a
  // document with no ids: an empty one is a signature of separators.
  const loaded = doc !== null;
  const key = `${apiBase}|${storyId}|${locale ?? ""}|${site ?? ""}`;
  // What the held answer was fetched for: the key and the signature, so an unchanged
  // pair is not asked again however often `idle` flips.
  const answered = useRef<string | null>(null);

  useEffect(() => {
    if (!loaded || !idle) return;
    const asked = `${key}#${signature}`;
    if (answered.current === asked) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(resolutionUrl(apiBase, storyId, { locale, site }), { signal: controller.signal })
        .then(async (res) => {
          if (res.ok) {
            const resolution = (await res.json()) as Resolution;
            if (controller.signal.aborted) return;
            answered.current = asked;
            setHeld({ key, resolution });
          } else if (!controller.signal.aborted && DEFINITIVE.has(res.status)) {
            // A definitive refusal is an answer about this signature, so it is not
            // asked again until the signature moves (a pause in typing must not retry
            // it). It is not an answer about the document, so what was held stays.
            // Anything else (5xx, 429, a dropped connection, an abort mid-body) is
            // transient and is left unanswered, so the next pause asks again.
            answered.current = asked;
          }
        })
        .catch(() => {});
    }, SETTLE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [apiBase, site, idle, storyId, locale, loaded, signature, key]);

  return held && held.key === key ? held.resolution : null;
}
