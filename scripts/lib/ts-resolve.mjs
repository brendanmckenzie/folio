// Lets the e2e scripts import library source directly.
//
// Node strips types from `.ts` natively, so loading is not the problem —
// resolution is. The library uses extensionless relative specifiers
// (`import { isSafeHref } from './values'`) because only a bundler ever resolved
// them. Node refuses, with ERR_MODULE_NOT_FOUND.
//
// Importing this module first installs a resolve hook that appends `.ts` when an
// extensionless relative specifier names a file that exists. Before it, a script
// could only import modules whose every import was type-only — a constraint the
// scripts documented in their headers and which broke silently the moment
// `richtext.ts` grew a real import of `./values`.

import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL)
      // No `format`: Node infers it from the `.ts` extension and strips types
      // itself. Forcing 'module' makes it parse TypeScript as plain JS, which
      // dies on the first `export interface`.
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  },
})
