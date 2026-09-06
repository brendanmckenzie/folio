import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { folio } from 'folio/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    react(),
    /**
     * Generates the preview entry from this project's blocks and adds the
     * library's prebuilt admin to the client build.
     *
     * The admin is not rebuilt per project — it is schema-driven and ships
     * compiled, so your block code never enters that bundle.
     */
    folio({ blocks: './src/blocks/index.ts' }),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
  ],
})
