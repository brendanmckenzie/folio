import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { folio } from "folio/vite";
import { defineConfig } from "vite";

// The scripts in `scripts/` drive a live server. `scripts/e2e.sh` and `e2e-all.sh` give
// each run its own port and its own state directory so several can run at once; a plain
// `pnpm dev` keeps 5199 and `.wrangler/state`.
const port = Number(process.env.FOLIO_E2E_PORT ?? 5199);
const stateDir = process.env.FOLIO_E2E_STATE;

export default defineConfig({
  server: { port, strictPort: true },
  preview: { port, strictPort: true },
  environments: {
    client: {
      // Source-mode admin only (see `adminFromSource` below). The dep scanner crawls the
      // host's entries and the admin sits outside them, so without this `@tiptap/react`'s
      // CommonJS `use-sync-external-store` is served raw and the admin never mounts, and
      // tiptap's packages split across two optimised copies of `prosemirror-state`
      // ("Adding different instances of a keyed plugin"). A consumer never hits either:
      // the prebuilt bundle has them inlined. `@tiptap/pm` has no `.` export; not listed.
      optimizeDeps: {
        include: [
          "@tiptap/react",
          "@tiptap/core",
          "@tiptap/starter-kit",
          "@tiptap/extension-subscript",
          "@tiptap/extension-superscript",
        ],
      },
      resolve: {
        dedupe: [
          "@tiptap/core",
          "@tiptap/pm",
          "prosemirror-state",
          "prosemirror-view",
          "prosemirror-model",
        ],
      },
    },
  },
  plugins: [
    react(),
    // Generates the preview entry from this project's blocks. The demo compiles the
    // admin from `src/admin` (HMR); a consumer gets the prebuilt `dist/admin/`.
    folio({ blocks: "./src/blocks/index.ts", adminFromSource: true }),
    cloudflare({
      viteEnvironment: { name: "ssr" },
      // A sweep runs several servers at once. They would race for the inspector's
      // port (9229 upward) and the loser dies on EADDRINUSE, so a run that has its own
      // state directory has no inspector.
      ...(stateDir ? { persistState: { path: stateDir }, inspectorPort: false as const } : {}),
    }),
  ],
});
