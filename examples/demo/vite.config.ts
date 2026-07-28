import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { folio } from 'folio/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  // Fixed because the scripts in `scripts/` drive a live server on this port.
  server: { port: 5199, strictPort: true },
  preview: { port: 5199, strictPort: true },
  plugins: [
    react(),
    // Generates the preview entry from this project's blocks and adds the
    // library's prebuilt admin to the client build.
    folio({ blocks: './src/blocks/index.ts' }),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
  ],
})
