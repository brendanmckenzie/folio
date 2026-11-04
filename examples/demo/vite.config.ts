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
  plugins: [
    react(),
    // Generates the preview entry from this project's blocks and adds the
    // library's prebuilt admin to the client build.
    folio({ blocks: "./src/blocks/index.ts" }),
    cloudflare({
      viteEnvironment: { name: "ssr" },
      // A sweep runs several servers at once. They would race for the inspector's
      // port (9229 upward) and the loser dies on EADDRINUSE, so a run that has its own
      // state directory has no inspector.
      ...(stateDir ? { persistState: { path: stateDir }, inspectorPort: false as const } : {}),
    }),
  ],
});
