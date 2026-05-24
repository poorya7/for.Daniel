/**
 * PhotoSummaryCard — the multi-row review surface for the photo path.
 *
 * Renders the rows extracted from a captured photo as a calm
 * sanity-check list the user can scan in seconds, with a single
 * "Save all" CTA.
 *
 * Visual vocabulary lifted from the existing review + input surfaces
 * (zero new fonts / button shapes / colour tokens):
 *   - heading uses the same eyebrow + cyan-body stack as the
 *     single-row review card's "EXTRACTED" / name pattern
 *   - row list reuses `.review-fields` + `.review-row`
 *   - Save All = `.primary-action` (same cyan gradient)
 *   - Retake = soft-tinted twin of the primary (same shape, lower
 *     ink) so the user reads it as a button without competing with
 *     Save for the tap
 *   - Discard = `.link-action`
 *
 * Only the per-row indicator dots are new declarations — they reuse
 * the colour recipes from `.outcome__check` and
 * `.review-confidence--check`.
 *
 * Locked rules from the plan:
 *   - Green ✓ for HIGH-confidence rows; calm amber ! for MEDIUM / LOW.
 *     No red — confidence is not failure.
 *   - Row count summary at the top so the user sanity-checks against
 *     the paper sheet still in her hand.
 *   - Retake affordance always reachable.
 *   - Save all N is the dominant action.
 *   - No delete-row button (all-blank rows are no-ops at save time).
 *
 * Per-row edit surface (tap a row → slide to edit) lands in M4.
 * Batch save endpoint + per-row idempotency keys land in M5.
 */

import type { PhotoRow } from "@/lib/api";

import "./PhotoSummaryCard.css";

interface PhotoSummaryCardProps {
  rows: PhotoRow[];
  /** Total reported by the terminal `photo_done` — used by future
   *  drop-detection code; currently we render `rows.length`. */
  totalRows: number;
  /** True while the per-row save loop is in flight. Disables the
   *  primary action so a double-tap can't fire a second batch. */
  saving: boolean;
  /** Plain-English error from the most recent save attempt, or null. */
  saveError: string | null;
  /** Retake — bounces back into the photo capture surface. */
  onRetake: () => void;
  /** Save the full batch of rows to the connected sheet. */
  onSaveAll: () => void;
  /** Tap any row → opens the per-row edit surface (M4). */
  onTapRow: (index: number) => void;
  /** Discard — closes the sheet without saving (parallel to
   *  ReviewCard's "Discard" link). */
  onDiscard: () => void;
  /**
   * Remove the row at this index from the batch. Optional — when
   * supplied each row renders a small "X" affordance on its right
   * edge for hard-deleting junk rows (header lines, doodles, false
   * positives) before saving. When omitted (the legacy app uses this
   * shape), no X renders and the user must blank out the fields to
   * skip a row instead.
   */
  onRemoveRow?: (index: number) => void;
}

export function PhotoSummaryCard({
  rows,
  totalRows,
  saving,
  saveError,
  onRetake,
  onSaveAll,
  onTapRow,
  onDiscard,
  onRemoveRow,
}: PhotoSummaryCardProps): React.ReactElement {
  void totalRows;
  const goodCount = rows.filter((r) => r.row_confidence === "high").length;
  const needsLookCount = rows.length - goodCount;
  const noun = rows.length === 1 ? "lead" : "leads";

  return (
    <div className="review-card photo-summary">
      <h2 className="photo-summary__title">
        <span className="capture-heading__eyebrow-stack">
          <span className="capture-heading__eyebrow capture-heading__eyebrow--current">
            EXTRACTED
          </span>
        </span>
        <span className="capture-heading__body-stack">
          <span className="capture-heading__inner capture-heading__inner--current">
            <span className="capture-heading__name photo-summary__title-body">
              <span className="photo-summary__title-count">
                {String(rows.length)}
              </span>{" "}
              <span className="photo-summary__title-noun">{noun}</span>
            </span>
          </span>
        </span>
      </h2>

      {rows.length > 0 && (
        <p className="photo-summary__sanity" aria-live="polite">
          {_renderSanity(goodCount, needsLookCount)}
        </p>
      )}

      <div className="review-fields photo-summary__rows" role="list">
        {rows.map((row, index) => {
          const variant =
            row.row_confidence === "high" ? "good" : "needs-look";
          const rowName =
            row.fields.name.value?.trim() || "(no name)";
          /* Two buttons inside the row container — the main strip
             opens the per-row edit surface (tap-to-edit) and the
             trailing X removes the row from the batch. They cannot
             nest because <button> inside <button> is invalid; the
             row container is a plain <div> with role="listitem". */
          return (
            <div
              key={row.idempotency_key}
              role="listitem"
              className={`review-row photo-summary__row photo-summary__row--${variant}`}
              data-has-remove={onRemoveRow ? "true" : "false"}
            >
              <button
                type="button"
                className="photo-summary__row-edit"
                onClick={() => {
                  onTapRow(index);
                }}
                disabled={saving}
                aria-label={`Edit ${rowName}`}
              >
                <span
                  aria-hidden="true"
                  className="photo-summary__row-indicator-slot"
                >
                  <span
                    className={`photo-summary__indicator photo-summary__indicator--${variant}`}
                  >
                    {variant === "good" ? "✓" : "!"}
                  </span>
                </span>
                <span className="photo-summary__row-body">
                  <span className="photo-summary__row-name">{rowName}</span>
                  <span className="photo-summary__row-contact">
                    {_renderContact(
                      row.fields.phone.value,
                      row.fields.email.value,
                    )}
                  </span>
                </span>
              </button>
              {onRemoveRow ? (
                <button
                  type="button"
                  className="photo-summary__row-remove"
                  onClick={() => {
                    onRemoveRow(index);
                  }}
                  disabled={saving}
                  aria-label={`Remove ${rowName}`}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <line x1="6" y1="6" x2="18" y2="18" />
                    <line x1="6" y1="18" x2="18" y2="6" />
                  </svg>
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {saveError && (
        // Same pill shape, colour family, and structural placement
        // the rest of the app uses for transient state messages
        // (see `.capture-offline-pill` in CaptureSheet.css —
        // shared visual language across InputPhase, VoicePhase,
        // and ReviewCard). One consistent error vocabulary
        // instead of a bespoke save-error widget. The
        // `--problem` modifier swaps the wifi-slash glyph for a
        // small alert-triangle since this isn't necessarily an
        // offline state.
        <div className="photo-summary__error-row">
          <span
            className="capture-offline-pill capture-offline-pill--problem"
            role="alert"
            aria-live="polite"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            {saveError}
          </span>
        </div>
      )}

      <button
        type="button"
        className="primary-action"
        onClick={onSaveAll}
        disabled={saving || rows.length === 0}
      >
        {saving
          ? _savingLabel(rows.length)
          : _saveAllLabel(rows.length)}
      </button>

      <button
        type="button"
        className="photo-summary__retake"
        onClick={onRetake}
        disabled={saving}
      >
        Retake photo
      </button>

      <button
        type="button"
        className="link-action"
        onClick={onDiscard}
        disabled={saving}
      >
        Discard
      </button>
    </div>
  );
}

/**
 * Render the sanity-check line under the title with the row counts
 * accented in the same tokens as the per-row indicators — sage for
 * good, amber for needs-look. Mirrors the title's accent pattern
 * (where the row count is cyan) so the user's eye lands on the
 * numeric counts at a glance.
 */
function _renderSanity(
  goodCount: number,
  needsLookCount: number,
): React.ReactNode {
  if (goodCount === 0 && needsLookCount === 0) return null;
  const goodPart =
    goodCount > 0 ? (
      <>
        <span className="photo-summary__sanity-good">
          {String(goodCount)}
        </span>
        {goodCount === 1 ? " looks good" : " look good"}
      </>
    ) : null;
  const needsPart =
    needsLookCount > 0 ? (
      <>
        <span className="photo-summary__sanity-warn">
          {String(needsLookCount)}
        </span>
        {needsLookCount === 1
          ? " needs a quick look"
          : " need a quick look"}
      </>
    ) : null;
  if (goodPart && needsPart) {
    return (
      <>
        {goodPart}
        {" · "}
        {needsPart}
      </>
    );
  }
  return goodPart ?? needsPart;
}

function _renderContact(
  phone: string | null,
  email: string | null,
): string {
  const phonePart = phone?.trim() || null;
  const emailPart = email?.trim() || null;
  if (phonePart && emailPart) return `${phonePart} · ${emailPart}`;
  if (phonePart) return `${phonePart} · (no email)`;
  if (emailPart) return `(no phone) · ${emailPart}`;
  return "(no contact details)";
}

function _saveAllLabel(rowsLength: number): string {
  if (rowsLength === 1) return "Save to sheet";
  return `Save all ${String(rowsLength)} to sheet`;
}

function _savingLabel(rowsLength: number): string {
  if (rowsLength === 1) return "Saving…";
  return `Saving ${String(rowsLength)} leads…`;
}
