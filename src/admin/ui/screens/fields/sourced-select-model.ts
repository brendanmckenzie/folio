/**
 * What the inspector's sourced select decides, as pure functions
 * (`platform/admin-extensions.md` decision 19). `SourcedSelect.tsx` is the request and the
 * markup; every branch it takes is one of these.
 */

/** `GET {base}/api/field-options`'s answer. */
export interface FieldOptionsAnswer {
  source: string;
  /** The source's own label (`FolioOptionSource.label`), for the sentences below. */
  label?: string;
  status: "fresh" | "stale" | "never-loaded";
  loadedAt: number | null;
  failure?: "timeout" | "threw" | "malformed" | "empty";
  /** Sourced entries, then the field's typed extras (`fieldOptions`). */
  options: { value: string; label: string }[];
  /** Values the open document stores that `options` no longer offers. */
  missing?: { value: string; label: string | null }[];
}

/** Past this many options a native `<select>` is too long to scan: a filterable list. */
export const COMBOBOX_AT = 20;

export const needsFilter = (options: readonly unknown[]): boolean => options.length > COMBOBOX_AT;

/** The options whose label or value contains `query`, case-insensitively. */
export function filterOptions<T extends { value: string; label: string }>(
  options: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...options];
  return options.filter(
    (o) => o.label.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle),
  );
}

/** What the control draws for the stored `value`. */
export interface SourcedView {
  /** The choices, with a retired stored value kept as the first entry so it stays shown. */
  options: { value: string; label: string; retired?: true }[];
  /** The stored value is not offered any more: say so beneath the control. */
  retired: boolean;
  /** The list never loaded: a disabled control and a reason, not an empty one. */
  unavailable: boolean;
}

/**
 * The control's choices for `value`. A stored value the list no longer has is **kept and
 * drawn** (as its `lookup` label, else the raw value) until the editor picks another: a
 * retired product must not be silently cleared by merely opening the page. `''` is "none".
 */
export function sourcedView(answer: FieldOptionsAnswer, value: string): SourcedView {
  const unavailable = answer.status === "never-loaded";
  const offered = answer.options.some((o) => o.value === value);
  if (value === "" || offered) return { options: answer.options, retired: false, unavailable };
  const label = answer.missing?.find((m) => m.value === value)?.label ?? value;
  return {
    options: [{ value, label, retired: true }, ...answer.options],
    retired: true,
    unavailable,
  };
}

const FAILURE: Record<NonNullable<FieldOptionsAnswer["failure"]>, string> = {
  timeout: "timed out",
  threw: "failed",
  malformed: "answered something unusable",
  empty: "answered with nothing",
};

/** "Products could not be loaded (timed out)". The category, never the host's message. */
export function unavailableLine(answer: Pick<FieldOptionsAnswer, "label" | "source" | "failure">) {
  const name = answer.label ?? answer.source;
  return answer.failure
    ? `${name} could not be loaded (${FAILURE[answer.failure]})`
    : `${name} has not loaded yet`;
}

/** "No longer offered by Products", beneath a retired value. */
export const retiredLine = (answer: Pick<FieldOptionsAnswer, "label" | "source">): string =>
  `No longer offered by ${answer.label ?? answer.source}`;

/** The request: `block`, `field` and the editor's locale, and `story` when a document is open. */
export function fieldOptionsUrl(
  apiBase: string,
  q: { block: string; field: string; locale?: string | null; story?: string },
): string {
  const params = new URLSearchParams({ block: q.block, field: q.field });
  if (q.locale) params.set("locale", q.locale);
  if (q.story) params.set("story", q.story);
  return `${apiBase}/field-options?${params}`;
}

/**
 * A `collection` filter on a sourced select (`QueryControls`): "Any", the sourced options,
 * then the typed extras. Without the list (not yet answered, or failed) the extras alone.
 */
export function filterChoices(
  answer: FieldOptionsAnswer | null,
  extras: readonly { value: string; label: string }[],
): { value: string; label: string }[] {
  return answer ? answer.options : [...extras];
}

/** The Model screen's description of a sourced select: from the source, with no request. */
export const sourceDetail = (field: { optionsFrom?: { source: string } }): string =>
  field.optionsFrom ? `from ${field.optionsFrom.source}` : "";
