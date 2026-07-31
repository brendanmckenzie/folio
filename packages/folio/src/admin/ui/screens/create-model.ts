/**
 * What the create dialog asks for, and what it posts.
 *
 * `CreateDialog.tsx`'s arithmetic, split out for the admin's testing convention:
 * no admin test mounts a component (`vitest.config.ts` runs the unit project
 * under `environment: 'node'`), so the rules that decide whether a name is
 * acceptable, what slug follows from it and what lands in the request body have
 * to live somewhere a Node test can reach. `content-model.ts` states the pattern;
 * this is the shared one, because two screens open the same dialog.
 *
 * The one rule worth reading before changing anything here: **the body this
 * produces is the body both screens already posted** — `{ title, slug?, parentId,
 * type }` — with a real title instead of the literal `'Untitled'`. No route
 * changed, and none needed to: `seed()` in `server/runtime.ts` writes the row's
 * title into the type's own title field (`titleFieldOf`), so a name collected
 * here arrives in `fullName` for a `person` and in `title` for a `page`.
 */
import { type DocumentType, type SchemaIndex, titleFieldOf } from '../../../core/schema'
import { joinPath, slugify } from '../../../core/story'

/**
 * What the dialog asks for, for one document type.
 *
 * Derived once from the type and the schema rather than read field by field in
 * the markup, because the interesting case is the *absent* one: a root block with
 * no `title` field, no declared `titleField` and no `summary` has nowhere for a
 * name to go, and every branch below has to agree about that.
 */
export interface CreateForm {
  /** The type name, as the request body carries it. */
  type: string
  /**
   * The root field the typed name will land in, through `seed()`, or undefined
   * when the type's root block offers none of the three `titleFieldOf` looks for.
   */
  titleField: string | undefined
  /**
   * Whether `titleField` is an **answer** rather than an absence of information.
   *
   * `titleFieldOf` needs the root block's definition, so a caller with no
   * `SchemaIndex` gets `undefined` for a type that has a perfectly good title
   * field. The two cases have to be told apart or the dialog says "this type has
   * no title field" about a `page`, which is false and reads as a bug in the
   * schema rather than a missing prop. Only false where a screen has not been
   * handed a schema yet, which is Content today.
   */
  titleFieldKnown: boolean
  /**
   * What to call the name input — **the title field's own label**, so creating a
   * `person` asks for a "Full name" rather than for a "Title". `'Title'` is the
   * fallback, and it is only reached by a type with no title field or by a caller
   * that has no `SchemaIndex` to look one up in.
   */
  nameLabel: string
  /**
   * This type owns a URL, so the dialog also asks for the slug. `page` kinds and
   * nothing else: a record has no path for a slug to be part of, and asking for
   * one would be asking about a URL that does not exist.
   */
  routed: boolean
}

export function createForm(type: DocumentType, schema?: SchemaIndex): CreateForm {
  const def = schema?.[type.root]
  const titleField = titleFieldOf(type, def)
  const label = titleField ? def?.fields[titleField]?.label : undefined
  return {
    type: type.name,
    titleField,
    titleFieldKnown: schema !== undefined,
    nameLabel: label || 'Title',
    routed: type.kind === 'page',
  }
}

/**
 * What the person has typed.
 *
 * `slugEdited` is a third field rather than a comparison against the derived
 * value, and it has to be: somebody who deliberately types the slug their title
 * would have produced anyway still owns it from then on, and a comparison would
 * silently hand it back to the derivation on the next keystroke of the title.
 */
export interface CreateDraft {
  name: string
  /** The slug **as typed**, which is not necessarily a slug — it is slugified on
   * the way into the body, exactly as the server would have done. */
  slug: string
  slugEdited: boolean
}

export const EMPTY_DRAFT: CreateDraft = { name: '', slug: '', slugEdited: false }

/**
 * `slugify` with the empty case left empty.
 *
 * `core/story.ts`'s `slugify('')` answers `'untitled'`, which is the right answer
 * for a document being written to the database and the wrong one for a field
 * somebody has not filled in yet: it would put `untitled` in the slug box before
 * the first keystroke of the name, and there is no way to tell that from a slug a
 * person chose.
 */
function slugFrom(input: string): string {
  return input.trim() ? slugify(input) : ''
}

/** What the slug input shows: the derivation until somebody takes it over, and
 * then whatever they are typing, unslugified — a slug being typed passes through
 * states (`team-`) that slugifying every keystroke would eat. */
export function slugFieldValue(draft: CreateDraft): string {
  return draft.slugEdited ? draft.slug : slugFrom(draft.name)
}

/**
 * The slug the request will actually claim.
 *
 * **An emptied slug falls back to the name**, which mirrors `createStory`'s own
 * `slugify(input.slug || input.title)` rather than inventing a second rule: a
 * cleared box means "derive it", not "no slug", and the two have to agree or the
 * path preview lies about where the page lands.
 */
export function slugOf(draft: CreateDraft): string {
  return slugFrom(slugFieldValue(draft)) || slugFrom(draft.name)
}

/**
 * The path the page will serve at, for the dialog to show.
 *
 * `joinPath` rather than string concatenation, for the one case concatenation
 * gets wrong: a page created at the top level has no parent path, and `'' + '/' +
 * slug` is how a leading double slash appears. The leading `/` is added here
 * because a stored path never carries one.
 */
export function pathOf(draft: CreateDraft, parentPath?: string): string {
  return `/${joinPath(parentPath ?? '', slugOf(draft))}`
}

/**
 * Why the dialog cannot submit yet, or undefined when it can — `Button`'s
 * `reason`, so a disabled control explains itself rather than just being grey.
 *
 * The name is the only requirement, and it is the whole point of the dialog:
 * a document must not exist before it has one. The slug needs no rule of its own
 * because `slugOf` cannot answer empty for a non-empty name.
 */
export function refusalOf(form: CreateForm, draft: CreateDraft): string | undefined {
  if (draft.name.trim()) return undefined
  return `Enter a ${form.nameLabel.toLowerCase()}`
}

/** The body of `POST {apiBase}/stories`, which is the request both screens were
 * already sending. */
export interface CreateBody {
  title: string
  slug?: string
  parentId: string | null
  type: string
}

/**
 * One request body, or null when the draft is not submittable — the same shape
 * `gestureMove` uses for a refusable gesture, so an unchecked caller cannot post
 * an `Untitled` row by skipping the guard.
 *
 * `parentId` is null for an unrouted type whatever the caller passed, because
 * `createStory` throws on a record with a parent: a record is not in the tree, so
 * there is nothing for it to be under.
 */
export function createBody(
  form: CreateForm,
  draft: CreateDraft,
  parentId: string | null = null,
): CreateBody | null {
  if (refusalOf(form, draft)) return null
  return {
    title: draft.name.trim(),
    ...(form.routed ? { slug: slugOf(draft) } : {}),
    parentId: form.routed ? parentId : null,
    type: form.type,
  }
}
