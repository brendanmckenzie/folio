import { useCallback, useEffect, useMemo, useState } from "react";
import type { Blok, Doc } from "../../../core/doc";
import {
  type LocaleConfig,
  localeContext,
  translationGaps,
  translationStatus,
} from "../../../core/locales";
import { buildResolution, type Resolution } from "../../../core/resolve";
import type { DocumentType, SchemaIndex } from "../../../core/schema";
import type { StoryMeta } from "../../../core/story";
import { useBlocks } from "../../hooks/useBlocks";
import { useClipboardShortcuts } from "../../hooks/useClipboardShortcuts";
import { useMigrations } from "../../hooks/useMigrations";
import { usePreviewBridge } from "../../hooks/usePreviewBridge";
import { usePublish } from "../../hooks/usePublish";
import { usePublishedDoc } from "../../hooks/usePublishedDoc";
import { resolutionApiBase, useServerResolution } from "../../hooks/useServerResolution";
import { useUndoShortcut } from "../../hooks/useUndoShortcut";
import { useVersions, useVersionsList } from "../../hooks/useVersions";
import { canEditIn, type Me } from "../../me";
import { StoryStore, useStoreState } from "../../store";
import { bareMount } from "../route";
import { type PaneChoice, paneSource, previewFrame } from "./editor-model";

/**
 * Everything the editor screen is, assembled from hooks that already existed.
 *
 * **This hook builds nothing new.** `docs/editor-port-plan.md`'s first rule is
 * that the sync engine, presence, undo, versions, publish, the preview bridge and
 * the migration status are done and reusable, and the port is a *view* change; so
 * this is `admin/Editor.tsx`'s composition read as the dependency graph it always
 * was, minus the seven rail tabs and the layout. One thing genuinely is new and it
 * is named where it lives: `useServerResolution`, which asks the server for the
 * resolution its own preview page would be given, in place of the four hooks that
 * used to assemble a lesser copy by hand.
 *
 * It exists as a hook rather than as the top of `EditorShell.tsx` for one reason:
 * `EditorShell` has three panes and two of them are other agents' (the inspector,
 * the history slide-over), so the state they share has to be nameable and
 * hand-off-able. `EditorApi` is that name.
 */
export interface EditorOptions {
  /** From the URL, so the store exists before the story row has loaded. */
  storyId: string;
  /** The story row, or undefined while it is in flight. */
  story: StoryMeta | undefined;
  apiBase: string;
  /** The mount the admin is on, `~scope` included on a multi-site deployment. */
  base: string;
  schema: SchemaIndex;
  types: readonly DocumentType[];
  globals: readonly string[];
  locales: LocaleConfig | undefined;
  me: Me;
  /**
   * The source-locale iframe src the caller computed — a page's own `previewUrl`,
   * or a global's borrowed one. Undefined for a record. See `previewFrame`, which
   * is what turns it into the URL for the locale being edited.
   */
  preview: string | undefined;
  /**
   * Where the pane loads on a deployment with `sites` (`editor-model.ts`'s
   * `paneChoice`); absent or `none` is a single-site editor, whose pane is exactly
   * `preview`. With a site, the iframe goes through `site/start` on `adminBase` and
   * the bridge is restricted to the site's preview origin.
   */
  pane?: PaneChoice;
  /** The mount with no scope: `site/start` is built from it. */
  adminBase?: string;
  /** The pane's cookie check found the browser refusing the partitioned grant. */
  onGrantBlocked?: () => void;
  notify: (message: string) => void;
  /**
   * The story row this screen was handed is out of date — a publish or an
   * unpublish moved its state, and it is the *caller's* row.
   *
   * The seam is here rather than a second fetch of the same row from in here,
   * which is how two views of one document start disagreeing. `Admin` supplies
   * it; `useStory` grew a `reload` for the purpose, and a global's row is refreshed
   * from the boot's singleton call instead, because that is where it came from.
   *
   * **It is optional in the type and must not be treated as optional in practice**,
   * and an earlier version of this comment got that wrong. It claimed the shell
   * worked without it because "only the state badge goes stale". The state is also
   * `publishStatus`'s `isLive` argument, and `everPublished && !isLive && delta 0`
   * is how a *taken-down* page looks — so an unrefreshed row left the Publish
   * button **enabled on a document that had just been published**, next to a status
   * line reading "Up to date". Pinned by `editor-shell.test.ts`'s
   * "the open row is refreshed after a write".
   */
  onStoryChanged?: () => void;
  /** True while the history slide-over is open: the activity trail loads with it,
   * exactly as the old History rail's `active` flag did. */
  historyOpen: boolean;
  /** A block was picked in the preview. The shell reveals the rail if it is
   * collapsed; there are no tabs to bring forward any more. */
  onPick: () => void;
}

export interface EditorApi {
  store: StoryStore;
  state: ReturnType<typeof useStoreState>;
  /** The live draft. Null until the store has bootstrapped. */
  liveDoc: Doc | null;
  /**
   * What is **on screen** — the version being viewed, or the live draft. The rail
   * and the inspector both draw this; only a write ever touches `liveDoc`.
   */
  shownDoc: Doc | null;
  /** The selected blok, out of `shownDoc`. */
  selected: Blok | null;
  /** Looking at a past version, or holding a role that may not edit. Deliberately
   * one flag: the inspector already knew how to be read-only for the first. */
  readOnly: boolean;
  blocks: ReturnType<typeof useBlocks>;
  locale: string;
  isSourceLocale: boolean;
  localeCtx: ReturnType<typeof localeContext>;
  setLocale: (code: string) => void;
  resolution: Resolution;
  translation: ReturnType<typeof translationStatus> | null;
  /** Locales that are incomplete on the draft as it stands, for the publish
   * warning. Computed from the document the store already holds, so it is right
   * at the instant Publish is clicked rather than as of the last fetch. */
  gaps: ReturnType<typeof translationGaps>;
  versions: ReturnType<typeof useVersions>;
  /**
   * The **version** list's paged trail, which `versions` does not carry.
   *
   * `useVersionsList` and `useVersions` are two hooks over two routes, and only the
   * second's return value was exposed here — so the history slide-over could reach
   * the activity trail and not the version one. Found by wiring 7a's slot to 7c's
   * panel: two agents agreed on the shape of every field except this one, which
   * neither could see was missing from its own side.
   *
   * The list itself stays where it is (`usePublishedDoc` needs its newest `publish`
   * on every load, unconditionally), so this is the same array under a second name
   * rather than a second read.
   */
  versionTrail: ReturnType<typeof useVersionsList>["trail"];
  published: ReturnType<typeof usePublishedDoc>;
  publish: ReturnType<typeof usePublish>;
  migrations: ReturnType<typeof useMigrations>;
  /** The iframe's ref callback. Nothing else in the editor talks to the frame. */
  frame: (node: HTMLIFrameElement | null) => void;
  /** The src for the frame in the locale being edited. */
  src: string | undefined;
  /**
   * A block inside a global was clicked while previewing something else: the name
   * of the global to offer "Edit … →" for, until the next selection or story
   * switch clears it (`globals.md` checkpoint 3).
   */
  globalHint: string | null;
}

export function useEditor(opts: EditorOptions): EditorApi {
  const { storyId, story, apiBase, base, schema, locales, me, notify } = opts;

  // The active locale, defaulting to the source. Editor state rather than a URL
  // parameter: it is a property of this editing session, and the *preview* URL is
  // what carries it into the iframe (`localisation.md` decision 6).
  const [locale, setLocale] = useState(locales?.default ?? "");
  const isSourceLocale = !locales || locale === locales.default;
  const localeCtx = useMemo(() => localeContext(locales, locale), [locales, locale]);

  const store = useMemo(() => new StoryStore(storyId, apiBase), [storyId, apiBase]);
  const state = useStoreState(store);
  const blocks = useBlocks(store, schema, notify, story?.path ?? "");

  // Which language this client is editing in, announced with its presence so a
  // peer ring can say so. Null on the source locale, so a single-locale site
  // announces nothing new at all.
  useEffect(() => {
    store.setLocale(isSourceLocale ? null : locale);
  }, [isSourceLocale, locale, store]);

  // Loaded unconditionally, not only while history is open: the publish state
  // needs the newest publish version on every load.
  const versionsList = useVersionsList(apiBase, storyId);
  const versions = useVersions({
    store,
    apiBase,
    storyId,
    liveDoc: state.doc,
    notify,
    active: opts.historyOpen,
    versions: versionsList.versions,
    reloadVersions: versionsList.reload,
  });
  const published = usePublishedDoc({
    apiBase,
    versions: versionsList.versions,
    liveDoc: state.doc,
  });

  // A publish or an unpublish adds a retained version and moves the story's state.
  // Unpublish adds none, but reloading unconditionally costs nothing extra and
  // keeps both writes sharing one afterWrite path.
  const { onStoryChanged } = opts;
  const afterPublish = useCallback(async () => {
    await versions.reload();
    onStoryChanged?.();
  }, [versions.reload, onStoryChanged]);
  const publish = usePublish({ apiBase, storyId, notify, onPublished: afterPublish });

  const migrations = useMigrations(apiBase, storyId, notify);

  /* ------------------------------------------------------------ resolution --- */

  // The pane site's mount on a deployment with `sites`: a shared page is resolved as
  // the site being previewed would serve it, and `loadStory`'s fence on that mount
  // decides whether the caller may. Off it (a refusal, say) the preview simply keeps
  // the server's own bootstrap.
  const resolutionBase = resolutionApiBase(apiBase, base, opts.pane);
  const serverResolution = useServerResolution({
    apiBase: resolutionBase,
    storyId,
    doc: state.doc,
    schema,
    locale: isSourceLocale ? undefined : locale,
    localeCtx,
    place: story?.path ?? undefined,
  });
  // The server's resolution, once held, is the whole of what the preview is told.
  // **Until then the bridge is given null and posts none**, so the iframe keeps the
  // resolution it was bootstrapped with and the first frame is never emptier than the
  // server's (#77). The inspector's pickers still want *something* to read in the
  // meantime, which is the open story alone.
  //
  // The open story's own row is laid over the server's, so a rename shows at once
  // rather than after the next fetch. Only its title: its `url` on a site is the
  // server's to say.
  const resolution = useMemo<Resolution>(() => {
    const own = story ? buildResolution([story]).stories[story.id] : undefined;
    if (!serverResolution) {
      return {
        ...buildResolution(story ? [story] : [], `${bareMount(base)}/asset`),
        ...(localeCtx ? { locale: localeCtx } : {}),
      };
    }
    if (!story || !own) return serverResolution;
    const held = serverResolution.stories[story.id];
    return {
      ...serverResolution,
      stories: {
        ...serverResolution.stories,
        [story.id]: held ? { ...held, title: story.title } : own,
      },
    };
  }, [story, base, serverResolution, localeCtx]);

  /* ---------------------------------------------------------------- bridge --- */

  const [globalHint, setGlobalHint] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: storyId and state.selection are deliberate — neither is read in the body, both are what should clear a stale hint
  useEffect(() => setGlobalHint(null), [storyId, state.selection]);

  const frame = usePreviewBridge({
    store,
    resolution: serverResolution ? resolution : null,
    source: versions.source,
    selection: state.selection,
    root: state.doc?.root,
    blocks,
    onPick: opts.onPick,
    onGlobalClick: setGlobalHint,
    ...(opts.pane?.kind === "site" && opts.pane.origin ? { origin: opts.pane.origin } : {}),
    ...(opts.onGrantBlocked ? { onGrantBlocked: opts.onGrantBlocked } : {}),
  });

  const live = versions.source.mode === "live";
  useUndoShortcut(store, live);
  useClipboardShortcuts(blocks, state.selection, live);

  /**
   * The object's refusals — a rejected transaction, an unreadable or wrongly
   * versioned frame — reach the screen through the same toast as local failures.
   * Without this the only sign of a refused edit is the value snapping back.
   */
  useEffect(() => {
    if (state.notice) notify(state.notice);
  }, [notify, state.notice]);

  /**
   * Select the root as soon as the document arrives and nothing else is selected.
   *
   * The old editor did this in form mode only, because there the preview does not
   * exist to be clicked and the inspector would sit asking to be clicked in a pane
   * that is not there. Doing it always is a small deliberate change: the inspector
   * opens on the page's own fields — its title, its description — which is what an
   * editor arriving at a page most often wants, and it makes the rail's first row
   * `aria-current` so the tree says where you are before you touch it.
   *
   * It costs nothing in the preview: `usePreviewBridge` posts `select` as null for
   * the root uid deliberately (the root wraps the whole page, so outlining it would
   * frame everything), so selecting the root highlights nothing in the frame.
   *
   * Only while nothing is selected, so an editor who has clicked into a nested
   * block keeps their place.
   */
  useEffect(() => {
    if (state.doc && !state.selection) store.select(state.doc.root);
  }, [state.doc, state.selection, store]);

  /* ----------------------------------------------------------------- reads --- */

  const shownDoc = versions.viewing?.doc ?? state.doc;
  const selected = state.selection && shownDoc ? (shownDoc.bloks[state.selection] ?? null) : null;
  // The role on the scope that **owns** the story, not the one being shown: a shared
  // page opened from `~alpha` is read there and written nowhere but `~shared`.
  const readOnly = !live || !canEditIn(me, story?.site);

  const gaps = useMemo(
    () => (state.doc ? translationGaps(state.doc, schema, locales) : []),
    [locales, schema, state.doc],
  );
  const translation = useMemo(
    () => (state.doc && !isSourceLocale ? translationStatus(state.doc, schema, locale) : null),
    [isSourceLocale, locale, schema, state.doc],
  );

  return {
    store,
    state,
    liveDoc: state.doc,
    shownDoc,
    selected,
    readOnly,
    blocks,
    locale,
    isSourceLocale,
    localeCtx,
    setLocale,
    resolution,
    translation,
    gaps,
    versions,
    versionTrail: versionsList.trail,
    published,
    publish,
    migrations,
    frame,
    src: paneSource(
      opts.pane ?? { kind: "none" },
      previewFrame(story, opts.preview, locale, isSourceLocale),
      story,
      opts.adminBase ?? base,
    ),
    globalHint,
  };
}
