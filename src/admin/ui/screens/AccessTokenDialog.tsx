import { useState } from 'react'
import type { Scope } from '../../../server/auth/roles'
import { Badge } from '../Badge'
import { Button } from '../Button'
import { Dialog } from '../Dialog'
import { Field, Input, Select } from '../Field'
import css from './Access.module.css'
import {
  CUSTOM_PRESET,
  DEFAULT_PRESET,
  EXPIRY_OPTIONS,
  SCOPE_MEANING,
  SCOPE_OPTIONS,
  TOKEN_PRESETS,
  expiryDays,
  grantedBy,
  mintRefusal,
  presetOf,
  scopesOfPreset,
  toggleScope,
} from './access-model'

/** What `POST {base}/api/tokens` answers, and the only response in the whole
 * server that carries a credential in the clear. */
export interface Minted {
  name: string
  token: string
}

/**
 * Minting an API token, and the screen's one real design task:
 * **`docs/ui-architecture.md` asks for scope selection to become a real control
 * instead of six 11px checkboxes in two ragged columns.**
 *
 * The answer is a two-layer control, and the layering is the decision rather than
 * the styling:
 *
 * 1. **Five named presets, as a radio group.** A person minting a token is thinking
 *    "an import script", not "content:write plus assets:write" — so the primary
 *    control is a list of the shapes of access that actually exist, each naming the
 *    kind of caller it is for. `access-model.ts`'s `TOKEN_PRESETS` holds them, and
 *    each shows the scopes it grants as mono badges, so the preset *teaches* the
 *    vocabulary rather than hiding it.
 * 2. **The individual scopes behind a disclosure**, each labelled with what it
 *    permits and carrying its identifier as a mono badge beside it. A preset that
 *    cannot be departed from is a cage, and opening the disclosure moves the radio
 *    group to *Custom* rather than fighting it.
 *
 * The part neither layer of the old control could express, and the reason it was
 * worse than merely cramped: **implication**. `content:write` already grants
 * `content:read` and `content:read:draft` (`auth/roles.ts`'s `IMPLIES`), so six
 * independent boxes let a person tick three to mean one thing, and left three
 * *unticked* boxes describing permissions the token would have anyway. Here a scope
 * something else grants renders as granted, disabled, and naming what grants it.
 *
 * **Rejected: six checkboxes, restyled.** The cheapest fix, and it keeps every
 * fault except the font size — no meanings, no implication, and `content:read:draft`
 * still as its own label.
 *
 * **Rejected: presets only, no escape.** Half the size and it reads beautifully
 * until somebody needs `assets:write` alone, which is a real shape (an upload-only
 * media worker) and not one of five presets. A closed set of presets over an open
 * set of scopes is a control that will be wrong the first time the scope list grows.
 *
 * **Rejected: a role-style single `<select>`**, treating scopes as a total order the
 * way roles are. Tempting, because `atLeast` makes roles exactly that — but scopes
 * are deliberately *not* a chain, and `auth/roles.ts` says so in as many words:
 * `publish` implies reading the draft it is about to publish and says nothing about
 * writing one, and `assets:write` implies nothing about content at all. A single
 * select would have to invent an ordering the permission model refuses to have.
 */
export function AccessTokenDialog({
  onClose,
  onMint,
}: {
  onClose: () => void
  onMint: (body: { name: string; scopes: Scope[]; expiresInDays?: number }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<Scope[]>(() => [...(scopesOfPreset(DEFAULT_PRESET) ?? [])])
  const [expiry, setExpiry] = useState('')
  const [pending, setPending] = useState(false)

  // Derived, never stored. Holding the chosen preset in its own state is how the
  // radio group and the checkboxes get to disagree: tick a box and the stored preset
  // would still say `read` while the scopes say otherwise.
  const preset = presetOf(scopes)
  const refusal = mintRefusal(name, scopes)
  const days = expiryDays(expiry)

  const submit = async () => {
    if (refusal) return
    setPending(true)
    try {
      await onMint({
        name: name.trim(),
        scopes,
        ...(days === undefined ? {} : { expiresInDays: days }),
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      title="New API token"
      description="Shown once, when it is created. Only its hash is stored."
      size="wide"
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={pending || refusal !== undefined}
            reason={pending ? 'Creating…' : refusal}
            onClick={() => void submit()}
          >
            Create token
          </Button>
        </>
      }
    >
      <div className={css.form}>
        <Field
          label="Name"
          help="What holds this token. It is what the activity trail records, as token:name."
          required
        >
          {(id) => (
            <Input
              id={id}
              value={name}
              placeholder="import-script"
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>

        {/* A group of related controls is a `<fieldset>` with a visually hidden
            `<legend>` rather than `role="group"` plus `aria-label` — Biome's
            `useSemanticElements`, and the reset a bare fieldset needs is in
            `Access.module.css` with the reason it is not optional. The legend is
            hidden because the visible "What it may do" heading above says the same
            thing; two names for one group is noise. */}
        <fieldset className={css.presets}>
          <legend className={css.srOnly}>What this token may do</legend>
          <p className={css.groupLabel}>What it may do</p>
          {TOKEN_PRESETS.map((option) => (
            <label
              key={option.id}
              className={`${css.preset} ${preset === option.id ? css.presetOn : ''} ${
                option.danger ? css.presetDanger : ''
              }`}
            >
              <input
                type="radio"
                name="token-preset"
                value={option.id}
                checked={preset === option.id}
                onChange={() => setScopes([...option.scopes])}
              />
              <span className={css.presetBody}>
                <span className={css.presetLabel}>{option.label}</span>
                <span className={css.presetNote}>{option.description}</span>
                <span className={css.presetScopes}>
                  {option.scopes.map((scope) => (
                    <Badge key={scope} mono tone={option.danger ? 'danger' : 'neutral'}>
                      {scope}
                    </Badge>
                  ))}
                </span>
              </span>
            </label>
          ))}
          {/*
            `Custom` is not a sixth radio anybody clicks — there is nothing for it to
            select — so it is a *state* the group reports when the scopes below no
            longer match a preset. Rendering it as a disabled radio would be a
            control that cannot act, which `## Cross-cutting` says should be absent.
          */}
          {preset === CUSTOM_PRESET ? (
            <p className={css.presetCustom}>
              <b>Custom</b> — the scopes below do not match a preset.
            </p>
          ) : null}
        </fieldset>

        {/* A real `<details>`: the disclosure is native, needs no state, and its
            summary is focusable and announced as expandable without a line of
            ARIA. */}
        <details className={css.scopeDetails}>
          <summary className={css.scopeSummary}>Choose individual permissions</summary>
          <fieldset className={css.scopes}>
            <legend className={css.srOnly}>Individual permissions</legend>
            {SCOPE_OPTIONS.map((scope) => {
              const via = grantedBy(scope, scopes)
              const held = scopes.includes(scope)
              return (
                <label key={scope} className={`${css.scope} ${via ? css.scopeImplied : ''}`}>
                  <input
                    type="checkbox"
                    checked={held || via !== null}
                    // Disabled with a reason rather than clickable-and-ignored:
                    // unticking a scope another selection grants would be asking for
                    // a token that cannot exist.
                    disabled={via !== null}
                    onChange={() => setScopes(toggleScope(scopes, scope))}
                  />
                  <span className={css.scopeBody}>
                    <span className={css.scopeLabel}>
                      {SCOPE_MEANING[scope].label}
                      <Badge mono tone={scope === 'admin' ? 'danger' : 'neutral'}>
                        {scope}
                      </Badge>
                    </span>
                    <span className={css.scopeNote}>
                      {via ? `Already granted by ${via}.` : SCOPE_MEANING[scope].description}
                    </span>
                  </span>
                </label>
              )
            })}
          </fieldset>
        </details>

        <Field label="Expires" help="A token with no expiry works until somebody revokes it.">
          {(id) => (
            <Select id={id} value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              {EXPIRY_OPTIONS.map((option) => (
                <option key={option.value || 'never'} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
    </Dialog>
  )
}

/**
 * The minted token, in the clear, exactly once.
 *
 * There is nothing to read it back from: `createToken` stores `hashToken(token)` as
 * the row's primary key and the plaintext exists only in the response that created
 * it (`auth/secrets.ts` — every credential in this feature is 32 bytes handed out
 * once and kept as a SHA-256). `examples/demo/seed.sql` makes the same point from
 * the other side, where a fixed known-fake hash is seeded because there is no way to
 * seed a *token*.
 *
 * So this is a second dialog rather than a line appended to the first: dismissing it
 * is the destructive act, and a person needs to understand that before they do it
 * rather than discover it afterwards. The old rail's version sat in the page until
 * dismissed, which meant a credential on a shared monitor for as long as nobody
 * scrolled.
 */
export function MintedTokenDialog({ minted, onClose }: { minted: Minted; onClose: () => void }) {
  const [copied, setCopied] = useState(false)

  const copy = () => {
    // Guarded: `navigator.clipboard` is absent over plain HTTP on anything but
    // localhost, and a Copy button that throws is worse than one that says it could
    // not — the value is on screen and selectable either way.
    navigator.clipboard
      ?.writeText(minted.token)
      .then(() => setCopied(true))
      .catch(() => setCopied(false))
  }

  return (
    <Dialog
      title="Copy this token now"
      description="This is the only time it is shown."
      size="wide"
      onClose={onClose}
      actions={
        <>
          <Button onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <p className={css.dialogNote}>
        <b>{minted.name}</b> is ready to use as{' '}
        <code className={css.inlineCode}>Authorization: Bearer …</code>. Only its SHA-256 is stored,
        so closing this is the last chance to copy it — mint a new one if it is lost.
      </p>
      {/* Selectable and wrapping, because the fallback when clipboard access is
          unavailable is a person selecting it by hand, and a 71-character secret
          truncated to one line cannot be selected in full. */}
      <code className={css.secret}>{minted.token}</code>
    </Dialog>
  )
}
