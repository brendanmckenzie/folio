/**
 * Locales: where a translation lives, which one wins, and how much of one is
 * done (`../../docs/specs/content-model/localisation.md`).
 *
 * One document holds every language. A translatable field's source value stays
 * in `Blok.data`; a translation is an entry in `Blok.i18n[code]`. That is the
 * whole storage model, and it is what makes a translation an ordinary `set`
 * mutation with a locale on it — inheriting multiplayer, undo, versioning, the
 * activity trail, atomic publish and per-keystroke preview with no new
 * mechanism (architecture decision 1).
 *
 * The spec named this file `core/values.ts`. That name was already taken by the
 * stored *shapes* of the richer field kinds (`AssetValue`, `LinkValue`), so the
 * locale reader lives here instead.
 *
 * Deliberately a leaf: it imports `doc` and `richtext` at runtime and everything
 * else as types only, so `core/schema.ts` can import `fieldValue` from here without
 * a cycle.
 */
import type { Blok, Doc, Json } from './doc'
import type { Field } from './fields'
import { asRichtext, isRichtextEmpty } from './richtext'
import type { BlockSchema, SchemaIndex } from './schema'

/** One language a site is available in. */
export interface LocaleDef {
  code: string
  label: string
  /**
   * Which locale an untranslated field tries *before* the source. Absent means
   * straight to the source. A chain is followed to its end (see `localeChain`);
   * a cycle is refused at construction.
   */
  fallback?: string
}

/**
 * `FolioConfig.locales`. Absent means a single-locale site, which is every site
 * that existed before this feature and every one that never asks for it: no
 * locale reaches a `Resolution`, `fieldValue` reads `data`, and not a byte of any
 * document changes.
 */
export interface LocaleConfig {
  /**
   * The source locale — the one `Blok.data` holds. Changing it is a content
   * migration (swap `data` with `i18n[new]`), not a config edit: nothing here
   * rewrites documents.
   */
  default: string
  available: readonly LocaleDef[]
}

/**
 * The active locale and the chain to try, derived once from config and carried
 * on the `Resolution` so the renderer reads one value rather than re-deriving a
 * fallback order per field.
 *
 * There is no context for the source locale: `localeContext` returns undefined
 * for it, so rendering the default is byte-identical to rendering a site with no
 * locales at all.
 */
export interface LocaleContext {
  code: string
  fallbacks: readonly string[]
}

/**
 * One field's value in `locale`, or the source value when it has no translation.
 *
 * The single read every caller goes through — `RenderBlok`, `summarise`,
 * `titleOf`, the inspector — so decision 5's rule lives in exactly one place:
 * the first **defined and non-null** candidate wins, which makes `''` a
 * deliberate emptiness that survives and `null` an untranslation that falls
 * back.
 *
 * `undefined` (the field has no key anywhere) is passed through rather than
 * normalised: `resolveValue` already turns an absent value into its kind's empty
 * value, and flattening it here would lose the distinction `translationStatus`
 * needs.
 */
export function fieldValue(blok: Blok, field: string, locale?: LocaleContext): Json | undefined {
  if (locale) {
    const translated = blok.i18n?.[locale.code]?.[field]
    if (translated !== undefined && translated !== null) return translated
    for (const code of locale.fallbacks) {
      const candidate = blok.i18n?.[code]?.[field]
      if (candidate !== undefined && candidate !== null) return candidate
    }
  }
  return blok.data[field]
}

/**
 * A whole blok's data as `locale` reads it: the source layered under each
 * fallback and then the active locale, nulls skipped for the same reason
 * `fieldValue` skips them.
 *
 * For the callers that legitimately want the map rather than one field — a
 * `reference`'s `data`, and a host reading page metadata off the root block.
 * Returns `blok.data` itself (not a copy) in the common case, so a
 * single-locale site allocates nothing.
 */
export function dataOf(blok: Blok, locale?: LocaleContext): Record<string, Json> {
  if (!locale || !blok.i18n) return blok.data
  const out: Record<string, Json> = { ...blok.data }
  // Weakest fallback first, so the nearest one and then the active locale win.
  for (let i = locale.fallbacks.length - 1; i >= 0; i--) {
    layer(out, blok.i18n[locale.fallbacks[i]!])
  }
  layer(out, blok.i18n[locale.code])
  return out
}

function layer(out: Record<string, Json>, map: Record<string, Json> | undefined): void {
  if (!map) return
  for (const [key, value] of Object.entries(map)) {
    if (value !== null && value !== undefined) out[key] = value
  }
}

/**
 * The locales to try after `code` and before the source, following each
 * locale's own `fallback`.
 *
 * Terminates on a cycle (which `validateLocales` refuses at construction, but a
 * config object can also be hand-built in a test) and stops at the default,
 * which has no fallback of its own — the source is `data`, and `fieldValue` reaches
 * it unconditionally.
 */
export function localeChain(config: LocaleConfig | undefined, code: string): string[] {
  if (!config) return []
  const out: string[] = []
  const seen = new Set<string>([code])
  let cursor = config.available.find((l) => l.code === code)?.fallback
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor)
    out.push(cursor)
    if (cursor === config.default) break
    cursor = config.available.find((l) => l.code === cursor)?.fallback
  }
  return out
}

/** True when `code` is one of the declared locales. */
export function isKnownLocale(config: LocaleConfig | undefined, code: string | undefined): boolean {
  return Boolean(config && code !== undefined && config.available.some((l) => l.code === code))
}

/**
 * The context to put on a `Resolution`, or **undefined** for the source locale,
 * an unknown code, or a site with no locales at all.
 *
 * Undefined for the default is the load-bearing part: it is what makes the
 * default-locale render path identical to the pre-localisation one, rather than
 * a fallback chain that happens to end up in the same place.
 */
export function localeContext(
  config: LocaleConfig | undefined,
  code: string | undefined,
): LocaleContext | undefined {
  if (!config || code === undefined || code === config.default) return undefined
  if (!isKnownLocale(config, code)) return undefined
  return { code, fallbacks: localeChain(config, code) }
}

/**
 * Construction-time checks for `FolioConfig.locales`, alongside
 * `validateTypes` / `validatePresets` / `validateGlobals` / `validateMigrations`:
 * a default that is not available, a duplicate code, a fallback that does not
 * exist, and a fallback cycle. A locale misconfiguration should throw once,
 * before a request is served, rather than becoming a page that quietly renders
 * the wrong language.
 */
export function validateLocales(locales: LocaleConfig | undefined): void {
  if (!locales) return
  const available = locales.available
  if (!Array.isArray(available) || available.length === 0) {
    throw new Error('folio: `locales.available` is empty; declare at least one locale')
  }

  const codes = new Set<string>()
  for (const locale of available) {
    if (!locale.code) throw new Error('folio: a locale has no `code`')
    if (codes.has(locale.code)) throw new Error(`folio: duplicate locale '${locale.code}'`)
    codes.add(locale.code)
  }
  if (!codes.has(locales.default)) {
    throw new Error(
      `folio: locales.default '${locales.default}' is not one of the available locales`,
    )
  }

  for (const locale of available) {
    if (locale.fallback === undefined) continue
    if (locale.fallback === locale.code) {
      throw new Error(`folio: locale '${locale.code}' falls back to itself`)
    }
    if (!codes.has(locale.fallback)) {
      throw new Error(
        `folio: locale '${locale.code}' falls back to '${locale.fallback}', which is not declared`,
      )
    }
  }

  // Walks the config, never a document — the same shape `validatePresets`' and
  // `validateTypes`' cycle checks have.
  for (const locale of available) {
    const path = [locale.code]
    let cursor = locale.fallback
    while (cursor !== undefined) {
      if (path.includes(cursor)) {
        throw new Error(`folio: locale fallback cycle: ${[...path, cursor].join(' -> ')}`)
      }
      path.push(cursor)
      cursor = available.find((l) => l.code === cursor)?.fallback
    }
  }
}

/* --------------------------------------------------------- completeness --- */

/**
 * True when this field may hold a per-locale value. Opt-in per field
 * (checkpoint 2): most `select`, `boolean`, `number` and `asset` fields should
 * not diverge per locale, and a default of "everything is translatable" turns
 * every schema into a translation surface nobody asked for.
 *
 * A `blocks` field can never be: children are separate bloks, not a value, and
 * per-locale structure is exactly what decision 1 trades away. Nor can a
 * `collection`: the locale belongs on the *query* it runs, taken from the
 * resolution, never on the configuration. The type says so for both, so neither
 * `blocks({ translatable: true })` nor `collection({ translatable: true })`
 * compiles.
 */
export function isTranslatable(field: Field): boolean {
  if (field.kind === 'blocks' || field.kind === 'collection') return false
  return field.translatable === true
}

/** A block's translatable fields, in declaration order. */
export function translatableFields(def: BlockSchema | undefined): [string, Field][] {
  if (!def) return []
  return Object.entries(def.fields).filter(([, field]) => isTranslatable(field))
}

/** One field of one blok with nothing in `locale`. */
export interface TranslationGap {
  uid: string
  /** Block type, so a report can say "hero → heading" without the schema. */
  type: string
  field: string
  /** The field's own label, or its name when it declares none. */
  label: string
}

/**
 * How far one locale has got, computed from the document alone so the admin's
 * badge, the publish warning and `GET {base}/story/:id/translation` cannot
 * disagree.
 *
 * `total` counts only the translatable fields whose **source has something in
 * it**: an empty English heading is not work a translator owes, and counting it
 * would make every page permanently incomplete. `translated` is how many of
 * those carry a defined, non-null value in `locale` — so `''` counts as done,
 * which is decision 5 again.
 */
export interface TranslationStatus {
  locale: string
  total: number
  translated: number
  missing: TranslationGap[]
}

export function translationStatus(
  doc: Doc,
  schema: SchemaIndex,
  locale: string,
): TranslationStatus {
  let total = 0
  let translated = 0
  const missing: TranslationGap[] = []

  for (const blok of Object.values(doc.bloks)) {
    const def = schema[blok.type]
    for (const [name, field] of translatableFields(def)) {
      if (isEmptySource(field, blok.data[name])) continue
      total++
      const value = blok.i18n?.[locale]?.[name]
      if (value !== undefined && value !== null) translated++
      else missing.push({ uid: blok.uid, type: blok.type, field: name, label: field.label ?? name })
    }
  }

  return { locale, total, translated, missing }
}

/**
 * Every non-source locale that is not finished, worst first — what the publish
 * confirmation names (checkpoint 3's mitigation). Empty when every locale is
 * complete, which is what makes "publish without asking" the ordinary case.
 */
export function translationGaps(
  doc: Doc,
  schema: SchemaIndex,
  config: LocaleConfig | undefined,
): TranslationStatus[] {
  if (!config) return []
  return config.available
    .filter((l) => l.code !== config.default)
    .map((l) => translationStatus(doc, schema, l.code))
    .filter((s) => s.missing.length > 0)
    .sort((a, b) => b.missing.length - a.missing.length || a.locale.localeCompare(b.locale))
}

/**
 * Whether a source value is worth translating at all. A whitespace-only string
 * and an empty richtext document both read as nothing to do; anything else
 * (including `false` and `0`) is real content.
 */
function isEmptySource(field: Field, value: Json | undefined): boolean {
  if (value === undefined || value === null) return true
  if (field.kind === 'richtext') return isRichtextEmpty(asRichtext(value))
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}
