import type { FieldCondition } from "../../../core/conditions";
import type { Json } from "../../../core/doc";
import type { FormField } from "../../../core/forms";
import { Button } from "../Button";
import { Input, Select } from "../Field";
import css from "./ConditionEditor.module.css";
import {
  blankClause,
  blankCondition,
  type Clause,
  type ClauseOp,
  formConditionText,
  fromEditable,
  OPERATOR_LABELS,
  operatorsFor,
  toEditable,
} from "./condition-model";

interface Props {
  condition: FieldCondition;
  /** The questions the rule may name (`sourcesFor`). */
  sources: readonly FormField[];
  /** Every question, for phrasing a condition this editor cannot edit. */
  fields: readonly FormField[];
  editable: boolean;
  onChange: (next: FieldCondition) => void;
}

/**
 * A condition, edited as one clause or as several joined by "all" / "any"
 * (`condition-model.ts`'s editable subset). A stored condition outside that subset
 * (`not`, deeper nesting) is shown as a sentence, read-only, with a **Replace**
 * button, rather than being flattened into something it never said.
 */
export function ConditionEditor({ condition, sources, fields, editable, onChange }: Props) {
  const editing = toEditable(condition);
  const first = sources[0];

  if (!editing) {
    return (
      <div className={css.editor}>
        <p className={css.sentence}>{formConditionText(condition, fields)}</p>
        <Button
          size="sm"
          disabled={!editable || !first}
          reason={!first ? "No question above this one to depend on" : undefined}
          onClick={() => first && onChange(blankCondition(first))}
        >
          Replace
        </Button>
      </div>
    );
  }

  const setClause = (index: number, next: Clause) =>
    onChange(
      fromEditable({
        ...editing,
        clauses: editing.clauses.map((c, i) => (i === index ? next : c)),
      }),
    );

  return (
    <div className={css.editor}>
      {editing.clauses.length > 1 ? (
        <Select
          aria-label="Match"
          value={editing.mode}
          disabled={!editable}
          onChange={(e) =>
            onChange(fromEditable({ ...editing, mode: e.target.value as "all" | "any" }))
          }
        >
          <option value="all">All of these</option>
          <option value="any">Any of these</option>
        </Select>
      ) : null}
      <ol className={css.clauses}>
        {editing.clauses.map((clause, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a clause has no identity beyond its place
          <li key={index} className={css.clause}>
            <ClauseRow
              clause={clause}
              sources={sources}
              editable={editable}
              onChange={(next) => setClause(index, next)}
            />
            {editing.clauses.length > 1 ? (
              <Button
                size="sm"
                variant="subtle"
                disabled={!editable}
                aria-label="Remove this condition"
                onClick={() =>
                  onChange(
                    fromEditable({
                      ...editing,
                      clauses: editing.clauses.filter((_, i) => i !== index),
                    }),
                  )
                }
              >
                ×
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
      <Button
        size="sm"
        disabled={!editable || !first}
        onClick={() =>
          first &&
          onChange(fromEditable({ ...editing, clauses: [...editing.clauses, blankClause(first)] }))
        }
      >
        Add a condition
      </Button>
    </div>
  );
}

function ClauseRow({
  clause,
  sources,
  editable,
  onChange,
}: {
  clause: Clause;
  sources: readonly FormField[];
  editable: boolean;
  onChange: (next: Clause) => void;
}) {
  const source = sources.find((f) => f.name === clause.field);
  const operators = source ? operatorsFor(source.kind) : [];

  return (
    <div className={css.row}>
      <Select
        aria-label="Question"
        value={clause.field}
        disabled={!editable}
        onChange={(e) => {
          const next = sources.find((f) => f.name === e.target.value);
          if (next) onChange(blankClause(next));
        }}
      >
        {source ? null : <option value={clause.field}>{clause.field} (missing)</option>}
        {sources.map((f) => (
          <option key={f.name} value={f.name}>
            {f.label || f.name}
          </option>
        ))}
      </Select>
      <Select
        aria-label="Operator"
        value={clause.op}
        disabled={!editable || !source}
        onChange={(e) => {
          if (!source) return;
          const op = e.target.value as ClauseOp;
          const base = blankClause(source);
          onChange({ ...base, op, value: op === "in" ? [base.value as Json] : base.value });
        }}
      >
        {operators.map((op) => (
          <option key={op} value={op}>
            {OPERATOR_LABELS[op]}
          </option>
        ))}
      </Select>
      {source && clause.op !== "set" && clause.op !== "unset" ? (
        <ValueInput clause={clause} source={source} editable={editable} onChange={onChange} />
      ) : null}
    </div>
  );
}

function ValueInput({
  clause,
  source,
  editable,
  onChange,
}: {
  clause: Clause;
  source: FormField;
  editable: boolean;
  onChange: (next: Clause) => void;
}) {
  if (source.kind === "checkbox") {
    return (
      <Select
        aria-label="Value"
        value={clause.value === false ? "no" : "yes"}
        disabled={!editable}
        onChange={(e) => onChange({ ...clause, value: e.target.value === "yes" })}
      >
        <option value="yes">ticked</option>
        <option value="no">not ticked</option>
      </Select>
    );
  }

  const options = source.options;
  if (options && clause.op === "in") {
    const chosen = Array.isArray(clause.value) ? clause.value : [];
    return (
      <fieldset className={css.checks} aria-label="Values">
        {options.map((o) => (
          <label key={o.value} className={css.check}>
            <input
              type="checkbox"
              checked={chosen.includes(o.value)}
              disabled={!editable}
              onChange={(e) =>
                onChange({
                  ...clause,
                  value: e.target.checked
                    ? [...chosen, o.value]
                    : chosen.filter((v) => v !== o.value),
                })
              }
            />
            {o.label || o.value}
          </label>
        ))}
      </fieldset>
    );
  }
  if (options) {
    return (
      <Select
        aria-label="Value"
        value={String(clause.value ?? "")}
        disabled={!editable}
        onChange={(e) => onChange({ ...clause, value: e.target.value })}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label || o.value}
          </option>
        ))}
      </Select>
    );
  }

  const numeric = source.kind === "number";
  const parse = (text: string): Json => (numeric ? Number(text) : text);
  if (clause.op === "in") {
    const list = Array.isArray(clause.value) ? clause.value : [];
    return (
      <Input
        aria-label="Values, separated by commas"
        value={list.join(", ")}
        disabled={!editable}
        spellCheck={false}
        onChange={(e) =>
          onChange({
            ...clause,
            value: e.target.value
              .split(",")
              .map((part) => part.trim())
              .filter((part) => part !== "")
              .map(parse),
          })
        }
      />
    );
  }
  return (
    <Input
      aria-label="Value"
      type={numeric ? "number" : "text"}
      value={String(clause.value ?? "")}
      disabled={!editable}
      onChange={(e) => onChange({ ...clause, value: parse(e.target.value) })}
    />
  );
}
