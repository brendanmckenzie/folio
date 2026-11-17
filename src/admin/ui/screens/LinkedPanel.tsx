import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { PanelAnswer } from "../../../core/panels";
import { Badge } from "../Badge";
import { Button } from "../Button";
import type { HostPageRef } from "./host-page-model";
import css from "./LinkedPanel.module.css";
import {
  cardState,
  errorLine,
  PANEL_DEBOUNCE_MS,
  panelLink,
  panelUrl,
  toneOf,
} from "./linked-panel-model";

/**
 * The host's linked-data summary of the open document, read-only, above its fields
 * (`platform/admin-extensions.md` decision 21): a heading with the panel's label, the items as a
 * definition list with tone badges, the note muted and the link as a link. `none` draws nothing;
 * `error` is one line with the category and a Retry.
 *
 * It keeps the last answer for the life of the open editor, refetches (debounced) when a root
 * scalar of the draft changes, on Refresh and on re-open, and never polls. Every string is React
 * text: the route already screened it, and nothing here is HTML.
 */
export function LinkedPanel({
  apiBase,
  storyId,
  label,
  locale,
  refetchKey,
  pages,
  mount,
}: {
  apiBase: string;
  storyId: string;
  /** The panel's heading, from the manifest. */
  label: string;
  locale?: string | null;
  /** `panelKey` of the draft root's scalars: a change refetches, debounced. */
  refetchKey: string;
  /** The declared host pages, for a link that opens inside the chrome. */
  pages: readonly HostPageRef[];
  /** The scoped mount the admin is showing. */
  mount: string;
}) {
  const [answer, setAnswer] = useState<PanelAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const height = useRef<number | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const url = panelUrl(apiBase, storyId, locale);

  const load = useCallback(
    (signal?: AbortSignal) => {
      setBusy(true);
      fetch(url, { headers: { accept: "application/json" }, ...(signal ? { signal } : {}) })
        .then((r) =>
          r.ok ? (r.json() as Promise<PanelAnswer>) : Promise.reject(new Error(String(r.status))),
        )
        .then((body) => setAnswer(body))
        .catch((e: unknown) => {
          if (signal?.aborted) return;
          void e;
          setAnswer({ status: "error", reason: "threw" });
        })
        .finally(() => {
          if (!signal?.aborted) setBusy(false);
        });
    },
    [url],
  );

  // Opening the document (or switching locale) asks at once.
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // A root scalar changed: ask again, but not on every keystroke.
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `refetchKey` is the trigger
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => load(controller.signal), PANEL_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [refetchKey, load]);

  useEffect(() => {
    if (card.current) height.current = card.current.offsetHeight;
  });

  const state = cardState(answer);
  if (state.kind === "none") return null;

  if (state.kind === "idle") {
    return (
      <div
        role="status"
        className={`${css.card} ${css.skeleton}`}
        style={height.current ? { minHeight: height.current } : { minHeight: 56 }}
        aria-busy="true"
        aria-label={`${label}, loading`}
      />
    );
  }

  const link =
    state.kind === "ok" && state.summary.link ? panelLink(state.summary.link, pages, mount) : null;

  return (
    <section className={css.card} ref={card} aria-label={label}>
      <div className={css.head}>
        <h3 className={css.title}>{label}</h3>
        <Button size="sm" variant="subtle" disabled={busy} onClick={() => load()}>
          Refresh
        </Button>
      </div>
      {state.kind === "error" ? (
        <p className={css.error} role="status">
          {errorLine(label, state.reason)}.{" "}
          <Button size="sm" variant="subtle" disabled={busy} onClick={() => load()}>
            Retry
          </Button>
        </p>
      ) : (
        <>
          {state.summary.items.length > 0 ? (
            <dl className={css.items}>
              {state.summary.items.map((item) => (
                // A host may repeat a label, but not (label, value) with any meaning.
                <Fragment key={`${item.label}\u0000${item.value}`}>
                  <dt>{item.label}</dt>
                  <dd>
                    {item.tone && item.tone !== "neutral" ? (
                      <Badge tone={toneOf(item.tone)}>{item.value}</Badge>
                    ) : (
                      item.value
                    )}
                  </dd>
                </Fragment>
              ))}
            </dl>
          ) : null}
          {state.summary.note ? <p className={css.note}>{state.summary.note}</p> : null}
          {link && state.kind === "ok" && state.summary.link ? (
            link.kind === "external" ? (
              <a className={css.link} href={link.href} target="_blank" rel="noopener noreferrer">
                {state.summary.link.label}
              </a>
            ) : (
              <a className={css.link} href={link.href}>
                {state.summary.link.label}
              </a>
            )
          ) : null}
        </>
      )}
    </section>
  );
}
