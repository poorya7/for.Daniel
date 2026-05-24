/**
 * Expanded queue list — bottom-sheet overlay (plan §8.2).
 *
 * Mounted by the parent in response to a pill tap. Lists each pending
 * capture as a single line: source icon, one-line title, state chip,
 * per-item action.
 *
 * Per-state action vocabulary (mirrors plan §8.2 verbs):
 *
 *   pending_extraction / pending_save / failed_transient
 *       → "Discard" (with confirm-on-tap-out via the sheet click
 *          intercept; the actual confirm is the user's deliberate tap).
 *
 *   syncing
 *       → "Discard" rendered DISABLED. Window is ≤500ms (plan §9.9);
 *          re-enables when the drainer transitions the record out of
 *          `syncing`. Disabling prevents the "I tapped discard but the
 *          row showed up anyway" mental-model break, without us having
 *          to build delete-row-from-Sheets in v1.
 *
 *   failed_auth
 *       → "Sign in" — same handler as the pill's sibling CTA. Surfaced
 *          per-row so the user knows WHICH rows are blocked, not just
 *          that some are.
 *
 *   failed_permanent
 *       → Two options: "Save to different sheet" (parent-owned wire;
 *          requires the currently-connected sheet) and "Discard". The
 *          first one is rendered only if the parent passes a handler —
 *          callers without a "current sheet" concept can omit it.
 *
 * Privacy: the title is the extracted name when we have one (the user
 * already saw it on their own screen during review) or a generic
 * "Photo · 2:14 PM" / "Voice memo · 2:14 PM" / "Note · 2:14 PM" for
 * raw-input items the drainer hasn't extracted yet. No leaking of
 * partial extraction text into the list.
 */

import { useCallback, useEffect } from "react";

import "./QueueListSheet.css";

import type {
  QueueRecord,
  QueueSource,
  QueueState,
} from "@/lib/queue/types";

export interface QueueListSheetProps {
  /**
   * The current queue, FIFO-ordered (oldest first). Typically passed
   * down from `useLiveRecords()` at the App level so the parent can
   * decide whether to mount this sheet at all.
   */
  records: ReadonlyArray<QueueRecord>;
  /**
   * Close the sheet — parent unmounts in response. Triggered by the
   * close button, the backdrop tap, and the Escape key.
   */
  onClose: () => void;
  /** Per-item discard. Errors are caller's to surface. */
  onDiscard: (id: string) => void;
  /**
   * Triggered by a per-row "Sign in" tap when the row is
   * `failed_auth`. Same handler as the pill's sibling CTA — the
   * parent typically wires both to the auth flow.
   */
  onSignIn: () => void;
  /**
   * Optional. If supplied, `failed_permanent` rows render a "Save to
   * different sheet" option (plan §8.2) wired to this callback. The
   * callback receives the offending record so the parent can re-target
   * its `sheet_target` and re-enqueue it. Omitted-by-default keeps
   * this component usable from contexts that don't have a "current
   * sheet" concept (tests, docs).
   */
  onSaveToDifferentSheet?: (record: QueueRecord) => void;
}

export function QueueListSheet({
  records,
  onClose,
  onDiscard,
  onSignIn,
  onSaveToDifferentSheet,
}: QueueListSheetProps): React.ReactElement {
  // Escape-to-close. Keyboard accessibility plus the muscle memory
  // that "Esc dismisses overlays" is universal enough that not
  // supporting it would feel broken.
  useEffect(() => {
    function handleKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // Backdrop click closes; clicks inside the sheet content do not
  // bubble out. `useCallback` so the click handler reference is
  // stable across re-renders (some downstream a11y tools complain
  // otherwise).
  const stop = useCallback((event: React.MouseEvent): void => {
    event.stopPropagation();
  }, []);

  return (
    <div
      className="queue-list-sheet-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <section
        className="queue-list-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Waiting to save"
        onClick={stop}
      >
        <header className="queue-list-sheet__header">
          <h2 className="queue-list-sheet__title">Waiting to save</h2>
          <button
            type="button"
            className="queue-list-sheet__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        {records.length === 0 ? (
          <p className="queue-list-sheet__empty">Nothing in the queue.</p>
        ) : (
          <ul className="queue-list-sheet__list" role="list">
            {records.map((record) => (
              <QueueListRow
                key={record.id}
                record={record}
                onDiscard={onDiscard}
                onSignIn={onSignIn}
                onSaveToDifferentSheet={onSaveToDifferentSheet}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

interface QueueListRowProps {
  record: QueueRecord;
  onDiscard: (id: string) => void;
  onSignIn: () => void;
  onSaveToDifferentSheet: ((record: QueueRecord) => void) | undefined;
}

function QueueListRow({
  record,
  onDiscard,
  onSignIn,
  onSaveToDifferentSheet,
}: QueueListRowProps): React.ReactElement {
  const title = formatTitle(record);
  const chip = formatStateChip(record.state);
  const discardDisabled = record.state === "syncing";

  return (
    <li className="queue-row" data-state={record.state}>
      <span className="queue-row__icon" aria-hidden="true">
        {sourceIcon(record.source)}
      </span>
      <span className="queue-row__title">{title}</span>
      <span
        className="queue-row__chip"
        data-chip={chip.tone}
      >
        {chip.label}
      </span>
      <span className="queue-row__actions">
        {record.state === "failed_auth" && (
          <button
            type="button"
            className="queue-row__btn queue-row__btn--primary"
            onClick={onSignIn}
          >
            Sign in
          </button>
        )}
        {record.state === "failed_permanent"
          && onSaveToDifferentSheet !== undefined && (
            <button
              type="button"
              className="queue-row__btn"
              onClick={() => {
                onSaveToDifferentSheet(record);
              }}
            >
              Save to different sheet
            </button>
          )}
        <button
          type="button"
          className="queue-row__btn queue-row__btn--quiet"
          onClick={() => {
            onDiscard(record.id);
          }}
          disabled={discardDisabled}
          aria-label={
            discardDisabled
              ? "Discard (disabled while saving)"
              : "Discard"
          }
          title={
            discardDisabled
              ? "Hold on — this one is saving right now."
              : undefined
          }
        >
          Discard
        </button>
      </span>
    </li>
  );
}

/**
 * One-line label for the row. Uses the extracted name when we have
 * one (we already showed it to the user during review); otherwise
 * falls back to a generic time-stamped label so we don't leak partial
 * extraction strings into the list.
 */
function formatTitle(record: QueueRecord): string {
  const name = record.extracted?.fields.name?.value?.trim();
  if (name) return name;
  const time = formatTime(record.created_at);
  switch (record.source) {
    case "photo":
      return `Photo · ${time}`;
    case "voice":
      return `Voice memo · ${time}`;
    case "text":
      return `Note · ${time}`;
  }
}

function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  // 12-hour, no leading zero on the hour. Locale-default minutes
  // keeps it consistent with the user's phone settings.
  return d.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

interface ChipShape {
  label: string;
  tone: "info" | "active" | "warn" | "danger";
}

function formatStateChip(state: QueueState): ChipShape {
  switch (state) {
    case "pending_extraction":
    case "pending_save":
      return { label: "Waiting", tone: "info" };
    case "syncing":
      return { label: "Saving…", tone: "active" };
    case "failed_transient":
      return { label: "Retrying", tone: "info" };
    case "failed_auth":
      return { label: "Sign in", tone: "warn" };
    case "failed_permanent":
      return { label: "Needs review", tone: "danger" };
  }
}

function sourceIcon(source: QueueSource): React.ReactElement {
  // Mirrors HomeScreen's mode glyphs but at 16px. Inline so we
  // don't ship an icon library for four tiny shapes.
  switch (source) {
    case "photo":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
          <circle cx="12" cy="13" r="3" />
        </svg>
      );
    case "voice":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="22" />
        </svg>
      );
    case "text":
      return (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
      );
  }
}
