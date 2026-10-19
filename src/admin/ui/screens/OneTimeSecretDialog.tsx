import { useState } from "react";
import { Button } from "../Button";
import { Dialog } from "../Dialog";
import css from "./Access.module.css";

/**
 * A credential shown in the clear, exactly once, with a Copy button.
 *
 * Two screens hand somebody a secret the server cannot hand back: an API token on
 * the Access screen and a share link in the editor. Both store only a hash, and the
 * response that created them is the only place the plaintext ever exists, so both
 * need the same treatment — a dialog of its own rather than a line appended to the
 * form, because dismissing it is the destructive act and a person should understand
 * that before they do it. (`platform/draft-sharing.md`'s "No admin UI" note asks for
 * one component to serve both; this is it.)
 *
 * `children` is the explanation specific to what was made, rendered above the value.
 */
export function OneTimeSecretDialog({
  title,
  description = "This is the only time it is shown.",
  secret,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  secret: string;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    // Guarded: `navigator.clipboard` is absent over plain HTTP on anything but
    // localhost, and a Copy button that throws is worse than one that says it could
    // not — the value is on screen and selectable either way.
    navigator.clipboard
      ?.writeText(secret)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <Dialog
      title={title}
      description={description}
      size="wide"
      onClose={onClose}
      actions={
        <>
          <Button onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      {children}
      {/* Selectable and wrapping, because the fallback when clipboard access is
          unavailable is a person selecting it by hand, and a 71-character secret
          truncated to one line cannot be selected in full. */}
      <code className={css.secret}>{secret}</code>
    </Dialog>
  );
}
