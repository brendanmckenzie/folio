import type { ReactNode } from 'react'

/**
 * JSON that is safe to embed inside a <script> tag. Only `<` needs escaping:
 * U+2028/U+2029 have been legal in JS string literals since ES2019.
 */
export function serializeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

export function Bootstrap({ global, value }: { global: string; value: unknown }) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: value goes through serializeJson (escapes `<`); `global` is only ever a library literal
  return <script dangerouslySetInnerHTML={{ __html: `window.${global}=${serializeJson(value)}` }} />
}

/**
 * Vite normally injects this when it transforms index.html. Folio generates its
 * HTML in the Worker instead, so @vitejs/plugin-react would otherwise throw
 * "can't detect preamble" on the first component module in dev.
 */
export function ReactRefreshPreamble() {
  return (
    <script
      type="module"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: static literal script, no interpolation
      dangerouslySetInnerHTML={{
        __html: [
          `import RefreshRuntime from "/@react-refresh"`,
          `RefreshRuntime.injectIntoGlobalHook(window)`,
          `window.$RefreshReg$ = () => {}`,
          `window.$RefreshSig$ = () => (type) => type`,
          `window.__vite_plugin_react_preamble_installed__ = true`,
        ].join('\n'),
      }}
    />
  )
}

/**
 * Minimal shell used for the editor route and as a default for previews. Host
 * applications that want their own <head> render `<FolioDoc>` inside their own
 * document instead.
 */
export function Shell({
  title,
  stylesheets = [],
  bodyClass,
  head,
  children,
}: {
  title: string
  stylesheets?: string[]
  bodyClass?: string
  head?: ReactNode
  children: ReactNode
}) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        {stylesheets.map((href) => (
          <link key={href} rel="stylesheet" href={href} />
        ))}
        {head}
      </head>
      <body className={bodyClass}>{children}</body>
    </html>
  )
}
