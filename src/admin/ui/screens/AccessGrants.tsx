import { useState } from "react";
import type { Grants, Role } from "../../../server/auth/roles";
import type { Me } from "../../me";
import { Button } from "../Button";
import { Select } from "../Field";
import css from "./Access.module.css";
import {
  grantScopeLabel,
  grantScopeOptions,
  nextScope,
  ROLE_MEANING,
  ROLE_OPTIONS,
  withGrant,
  withoutGrant,
} from "./access-model";

/**
 * A person's grants, one role per scope (`multi-site.md` decision 10): `*` is the
 * platform, `shared` the shared content, and a group or a site its own.
 *
 * Only on a deployment with `sites` — `Access` and the invite dialog draw a single
 * role otherwise, exactly as they always did. The scope of a grant already in the set
 * is fixed (change the role, or remove it); *Add* offers the scopes not yet granted.
 * A grant naming a scope that no longer exists is kept in the set and labelled by its
 * id, so saving never drops one the admin has not looked at — the registry delete
 * removes those itself.
 */
export function GrantsEditor({
  me,
  value,
  onChange,
}: {
  me: Me;
  value: Grants;
  onChange: (next: Grants) => void;
}) {
  const [scope, setScope] = useState<string>("");
  const [role, setRole] = useState<Role>("editor");
  const entries = Object.entries(value);
  const options = grantScopeOptions(me).filter((option) => !(option.id in value));
  const chosen = options.some((option) => option.id === scope)
    ? scope
    : (nextScope(me, value) ?? "");

  return (
    <div className={css.grants}>
      {entries.length === 0 ? <p className={css.help}>No grants yet.</p> : null}
      {entries.map(([held, heldRole]) => (
        <div className={css.grantRow} key={held}>
          <span className={css.grantScope}>{grantScopeLabel(me, held)}</span>
          <Select
            value={heldRole}
            aria-label={`Role on ${grantScopeLabel(me, held)}`}
            title={ROLE_MEANING[heldRole]}
            onChange={(e) => onChange(withGrant(value, held, e.target.value as Role))}
          >
            {ROLE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="subtle" onClick={() => onChange(withoutGrant(value, held))}>
            Remove
          </Button>
        </div>
      ))}

      {options.length > 0 ? (
        <div className={css.grantRow}>
          <Select
            value={chosen}
            aria-label="Scope to grant"
            onChange={(e) => setScope(e.target.value)}
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
          <Select
            value={role}
            aria-label="Role to grant"
            onChange={(e) => setRole(e.target.value as Role)}
          >
            {ROLE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            disabled={chosen === ""}
            reason="Every scope is already granted"
            onClick={() => {
              onChange(withGrant(value, chosen, role));
              setScope("");
            }}
          >
            Add
          </Button>
        </div>
      ) : null}
      <p className={css.help}>{ROLE_MEANING[role]}</p>
    </div>
  );
}
