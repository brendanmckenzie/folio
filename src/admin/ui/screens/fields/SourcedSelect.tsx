import { useState } from "react";
import type { Json } from "../../../../core/doc";
import { Button } from "../../Button";
import { Input, Select } from "../../Field";
import css from "./fields.module.css";
import {
  filterOptions,
  needsFilter,
  retiredLine,
  sourcedView,
  unavailableLine,
} from "./sourced-select-model";
import { useFieldOptions } from "./useFieldOptions";

/**
 * A `select` whose choices come from a host's option source
 * (`platform/admin-extensions.md` decision 19): the options from
 * `GET {base}/api/field-options`; a stored value the list no longer has drawn (its `lookup`
 * label, else the raw value) with "No longer offered by <source>" beneath it and kept until
 * the editor picks another; a list that never loaded as a disabled control with its reason
 * and a Retry; a stale list used as it is. Past 20 options a filter box narrows the list.
 *
 * The editor writes through the Durable Object as for any field, which knows no schema: the
 * picker offers only listed values, and `check_document` reports the drift.
 */
export function SourcedSelect({
  id,
  apiBase,
  block,
  name,
  locale,
  story,
  value,
  editable,
  onChange,
}: {
  id: string;
  apiBase: string;
  block: string;
  name: string;
  locale?: string | null;
  story?: string;
  value: Json;
  editable: boolean;
  onChange: (value: Json) => void;
}) {
  const stored = String(value ?? "");
  const { answer, loading, failed, reload } = useFieldOptions(apiBase, {
    block,
    field: name,
    locale,
    ...(story ? { story } : {}),
  });
  const [query, setQuery] = useState("");

  if (!answer) {
    return (
      <div className={css.stack}>
        <Select id={id} value={stored} disabled>
          <option value={stored}>{loading ? "Loading…" : stored || "Unavailable"}</option>
        </Select>
        {failed ? (
          <p className={css.note} role="status">
            The choices could not be loaded.{" "}
            <Button size="sm" variant="subtle" onClick={reload}>
              Retry
            </Button>
          </p>
        ) : null}
      </div>
    );
  }

  const view = sourcedView(answer, stored);
  const filtering = needsFilter(view.options);
  // The retired value and the current one stay listed whatever the filter says, so the
  // control never shows a value that is not among its options.
  const shown = filtering
    ? view.options.filter((o) => o.value === stored || filterOptions([o], query).length > 0)
    : view.options;

  return (
    <div className={css.stack}>
      {filtering ? (
        <Input
          type="search"
          aria-label={`Filter the ${answer.label ?? answer.source} list`}
          placeholder="Filter…"
          value={query}
          disabled={!editable || view.unavailable}
          onChange={(e) => setQuery(e.target.value)}
        />
      ) : null}
      <Select
        id={id}
        value={stored}
        disabled={!editable || view.unavailable}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">None</option>
        {shown.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
      {view.unavailable ? (
        <p className={css.note} role="status">
          {unavailableLine(answer)}.{" "}
          <Button size="sm" variant="subtle" onClick={reload}>
            Retry
          </Button>
        </p>
      ) : view.retired ? (
        <p className={css.note}>{retiredLine(answer)}</p>
      ) : null}
    </div>
  );
}
