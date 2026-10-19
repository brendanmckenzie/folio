import { useEffect, useState } from "react";
import {
  FILE_ACCEPT,
  type FormField,
  type FormFieldKind,
  type FormLayout,
  type FormSection,
  MAX_FORM_FIELDS,
  MAX_FORM_SECTIONS,
  shapeOf,
} from "../../../core/forms";
import type { LocaleConfig } from "../../../core/locales";
import type { Form } from "../../../server/forms";
import { canDeleteForms, canEdit, type Me } from "../../me";
import { Badge } from "../Badge";
import { Button } from "../Button";
import { EmptyState } from "../EmptyState";
import { Field, Input, Select, Textarea } from "../Field";
import { ListHeader } from "../List";
import { Menu, type MenuItem } from "../Menu";
import { ConditionEditor } from "./ConditionEditor";
import { FormDeleteDialog } from "./FormDeleteDialog";
import css from "./FormBuilder.module.css";
import { blankCondition, formConditionText, sourcesFor } from "./condition-model";
import {
  addField,
  addOption,
  endSectionAfter,
  logicRefusal,
  optionRefusal,
  pruneSections,
  removeRefusal,
  removeSection,
  renameField,
  startSection,
  updateSection,
  MAX_FIELDS_REACHED,
  canJoinPrevious,
  canMoveField,
  closesAtFromInput,
  closesAtInputValue,
  fieldKindLabel,
  FIELD_KINDS,
  fieldNameRefusal,
  fieldRows,
  fieldText,
  moveFieldStep,
  needsOptions,
  normaliseFieldName,
  optionLabel,
  removeField,
  removeOption,
  renameWarning,
  showLocaleSwitcher,
  type TranslatableKey,
  updateField,
  updateOption,
  withBeside,
  withFieldText,
  withGrow,
  withOptionLabel,
} from "./form-model";
import { messageOf } from "./useContent";
import { useForm } from "./useForm";

interface Props {
  apiBase: string;
  id: string;
  me: Me;
  /** `FolioConfig.locales`, when the host declared one. Absent hides the
   *  locale switcher entirely — decision 12: "shown only when
   *  `config.locales` is set." */
  locales?: LocaleConfig;
  onNotice: (message: string) => void;
  /** Reports the saved label, for the shell's breadcrumb and tab title. */
  onLabel: (label: string) => void;
  onOpenResponses: (id: string) => void;
  onDeleted: () => void;
}

/**
 * The builder — `docs/specs/content-model/forms.md` phase 6, the second of
 * decision 12's three screens.
 *
 * **Local draft, not autosave.** Every other authored thing in Folio is on the
 * mutation log, where a keystroke is a change nobody has to remember to save.
 * A form is a row with an `expectedUpdatedAt` guard instead (decision 18), so
 * this screen holds its own edit in component state and one explicit Save
 * commits it — the guard is only meaningful around a single write, not around
 * every keystroke becoming one.
 *
 * **A 409 replaces the draft with the reloaded form and says so**, rather than
 * retrying or silently keeping the rejected edit: `useForm`'s `save` already
 * reloads on conflict, and the effect that seeds `draft` from `data.form`
 * picks the fresh row up the moment it lands.
 */
export function FormBuilder({
  apiBase,
  id,
  me,
  locales,
  onNotice,
  onLabel,
  onOpenResponses,
  onDeleted,
}: Props) {
  const data = useForm(apiBase, id);
  const [draft, setDraft] = useState<Form | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedSection, setSelectedSection] = useState<string | null>(null);
  const [selectedInitialName, setSelectedInitialName] = useState<string | null>(null);
  const [locale, setLocale] = useState(locales?.default ?? "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (data.form) setDraft(data.form);
  }, [data.form]);

  // `onLabel` is a fresh closure on every render of the shell around this
  // screen; naming it here would refire this effect — and re-notify the
  // breadcrumb — on every keystroke anywhere above this component. `data.form`
  // (the last *saved* row) is the only real dependency: the tab title and
  // crumb track what was saved, not what is mid-edit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  useEffect(() => {
    if (data.form) onLabel(data.form.label || "Untitled form");
  }, [data.form]);

  if (data.notFound) {
    return (
      <EmptyState
        title="No such form"
        body="This form was deleted, or the link to it is stale. It no longer exists."
      />
    );
  }

  if (!draft) {
    if (data.error) {
      return (
        <EmptyState
          title="Could not load this form"
          body={data.error}
          action={
            <Button size="sm" onClick={data.reload}>
              Try again
            </Button>
          }
        />
      );
    }
    return (
      <div className={css.screen}>
        <div className={css.loadingSkeleton} aria-hidden="true" />
      </div>
    );
  }

  const editable = canEdit(me);
  const source = locales?.default ?? "";
  const showLocales = showLocaleSwitcher(locales);
  const hasResponses = (data.usage?.responses ?? 0) > 0;
  const selectedField = draft.fields.find((f) => f.name === selected) ?? null;
  // Decision 7: `version` (and therefore `formChanged`) only bumps on a
  // *shape* change — a name, kind, required flag or option values added,
  // removed or retyped — never on a label, help, translation or layout edit.
  // `shapeOf` is the one function that says which, shared with the server so
  // this can never disagree with what actually triggers `formChanged`.
  const structural = data.form
    ? shapeOf(draft.fields, draft.layout) !== shapeOf(data.form.fields, data.form.layout)
    : false;
  // The same refusal the server would send (`checkFormLogic`), shown before Save
  // rather than after a round trip, and Save is disabled while there is one.
  const logicProblem = logicRefusal(draft.fields, draft.layout);
  const selectedSectionDef = draft.layout.sections?.find((s) => s.name === selectedSection) ?? null;
  // The list's own row grouping (`form-model.ts`'s `fieldRows`), and whether
  // `beside` on the selected question could do anything at all — the first
  // question in the form, and the one right after a statement, always start a
  // fresh row regardless of it.
  const rows = fieldRows(draft.fields);
  const rowOfField = new Map(rows.flatMap((row, r) => row.map((i) => [draft.fields[i]?.name, r])));
  // Every index but a row's first: the list draws these joined to the
  // question above rather than starting a fresh line for them.
  const joinedIndices = new Set(rows.flatMap((row) => row.slice(1)));
  const joinable = selectedField ? canJoinPrevious(draft.fields, selectedField.name) : false;

  const select = (name: string | null) => {
    setSelected(name);
    setSelectedSection(null);
    setSelectedInitialName(name);
  };

  const selectSection = (name: string) => {
    setSelected(null);
    setSelectedInitialName(null);
    setSelectedSection(name);
  };

  const onAddField = (kind: FormFieldKind) => {
    const next = addField(draft.fields, kind, draft.id);
    setDraft({ ...draft, fields: next });
    select(next[next.length - 1]?.name ?? null);
  };

  const onFieldChange = (name: string, next: FormField) => {
    // A rename goes through `renameField`, which also repoints every rule that
    // names the question; the rest of the edit is then applied on top of it.
    const renamed =
      next.name === name
        ? { fields: draft.fields, layout: draft.layout }
        : renameField(draft.fields, draft.layout, name, next.name);
    setDraft({
      ...draft,
      fields: updateField(renamed.fields, next.name, next),
      layout: renamed.layout,
    });
    if (selected === name) setSelected(next.name);
  };

  const onRemoveField = (name: string) => {
    const fields = removeField(draft.fields, name, draft.layout);
    setDraft({ ...draft, fields, layout: pruneSections(fields, draft.layout) });
    if (selected === name) select(null);
  };

  const onMoveField = (index: number, direction: -1 | 1) => {
    setDraft({ ...draft, fields: moveFieldStep(draft.fields, index, direction, draft.layout) });
  };

  const onLayout = (next: { fields: FormField[]; layout: FormLayout }) =>
    setDraft({ ...draft, ...next });

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    const result = await data.save({
      label: draft.label,
      name: draft.name,
      fields: draft.fields,
      layout: draft.layout,
      open: draft.open,
      closesAt: draft.closesAt,
      successMessage: draft.successMessage,
      closedMessage: draft.closedMessage,
      submitLabel: draft.submitLabel,
      redirectTo: draft.redirectTo,
    });
    setSaving(false);
    onNotice(
      result.ok
        ? "Saved."
        : result.conflict
          ? `${result.message} Your unsaved change was discarded — the form below is the latest version.`
          : result.message,
    );
  };

  const remove = async () => {
    const res = await fetch(`${apiBase}/forms/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      onNotice(await messageOf(res));
      return;
    }
    onNotice(`"${draft.label || "Untitled form"}" and everything it collected are gone.`);
    onDeleted();
  };

  const addMenuItems: MenuItem[] = FIELD_KINDS.map((k) => ({
    id: k.kind,
    label: (
      <span className={css.menuItem}>
        <span className={css.menuItemLabel}>{k.label}</span>
        <span className={css.menuItemHint}>{k.hint}</span>
      </span>
    ),
    run: () => onAddField(k.kind),
  }));
  const atLimit = draft.fields.length >= MAX_FORM_FIELDS;

  return (
    <div className={css.screen}>
      <ListHeader
        actions={
          <>
            {showLocales ? (
              <Select
                aria-label="Editing locale"
                value={locale}
                onChange={(e) => setLocale(e.target.value)}
              >
                {locales?.available.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                    {l.code === source ? " (source)" : ""}
                  </option>
                ))}
              </Select>
            ) : null}
            <Button size="sm" onClick={() => onOpenResponses(id)}>
              Responses
            </Button>
            {canDeleteForms(me) ? (
              <Button size="sm" variant="subtle" onClick={() => setDeleting(true)}>
                Delete
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="primary"
              disabled={!editable || saving || logicProblem !== null}
              reason={!editable ? "Your role may not edit forms" : (logicProblem ?? undefined)}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        {/*
          The screen's `h1` is the breadcrumb's last crumb now (issue #8), not this
          input — this renders inside `ListHeader`'s section-label `h2`, whose
          class affects nothing here because the input carries its own font. It
          stays as `children` anyway, because it is not a title: it is the form's
          editable name, a rename control rather than a heading.

          A plain `<input>`, not the shared `Input` — that wrapper always
          applies `Field.module.css`'s `.control` and deliberately omits
          `className` (`Field.tsx`), because it exists for the one look a
          labelled field control has. A screen title styled like a form field
          is the wrong look, the same reason `Redirects.tsx`'s search box is
          a bare `<input>` too.
        */}
        <input
          className={css.titleInput}
          aria-label="Form label"
          value={draft.label}
          disabled={!editable}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
        />
      </ListHeader>

      {structural ? (
        <p className={css.structuralNote}>
          Saving will change this form's shape — a question added, removed, renamed, retyped, made
          required or conditional, an option, length limit, pattern or accepted file type changed,
          or a section given a condition — which bumps its version as well as purging every cached
          page that renders it. A label, help-text, layout, prefill or section-heading change purges
          the same cache without bumping the version.
        </p>
      ) : null}
      {logicProblem ? (
        <p className={css.structuralNote} role="alert">
          {logicProblem}
        </p>
      ) : null}

      <div className={css.body}>
        <div className={css.fields}>
          <ol className={css.fieldList}>
            {draft.fields.flatMap((field, i) => {
              const section = draft.layout.sections?.find((s) => s.name === field.section);
              const opensSection =
                section !== undefined && draft.fields[i - 1]?.section !== field.section;
              const removal = removeRefusal(draft.fields, draft.layout, field.name);
              const shownWhen = field.showIf ? formConditionText(field.showIf, draft.fields) : null;
              const requiredWhen = field.requireIf
                ? formConditionText(field.requireIf, draft.fields)
                : null;
              return [
                opensSection ? (
                  <li key={`section:${section.name}`} className={css.sectionRow}>
                    <button
                      type="button"
                      className={`${css.fieldRow} ${selectedSection === section.name ? css.fieldRowSelected : ""}`}
                      onClick={() => selectSection(section.name)}
                    >
                      <span className={css.fieldRowKind}>Section</span>
                      <span className={css.fieldRowLabel}>{section.label || section.name}</span>
                      {section.showIf ? <Badge>Conditional</Badge> : null}
                    </button>
                  </li>
                ) : null,
                <li
                  key={field.name}
                  className={joinedIndices.has(i) ? css.fieldRowJoined : undefined}
                >
                  <button
                    type="button"
                    className={`${css.fieldRow} ${selected === field.name ? css.fieldRowSelected : ""}`}
                    onClick={() => select(field.name)}
                  >
                    <span className={css.fieldRowKind}>
                      {fieldKindLabel(field.kind)}
                      {/* Which row this question draws in — `hidden` has none,
                        being position-free on the live page. */}
                      {field.kind !== "hidden"
                        ? ` · Row ${(rowOfField.get(field.name) ?? 0) + 1}`
                        : ""}
                    </span>
                    <span className={css.fieldRowLabel}>{field.label || field.name}</span>
                    {field.required ? <Badge tone="accent">Required</Badge> : null}
                    {shownWhen || requiredWhen ? (
                      <span className={css.fieldRowLogic}>
                        {shownWhen ? `Shown when ${shownWhen}` : ""}
                        {shownWhen && requiredWhen ? ". " : ""}
                        {requiredWhen ? `Required when ${requiredWhen}` : ""}
                      </span>
                    ) : null}
                  </button>
                  <span className={css.fieldRowActions}>
                    <Button
                      size="sm"
                      variant="subtle"
                      // Row-aware, not `i === 0`: the first member of a
                      // multi-question row can still detach from its row-mates
                      // without leaving position 0 (`canMoveField`).
                      disabled={!editable || !canMoveField(draft.fields, i, -1, draft.layout)}
                      reason="Already first"
                      aria-label={`Move ${field.label || field.name} up`}
                      onClick={() => onMoveField(i, -1)}
                    >
                      ↑
                    </Button>
                    <Button
                      size="sm"
                      variant="subtle"
                      disabled={!editable || !canMoveField(draft.fields, i, 1, draft.layout)}
                      reason="Already last"
                      aria-label={`Move ${field.label || field.name} down`}
                      onClick={() => onMoveField(i, 1)}
                    >
                      ↓
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={!editable || removal !== null}
                      reason={removal ?? undefined}
                      aria-label={`Remove ${field.label || field.name}`}
                      onClick={() => onRemoveField(field.name)}
                    >
                      ×
                    </Button>
                  </span>
                </li>,
              ];
            })}
          </ol>
          {draft.fields.length === 0 ? (
            <p className={css.note}>No questions yet. Add the first one below.</p>
          ) : null}
          <Menu
            trigger="Add a question…"
            items={
              atLimit
                ? addMenuItems.map((item) => ({
                    ...item,
                    disabled: true,
                    reason: MAX_FIELDS_REACHED(MAX_FORM_FIELDS),
                  }))
                : addMenuItems
            }
          />
        </div>

        <div className={css.panel}>
          {selectedSectionDef ? (
            <SectionPanel
              key={selectedSectionDef.name}
              section={selectedSectionDef}
              fields={draft.fields}
              locale={locale || source}
              source={source}
              editable={editable}
              onChange={(next) =>
                setDraft({ ...draft, layout: updateSection(draft.layout, next.name, next) })
              }
              onRemove={() => {
                onLayout(removeSection(draft.fields, draft.layout, selectedSectionDef.name));
                setSelectedSection(null);
              }}
            />
          ) : selectedField ? (
            <FieldPanel
              key={selectedInitialName ?? selectedField.name}
              field={selectedField}
              fields={draft.fields}
              layout={draft.layout}
              index={draft.fields.findIndex((f) => f.name === selectedField.name)}
              rowSize={
                rows.find((row) => row.some((i) => draft.fields[i]?.name === selectedField.name))
                  ?.length ?? 1
              }
              sectionCount={draft.layout.sections?.length ?? 0}
              onStartSection={() => {
                const started = startSection(draft.fields, draft.layout, selectedField.name);
                if (started) {
                  onLayout(started);
                  selectSection(started.section);
                }
              }}
              onEndSection={() =>
                setDraft({ ...draft, fields: endSectionAfter(draft.fields, selectedField.name) })
              }
              formId={draft.id}
              otherNames={draft.fields
                .filter((f) => f.name !== selectedField.name)
                .map((f) => f.name)}
              locale={locale || source}
              source={source}
              editable={editable}
              showRenameWarning={hasResponses}
              canJoinPrevious={joinable}
              onChange={(next) => onFieldChange(selectedField.name, next)}
            />
          ) : (
            <FormSettingsPanel
              form={draft}
              editable={editable}
              onChange={(next) => setDraft(next)}
            />
          )}
        </div>
      </div>

      {deleting ? (
        <FormDeleteDialog
          apiBase={apiBase}
          id={id}
          label={draft.label}
          onClose={() => setDeleting(false)}
          onConfirm={() => {
            setDeleting(false);
            void remove();
          }}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- field panel --- */

function FieldPanel({
  field,
  fields,
  layout,
  index,
  rowSize,
  sectionCount,
  onStartSection,
  onEndSection,
  formId,
  otherNames,
  locale,
  source,
  editable,
  showRenameWarning,
  canJoinPrevious,
  onChange,
}: {
  field: FormField;
  /** Every question and the layout, for the rule editors and the section actions. */
  fields: readonly FormField[];
  layout: FormLayout;
  index: number;
  /** How many questions share this one's row: `hold` only matters above one. */
  rowSize: number;
  sectionCount: number;
  onStartSection: () => void;
  onEndSection: () => void;
  formId: string;
  otherNames: readonly string[];
  locale: string;
  source: string;
  editable: boolean;
  showRenameWarning: boolean;
  /** Whether `beside` on this question could do anything at all — false for
   *  the form's first real question and for one right after a `statement`. */
  canJoinPrevious: boolean;
  onChange: (next: FormField) => void;
}) {
  const [nameDraft, setNameDraft] = useState(field.name);
  useEffect(() => setNameDraft(field.name), [field.name]);

  // What the rule editors may name (`sourcesFor`), and whether this question is
  // conditionally asked at all (its own `showIf` or its section's), which is what
  // makes "Required" read "Whenever it is shown".
  const showSources = sourcesFor(fields, index, "show");
  const requireSources = sourcesFor(fields, index, "require");
  const sectionRule = layout.sections?.find((sec) => sec.name === field.section)?.showIf;
  const conditional = field.showIf !== undefined || sectionRule !== undefined;
  const requirement = field.requireIf ? "when" : field.required ? "always" : "no";

  const text = (key: TranslatableKey) => fieldText(field, key, locale, source);
  const setText = (key: TranslatableKey, value: string) =>
    onChange(withFieldText(field, key, value, locale, source));

  /**
   * What committing `nameDraft` would produce, and what is wrong with it — a
   * *preview*, computed the same way `commitName` commits, so the charset
   * autocorrection (`normaliseFieldName`) never itself reads as an error: a
   * name typed as "First Name" previews as `first_name` and shows nothing
   * wrong, because nothing is. What can still refuse is the one thing this
   * screen alone can catch — a collision with another question's name or with
   * this form's honeypot (decision 9) — and committing over either is refused
   * rather than silently disambiguated, because a silent `_2` suffix is a
   * rename that did not do what it looked like it did.
   */
  const previewName = normaliseFieldName(nameDraft);
  const renamed = previewName !== field.name;
  const nameRefusal = renamed ? fieldNameRefusal(previewName, { formId, otherNames }) : null;

  const commitName = () => {
    if (nameRefusal) return;
    setNameDraft(previewName);
    if (previewName !== field.name) onChange({ ...field, name: previewName });
  };

  return (
    <div className={css.fieldPanel}>
      <div className={css.panelHead}>
        <Badge>{fieldKindLabel(field.kind)}</Badge>
      </div>

      {locale === source ? (
        <Field
          label="Field name"
          help={
            nameRefusal
              ? undefined
              : renamed && showRenameWarning
                ? (renameWarning(true) ?? undefined)
                : "The HTML input's name, the CSV column header, and the key a response is stored under. Lowercase letters, numbers and underscores."
          }
          error={nameRefusal ?? undefined}
        >
          {(id) => (
            <Input
              id={id}
              value={nameDraft}
              disabled={!editable}
              spellCheck={false}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
            />
          )}
        </Field>
      ) : null}

      <Field label="Label" required={locale === source}>
        {(id) => (
          <Input
            id={id}
            value={text("label")}
            placeholder={locale === source ? undefined : field.label}
            disabled={!editable}
            onChange={(e) => setText("label", e.target.value)}
          />
        )}
      </Field>

      {field.kind !== "hidden" && field.kind !== "statement" ? (
        <Field label="Help text">
          {(id) => (
            <Input
              id={id}
              value={text("help")}
              placeholder={locale === source ? undefined : field.help}
              disabled={!editable}
              onChange={(e) => setText("help", e.target.value)}
            />
          )}
        </Field>
      ) : null}

      {supportsPlaceholder(field.kind) ? (
        <Field label="Placeholder">
          {(id) => (
            <Input
              id={id}
              value={text("placeholder")}
              placeholder={locale === source ? undefined : field.placeholder}
              disabled={!editable}
              onChange={(e) => setText("placeholder", e.target.value)}
            />
          )}
        </Field>
      ) : null}

      {locale === source ? (
        <Field
          label="Show this question"
          help={
            field.showIf
              ? "Revealing one question works well for screen reader users; to reveal several, put them in a section."
              : undefined
          }
        >
          {(id) => (
            <Select
              id={id}
              value={field.showIf ? "when" : "always"}
              disabled={!editable || (!field.showIf && showSources.length === 0)}
              onChange={(e) => {
                if (e.target.value === "always") {
                  const next = { ...field };
                  delete next.showIf;
                  delete next.hold;
                  onChange(next);
                } else if (showSources[0]) {
                  onChange({ ...field, showIf: blankCondition(showSources[0]) });
                }
              }}
            >
              <option value="always">Always</option>
              <option value="when" disabled={showSources.length === 0}>
                Only when…
              </option>
            </Select>
          )}
        </Field>
      ) : null}
      {locale === source && field.showIf ? (
        <ConditionEditor
          condition={field.showIf}
          sources={showSources}
          fields={fields}
          editable={editable}
          onChange={(showIf) => onChange({ ...field, showIf })}
        />
      ) : null}

      {locale === source && field.kind !== "hidden" && field.kind !== "statement" ? (
        <Field label="Required">
          {(id) => (
            <Select
              id={id}
              value={requirement}
              disabled={!editable}
              onChange={(e) => {
                const next = { ...field };
                delete next.required;
                delete next.requireIf;
                if (e.target.value === "always") next.required = true;
                else if (e.target.value === "when" && requireSources[0]) {
                  next.requireIf = blankCondition(requireSources[0]);
                }
                onChange(next);
              }}
            >
              <option value="no">No</option>
              <option value="always">{conditional ? "Whenever it is shown" : "Always"}</option>
              <option value="when" disabled={requireSources.length === 0}>
                Only when…
              </option>
            </Select>
          )}
        </Field>
      ) : null}
      {locale === source && field.requireIf ? (
        <ConditionEditor
          condition={field.requireIf}
          sources={requireSources}
          fields={fields}
          editable={editable}
          onChange={(requireIf) => onChange({ ...field, requireIf })}
        />
      ) : null}

      {locale === source && conditional && rowSize > 1 ? (
        <Field
          label="Keep its space when hidden"
          inline
          help="Its row-mates stay the same width instead of stretching to fill the gap."
        >
          {(id) => (
            <input
              id={id}
              type="checkbox"
              checked={field.hold === true}
              disabled={!editable}
              onChange={(e) => {
                const next = { ...field };
                if (e.target.checked) next.hold = true;
                else delete next.hold;
                onChange(next);
              }}
            />
          )}
        </Field>
      ) : null}

      {locale === source && field.kind !== "file" && field.kind !== "statement" ? (
        <Field
          label="Fill from the page address"
          inline
          help={`A link to this page ending ?${field.name}=… fills this question in.`}
        >
          {(id) => (
            <input
              id={id}
              type="checkbox"
              checked={field.prefill === "query"}
              disabled={!editable}
              onChange={(e) => {
                const next = { ...field };
                if (e.target.checked) next.prefill = "query";
                else delete next.prefill;
                onChange(next);
              }}
            />
          )}
        </Field>
      ) : null}

      {locale === source ? (
        <div className={css.sectionActions}>
          <Button
            size="sm"
            disabled={!editable || sectionCount >= MAX_FORM_SECTIONS}
            reason={`A form may hold at most ${MAX_FORM_SECTIONS} sections.`}
            onClick={onStartSection}
          >
            Start a section here
          </Button>
          {field.section !== undefined ? (
            <Button size="sm" disabled={!editable} onClick={onEndSection}>
              End the section after this question
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Layout, not shape (`docs/form-layout-approach.md` decision 2): neither
          control touches `shapeOf`, so neither bumps `version` — but saving
          either still purges the cached page (`updateForm`'s
          `descriptorChanged`). Not shown for `hidden` (position-free) or
          `statement` (always its own row) — `rowsOf` ignores both anyway. */}
      {locale === source && field.kind !== "hidden" && field.kind !== "statement" ? (
        <>
          <Field
            label="Sit beside the previous question"
            inline
            help={
              canJoinPrevious
                ? undefined
                : "The first question in a form, or the one right after a statement, always starts its own row."
            }
          >
            {(id) => (
              <input
                id={id}
                type="checkbox"
                checked={field.beside === true}
                disabled={!editable || !canJoinPrevious}
                onChange={(e) => onChange(withBeside(field, e.target.checked))}
              />
            )}
          </Field>
          <Field
            label="Row width share"
            help="Relative to the other questions in its row. 1 is the default."
          >
            {(id) => (
              <Select
                id={id}
                value={field.grow ?? 1}
                disabled={!editable}
                onChange={(e) => onChange(withGrow(field, Number(e.target.value)))}
              >
                <option value={1}>1 (default)</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
                <option value={4}>4</option>
              </Select>
            )}
          </Field>
        </>
      ) : null}

      {locale === source && supportsMax(field.kind) ? (
        <Field label={field.kind === "number" ? "Maximum value" : "Maximum length"}>
          {(id) => (
            <Input
              id={id}
              type="number"
              value={field.max ?? ""}
              disabled={!editable}
              onChange={(e) =>
                onChange({
                  ...field,
                  max: e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
            />
          )}
        </Field>
      ) : null}

      {locale === source && field.kind === "number" ? (
        <Field label="Minimum value">
          {(id) => (
            <Input
              id={id}
              type="number"
              value={field.min ?? ""}
              disabled={!editable}
              onChange={(e) =>
                onChange({
                  ...field,
                  min: e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
            />
          )}
        </Field>
      ) : null}

      {locale === source && supportsPattern(field.kind) ? (
        <Field
          label="Pattern"
          help="An HTML pattern the input enforces, re-checked on submit. Leave blank for none."
        >
          {(id) => (
            <Input
              id={id}
              value={field.pattern ?? ""}
              disabled={!editable}
              spellCheck={false}
              onChange={(e) =>
                onChange({ ...field, pattern: e.target.value === "" ? undefined : e.target.value })
              }
            />
          )}
        </Field>
      ) : null}

      {needsOptions(field.kind) ? (
        <OptionsEditor
          field={field}
          fields={fields}
          layout={layout}
          locale={locale}
          source={source}
          editable={editable}
          onChange={onChange}
        />
      ) : null}

      {locale === source && field.kind === "file" ? (
        <>
          <Field label="Accepts">
            {(id) => (
              <Select
                id={id}
                value={field.accept ?? "documents"}
                disabled={!editable}
                onChange={(e) =>
                  onChange({ ...field, accept: e.target.value as FormField["accept"] })
                }
              >
                {(Object.keys(FILE_ACCEPT) as (keyof typeof FILE_ACCEPT)[]).map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Maximum size (bytes)"
            help="Left blank, this uses Folio's own upload limit."
          >
            {(id) => (
              <Input
                id={id}
                type="number"
                value={field.maxBytes ?? ""}
                disabled={!editable}
                onChange={(e) =>
                  onChange({
                    ...field,
                    maxBytes: e.target.value === "" ? undefined : Number(e.target.value),
                  })
                }
              />
            )}
          </Field>
        </>
      ) : null}

      {locale === source && field.kind === "hidden" ? (
        <Field label="Value" help="The value the host's own markup emits for this input.">
          {(id) => (
            <Input
              id={id}
              value={field.value ?? ""}
              disabled={!editable}
              onChange={(e) => onChange({ ...field, value: e.target.value })}
            />
          )}
        </Field>
      ) : null}

      {field.kind === "statement" && locale === source ? (
        <Field label="Text" help="Prose between questions. Renders no input and stores nothing.">
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={field.text ?? ""}
              disabled={!editable}
              onChange={(e) => onChange({ ...field, text: e.target.value })}
            />
          )}
        </Field>
      ) : null}
      {field.kind === "statement" && locale !== source ? (
        // `FormFieldI18n` has no `text` key (only `label`, `help`,
        // `placeholder` and `options`), and `compileField` in
        // `server/forms.ts` confirms why: `out.text = field.text` is written
        // verbatim, with no locale lookup at all. A statement's prose is not
        // translatable today, so saying that plainly beats inventing an editor
        // for a key that would silently do nothing.
        <p className={css.note}>
          Statement text is not translated — every locale shows the source text.
        </p>
      ) : null}
    </div>
  );
}

function OptionsEditor({
  field,
  fields,
  layout,
  locale,
  source,
  editable,
  onChange,
}: {
  field: FormField;
  fields: readonly FormField[];
  layout: FormLayout;
  locale: string;
  source: string;
  editable: boolean;
  onChange: (next: FormField) => void;
}) {
  const options = field.options ?? [];
  return (
    <div className={css.options}>
      <span className={css.optionsLabel}>Options</span>
      <ol className={css.optionList}>
        {/* Keyed by position: the value is what the first input edits, so a
            value key remounts the row, and drops focus, on every keystroke. */}
        {options.map((option, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <li key={index} className={css.optionRow}>
            {locale === source ? (
              <Input
                value={option.value}
                disabled={!editable}
                spellCheck={false}
                aria-label="Option value"
                onChange={(e) =>
                  onChange(
                    updateOption(field, index, {
                      value: e.target.value,
                      label: option.label,
                    }),
                  )
                }
              />
            ) : null}
            <Input
              value={optionLabel(field, option.value, locale, source)}
              placeholder={locale === source ? undefined : option.label}
              disabled={!editable}
              aria-label="Option label"
              onChange={(e) =>
                onChange(withOptionLabel(field, option.value, e.target.value, locale, source))
              }
            />
            {locale === source ? (
              <Button
                size="sm"
                variant="danger"
                disabled={
                  !editable ||
                  options.length <= 1 ||
                  optionRefusal(fields, layout, field.name, option.value) !== null
                }
                reason={
                  options.length <= 1
                    ? "At least one option is required"
                    : (optionRefusal(fields, layout, field.name, option.value) ?? undefined)
                }
                aria-label={`Remove ${option.label || option.value}`}
                onClick={() => onChange(removeOption(field, index, { fields, layout }))}
              >
                ×
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
      {locale === source ? (
        <Button size="sm" disabled={!editable} onClick={() => onChange(addOption(field))}>
          Add option
        </Button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ section panel --- */

/** A section's heading, its translations and the rule that shows the group. */
function SectionPanel({
  section,
  fields,
  locale,
  source,
  editable,
  onChange,
  onRemove,
}: {
  section: FormSection;
  fields: readonly FormField[];
  locale: string;
  source: string;
  editable: boolean;
  onChange: (next: FormSection) => void;
  onRemove: () => void;
}) {
  const translating = locale !== source;
  const text = (key: "label" | "help") =>
    translating ? (section.i18n?.[locale]?.[key] ?? "") : (section[key] ?? "");
  const setText = (key: "label" | "help", value: string) => {
    if (!translating) {
      const next = { ...section, [key]: value };
      if (key === "help" && value === "") delete next.help;
      onChange(next);
      return;
    }
    const entry = { ...section.i18n?.[locale] };
    if (value === "") delete entry[key];
    else entry[key] = value;
    const i18n = { ...section.i18n };
    if (Object.keys(entry).length > 0) i18n[locale] = entry;
    else delete i18n[locale];
    const next = { ...section };
    if (Object.keys(i18n).length > 0) next.i18n = i18n;
    else delete next.i18n;
    onChange(next);
  };

  // A section's rule may name only questions above its first member.
  const firstMember = fields.findIndex((f) => f.section === section.name);
  const sources = sourcesFor(fields, firstMember === -1 ? fields.length : firstMember, "show");

  return (
    <div className={css.fieldPanel}>
      <div className={css.panelHead}>
        <Badge>Section</Badge>
      </div>
      <Field label="Heading" required={!translating}>
        {(id) => (
          <Input
            id={id}
            value={text("label")}
            placeholder={translating ? section.label : undefined}
            disabled={!editable}
            onChange={(e) => setText("label", e.target.value)}
          />
        )}
      </Field>
      <Field label="Help text">
        {(id) => (
          <Input
            id={id}
            value={text("help")}
            placeholder={translating ? section.help : undefined}
            disabled={!editable}
            onChange={(e) => setText("help", e.target.value)}
          />
        )}
      </Field>
      {!translating ? (
        <>
          <Field
            label="Show this section"
            help={
              section.showIf
                ? "Revealing one question works well for screen reader users; to reveal several, put them in a section."
                : undefined
            }
          >
            {(id) => (
              <Select
                id={id}
                value={section.showIf ? "when" : "always"}
                disabled={!editable || (!section.showIf && sources.length === 0)}
                onChange={(e) => {
                  if (e.target.value === "always") {
                    const next = { ...section };
                    delete next.showIf;
                    onChange(next);
                  } else if (sources[0]) {
                    onChange({ ...section, showIf: blankCondition(sources[0]) });
                  }
                }}
              >
                <option value="always">Always</option>
                <option value="when" disabled={sources.length === 0}>
                  Only when…
                </option>
              </Select>
            )}
          </Field>
          {section.showIf ? (
            <ConditionEditor
              condition={section.showIf}
              sources={sources}
              fields={fields}
              editable={editable}
              onChange={(showIf) => onChange({ ...section, showIf })}
            />
          ) : null}
          <Button size="sm" variant="danger" disabled={!editable} onClick={onRemove}>
            Remove section (keeps its questions)
          </Button>
        </>
      ) : null}
    </div>
  );
}

function supportsPlaceholder(kind: FormFieldKind): boolean {
  return (
    kind === "text" || kind === "textarea" || kind === "email" || kind === "tel" || kind === "url"
  );
}

function supportsMax(kind: FormFieldKind): boolean {
  return kind === "text" || kind === "textarea" || kind === "number";
}

function supportsPattern(kind: FormFieldKind): boolean {
  return kind === "text" || kind === "email" || kind === "tel" || kind === "url";
}

/* ------------------------------------------------------------- form settings --- */

function FormSettingsPanel({
  form,
  editable,
  onChange,
}: {
  form: Form;
  editable: boolean;
  onChange: (next: Form) => void;
}) {
  return (
    <div className={css.fieldPanel}>
      <ListHeader>Settings</ListHeader>

      <Field
        label="Name"
        help="The admin's stable handle for this form — never part of the public action URL, but it rides back on a redirect as `folio_form` so a page carrying two forms can tell which one answered."
      >
        {(id) => (
          <Input
            id={id}
            value={form.name}
            disabled={!editable}
            spellCheck={false}
            onChange={(e) => onChange({ ...form, name: e.target.value })}
          />
        )}
      </Field>

      <Field label="Accepting submissions" inline>
        {(id) => (
          <input
            id={id}
            type="checkbox"
            checked={form.open}
            disabled={!editable}
            onChange={(e) => onChange({ ...form, open: e.target.checked })}
          />
        )}
      </Field>

      <Field
        label="Closes automatically"
        help="Enforced at the route, not only in the markup — a cached page that is still showing the form gets refused once this passes."
      >
        {(id) => (
          <Input
            id={id}
            type="datetime-local"
            value={closesAtInputValue(form.closesAt)}
            disabled={!editable}
            onChange={(e) => onChange({ ...form, closesAt: closesAtFromInput(e.target.value) })}
          />
        )}
      </Field>

      <Field label="Submit button label">
        {(id) => (
          <Input
            id={id}
            value={form.submitLabel}
            disabled={!editable}
            onChange={(e) => onChange({ ...form, submitLabel: e.target.value })}
          />
        )}
      </Field>

      <Field label="Success message" help="Shown on the page a visitor lands on after submitting.">
        {(id) => (
          <Textarea
            id={id}
            rows={2}
            value={form.successMessage}
            disabled={!editable}
            onChange={(e) => onChange({ ...form, successMessage: e.target.value })}
          />
        )}
      </Field>

      <Field label="Closed message" help="Shown in place of the form once it stops accepting.">
        {(id) => (
          <Textarea
            id={id}
            rows={2}
            value={form.closedMessage}
            disabled={!editable}
            onChange={(e) => onChange({ ...form, closedMessage: e.target.value })}
          />
        )}
      </Field>

      <Field
        label="Redirect to"
        help="A path on this site, or a full URL, to send a successful submission to instead of back where it came from. Leave blank to return to the page it was submitted from."
      >
        {(id) => (
          <Input
            id={id}
            value={form.redirectTo ?? ""}
            disabled={!editable}
            spellCheck={false}
            onChange={(e) =>
              onChange({ ...form, redirectTo: e.target.value === "" ? null : e.target.value })
            }
          />
        )}
      </Field>
    </div>
  );
}
