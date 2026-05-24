/**
 * Dialog — the one shared modal primitive for the whole app.
 *
 * Apple UIAlertController-style: a single component renders every
 * modal surface (warnings, confirmations, future picker prompts).
 * Variation is by props — icon tone, title, body, action stack.
 * No bespoke modals anywhere else in the tree.
 *
 * Visual: cream theme. Backdrop is a warm espresso dim, card is the
 * cream page bg with a hairline tan border, primary action filled
 * espresso. Matches the App.canvas surface, not the legacy slate.
 *
 * Dismiss behavior:
 *   - If `onDismiss` is provided, backdrop tap + Escape both dismiss.
 *   - If `onDismiss` is omitted, the dialog is blocking (user must
 *     resolve via an action button).
 *
 * Rendered via portal to document.body so z-index stacks correctly
 * regardless of where the caller mounts it.
 */

import { useEffect, useId, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

import "./Dialog.css";

export type DialogIcon = "warning" | "question";

export type DialogActionKind = "primary" | "secondary" | "destructive";

export interface DialogAction {
  label: string;
  kind: DialogActionKind;
  onPress: () => void;
}

export interface DialogProps {
  /** Whether the dialog is currently mounted + visible. */
  open: boolean;
  /** Optional ring-icon above the title. */
  icon?: DialogIcon;
  /** The big headline. Plain English, no jargon. */
  title: string;
  /** Optional supporting copy under the title. */
  body?: ReactNode;
  /** Stack of action buttons. Render order = visual order, top to bottom. */
  actions: DialogAction[];
  /**
   * Called on backdrop tap + Escape. Omit to make the dialog blocking
   * (no silent dismiss — user must pick an action).
   */
  onDismiss?: () => void;
}

export function Dialog({
  open,
  icon,
  title,
  body,
  actions,
  onDismiss,
}: DialogProps): ReactElement | null {
  // Per-instance ID so aria-labelledby stays valid if two dialogs ever
  // mount simultaneously (rare in this app, but the cost is zero and
  // the correctness gain is unambiguous).
  const titleId = useId();

  useEffect(() => {
    if (!open || onDismiss === undefined) return undefined;
    function handleKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onDismiss?.();
    }
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
    };
  }, [open, onDismiss]);

  if (!open) return null;

  const dismissable = onDismiss !== undefined;

  return createPortal(
    <div
      className="dialog__backdrop"
      onClick={dismissable ? onDismiss : undefined}
    >
      <div
        className="dialog__card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        {icon !== undefined ? (
          <div className="dialog__indicator" aria-hidden="true">
            <div className={`dialog__icon dialog__icon--${icon}`}>
              {icon === "warning" ? "!" : "?"}
            </div>
          </div>
        ) : null}
        <h2 id={titleId} className="dialog__title">
          {title}
        </h2>
        {body !== undefined && body !== null ? (
          <div className="dialog__body">{body}</div>
        ) : null}
        <div className="dialog__actions">
          {actions.map((action, i) => (
            <button
              key={i}
              type="button"
              className={`dialog__action dialog__action--${action.kind}`}
              onClick={action.onPress}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
