import { useCallback, useEffect, useRef, useState } from "react";
import { screenHostFrame } from "../../../core/host-page";
import type { MeHostPage } from "../../../server/admin-config";
import { type Me, scopeChoices } from "../../me";
import { href, scopedMount, type Screen } from "../route";
import type { Router } from "../useRouter";
import css from "./HostPage.module.css";
import {
  chooserScopes,
  announcedFor,
  classifyUnreadable,
  framedSrc,
  hostScreenOf,
  loadedAnnounce,
  mirror,
  needsScopeHeal,
  SLOW_FRAME_MS,
  shouldReplaceFrame,
} from "./host-page-model";

/**
 * What the open host page has said about itself, for the top bar: the frame's own
 * document title until it announces one, and the crumbs it announced, `href`s already
 * mapped to admin screens.
 */
export interface HostAnnounce {
  id: string;
  title?: string;
  crumbs: { text: string; screen?: Screen; query?: Record<string, string> }[];
}

interface Props {
  page: MeHostPage;
  pages: readonly MeHostPage[];
  rest: string;
  query: Readonly<Record<string, string>>;
  /** The scope in the URL, or null. */
  scope: string | null;
  /** The mount with no scope. */
  base: string;
  me: Me;
  replace: Router["replace"];
  notify: (message: string) => void;
  onAnnounce: (state: HostAnnounce) => void;
}

/**
 * A host page inside the admin's chrome: a same-origin `<iframe>` of the host's own
 * route (decision 7). Isolation of script, style and routing comes free, it works with any
 * host framework unchanged, and there is no `sandbox`: the page is the host's own code on
 * the admin's own origin, so `allow-scripts allow-same-origin` would be no boundary at all.
 *
 * A `site` page at the bare mount of a multi-site deployment has no scope to frame, so it
 * renders the chooser (decision 8) instead.
 */
export function HostPage(props: Props) {
  const { page, me, scope, base, rest, query } = props;
  if (page.scope === "site" && scope === null && me.sites) {
    const options = chooserScopes(scopeChoices(me), page);
    return (
      <div className={css.chooser}>
        <h2 className={css.heading}>Open {page.label} in which site?</h2>
        {options.length === 0 ? (
          <p className={css.body}>No site you can reach may open {page.label}.</p>
        ) : (
          <ul className={css.choices}>
            {options.map((option) => (
              <li className={css.choice} key={option.id}>
                <a
                  href={href(
                    { name: "host", id: page.id, rest },
                    scopedMount(base, option.id),
                    query,
                  )}
                >
                  {option.name}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  return <Frame key={page.id} {...props} />;
}

type FrameState = { kind: "ok" } | { kind: "refused" } | { kind: "left"; last: string | null };

function Frame({ page, pages, rest, query, scope, base, replace, notify, onAnnounce }: Props) {
  const wanted = framedSrc(page, rest, query, scope);
  const frame = useRef<HTMLIFrameElement>(null);
  const [src, setSrc] = useState(wanted);
  const [epoch, setEpoch] = useState(0);
  const [state, setState] = useState<FrameState>({ kind: "ok" });
  const [slow, setSlow] = useState(false);
  /** True from the moment the admin sets a `src` until a load of it is read. */
  const firstLoad = useRef(true);
  const last = useRef<string | null>(null);
  const warned = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(false);
  const announced = useRef<HostAnnounce>({ id: page.id, crumbs: [] });
  /** The frame document `announced` is about, so a `load` does not discard its announce. */
  const announcedDoc = useRef<unknown>(undefined);
  const adminOrigin = window.location.origin;

  const wait = useCallback(() => {
    clearTimeout(timer.current);
    setSlow(false);
    timer.current = setTimeout(() => setSlow(true), SLOW_FRAME_MS);
  }, []);
  useEffect(() => {
    wait();
    return () => clearTimeout(timer.current);
  }, [wait]);

  /** `replaceState` the admin to wherever the frame is: never a push (decision 8, rule 3). */
  const follow = useCallback(
    (location: string) => {
      const m = mirror(location, pages, {
        adminOrigin,
        base,
        adminUrl: window.location.pathname + window.location.search,
      });
      if (m.kind === "login" || m.kind === "promote") window.location.assign(m.url);
      else if (m.kind === "replace") {
        replace({ name: "host", id: m.id, rest: m.rest }, m.query);
      }
    },
    [pages, adminOrigin, base, replace],
  );

  const onLoad = () => {
    const win = frame.current?.contentWindow;
    if (!win) return;
    let location: string;
    let title: string;
    try {
      location = win.location.href;
      title = win.document.title;
    } catch {
      // Not same-origin, so not readable (decision 8, rule 6).
      clearTimeout(timer.current);
      setSlow(false);
      setState(
        classifyUnreadable(firstLoad.current) === "refused"
          ? { kind: "refused" }
          : { kind: "left", last: last.current },
      );
      firstLoad.current = false;
      return;
    }
    // `about:blank` (some browsers fire `load` for the initial empty document), `blob:`
    // and `data:` are ignored, and do not use up the first load.
    if (!/^https?:/.test(location)) return;
    firstLoad.current = false;
    warned.current = false;
    clearTimeout(timer.current);
    setSlow(false);
    const heal = needsScopeHeal(page, location, scope);
    if (heal) {
      win.location.replace(heal);
      return;
    }
    last.current = location;
    // An announce may have arrived already (the page's inline script posts during parse).
    announced.current = {
      id: page.id,
      ...loadedAnnounce(announced.current, announcedDoc.current, win.document, title),
    };
    announcedDoc.current = win.document;
    onAnnounce(announced.current);
    follow(location);
  };

  // The frame's messages (decision 9): only this origin, only from the frame this admin owns.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== adminOrigin || event.source !== frame.current?.contentWindow) return;
      const result = screenHostFrame(
        event.data,
        pages.map((p) => p.path),
      );
      if (!result.ok) {
        if (result.reason === "version" && !warned.current) {
          warned.current = true;
          console.warn(
            `folio: a host page sent a version ${String(result.v)} frame; this admin speaks version 1`,
          );
        }
        return;
      }
      const f = result.frame;
      if (f.type === "notice") {
        notify(f.message);
        return;
      }
      const doc = frame.current?.contentWindow?.document;
      const base = announcedFor(announced.current, announcedDoc.current, doc);
      announcedDoc.current = doc;
      announced.current = {
        id: page.id,
        ...(f.title !== undefined
          ? { title: f.title }
          : base.title !== undefined
            ? { title: base.title }
            : {}),
        crumbs: f.crumbs
          ? f.crumbs.map((crumb) => {
              const target = crumb.href ? hostScreenOf(crumb.href, pages) : null;
              return target
                ? {
                    text: crumb.text,
                    screen: { name: "host" as const, id: target.id, rest: target.rest },
                    query: target.query,
                  }
                : { text: crumb.text };
            })
          : base.crumbs,
      };
      onAnnounce(announced.current);
      if (f.path) follow(new URL(f.path, adminOrigin).href);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [adminOrigin, pages, page.id, notify, onAnnounce, follow]);

  // The admin's own navigation (a sidebar click, a crumb, Back): move the frame only when
  // it is not already there. A Back that traversed a frame entry, and the mirror above,
  // both leave `wanted` equal to the frame's location, so nothing reloads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `state` and `wait` are read, not triggers: only a changed destination moves the frame
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (wanted === null) return;
    if (state.kind !== "ok") {
      setState({ kind: "ok" });
      setSrc(wanted);
      setEpoch((n) => n + 1);
      firstLoad.current = true;
      wait();
      return;
    }
    const win = frame.current?.contentWindow;
    let current: string | undefined;
    try {
      current = win?.location.href;
    } catch {
      return;
    }
    if (!win || !current || !/^https?:/.test(current)) return;
    if (shouldReplaceFrame(wanted, current)) {
      firstLoad.current = true;
      wait();
      win.location.replace(wanted);
    }
  }, [wanted]);

  if (wanted === null) return null;

  if (state.kind === "refused") {
    return (
      <div className={css.wrap}>
        <div className={css.notice} role="alert">
          <h2 className={css.heading}>This page refused to be shown inside Folio</h2>
          <p className={css.body}>
            Check its <code>X-Frame-Options</code> and <code>Content-Security-Policy</code> headers.
          </p>
          <a className={css.link} href={wanted} target="_blank" rel="noopener">
            Open in a new tab
          </a>
        </div>
      </div>
    );
  }
  if (state.kind === "left") {
    return (
      <div className={css.wrap}>
        <div className={css.notice} role="alert">
          <h2 className={css.heading}>This page left the admin</h2>
          <p className={css.body}>It navigated to another site, so Folio cannot show it here.</p>
          <a className={css.link} href={state.last ?? wanted} target="_blank" rel="noopener">
            Open in a new tab
          </a>
        </div>
      </div>
    );
  }
  return (
    <div className={css.wrap}>
      <iframe
        key={epoch}
        ref={frame}
        className={css.frame}
        title={page.label}
        src={src ?? wanted}
        onLoad={onLoad}
      />
      {slow ? (
        <div className={css.overlay}>
          <div className={css.overlayCard} role="status">
            <h2 className={css.heading}>This page is taking a while</h2>
            <a className={css.link} href={wanted} target="_blank" rel="noopener">
              Open in a new tab
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}
