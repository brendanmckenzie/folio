/**
 * The publish-time projection for full-text search: which prose lands in
 * `content_text`, per locale (`../../../docs/specs/content-model/
 * full-text-search.md` architecture decision 3), and the two pure functions
 * either side of the FTS5 column those rows feed — `ftsQuery` turning visitor
 * input into `MATCH` syntax (decision 5) and `splitSnippet` turning a marked
 * `snippet()` result back into parts a host can render safely (decision 6).
 *
 * Pure, like `index-projection.ts`, and deliberately so: every rule about what
 * gets indexed is testable without a database, and `POST {base}/api/reindex`
 * rebuilds rows by running exactly this function over `published_doc` rather
 * than by restating the rules in SQL.
 *
 * **This is the one place `indexRowsFor`'s two invariants both change.**
 * `indexRowsFor` reads the root block only, because the index is a fixed
 * projection keyed on schema and locale alone. Search reads the **whole blok
 * graph** — a nested `prose` block's body is exactly the content a visitor is
 * searching for — so the row set here depends on which blocks a document
 * happens to contain, and the walk order (root first, then depth-first by
 * slot, siblings sorted by `compareSiblings`, orphans last in map order) is
 * what keeps a snippet reading in page order and two runs byte-identical, the
 * same promise `indexRowsFor`'s doc comment makes for a different reason.
 */
import { type Blok, compareSiblings, type Doc } from './doc'
import type { Field } from './fields'
import { fieldValue, type LocaleConfig, type LocaleContext, localeChain } from './locales'
import { asRichtext, richtextToText } from './richtext'
import { type DocumentType, type SchemaIndex, slotsOf, titleOf } from './schema'

/** One `content_text` row. `locale` is `''` for the source, as `content_index`. */
export interface SearchRow {
  locale: string
  title: string
  body: string
}

/** `text` | `textarea` | `richtext`, unless `searchable: false`. Opt-out, not
 * opt-in (decision 3): `indexed` costs a row per locale and makes a filter
 * promise, so it defaults off; search costs one row per locale however many
 * fields contribute, so it defaults on. */
export function isSearchable(field: Field): boolean {
  switch (field.kind) {
    case 'text':
    case 'textarea':
    case 'richtext':
      return field.searchable !== false
    default:
      return false
  }
}

/** A single-blok field value as plain text, or `''` when the field contributes
 * nothing — an absent value, or a non-string value on a hand-written schema. */
function fieldText(field: Field, value: unknown): string {
  if (value === undefined || value === null) return ''
  if (field.kind === 'richtext') return richtextToText(asRichtext(value))
  return typeof value === 'string' ? value : ''
}

/**
 * Every blok in document order: the root, then depth-first by slot (schema
 * declaration order) with siblings sorted by `compareSiblings`, then any blok
 * the walk never reached — a dangling parent, a cycle, an import artefact —
 * appended last in map order. A snippet then reads in the same order a visitor
 * would encounter the blocks on the page, and two runs of this over the same
 * document produce the same order every time.
 */
function walkOrder(doc: Doc, schema: SchemaIndex): Blok[] {
  const out: Blok[] = []
  const visited = new Set<string>()

  const visit = (blok: Blok): void => {
    if (visited.has(blok.uid)) return
    visited.add(blok.uid)
    out.push(blok)
    for (const [slotName] of slotsOf(schema[blok.type])) {
      const kids = Object.values(doc.bloks)
        .filter((b) => b.parent === blok.uid && b.slot === slotName)
        .sort((a, b) => compareSiblings(a.order, a.uid, b.order, b.uid))
      for (const kid of kids) visit(kid)
    }
  }

  const root = doc.bloks[doc.root]
  if (root) visit(root)

  for (const blok of Object.values(doc.bloks)) {
    if (!visited.has(blok.uid)) out.push(blok)
  }

  return out
}

// Decision 6's snippet markers (U+0001 / U+0002), plus every other C0
// control character. Stripped (as a space, so two words either side of a
// stray control character do not fuse) before whitespace is collapsed, so
// the split `splitSnippet` does on those two bytes downstream is
// unambiguous: the projection never emits either as content.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point — they get stripped from stored content.
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g

/** Whitespace-collapsed, control-stripped, truncated on a word boundary at `max`. */
function clean(raw: string, max: number): string {
  const collapsed = raw.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  const cut = collapsed.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut
}

/** A record with no prose costs nothing: no row for a document holding, say, one
 * `select` and one `number`. */
export const MAX_SEARCH_BODY = 65_536
export const MAX_SEARCH_TITLE = 256
export const MAX_SEARCH_ROWS = 24

/**
 * The `content_text` rows for one published document.
 *
 * One row per locale — `''` (source) first, then each declared non-source
 * locale in declaration order, capped at `MAX_SEARCH_ROWS` — holding the title
 * `titleOf` computes for that locale (so the ranked title and the listed title
 * agree) and the body: every `isSearchable` field's value across the *whole*
 * blok graph, in document order, flattened to plain text and joined with `\n`.
 * A row is emitted only when `title || body` is non-empty.
 */
export function searchRowsFor(
  doc: Doc,
  type: DocumentType | undefined,
  schema: SchemaIndex,
  locales?: LocaleConfig,
): SearchRow[] {
  const root = doc.bloks[doc.root]
  if (!root) return []

  const order = walkOrder(doc, schema)

  const codes: string[] = ['']
  for (const locale of locales?.available ?? []) {
    if (locale.code === locales?.default) continue
    codes.push(locale.code)
  }

  const out: SearchRow[] = []
  for (const code of codes.slice(0, MAX_SEARCH_ROWS)) {
    const ctx: LocaleContext | undefined =
      code === '' ? undefined : { code, fallbacks: localeChain(locales, code) }

    const pieces: string[] = []
    for (const blok of order) {
      const def = schema[blok.type]
      if (!def) continue
      for (const [name, field] of Object.entries(def.fields)) {
        if (!isSearchable(field)) continue
        const text = fieldText(field, fieldValue(blok, name, ctx))
        if (text) pieces.push(text)
      }
    }

    const title = clean(titleOf(doc, type, schema, '', ctx), MAX_SEARCH_TITLE)
    const body = clean(pieces.join('\n'), MAX_SEARCH_BODY)
    if (title || body) out.push({ locale: code, title, body })
  }

  return out
}

// unicode61's default token characters: letters, numbers, and the private-use
// category. Everything else — punctuation, symbols, whitespace, emoji — is a
// separator, which is what makes a syntax character or a bare FTS5 keyword
// (`"`, `-`, `:`, `^`, `*`, `(`, `)`, `+`, `NOT`, `AND`, `OR`, `NEAR`) land inside
// a quoted term rather than as an operator: quoting happens after the split, so
// there is nothing left in any token for FTS5 to parse as syntax.
const TOKEN_SPLIT = /[^\p{L}\p{N}\p{Co}]+/u

const MAX_TOKEN_LENGTH = 64
const MAX_TOKENS = 12

/**
 * User input, as `content_fts match ?` syntax — or `null` when nothing is left
 * to search for (decision 5). A `MATCH` syntax error is a 500 with the
 * visitor's own text in the log, and this function is what makes that
 * impossible rather than merely unlikely: nothing it emits can be anything but
 * a run of quoted terms joined by FTS5's implicit `AND`.
 */
export function ftsQuery(input: string): string | null {
  const tokens = input
    .split(TOKEN_SPLIT)
    .filter((t) => t.length > 0 && t.length <= MAX_TOKEN_LENGTH)
    .slice(0, MAX_TOKENS)

  if (tokens.length === 0) return null

  const quoted = tokens.map((token, i) => {
    const isLast = i === tokens.length - 1
    return isLast && token.length >= 2 ? `"${token}"*` : `"${token}"`
  })

  return quoted.join(' ')
}

/** One piece of a snippet: plain text, or a matched term to highlight. */
export interface SnippetPart {
  text: string
  match: boolean
}

// Decision 6's markers, exactly as passed to `snippet(content_fts, 1,
// char(1), char(2), '…', 32)`: U+0001 opens a match, U+0002 closes it.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these ARE snippet()'s own markers, the whole reason splitSnippet can split at all.
const SNIPPET_MATCH = /\u0001([^\u0002]*)\u0002/g

/**
 * A raw `snippet()` result, split on decision 6's control-character markers
 * into parts a host renders directly — never a `<mark>…</mark>` string a host
 * would otherwise have to trust as HTML or escape (which would destroy the
 * markers along with everything else).
 *
 * `null` (the correlated snippet subquery found nothing) and `''` both answer
 * an empty array; text with no marker at all answers one unmatched part.
 */
export function splitSnippet(raw: string | null): SnippetPart[] {
  if (!raw) return []

  const out: SnippetPart[] = []
  let last = 0
  SNIPPET_MATCH.lastIndex = 0
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: the idiomatic exec loop
  while ((m = SNIPPET_MATCH.exec(raw))) {
    if (m.index > last) out.push({ text: raw.slice(last, m.index), match: false })
    out.push({ text: m[1] ?? '', match: true })
    last = SNIPPET_MATCH.lastIndex
  }
  if (last < raw.length) out.push({ text: raw.slice(last), match: false })
  return out
}
