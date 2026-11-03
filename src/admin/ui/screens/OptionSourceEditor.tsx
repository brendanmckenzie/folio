import { useEffect, useId, useState } from "react";
import type { Json } from "../../../core/doc";
import type { Field as FieldDef } from "../../../core/fields";
import type { FormField, FormFieldOption } from "../../../core/forms";
import { CONTENT_SOURCE, type OptionsFrom } from "../../../core/option-sources";
import {
  asCollectionValue,
  BUILT_IN_ORDERS,
  type CollectionValue,
  type ContentOrderSpec,
} from "../../../core/query";
import type { DocumentType, SchemaIndex } from "../../../core/schema";
import { Button } from "../Button";
import { Field, Input, Select } from "../Field";
import css from "./OptionSourceEditor.module.css";
import { DocumentPicker } from "./fields/DocumentPicker";
import fieldsCss from "./fields/fields.module.css";
import { QueryControls } from "./fields/QueryControls";
import {
  blankOptionsFrom,
  contentTypes,
  emptyRequiredWarning,
  type FormSourceInfo,
  type OptionPreview,
  PREVIEW_LABELS,
  previewStatusText,
  previewSummary,
  withOptionsFrom,
  withSetting,
} from "./form-model";
import { useOptionPreview } from "./useOptionPreview";

interface Props {
  apiBase: string;
  formId: string;
  field: FormField;
  types: readonly DocumentType[];
  schema: SchemaIndex;
  /** The host sources the registry route listed. */
  sources: readonly FormSourceInfo[];
  /** Why the registry could not be read, when it could not. */
  registryError?: string | undefined;
  /** The builder's active locale, for the labels the preview shows. */
  locale: string;
  /** Not the source locale: the source is chosen once, in the source locale. */
  translating: boolean;
  editable: boolean;
  onChange: (next: FormField) => void;
  /** Reports the list a preview answered, for the rule editors' value menus. */
  onList: (name: string, options: readonly FormFieldOption[] | null) => void;
}

/**
 * Where an option question's choices come from (`form-option-sources.md` decision 14):
 * typed by the editor, the published documents of one type, or a host's own source.
 *
 * **The preview runs on commit, not on every keystroke.** A `select`, a `boolean`, the
 * type, the parent, a filter or the sort commit when they change; a text or number
 * setting on blur or Enter. Each commit is a request the server may turn into a vendor
 * call, so a text box that asked per key would be a vendor-facing keystroke logger. The
 * edit itself still reaches the draft on every change, so Save always holds what is on
 * screen.
 */
export function OptionSourceEditor({
  apiBase,
  formId,
  field,
  types,
  schema,
  sources,
  registryError,
  locale,
  translating,
  editable,
  onChange,
  onList,
}: Props) {
  const name = field.name;
  const from = field.optionsFrom;
  const preview = useOptionPreview(apiBase, formId, locale, (options) => onList(name, options));
  const { run } = preview;

  // The saved descriptor is previewed when the question is opened, and again if the
  // locale changes (a localised source loads once per locale). Not on `from`: that
  // moves on every keystroke, and the commit handlers below are what ask for those.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  useEffect(() => {
    run(from);
  }, [run]);

  const info = from ? sources.find((s) => s.id === from.source) : undefined;
  const registered = from?.source === CONTENT_SOURCE || info !== undefined;

  const commit = (next: OptionsFrom | undefined) => run(next);
  const set = (next: OptionsFrom | undefined) => onChange(withOptionsFrom(field, next));

  const warning = emptyRequiredWarning(field, preview.preview);

  return (
    <div className={css.source}>
      {translating ? null : (
        <Field
          label="Options come from"
          {...(registryError
            ? { error: `The host's own sources could not be listed: ${registryError}` }
            : {})}
        >
          {(id) => (
            <Select
              id={id}
              value={from?.source ?? ""}
              disabled={!editable}
              onChange={(e) => {
                const chosen = e.target.value;
                const next =
                  chosen === ""
                    ? undefined
                    : blankOptionsFrom(
                        chosen,
                        sources.find((s) => s.id === chosen),
                        types,
                      );
                set(next);
                commit(next);
              }}
            >
              <option value="">Options I type</option>
              <option value={CONTENT_SOURCE}>Published content</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
              {from && !registered ? (
                <option value={from.source}>{from.source} (not registered)</option>
              ) : null}
            </Select>
          )}
        </Field>
      )}

      {from && !translating && !registered ? (
        <p className={css.error} role="alert">
          This site does not register a source called “{from.source}”. Saving is refused until
          another is chosen.
        </p>
      ) : null}

      {from && !translating && from.source === CONTENT_SOURCE ? (
        <ContentSettings
          apiBase={apiBase}
          field={field}
          from={from}
          types={types}
          schema={schema}
          editable={editable}
          onEdit={set}
          onCommit={commit}
        />
      ) : null}

      {from && !translating && info ? (
        <div className={css.settings}>
          {Object.entries(info.settings).map(([key, def]) => (
            <SettingControl
              key={key}
              name={key}
              def={def}
              value={from.settings?.[key]}
              editable={editable}
              onChange={(value) => set(withSetting(from, key, value))}
              onCommit={(value) => commit(withSetting(from, key, value))}
            />
          ))}
        </div>
      ) : null}

      {from ? (
        <PreviewPanel
          state={preview}
          warning={warning}
          host={from.source !== CONTENT_SOURCE}
          translating={translating}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------ published content --- */

function ContentSettings({
  apiBase,
  field,
  from,
  types,
  schema,
  editable,
  onEdit,
  onCommit,
}: {
  apiBase: string;
  field: FormField;
  from: OptionsFrom;
  types: readonly DocumentType[];
  schema: SchemaIndex;
  editable: boolean;
  onEdit: (next: OptionsFrom) => void;
  onCommit: (next: OptionsFrom) => void;
}) {
  const base = useId();
  const [picking, setPicking] = useState(false);
  const settings = from.settings ?? {};
  const typeName = typeof settings.type === "string" ? settings.type : "";
  const type = types.find((t) => t.name === typeName);
  const parent = typeof settings.parent === "string" ? settings.parent : null;
  const listable = contentTypes(types);

  // Only fields indexed on the chosen type's root block can be filtered or sorted on:
  // `contentOptionQuery` drops the rest at render, so offering them would be a control
  // that does nothing.
  const filterable = type
    ? Object.entries(schema[type.root]?.fields ?? {})
        .filter(([, def]) => (def as { indexed?: unknown }).indexed === true)
        .map(([key]) => key)
    : [];
  const orderable = [
    ...Object.keys(BUILT_IN_ORDERS).filter((key) => key !== "relevance"),
    ...filterable,
  ];
  const stored = asCollectionValue(settings as Json);
  const order: ContentOrderSpec = stored.order ?? { field: "title", dir: "asc" };

  const withQuery = (next: CollectionValue): OptionsFrom => {
    const out: Record<string, Json> = { ...settings };
    if (next.where && next.where.length > 0) out.where = next.where as unknown as Json;
    else delete out.where;
    if (next.order) out.order = next.order as unknown as Json;
    return { ...from, settings: out };
  };
  const withType = (next: string): OptionsFrom => ({
    ...from,
    // A new type has a different root block: its filters and parent mean nothing here.
    settings: { type: next },
  });
  const withParent = (next: string | null): OptionsFrom => {
    const out: Record<string, Json> = { ...settings };
    if (next === null) delete out.parent;
    else out.parent = next;
    return { ...from, settings: out };
  };

  return (
    <div className={css.settings}>
      <Field label="Type">
        {(id) => (
          <Select
            id={id}
            value={typeName}
            disabled={!editable}
            onChange={(e) => {
              const next = withType(e.target.value);
              onEdit(next);
              onCommit(next);
            }}
          >
            {type ? null : <option value={typeName}>{typeName || "Choose a type"}</option>}
            {listable.map((t) => (
              <option key={t.name} value={t.name}>
                {t.label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {type ? (
        <>
          <Field label="Under" help="Only documents beneath this one. Leave empty for all of them.">
            {() => (
              <div className={css.parent}>
                {parent !== null ? (
                  <span className={css.parentName}>{parent}</span>
                ) : (
                  <span>Anywhere</span>
                )}
                <Button size="sm" disabled={!editable} onClick={() => setPicking(true)}>
                  {parent !== null ? "Change…" : "Choose…"}
                </Button>
                {parent !== null ? (
                  <Button
                    size="sm"
                    variant="subtle"
                    disabled={!editable}
                    onClick={() => {
                      const next = withParent(null);
                      onEdit(next);
                      onCommit(next);
                    }}
                  >
                    Clear
                  </Button>
                ) : null}
              </div>
            )}
          </Field>

          <fieldset
            className={`${fieldsCss.group} ${fieldsCss.stack}`}
            disabled={!editable}
            aria-label="Filter and order"
          >
            <QueryControls
              schema={schema}
              value={stored}
              order={order}
              filterable={filterable}
              orderable={orderable}
              idFor={(suffix) => `${base}-${suffix}`}
              onChange={(next) => onEdit(withQuery(next))}
              onCommit={(next) => onCommit(withQuery(next))}
            />
          </fieldset>
        </>
      ) : null}

      {picking ? (
        <DocumentPicker
          apiBase={apiBase}
          label={`${field.label || field.name}: under`}
          routed
          {...(type ? { types: [type.name] } : {})}
          onPick={(id) => {
            const next = withParent(id);
            setPicking(false);
            onEdit(next);
            onCommit(next);
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------- host settings --- */

/**
 * One declared setting of a host source, drawn with the same `Input` and `Select`
 * primitives `Control` uses, for the four kinds a source may declare. Not `Control`
 * itself: that needs a document's `FieldEnv`, `Resolution` and richtext chrome, which a
 * form builder has none of, for the sake of four scalar inputs.
 */
export function SettingControl({
  name,
  def,
  value,
  editable,
  onChange,
  onCommit,
}: {
  name: string;
  def: FieldDef;
  value: Json | undefined;
  editable: boolean;
  /** Every edit, so the draft always holds what is on screen. */
  onChange: (value: Json | undefined) => void;
  /** An edit that is finished: preview it. */
  onCommit: (value: Json | undefined) => void;
}) {
  const label = def.label ?? name;
  const common = { label, ...(def.help ? { help: def.help } : {}) };
  const required = def.required === true;

  if (def.kind === "boolean") {
    return (
      <Field {...common} inline>
        {(id) => (
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            disabled={!editable}
            onChange={(e) => {
              onChange(e.target.checked);
              onCommit(e.target.checked);
            }}
          />
        )}
      </Field>
    );
  }

  if (def.kind === "select") {
    return (
      <Field {...common} required={required}>
        {(id) => (
          <Select
            id={id}
            value={typeof value === "string" ? value : ""}
            disabled={!editable}
            onChange={(e) => {
              const next = e.target.value === "" ? undefined : e.target.value;
              onChange(next);
              onCommit(next);
            }}
          >
            {required && value !== undefined ? null : <option value="">—</option>}
            {def.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
    );
  }

  const numeric = def.kind === "number";
  const parse = (text: string): Json | undefined => {
    if (text === "") return undefined;
    if (!numeric) return text;
    const n = Number(text);
    return Number.isFinite(n) ? n : undefined;
  };
  const fallback = (def as { default?: unknown }).default;
  const placeholder = fallback !== undefined && fallback !== null ? String(fallback) : undefined;
  return (
    <Field {...common} required={required}>
      {(id) => (
        <Input
          id={id}
          type={numeric ? "number" : "text"}
          value={value === undefined ? "" : String(value)}
          disabled={!editable}
          spellCheck={false}
          {...(placeholder ? { placeholder } : {})}
          onChange={(e) => onChange(parse(e.target.value))}
          onBlur={(e) => onCommit(parse(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommit(parse(e.currentTarget.value));
          }}
        />
      )}
    </Field>
  );
}

/* --------------------------------------------------------------- preview --- */

function PreviewPanel({
  state,
  warning,
  host,
  translating,
}: {
  state: { preview: OptionPreview | null; loading: boolean; error: string | null };
  warning: string | null;
  host: boolean;
  translating: boolean;
}) {
  const { preview, loading, error } = state;
  const status = preview && host ? previewStatusText(preview) : null;
  return (
    <>
      {warning ? (
        <p className={css.warning} role="status">
          {warning}
        </p>
      ) : null}
      {error ? (
        <p className={css.error} role="alert">
          {error}
        </p>
      ) : null}
      <section className={css.preview} aria-label="List preview" aria-busy={loading}>
        {preview ? (
          <>
            <div className={css.previewHead}>
              <span>{previewSummary(preview)}</span>
              {status ? <span>{status}</span> : null}
            </div>
            {preview.options.length > 0 ? (
              <ul className={css.previewList}>
                {preview.options.slice(0, PREVIEW_LABELS).map((o) => (
                  <li key={o.value}>{o.label || o.value}</li>
                ))}
              </ul>
            ) : null}
            {preview.options.length > PREVIEW_LABELS ? (
              <p className={css.previewMeta}>and {preview.options.length - PREVIEW_LABELS} more</p>
            ) : null}
            {preview.truncated ? (
              <p className={css.previewMeta}>First 500 shown. A visitor sees no more than that.</p>
            ) : null}
            {translating ? (
              <p className={css.previewMeta}>Labels as a visitor reading this locale sees them.</p>
            ) : null}
          </>
        ) : loading ? (
          <p className={css.previewMeta}>Loading the list…</p>
        ) : error ? null : (
          <p className={css.previewMeta}>Choose a type to see the list.</p>
        )}
      </section>
    </>
  );
}
