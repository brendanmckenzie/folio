/**
 * `GET {base}/api/stories/:id/panel?locale=` (`platform/admin-extensions.md` decision 21): the
 * host's linked-data summary of one document, for the inspector. Internal to the admin and
 * scoped; `READ`, plus the panel's own role.
 *
 * The draft is read through `draftOf` (the sanctioned draft read), so a panel sees what the
 * editor sees now and not the two-second `draft_data` mirror. The gate is the same in both
 * currencies `Access` uses: a person needs the panel's `role` or above as their effective role on
 * the scope; a token needs `content:read:draft` (the panel is computed from the draft) and **only
 * when the panel's role is `viewer`**, because a role has no token equivalent. Nothing is cached
 * on the server: `load` receives the editor, so a shared cache would leak one editor's view to
 * another, and a table would be a migration and a write per read for a summary measured in seconds.
 */
import { Hono } from "hono";
import { dataOf } from "../../core/locales";
import { isKnownLocale } from "../../core/locales";
import { type PanelAnswer, screenPanel } from "../../core/panels";
import { atLeast, hasScope, READ, READ_DRAFT } from "../auth/roles";
import { editorOf } from "../editor";
import { FolioError } from "../errors";
import { ensureAccess, fenceStory, requireAccess } from "../middleware";
import type { FolioRuntime } from "../runtime";
import { storyById } from "../stories";
import type { FolioEnv } from "../types";
import { idParam, localeQuery } from "../validate";
import { brandOf, draftOf } from "./stories";

const TIMED_OUT = Symbol("panel timed out");

export function panelRoutes<Env>(rt: FolioRuntime): Hono<FolioEnv<Env>> {
  const app = new Hono<FolioEnv<Env>>();

  app.get(
    "/stories/:id/panel",
    requireAccess<Env>(rt, READ),
    fenceStory<Env>(rt, "read"),
    async (c) => {
      const brand = brandOf(c);
      const story = await storyById(c.var.bindings().db, idParam("id", c.req.param("id")));
      if (!story) throw new FolioError("not_found", "Unknown story");
      const panel = brand.panels.get(story.type);
      if (!panel) throw new FolioError("not_found", "That document type has no panel");

      // Both currencies (`roles.ts`'s `Access`): READ_DRAFT first, then the panel's own role.
      const actor = c.var.actor;
      ensureAccess(rt, actor, READ_DRAFT);
      if (rt.auth.mode === "session" && actor) {
        if (actor.kind === "user" && !atLeast(actor.role, panel.role)) {
          throw new FolioError(
            "forbidden",
            `Your role (${actor.role}) may not see this panel; ${panel.role} is required.`,
          );
        }
        if (
          actor.kind === "token" &&
          (panel.role !== "viewer" || !hasScope(actor.scopes, READ_DRAFT.scope))
        ) {
          throw new FolioError(
            "forbidden",
            panel.role === "viewer"
              ? "This token is missing the 'content:read:draft' scope."
              : `This panel needs the ${panel.role} role, which a token cannot hold.`,
          );
        }
      }

      const asked = c.req.query("locale");
      let locale: string | null = null;
      if (asked !== undefined) {
        const code = localeQuery(asked);
        if (!isKnownLocale(rt.locales, code)) {
          throw new FolioError("unsupported", `Unknown locale: ${code}`);
        }
        locale = code === rt.locales?.default ? null : code;
      }

      const doc = await draftOf(c, rt)(story);
      const root = doc.bloks[doc.root];
      const scope = c.var.scope;
      const registry = rt.sites && scope !== null ? await rt.sites.registry(c.env) : null;
      // From the actor `withActor` already resolved and scoped: no second credential read.
      const editor =
        rt.auth.mode === "session" && actor ? editorOf(actor, registry, scope, rt) : null;

      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let answer: PanelAnswer;
      try {
        const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve(TIMED_OUT);
          }, panel.timeoutMs);
        });
        const loading = Promise.resolve().then(() =>
          panel.load(
            {
              story,
              data: root ? dataOf(root) : {},
              locale,
              scope,
              brand: brand.brand,
              editor,
              signal: controller.signal,
            },
            c.env,
          ),
        );
        // A `load` abandoned at the timeout may still reject later: say nothing of it.
        loading.catch(() => {});
        const raced = await Promise.race([loading, timedOut]);
        if (raced === TIMED_OUT) {
          rt.logger.error(`folio: panel ${story.type} failed (timeout)`);
          answer = { status: "error", reason: "timeout" };
        } else if (raced === null) {
          answer = { status: "none" };
        } else {
          const summary = screenPanel(raced);
          if (summary === null) {
            rt.logger.error(`folio: panel ${story.type} failed (malformed)`);
            answer = { status: "error", reason: "malformed" };
          } else {
            answer = { status: "ok", summary, at: Date.now() };
          }
        }
      } catch (err) {
        // The editor sees the category and never the message (spec 37 decision 16).
        rt.logger.error(`folio: panel ${story.type} failed (threw)`, err);
        answer = { status: "error", reason: "threw" };
      } finally {
        clearTimeout(timer);
      }
      return c.json(answer);
    },
  );

  return app;
}
