import type { ReactNode } from 'react'

/**
 * JSON that is safe to embed inside a <script> tag. Only `<` needs escaping:
 * U+2028/U+2029 have been legal in JS string literals since ES2019.
 *
 * Total over its input: `JSON.stringify(undefined)` returns `undefined` itself
 * (not a string), which would otherwise crash `.replace` below. `undefined`
 * normalises to `null`, the same value a `set` mutation's own absent-field
 * normalisation already uses (see docs/sync-design.md), rather than a bespoke
 * sentinel just for this call site.
 */
export function serializeJson(value: unknown): string {
  return JSON.stringify(value ?? null).replace(/</g, '\\u003c')
}

export function Bootstrap({ global, value }: { global: string; value: unknown }) {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: value goes through serializeJson (escapes `<`); `global` is only ever a library literal
  return <script dangerouslySetInnerHTML={{ __html: `window.${global}=${serializeJson(value)}` }} />
}

/**
 * The stubs and the flag a React Fast Refresh transform expects to find already
 * on `window`. Vite injects the equivalent when it transforms `index.html`;
 * Folio generates its HTML in the Worker, so it has to emit its own.
 *
 * **A classic script, not a module, and that is the whole point.** A React
 * plugin's transform opens every component module with
 *
 *     if (!window.__vite_plugin_react_preamble_installed__) throw new Error(…)
 *
 * so the flag has to be set before *any* transformed module evaluates. React
 * emits the page's entries through `bootstrapModules`, which appends them as
 * `<script type="module" async>` — and an async module executes the moment it
 * has loaded, which can be before an inline module script in `<head>` runs.
 * Being a classic inline script makes this run during parse, ahead of both.
 *
 * It shipped as a single module script and the race was invisible in this repo,
 * because the demo's only transformed modules are Folio's own and they live in
 * `node_modules`, which the React plugins skip. The first host to put *its*
 * components in a Folio preview lost it immediately: the blocks module threw on
 * import, so `mountPreview` never ran, and the preview showed unhydrated,
 * unstyled server markup with nothing in the console. It reads as "the preview
 * has no CSS", which is three inferences away from the cause.
 */
export function ReactRefreshPreamble() {
  return (
    <>
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static literal script, no interpolation
        dangerouslySetInnerHTML={{
          __html: [
            `window.$RefreshReg$ = () => {}`,
            `window.$RefreshSig$ = () => (type) => type`,
            `window.__vite_plugin_react_preamble_installed__ = true`,
          ].join('\n'),
        }}
      />
      {/*
        The runtime itself, which can only be reached by a module. Separate and
        second because it is the half that may lose the race and can afford to:
        without it Fast Refresh does not rebind on edit, which costs a reload.
        Without the flag above, nothing renders at all.
      */}
      <script
        type="module"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static literal script, no interpolation
        dangerouslySetInnerHTML={{
          __html: [
            `import RefreshRuntime from "/@react-refresh"`,
            `RefreshRuntime.injectIntoGlobalHook(window)`,
          ].join('\n'),
        }}
      />
    </>
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
  lang = 'en',
  children,
}: {
  title: string
  stylesheets?: string[]
  bodyClass?: string
  head?: ReactNode
  /** `<html lang>`. Defaults to `'en'`, which is what this was hard-coded to
   * before locales existed (`localisation.md`); a host rendering its own
   * document sets its own. */
  lang?: string
  children: ReactNode
}) {
  return (
    <html lang={lang}>
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
