import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { fallbackColour } from "../../../core/protocol";
import type { Grants, Role } from "../../../server/auth/roles";
import type { PasskeyRow } from "../../../server/auth/passkeys";
import type { Me } from "../../me";
import { Badge } from "../Badge";
import { Button } from "../Button";
import { Dialog } from "../Dialog";
import { EmptyState } from "../EmptyState";
import { Field, Input, Select } from "../Field";
import { ListHeader } from "../List";
import { type Column, Table } from "../Table";
import {
  type AccessGate,
  accessGate,
  grantsOf,
  grantsReason,
  grantsRefusal,
  isSelf,
  removePasskeysRefusal,
  ROLE_MEANING,
  ROLE_OPTIONS,
  roleFromReason,
  SELF_REMOVE_REASON,
  SELF_ROLE_REASON,
  since,
  type AccessUser,
  showsGrants,
} from "./access-model";
import { Unavailable } from "./Access";
import { GrantsEditor } from "./AccessGrants";
import css from "./Access.module.css";
import { messageOf } from "./useContent";

interface Props {
  apiBase: string;
  me: Me;
  id: string;
  /** The shell's boot is still in flight; see `Access`'s `loading`. */
  loading?: boolean;
  onNotice: (message: string) => void;
  /** Patches the shell's copy of the signed-in person's name. */
  onRenamed?: (id: string, name: string) => void;
  /** Reports the editor's name for the breadcrumb. */
  onLabel: (name: string) => void;
  /** Back to the Editors table: after a removal, and for the missing-user state. */
  onBack: () => void;
}

interface Loaded {
  user: AccessUser;
  passkeys: PasskeyRow[];
}

const SELF_EMAIL_REASON = "You cannot change your own sign-in address. Ask another admin.";

/**
 * One editor: details, access, passkeys and removal, on a page of their own
 * (`{base}/access/users/:id`). It replaces the Rename and Edit access dialogs and the
 * actions column the Editors table could not fit.
 *
 * Every write here is a `PATCH`/`DELETE` against routes the table already used, plus
 * `GET /users/:id` and `DELETE /users/:id/passkeys/:passkeyId`. A refusal the server
 * would make (your own address or role, a provider-managed account) is stated where
 * the control would be, as the table's role select already does, and the server's
 * sentence is the toast if one is reached anyway.
 */
export function AccessUserPage({
  apiBase,
  me,
  id,
  loading,
  onNotice,
  onRenamed,
  onLabel,
  onBack,
}: Props) {
  const gate = accessGate(me);
  const enabled = !loading && gate.kind === "ok";
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removingAll, setRemovingAll] = useState(false);
  const [removingOne, setRemovingOne] = useState<PasskeyRow | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [grants, setGrants] = useState<Grants>({});
  const [role, setRole] = useState<Role>("editor");

  const url = `${apiBase}/users/${encodeURIComponent(id)}`;
  // Held in a ref: the shell hands a fresh `onLabel` closure every render, and a load
  // that depended on it would refetch on each render (reporting the label re-renders
  // the shell) and keep resetting the form to the saved values under the person typing.
  const labelled = useRef(onLabel);
  labelled.current = onLabel;

  /**
   * Refetches the person, and resets only the form `sync` names. Each section saves on
   * its own, so a refresh after one must not overwrite what is half typed in another:
   * the details form (name, email) and the access control are separate drafts.
   */
  const load = useCallback(
    async (sync: readonly ("details" | "access")[] = ["details", "access"]) => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(await messageOf(res));
        const body = (await res.json()) as { user: AccessUser; passkeys: PasskeyRow[] };
        setData(body);
        setError(null);
        if (sync.includes("details")) {
          setName(body.user.name);
          setEmail(body.user.email);
        }
        if (sync.includes("access")) {
          setGrants(grantsOf(body.user));
          setRole(body.user.role);
        }
        labelled.current(body.user.name);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [url],
  );

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  const run = async (work: () => Promise<string>): Promise<boolean> => {
    setBusy(true);
    try {
      onNotice(await work());
      return true;
    } catch (e) {
      onNotice((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const send = async (path: string, method: "PATCH" | "DELETE", body?: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(await messageOf(res));
  };

  if (loading) return <Skeleton />;
  if (gate.kind !== "ok") return <Unavailable gate={gate as Exclude<AccessGate, { kind: "ok" }>} />;
  if (error && !data) {
    return (
      <div className={css.screen}>
        <EmptyState
          title="Could not load this editor"
          body={error}
          action={
            <Button size="sm" onClick={onBack}>
              Back to Access
            </Button>
          }
        />
      </div>
    );
  }
  if (!data) return <Skeleton />;

  const { user, passkeys } = data;
  const self = isSelf(user.id, gate.self.id);
  const many = showsGrants(me);
  const placedBy = grantsReason(user);
  const detailsChanged = name.trim() !== user.name || email.trim().toLowerCase() !== user.email;
  const nameBlank = name.trim() === "";
  const grantsProblem = grantsRefusal(grants);
  const sortedGrants = (g: Grants) =>
    JSON.stringify(Object.entries(g).sort(([a], [b]) => (a < b ? -1 : 1)));
  const grantsUnchanged = sortedGrants(grants) === sortedGrants(grantsOf(user));

  const saveDetails = async () => {
    const patch: { name?: string; email?: string } = {};
    if (name.trim() !== user.name) patch.name = name.trim();
    if (email.trim().toLowerCase() !== user.email) patch.email = email.trim();
    const ok = await run(async () => {
      await send("", "PATCH", patch);
      if (patch.name) onRenamed?.(user.id, patch.name);
      return patch.email
        ? `${patch.name ?? user.name} now signs in as ${patch.email.toLowerCase()}, and was signed out everywhere. Their passkeys are kept; to hand the account to a different person, also remove all passkeys.`
        : `${user.name} is now ${patch.name}.`;
    });
    if (ok) await load(["details"]);
  };

  const saveAccess = async () => {
    const ok = await run(async () => {
      await send("", "PATCH", many ? { grants } : { role });
      return `${user.name}’s access is updated. They will need to sign in again.`;
    });
    if (ok) await load(["access"]);
  };

  const removeAll = async () => {
    const ok = await run(async () => {
      await send("/passkeys", "DELETE");
      return `Removed every passkey for ${user.name}. Magic link or single sign-on still gets them in.`;
    });
    if (ok) await load([]);
  };

  const removeOne = async (row: PasskeyRow) => {
    const ok = await run(async () => {
      await send(`/passkeys/${encodeURIComponent(row.id)}`, "DELETE");
      return `Removed "${row.name}".`;
    });
    if (ok) await load([]);
  };

  const removeUser = async () => {
    const ok = await run(async () => {
      await send("", "DELETE");
      return `${user.name} no longer has access. Their edit history is untouched.`;
    });
    if (ok) onBack();
  };

  const passkeyColumns: Column<PasskeyRow>[] = [
    { key: "name", label: "Name", cell: (row) => <span className={css.name}>{row.name}</span> },
    {
      key: "created",
      label: "Added",
      cell: (row) => <span className={css.stamp}>{since(row.createdAt)}</span>,
    },
    {
      key: "used",
      label: "Last used",
      cell: (row) => <span className={css.stamp}>{since(row.lastUsedAt)}</span>,
    },
    {
      key: "synced",
      label: "Synced",
      cell: (row) => (row.backedUp ? <Badge>synced</Badge> : <span className={css.blank}>—</span>),
    },
    {
      key: "act",
      label: "Actions",
      cell: (row) => (
        <Button
          size="sm"
          variant="danger"
          disabled={busy}
          reason="A write is in flight"
          onClick={() => setRemovingOne(row)}
        >
          Remove
        </Button>
      ),
    },
  ];

  const noPasskeys = removePasskeysRefusal({ passkeys: passkeys.length });
  const roleReason = self ? SELF_ROLE_REASON : (placedBy ?? roleFromReason(user));

  return (
    <div className={`${css.screen} ${css.userPage}`}>
      <section className={css.section} aria-label="Details">
        <ListHeader>
          <span className={css.who}>
            <span
              className={css.dot}
              style={{ "--dot": user.colour ?? fallbackColour(user.id) } as CSSProperties}
            />
            {user.name}
            {self ? <Badge>you</Badge> : null}
          </span>
        </ListHeader>
        <form
          className={css.userForm}
          onSubmit={(e) => {
            e.preventDefault();
            if (detailsChanged && !nameBlank && !busy) void saveDetails();
          }}
        >
          <Field label="Name">
            {(fid) => (
              <Input
                id={fid}
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Email"
            help={
              self
                ? SELF_EMAIL_REASON
                : (placedBy ??
                  'The address they sign in with. Changing it signs them out everywhere but keeps their passkeys, so handing the account to a different person also needs "Remove all passkeys".')
            }
          >
            {(fid) => (
              <Input
                id={fid}
                type="email"
                value={email}
                maxLength={254}
                disabled={self || placedBy !== null}
                onChange={(e) => setEmail(e.target.value)}
              />
            )}
          </Field>
          <div className={css.userFormActions}>
            <Button
              variant="primary"
              type="submit"
              disabled={busy || !detailsChanged || nameBlank}
              reason={
                busy
                  ? "A write is in flight"
                  : nameBlank
                    ? "A name is required"
                    : "Nothing has changed"
              }
            >
              Save
            </Button>
          </div>
        </form>
        <p className={css.help}>
          {user.provider ? `Last signed in with ${user.provider}. ` : "Has not signed in yet. "}
          Last seen {since(user.lastSeenAt)}.
        </p>
      </section>

      <section className={css.section} aria-label="Access">
        <ListHeader>Access</ListHeader>
        {placedBy ? (
          <p className={css.help}>{placedBy}</p>
        ) : many ? (
          <GrantsEditor me={me} value={grants} onChange={setGrants} />
        ) : (
          <div className={css.userForm}>
            <Field label="Role" help={ROLE_MEANING[role]}>
              {(fid) => (
                <Select
                  id={fid}
                  value={role}
                  disabled={self}
                  title={self ? SELF_ROLE_REASON : undefined}
                  onChange={(e) => setRole(e.target.value as Role)}
                >
                  {ROLE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        )}
        {placedBy ? null : (
          <div className={css.userFormActions}>
            <Button
              variant="primary"
              disabled={
                busy ||
                self ||
                (many ? grantsProblem !== undefined || grantsUnchanged : role === user.role)
              }
              reason={
                roleReason ??
                (busy
                  ? "A write is in flight"
                  : many
                    ? (grantsProblem ?? "Nothing has changed")
                    : "Nothing has changed")
              }
              onClick={() => void saveAccess()}
            >
              Save access
            </Button>
          </div>
        )}
      </section>

      <section className={css.section} aria-label="Passkeys">
        <ListHeader
          actions={
            <Button
              size="sm"
              variant="danger"
              disabled={busy || noPasskeys !== undefined}
              reason={noPasskeys ?? "A write is in flight"}
              onClick={() => setRemovingAll(true)}
            >
              Remove all passkeys
            </Button>
          }
        >
          Passkeys
        </ListHeader>
        <Table
          label="Passkeys"
          columns={passkeyColumns}
          rows={passkeys}
          rowKey={(row) => row.id}
          empty={
            <EmptyState title="No passkeys" body="They sign in by magic link or single sign-on." />
          }
        />
      </section>

      <section className={css.section} aria-label="Remove">
        <ListHeader>Remove</ListHeader>
        <p className={css.help}>
          They lose access immediately and every session they hold is dropped. Their edit history
          stays.
        </p>
        <div className={css.userFormActions}>
          <Button
            variant="danger"
            disabled={busy || self}
            reason={self ? SELF_REMOVE_REASON : "A write is in flight"}
            onClick={() => setRemoving(true)}
          >
            Remove {user.name}
          </Button>
        </div>
      </section>

      {removing ? (
        <Dialog
          title={`Remove ${user.name}?`}
          description="They lose access immediately."
          danger
          onClose={() => setRemoving(false)}
          actions={
            <>
              <Button onClick={() => setRemoving(false)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setRemoving(false);
                  void removeUser();
                }}
              >
                Remove
              </Button>
            </>
          }
        >
          <p className={css.dialogNote}>
            <code className={css.inlineCode}>{user.email}</code> can no longer sign in, and every
            session they hold is dropped.
          </p>
          <p className={css.dialogNote}>
            Their edit history stays. Version rows record who made a change as a string, not as a
            link to an account, so removing somebody never rewrites the record of what they did.
          </p>
        </Dialog>
      ) : null}

      {removingAll ? (
        <Dialog
          title={`Remove every passkey for ${user.name}?`}
          description="For a lost or stolen device. They keep whatever other way they have in."
          danger
          onClose={() => setRemovingAll(false)}
          actions={
            <>
              <Button onClick={() => setRemovingAll(false)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setRemovingAll(false);
                  void removeAll();
                }}
              >
                Remove all passkeys
              </Button>
            </>
          }
        >
          <p className={css.dialogNote}>
            Anything signed in with a passkey stops working on its next request. Magic link or
            single sign-on still gets them in.
          </p>
        </Dialog>
      ) : null}

      {removingOne ? (
        <Dialog
          title={`Remove the passkey "${removingOne.name}"?`}
          description="The device it lives on can no longer sign in with it."
          danger
          onClose={() => setRemovingOne(null)}
          actions={
            <>
              <Button onClick={() => setRemovingOne(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  const row = removingOne;
                  setRemovingOne(null);
                  void removeOne(row);
                }}
              >
                Remove
              </Button>
            </>
          }
        >
          <p className={css.dialogNote}>Their other passkeys and any other way in are untouched.</p>
        </Dialog>
      ) : null}
    </div>
  );
}

function Skeleton() {
  return (
    <div className={css.screen} aria-hidden="true">
      <div className={css.skeletons}>
        {["a", "b", "c", "d"].map((key) => (
          <div className={css.skeleton} key={key} />
        ))}
      </div>
    </div>
  );
}
