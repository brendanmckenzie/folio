import { useEffect, useMemo, useState } from "react";
import type { Doc } from "../../core/doc";
import type { LocaleContext } from "../../core/locales";
import { collectionQueries } from "../../core/query";
import { formIds, linkedIds, referencedIdsAllLocales } from "../../core/refs";
import type { Resolution } from "../../core/resolve";
import type { SchemaIndex } from "../../core/schema";
import { bareMount } from "../ui/route";

/** How long the id set has to hold still before it is asked about. Long enough that
 * the server's draft has taken the edit that changed it (the socket and this fetch are
 * two connections), short enough that a freshly picked link resolves at once. */
const SETTLE_MS = 300;

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
  ].join(";");
}

/**
 * The JSON base the resolution is fetched from: the pane site's own mount
 * (`{base}/~<site>/api`) when the pane previews a site, else the admin's `apiBase`.
 * The fence on that mount decides whether the caller may read the story as that site
 * would serve it, and a refusal leaves the preview on its bootstrap. Pure and exported
 * so the URL is a test and not a network tab.
 */
export function resolutionApiBase(
  apiBase: string,
  base: string,
  pane: { kind: string; site?: { id: string } } | undefined,
): string {
  return pane?.kind === "site" && pane.site
    ? `${bareMount(base)}/~${encodeURIComponent(pane.site.id)}/api`
    : apiBase;
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
 * `SETTLE_MS`; never per keystroke. A failed fetch keeps what was held. A held
 * resolution belongs to the story and locale it was fetched for, and is not handed
 * out for any other.
 */
export function useServerResolution(opts: {
  /** `{base}/api` on the mount of the site the pane previews. */
  apiBase: string;
  storyId: string;
  doc: Doc | null;
  schema: SchemaIndex;
  /** The locale code being edited, or undefined for the source. */
  locale: string | undefined;
  localeCtx: LocaleContext | undefined;
  /** Moves when the story's place in the tree does (its path). */
  place: string | undefined;
}): Resolution | null {
  const { apiBase, storyId, doc, schema, locale, localeCtx, place } = opts;
  const [held, setHeld] = useState<{ key: string; resolution: Resolution } | null>(null);
  const signature = useMemo(
    () => resolutionSignature(doc, schema, { locale: localeCtx, place }),
    [doc, schema, localeCtx, place],
  );
  // Whether there is a document at all is the one thing `signature` cannot say for a
  // document with no ids: an empty one is a signature of separators.
  const loaded = doc !== null;
  const key = `${apiBase}|${storyId}|${locale ?? ""}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` is the dependency that matters; it is what changes when the answer may have
  useEffect(() => {
    if (!loaded) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const query = locale ? `?${new URLSearchParams({ locale })}` : "";
      fetch(`${apiBase}/story/${encodeURIComponent(storyId)}/resolution${query}`, {
        signal: controller.signal,
      })
        .then((res) => (res.ok ? (res.json() as Promise<Resolution>) : null))
        .then((resolution) => {
          // A refusal or a transport failure is not an answer about the document:
          // keep what was held rather than blank the preview.
          if (resolution && !controller.signal.aborted) setHeld({ key, resolution });
        })
        .catch(() => {});
    }, SETTLE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [apiBase, storyId, locale, loaded, signature, key]);

  return held && held.key === key ? held.resolution : null;
}
