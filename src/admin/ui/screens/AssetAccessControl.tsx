import { useState } from "react";
import type { Json } from "../../../core/doc";
import { Button } from "../Button";
import { Input, Select } from "../Field";
import {
  accessChoices,
  accessLabel,
  type AssetAccessConfig,
  parseAccessInput,
  publicLabel,
} from "./assets-model";
import css from "./Assets.module.css";

interface Props {
  id: string;
  config: AssetAccessConfig;
  /** The own value: null or absent is "inherit". */
  value: Json | null | undefined;
  /**
   * The label of the null option, naming what it resolves to ("Inherit (Members, from
   * Member downloads)"). **Absent means there is no such option**, which is the bulk
   * action's case: a selection is given a value, never told to inherit.
   */
  inherit?: string;
  /**
   * What the select reads before a value is chosen, for a control with no inherit option
   * (the bulk action): a disabled first option, so nothing is pre-selected and nothing can
   * run by accident.
   */
  placeholder?: string;
  disabled?: boolean;
  onChange: (next: Json | null) => void;
}

const INHERIT = "inherit";
const OTHER = "other";

/**
 * One control for a file's, a folder's or a selection's access: a `select` over the gate
 * field's own vocabulary, with the inherit option first where there is one.
 *
 * A number or free-text gate has no list to pick from, so it offers inherit, the public
 * value and "Another value", which reveals a box and an *Apply*. The server validates
 * every value again; what is checked here is only that a number is a number.
 *
 * Options are keyed by position and not by value: a `<option value>` is a string, and a
 * boolean or numeric gate value would not survive the trip back.
 */
export function AssetAccessControl({
  id,
  config,
  value,
  inherit,
  placeholder,
  disabled,
  onChange,
}: Props) {
  const choices = accessChoices(config);
  const own = value === null || value === undefined ? null : value;
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState(own !== null && own !== config.public ? String(own) : "");
  const [error, setError] = useState<string | null>(null);

  if (choices.kind === "options") {
    const index = own === null ? -1 : choices.options.findIndex((o) => o.value === own);
    // A stored value the gate no longer lists (a renamed option) is shown rather than
    // silently re-selecting the first, so the editor can see and correct it.
    const unknown = own !== null && index === -1;
    return (
      <Select
        id={id}
        disabled={disabled}
        value={own === null ? INHERIT : unknown ? "unknown" : `o:${index}`}
        onChange={(e) => {
          const v = e.target.value;
          if (v === INHERIT) onChange(null);
          else if (v.startsWith("o:")) onChange(choices.options[Number(v.slice(2))]!.value);
        }}
      >
        {inherit === undefined ? null : <option value={INHERIT}>{inherit}</option>}
        {inherit === undefined && placeholder ? (
          <option value={INHERIT} disabled>
            {placeholder}
          </option>
        ) : null}
        {unknown ? <option value="unknown">{String(own)} (not an option)</option> : null}
        {choices.options.map((option, i) => (
          <option key={String(option.value)} value={`o:${i}`}>
            {option.label}
          </option>
        ))}
      </Select>
    );
  }

  const other = own !== null && own !== config.public;
  const apply = () => {
    const parsed = parseAccessInput(config, draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    setTyping(false);
    onChange(parsed.value);
  };

  return (
    <div className={css.accessControl}>
      <Select
        id={id}
        disabled={disabled}
        value={typing ? OTHER : own === null ? INHERIT : other ? OTHER : "public"}
        onChange={(e) => {
          const v = e.target.value;
          setError(null);
          if (v === OTHER) setTyping(true);
          else {
            setTyping(false);
            onChange(v === INHERIT ? null : config.public);
          }
        }}
      >
        {inherit === undefined ? null : <option value={INHERIT}>{inherit}</option>}
        {inherit === undefined && placeholder ? (
          <option value={INHERIT} disabled>
            {placeholder}
          </option>
        ) : null}
        <option value="public">{publicLabel(config)}</option>
        <option value={OTHER}>
          {other && !typing ? accessLabel(own, config) : "Another value…"}
        </option>
      </Select>
      {typing || other ? (
        <span className={css.accessRow}>
          <Input
            type={choices.kind === "number" ? "number" : "text"}
            value={draft}
            disabled={disabled}
            aria-label={`Value of ${config.field}`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                apply();
              }
            }}
          />
          <Button size="sm" disabled={disabled} onClick={apply}>
            Apply
          </Button>
        </span>
      ) : null}
      {error ? <span className={css.warn}>{error}</span> : null}
    </div>
  );
}
