/**
 * Content checks over one document (`../../docs/specs/content-model/authoring-guidance.md`
 * decisions 9 to 11 and 17): what `GET {base}/api/v1/documents/:id/check` and the
 * `check_document` tool answer.
 *
 * **Every rule that already exists, plus the authoring ones, in one list.** Per
 * blok, in document order:
 *
 *   1. The audit's `DOCUMENT_CHECKS`, imported as the array, so a drift check
 *      added to the audit later reaches this report with no change here. Minus
 *      `date-invalid`, which step 2 subsumes (it calls the same `dateError`).
 *   2. `field-shape`: `fieldShapeError` over every stored value, source and
 *      overrides. The admin writes through the Durable Object and an importer
 *      through `folio/engine`, and neither runs it.
 *   3. `AUTHORING_CHECKS`, below.
 *   4. The link and reference checks, which need the target rows: one `targets`
 *      call for the whole document, after the walk (decision 11).
 *
 * **Not the audit, and the audit does not import this.** The audit is the drift
 * report, tallied across every published document; four hundred heroes without
 * alt text would bury the orphan key it exists to find. Content quality is not
 * schema drift.
 *
 * **Advisory.** Nothing here blocks a write or a publish (decision 18). A finding
 * is located by `{ uid, field, locale }`, the exact address `patch_fields` takes,
 * and `fix` names the tool that repairs it.
 *
 * ## Adding a check
 *
 * Add a function to `AUTHORING_CHECKS` if it reads one blok's values, returning a
 * `Draft` per problem; the walker adds `uid`, `type` and `path`, filters by the
 * request's `locale`, sorts and caps. A check that needs another document's row
 * belongs in `targetFindings`, where the one read has already been made. A name is
 * a v1 contract from `v1.4.0`: add names, never rename or remove one.
 */
import { DOCUMENT_CHECKS, type Finding } from "./audit";
import type { Blok, Doc, Json } from "../core/doc";
import { type Field, isBlankValue } from "../core/fields";
import { lengthMessage, lengthProblem } from "../core/guidance";
import { type LocaleConfig, translationStatus } from "../core/locales";
import { fieldShapeError, nestedPaths } from "../core/nested";
import { blokTargets, type BlokTarget } from "../core/refs";
import { asRichtext, richtextToText } from "../core/richtext";
import { type BlockSchema, type DocumentType, type SchemaIndex, typeByName } from "../core/schema";
import type { StoryMeta } from "../core/story";
import { asAsset } from "../core/values";
import type { WritingGuide } from "./types";
import { avoidMatchers } from "./writing";

export type ContentCheckSeverity = "error" | "warning" | "info";

/** One problem in one document, addressed the way `patch_fields` addresses a write. */
export interface ContentCheck {
  /** Stable kebab-case name. A v1 contract: added to, never renamed. */
  check: string;
  severity: ContentCheckSeverity;
  /** One sentence naming the field's label. Not a contract. */
  message: string;
  /** The blok; the root's uid for a root field. */
  uid: string;
  /** Block type. */
  type: string;
  /** Null when the finding is about the blok itself. */
  field: string | null;
  /** Present when the finding is about one locale's value. */
  locale?: string;
  /** The blok's place in the nested shape, `NestedError`'s grammar; `''` for the root. */
  path: string;
  /** Which tool repairs it. `schema` means only a code change or a content migration can. */
  fix: "patch_fields" | "write_content" | "schema";
  detail?: Record<string, Json>;
}

export interface ContentCheckReport {
  id: string;
  source: "draft" | "published";
  /** Present when `?locale=` narrowed the locale checks. */
  locale?: string;
  /** Over every finding, including any past the cap. */
  counts: Record<ContentCheckSeverity, number>;
  /** Errors, then warnings, then info; within each, document order. At most `MAX_FINDINGS`. */
  findings: ContentCheck[];
  truncated: boolean;
}

/** Ceiling on `findings`. A report the size of the document is one no agent context holds. */
export const MAX_FINDINGS = 500;

/** What one check needs beyond the document and its brand. */
export interface CheckContext {
  id: string;
  source: "draft" | "published";
  /** The deployment's locales; absent on a single-locale site. */
  locales?: LocaleConfig;
  /** `?locale=`: per-locale findings for this locale only. Source findings always. */
  locale?: string;
  /** A layer with something below it: absent means inherited, so no missing or empty. */
  bare: boolean;
  /** The rows behind these story ids, within the request's chain. Called at most once. */
  targets: (ids: string[]) => Promise<StoryMeta[]>;
}

/** The brand half: its schema, its types, its guide. A `BrandRuntime` is one. */
export interface CheckBrand {
  schema: SchemaIndex;
  types: readonly DocumentType[];
  writing: WritingGuide | null;
}

/** A finding before the walker places it. */
export type Draft = Omit<ContentCheck, "uid" | "type" | "path">;

interface AuthoringContext {
  locales?: LocaleConfig;
  bare: boolean;
  matchers: ReturnType<typeof avoidMatchers>;
  /** `translationStatus`'s gaps, by uid then locale. */
  gaps: Map<string, { field: string; locale: string }[]>;
  /** Whether `blok` has a child in `slot`, for a required `blocks` field. */
  hasChildren: (uid: string, slot: string) => boolean;
  /** The configured locale codes; empty on a single-locale site. */
  declared: ReadonlySet<string>;
}

export type AuthoringCheck = (blok: Blok, def: BlockSchema, ctx: AuthoringContext) => Draft[];

const labelOf = (def: BlockSchema | undefined, field: string): string =>
  def?.fields[field]?.label ?? field;

/**
 * Every stored value of a field: the source, then each **configured** locale's
 * override. An override under a locale the site does not declare is drift, reported
 * once per blok and code as `unknown-locale` (`fix: "schema"`); a per-value finding on
 * it would point at `patch_fields`, which refuses that locale, and an agent would loop
 * check, patch, `unsupported`, check.
 */
function storedByLocale(
  blok: Blok,
  name: string,
  declared: ReadonlySet<string>,
): { locale?: string; value: Json }[] {
  const out: { locale?: string; value: Json }[] = [];
  const source = blok.data[name];
  if (source !== undefined) out.push({ value: source });
  for (const [locale, map] of Object.entries(blok.i18n ?? {})) {
    if (!declared.has(locale)) continue;
    const value = map[name];
    if (value !== undefined) out.push({ locale, value });
  }
  return out;
}

const PROSE: ReadonlySet<Field["kind"]> = new Set(["text", "textarea", "richtext"]);

/* -------------------------------------------------------- authoring checks --- */

/** A `required` field holding nothing, by the one blank rule (decision 15). Source only. */
const requiredEmpty: AuthoringCheck = (blok, def, ctx) => {
  if (ctx.bare) return [];
  const out: Draft[] = [];
  for (const [name, field] of Object.entries(def.fields)) {
    if (!field.required) continue;
    const label = field.label ?? name;
    if (field.kind === "blocks") {
      if (!ctx.hasChildren(blok.uid, name)) {
        out.push({
          check: "required-empty",
          severity: "warning",
          message: `${label} is required and has no blocks.`,
          field: name,
          fix: "write_content",
        });
      }
    } else if (isBlankValue(field, blok.data[name])) {
      out.push({
        check: "required-empty",
        severity: "warning",
        message: `${label} is required and empty.`,
        field: name,
        fix: "patch_fields",
      });
    }
  }
  return out;
};

/** An image with no alt text (decision 16). Skips `decorative` fields and non-images. */
const altMissing: AuthoringCheck = (blok, def, ctx) => {
  const out: Draft[] = [];
  const wants = (value: unknown): boolean => {
    const a = asAsset(value);
    return a?.contentType.startsWith("image/") === true && !a.alt.trim();
  };
  for (const [name, field] of Object.entries(def.fields)) {
    if (field.kind !== "asset" && field.kind !== "multiasset") continue;
    if (field.decorative) continue;
    const label = field.label ?? name;
    for (const { locale, value } of storedByLocale(blok, name, ctx.declared)) {
      // An override in a field that is not translatable is the drift
      // `translated-not-translatable` reports; its alt text is not this check's.
      if (locale !== undefined && !field.translatable) continue;
      const at = locale !== undefined ? { locale } : {};
      if (field.kind === "asset") {
        if (wants(value)) {
          out.push({
            check: "alt-missing",
            severity: "warning",
            message: `${label} has no alt text.`,
            field: name,
            ...at,
            fix: "patch_fields",
          });
        }
        continue;
      }
      // By position in the stored array, so `index` is the entry the agent writes back.
      for (const [index, entry] of (Array.isArray(value) ? value : []).entries()) {
        if (!wants(entry)) continue;
        out.push({
          check: "alt-missing",
          severity: "warning",
          message: `${label} image ${index + 1} has no alt text.`,
          field: name,
          ...at,
          fix: "patch_fields",
          detail: { index },
        });
      }
    }
  }
  return out;
};

/** A prose value outside its field's advisory `length` (decisions 3 and 4), per stored value. */
const lengthOutside: AuthoringCheck = (blok, def, ctx) => {
  const out: Draft[] = [];
  for (const [name, field] of Object.entries(def.fields)) {
    if (!PROSE.has(field.kind)) continue;
    for (const { locale, value } of storedByLocale(blok, name, ctx.declared)) {
      const problem = lengthProblem(field, value);
      if (!problem) continue;
      out.push({
        check: problem.kind === "over" ? "length-over" : "length-under",
        severity: "warning",
        message: lengthMessage(field.label ?? name, problem),
        field: name,
        ...(locale !== undefined ? { locale } : {}),
        fix: "patch_fields",
        detail:
          problem.kind === "over"
            ? { length: problem.length, max: problem.limit, unit: problem.unit }
            : { length: problem.length, min: problem.limit, unit: problem.unit },
      });
    }
  }
  return out;
};

/** A term the brand avoids, in source-locale prose (decision 7). One finding per term per field. */
const termAvoided: AuthoringCheck = (blok, def, ctx) => {
  if (ctx.matchers.length === 0) return [];
  const out: Draft[] = [];
  for (const [name, field] of Object.entries(def.fields)) {
    if (!PROSE.has(field.kind)) continue;
    const value = blok.data[name];
    if (value === undefined || value === null) continue;
    const text =
      field.kind === "richtext"
        ? richtextToText(asRichtext(value))
        : typeof value === "string"
          ? value
          : "";
    if (!text) continue;
    for (const m of ctx.matchers) {
      if (!m.test(text)) continue;
      out.push({
        check: "term-avoided",
        severity: "warning",
        message: `${field.label ?? name} uses '${m.term}', which this brand avoids${m.use !== undefined ? `; use '${m.use}' instead.` : "."}`,
        field: name,
        fix: "patch_fields",
        detail: { term: m.term, ...(m.use !== undefined ? { use: m.use } : {}) },
      });
    }
  }
  return out;
};

/** A translatable field with source content and nothing in a locale: `translationStatus`'s gaps. */
const translationMissing: AuthoringCheck = (blok, def, ctx) =>
  (ctx.gaps.get(blok.uid) ?? []).map(({ field, locale }) => ({
    check: "translation-missing",
    severity: "info" as const,
    message: `${labelOf(def, field)} has no ${locale} translation.`,
    field,
    locale,
    fix: "patch_fields" as const,
  }));

/** See "Adding a check" in the file header. */
export const AUTHORING_CHECKS: readonly AuthoringCheck[] = [
  requiredEmpty,
  altMissing,
  lengthOutside,
  termAvoided,
  translationMissing,
];

/* ------------------------------------------------------------ audit checks --- */

/**
 * One audit `Finding` as a located check (the table in "Wire & schema changes").
 * An audit check this table does not know yet reaches the report as a `schema`
 * warning, because every audit finding is drift.
 */
function fromAudit(f: Finding, def: BlockSchema | undefined): Draft {
  const label = f.field === null ? f.type : labelOf(def, f.field);
  switch (f.check) {
    case "unknown-type":
      return {
        check: f.check,
        severity: "error",
        message: `Block type '${f.type}' is not declared, so this block renders nothing.`,
        field: null,
        fix: "write_content",
      };
    case "orphan-key":
      return {
        check: f.check,
        severity: "warning",
        message: `'${f.field}' holds a value the schema no longer declares.`,
        field: f.field,
        fix: "schema",
      };
    case "translated-not-translatable":
      return {
        check: f.check,
        severity: "warning",
        message: `${label} holds translations but is not translatable.`,
        field: f.field,
        fix: "schema",
      };
    case "unknown-locale":
      // The audit puts the locale code in `field`; here it is the locale.
      return {
        check: f.check,
        severity: "warning",
        message: `This block holds translations for '${f.field}', which is not a configured locale.`,
        field: null,
        ...(f.field !== null ? { locale: f.field } : {}),
        fix: "schema",
      };
    case "missing-field":
      return {
        check: f.check,
        severity: "info",
        message: `${label} has no stored value, so it renders empty.`,
        field: f.field,
        fix: "patch_fields",
      };
    default:
      return {
        check: f.check,
        severity: "warning",
        message:
          f.field === null ? `This block fails '${f.check}'.` : `${label} fails '${f.check}'.`,
        field: f.field,
        fix: "schema",
      };
  }
}

/* ---------------------------------------------------------- target checks --- */

interface Located extends BlokTarget {
  blok: Blok;
  def: BlockSchema;
}

/** Decision 11's table, over the rows one `targets` call answered. */
function targetFindings(
  located: readonly Located[],
  rows: readonly StoryMeta[],
  types: readonly DocumentType[],
): { blok: Blok; draft: Draft }[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: { blok: Blok; draft: Draft }[] = [];
  for (const t of located) {
    const field = t.def.fields[t.field];
    const label = field?.label ?? t.field;
    const row = byId.get(t.id);
    const allowed =
      field &&
      (field.kind === "multilink" || field.kind === "reference" || field.kind === "references")
        ? field.types
        : undefined;
    const at = {
      field: t.field,
      ...(t.locale !== null ? { locale: t.locale } : {}),
      fix: "patch_fields" as const,
    };
    const push = (draft: Draft) => out.push({ blok: t.blok, draft });
    if (t.kind === "link") {
      // Only a page has a URL; a record or a singleton always resolves `broken`.
      const kind = row ? typeByName(types, row.type)?.kind : undefined;
      const reason = !row
        ? "missing"
        : kind !== undefined && kind !== "page"
          ? "unrouted"
          : allowed && !allowed.includes(row.type)
            ? "type"
            : null;
      if (reason) {
        push({
          check: "link-broken",
          severity: "error",
          message:
            reason === "missing"
              ? `${label} links to a document that does not exist on this site.`
              : reason === "unrouted"
                ? `${label} links to a document that has no URL.`
                : `${label} links to a '${row!.type}' document, which this field does not allow.`,
          ...at,
          detail: { target: t.id, reason },
        });
      } else if (row && (row.state === "draft" || row.state === "unpublished")) {
        push({
          check: "link-unpublished",
          severity: "warning",
          message: `${label} links to a document that is not published.`,
          ...at,
          detail: { target: t.id, state: row.state },
        });
      }
      continue;
    }
    const reason = !row ? "missing" : allowed && !allowed.includes(row.type) ? "type" : null;
    if (reason) {
      push({
        check: "reference-broken",
        severity: "error",
        message:
          reason === "missing"
            ? `${label} references a document that does not exist on this site.`
            : `${label} references a '${row!.type}' document, which this field does not allow.`,
        ...at,
        detail: { target: t.id, reason },
      });
    } else if (row && (row.state === "draft" || row.state === "unpublished")) {
      push({
        check: "reference-unpublished",
        severity: "warning",
        message: `${label} references a document that is not published, so it renders empty.`,
        ...at,
        detail: { target: t.id, state: row.state },
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ walker --- */

const SEVERITY_RANK: Record<ContentCheckSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Every finding in one document (decision 9's four steps), sorted and capped
 * (decision 17). Reads nothing but `ctx.targets`, once, and only when the document
 * has a link or a reference; it opens no Durable Object for a target, because a
 * row's `state` answers everything decision 11's table needs.
 */
export async function checkDocument(
  doc: Doc,
  brand: CheckBrand,
  ctx: CheckContext,
): Promise<ContentCheckReport> {
  const { schema } = brand;
  const paths = nestedPaths(doc, schema);
  const order = new Map([...paths.keys()].map((uid, i) => [uid, i]));

  const slots = new Set<string>();
  for (const b of Object.values(doc.bloks)) {
    if (b.parent !== null && b.slot !== null) slots.add(`${b.parent}\u0000${b.slot}`);
  }

  const gaps = new Map<string, { field: string; locale: string }[]>();
  if (ctx.locales) {
    for (const l of ctx.locales.available) {
      if (l.code === ctx.locales.default) continue;
      if (ctx.locale !== undefined && ctx.locale !== l.code) continue;
      for (const gap of translationStatus(doc, schema, l.code).missing) {
        const list = gaps.get(gap.uid) ?? [];
        list.push({ field: gap.field, locale: l.code });
        gaps.set(gap.uid, list);
      }
    }
  }
  const declared = new Set((ctx.locales?.available ?? []).map((l) => l.code));
  const authoring: AuthoringContext = {
    locales: ctx.locales,
    bare: ctx.bare,
    matchers: avoidMatchers(brand.writing),
    gaps,
    hasChildren: (uid, slot) => slots.has(`${uid}\u0000${slot}`),
    declared,
  };

  const placed: { blok: Blok; draft: Draft }[] = [];
  const located: Located[] = [];
  for (const uid of paths.keys()) {
    const blok = doc.bloks[uid]!;
    const def = schema[blok.type];
    const add = (draft: Draft) => placed.push({ blok, draft });

    // 1. The audit's per-blok drift checks.
    for (const check of DOCUMENT_CHECKS) {
      for (const finding of check(blok, def, { locales: ctx.locales })) {
        if (finding.check === "date-invalid") continue;
        // A bare layer leaves fields out on purpose: absent means inherited.
        if (ctx.bare && finding.check === "missing-field") continue;
        add(fromAudit(finding, def));
      }
    }
    // The audit's `unknown-locale` is silent with no `LocaleConfig`, so on a
    // single-locale site every override is reported here instead, once per code:
    // the same drift finding, and the only one, since the steps below skip them.
    if (!ctx.locales) {
      for (const [code, map] of Object.entries(blok.i18n ?? {})) {
        if (Object.values(map).some((v) => v !== null)) {
          add(fromAudit({ check: "unknown-locale", type: blok.type, field: code }, def));
        }
      }
    }
    if (!def) continue;

    // 2. Every stored value against its field's shape.
    for (const [name, field] of Object.entries(def.fields)) {
      if (field.kind === "blocks") continue;
      for (const { locale, value } of storedByLocale(blok, name, declared)) {
        const reason = fieldShapeError(field, value);
        if (!reason) continue;
        add({
          check: "field-shape",
          severity: "error",
          message: `${field.label ?? name} ${reason}.`,
          field: name,
          ...(locale !== undefined ? { locale } : {}),
          fix: "patch_fields",
          detail: { reason },
        });
      }
    }

    // 3. The authoring checks.
    for (const check of AUTHORING_CHECKS)
      for (const draft of check(blok, def, authoring)) add(draft);

    // 4, collected: every story edge, located.
    for (const t of blokTargets(blok, def)) located.push({ ...t, blok, def });
  }

  // 4. One read for every target, and none for a document with no edges.
  if (located.length > 0) {
    const rows = await ctx.targets([...new Set(located.map((t) => t.id))]);
    placed.push(...targetFindings(located, rows, brand.types));
  }

  const localeRank = new Map((ctx.locales?.available ?? []).map((l, i) => [l.code, i]));
  const rank = ({ blok, draft }: { blok: Blok; draft: Draft }) => {
    const fields = Object.keys(schema[blok.type]?.fields ?? {});
    const at = draft.field === null ? -1 : fields.indexOf(draft.field);
    return [
      SEVERITY_RANK[draft.severity],
      order.get(blok.uid) ?? Number.MAX_SAFE_INTEGER,
      at === -1 && draft.field !== null ? fields.length : at,
      draft.locale === undefined ? -1 : (localeRank.get(draft.locale) ?? localeRank.size),
    ];
  };

  const all = placed
    .filter(
      ({ draft }) =>
        ctx.locale === undefined || draft.locale === undefined || draft.locale === ctx.locale,
    )
    .map((p) => ({ p, key: rank(p) }))
    // Stable, so findings tied on every key keep the order the checks ran in.
    .sort((a, b) => {
      for (let i = 0; i < a.key.length; i++) {
        const d = a.key[i]! - b.key[i]!;
        if (d !== 0) return d;
      }
      return 0;
    })
    .map(({ p: { blok, draft } }): ContentCheck => {
      const { check, severity, message, field, locale, fix, detail } = draft;
      return {
        check,
        severity,
        message,
        uid: blok.uid,
        type: blok.type,
        field,
        ...(locale !== undefined ? { locale } : {}),
        path: paths.get(blok.uid) ?? "",
        fix,
        ...(detail !== undefined ? { detail } : {}),
      };
    });

  const counts: Record<ContentCheckSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of all) counts[f.severity]++;
  return {
    id: ctx.id,
    source: ctx.source,
    ...(ctx.locale !== undefined ? { locale: ctx.locale } : {}),
    counts,
    findings: all.slice(0, MAX_FINDINGS),
    truncated: all.length > MAX_FINDINGS,
  };
}
