#!/usr/bin/env node
/**
 * Folio's CLI. Two commands, no dependencies.
 *
 *   folio init [dir]     scaffold a new host project
 *   folio agents [file]  write (or refresh) the agent instruction block
 *
 * Reachable without an npm registry, because Folio has no npm package:
 *
 *   npx github:brendanmckenzie/folio init my-site
 *
 * `init` copies `examples/starter` — a real workspace package that
 * `pnpm typecheck` gates on every commit, which is the only reason to believe
 * the thing it writes compiles — and rewrites four things: the project name,
 * the `folio` dependency (a workspace link becomes a pinned SHA), the seeded
 * admin's address, and the migrations path.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'https://github.com/brendanmckenzie/folio'
const SPEC = 'github:brendanmckenzie/folio'
const DEFAULT_EMAIL = 'you@example.com'

/** Copied verbatim into the new project; the starter has no .gitignore of its
 *  own because this repository's root one already covers it. */
const GITIGNORE = `node_modules
dist
.wrangler
.dev.vars
worker-configuration.d.ts
.DS_Store
`

const HELP = `
folio — a Cloudflare-native block CMS

  folio init [dir]        Scaffold a new project into dir (default: the current
                          directory, which must be empty)
  folio agents [file]     Write the Folio instruction block into your AGENTS.md
                          or CLAUDE.md, replacing an existing one in place

Options for init:
  --email <address>       Address seeded as the first admin (default ${DEFAULT_EMAIL})
  --sha <sha>             Pin this commit instead of the current main
  --force                 Write into a directory that is not empty

  ${REPO}
`

main().catch((err) => {
  console.error(`\nfolio: ${err.message}\n`)
  process.exit(1)
})

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]

  if (!command || command === '-h' || command === '--help' || command === 'help') {
    console.log(HELP)
    return
  }
  if (command === '-v' || command === '--version' || command === 'version') {
    console.log(await selfSha())
    return
  }
  if (command === 'init') return init(argv.slice(1))
  if (command === 'agents') return agents(argv.slice(1))

  throw new Error(`unknown command "${command}". Try \`folio --help\`.`)
}

// --- init -----------------------------------------------------------------

async function init(argv) {
  const { flags, positional } = parseArgs(argv)
  const target = path.resolve(process.cwd(), positional[0] ?? '.')
  const name = sanitiseName(path.basename(target))

  if (existsSync(target) && !flags.force) {
    const entries = readdirSync(target).filter((e) => e !== '.git' && e !== '.DS_Store')
    if (entries.length > 0) {
      throw new Error(
        `${target} is not empty (${entries.length} entries). Pass --force to write into it anyway.`,
      )
    }
  }

  const template = path.join(PKG_ROOT, 'examples', 'starter')
  if (!existsSync(template)) {
    throw new Error(
      `the starter template is missing from this copy of the package (looked in ${template}).\n` +
        `  If you installed from npm, the template is not published yet — clone ${REPO} instead.`,
    )
  }

  const email = flags.email ?? (await askEmail())
  const sha = flags.sha ?? (await resolveSha())

  console.log(`\n  Scaffolding ${name} into ${target}`)

  await mkdir(target, { recursive: true })
  await cp(template, target, {
    recursive: true,
    // The workspace symlinks a `folio` into examples/*/node_modules. Copying
    // that would be a directory path install, which resolves `vite` from
    // Folio's own tree and lands you with two incompatible `Plugin` types.
    filter: (src) => {
      const rel = path.relative(template, src)
      const top = rel.split(path.sep)[0]
      return !['node_modules', '.wrangler', 'dist', '.DS_Store'].includes(top)
    },
  })

  await rewrite(path.join(target, 'package.json'), (s) =>
    s
      .replace('"name": "folio-starter"', `"name": ${JSON.stringify(name)}`)
      .replace('"folio": "workspace:*"', `"folio": "${SPEC}#${sha}"`),
  )
  await rewrite(path.join(target, 'wrangler.jsonc'), (s) =>
    s.replace('"name": "folio-starter"', `"name": ${JSON.stringify(name)}`),
  )
  await rewrite(path.join(target, 'seed.sql'), (s) => s.split(DEFAULT_EMAIL).join(email))
  await rewrite(path.join(target, 'README.md'), (s) => s.replace(/^# folio-starter$/m, `# ${name}`))

  await writeFile(path.join(target, '.gitignore'), GITIGNORE)
  await writeFile(path.join(target, 'AGENTS.md'), await agentsFile(name))

  const rel = path.relative(process.cwd(), target)
  const where = !rel ? '.' : rel.startsWith('..') ? target : rel
  console.log(`
  Pinned folio at ${sha === 'main' ? 'main (unpinned — see below)' : sha}
  Seeded ${email} as the first admin

  Next:

    ${where === '.' ? '' : `cd ${where}\n    `}npm install
    npm run db:local && npm run db:seed
    npm run dev

  Then open http://localhost:5173/folio/login and sign in as ${email}.
  There is no mail binding, so the link is logged to your terminal.
${
  sha === 'main'
    ? `
  WARNING: could not resolve a commit SHA, so package.json pins the branch
  "main". A branch resolves differently later — replace it with a full
  40-character SHA before you commit:

      git ls-remote ${REPO} main
`
    : ''
}`)
}

/** Prompt only where there is a terminal to prompt at; npx usually has one. */
async function askEmail() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return DEFAULT_EMAIL
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`\n  Email for the first admin [${DEFAULT_EMAIL}]: `)).trim()
    return answer || DEFAULT_EMAIL
  } finally {
    rl.close()
  }
}

/**
 * The commit to pin, most trustworthy source first.
 *
 * A pinned SHA is Folio's version number, so getting this wrong is not
 * cosmetic: a branch resolves differently later, and a consumer who pinned one
 * gets a different library on their next clean install with nothing to say so.
 *
 * The remote is asked *before* a local checkout's HEAD, deliberately. An npx
 * install keeps no record of what it resolved, so the remote is the only answer
 * available there — and where both exist, a local HEAD may be a commit nobody
 * has pushed, which `npm install` could not fetch. Local HEAD is the offline
 * fallback and says so.
 */
async function resolveSha() {
  if (process.env.FOLIO_SHA) return process.env.FOLIO_SHA

  const remote = git(['ls-remote', REPO, 'main'])
  const head = remote?.split(/\s+/)[0]
  if (head && /^[0-9a-f]{40}$/.test(head)) return head

  const local = git(['rev-parse', 'HEAD'], PKG_ROOT)
  if (local && /^[0-9a-f]{40}$/.test(local)) {
    console.warn(
      `\n  folio: could not reach ${REPO}; pinning this checkout's HEAD instead.\n` +
        '  Check that it has been pushed, or pass --sha.',
    )
    return local
  }

  return 'main'
}

async function selfSha() {
  const sha = await resolveSha()
  return sha === 'main' ? 'folio (unknown commit)' : `folio ${sha}`
}

// --- agents ---------------------------------------------------------------

const BEGIN = '<!-- folio:begin -->'
const END = '<!-- folio:end -->'

async function agents(argv) {
  const { positional } = parseArgs(argv)
  const explicit = positional[0]
  const target = explicit
    ? path.resolve(process.cwd(), explicit)
    : (firstExisting(['AGENTS.md', 'CLAUDE.md']) ?? path.resolve(process.cwd(), 'AGENTS.md'))

  const block = await pasteBlock()
  const existing = existsSync(target) ? await readFile(target, 'utf8') : null

  if (existing === null) {
    await writeFile(target, `${block}\n`)
    console.log(`folio: wrote ${path.relative(process.cwd(), target)}`)
    return
  }

  const start = existing.indexOf(BEGIN)
  const end = existing.indexOf(END)
  if (start !== -1 && end !== -1 && end > start) {
    const next = existing.slice(0, start) + block + existing.slice(end + END.length)
    await writeFile(target, next)
    console.log(`folio: refreshed the block in ${path.relative(process.cwd(), target)}`)
    return
  }

  const sep = existing.endsWith('\n') ? '\n' : '\n\n'
  await writeFile(target, `${existing}${sep}${block}\n`)
  console.log(`folio: appended the block to ${path.relative(process.cwd(), target)}`)
}

/**
 * The block, read out of AGENTS.md rather than duplicated here.
 *
 * AGENTS.md is the file a maintainer edits when the integration rules change,
 * so a second copy in this script would go stale without anything noticing —
 * which is the exact failure the markers exist to prevent.
 */
async function pasteBlock() {
  const source = await readFile(path.join(PKG_ROOT, 'AGENTS.md'), 'utf8')
  const start = source.indexOf(BEGIN)
  const end = source.indexOf(END)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`AGENTS.md has no ${BEGIN} … ${END} block to copy`)
  }
  return source.slice(start, end + END.length)
}

async function agentsFile(name) {
  return `# ${name}

${await pasteBlock()}
`
}

// --- helpers --------------------------------------------------------------

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--force') flags.force = true
    else if (arg === '--email') flags.email = argv[++i]
    else if (arg === '--sha') flags.sha = argv[++i]
    else if (arg.startsWith('--')) throw new Error(`unknown option "${arg}"`)
    else positional.push(arg)
  }
  if (flags.email !== undefined && !flags.email) throw new Error('--email needs an address')
  if (flags.sha !== undefined && !flags.sha) throw new Error('--sha needs a commit')
  return { flags, positional }
}

/** npm package names: lowercase, no spaces, no leading dot or underscore. */
function sanitiseName(raw) {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/-+$/, '')
  return name || 'folio-site'
}

async function rewrite(file, fn) {
  const before = await readFile(file, 'utf8')
  const after = fn(before)
  if (after !== before) await writeFile(file, after)
}

function firstExisting(names) {
  for (const name of names) {
    const full = path.resolve(process.cwd(), name)
    if (existsSync(full) && statSync(full).isFile()) return full
  }
  return null
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd: cwd ?? process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    }).trim()
  } catch {
    return null
  }
}
