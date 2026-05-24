/**
 * Mapping confirmation screen — the "We found these columns. Do these
 * look right?" moment that lands between Picker selection and the first
 * save (per v1 sketch §4).
 *
 * Three rendered states, picked from `proposal.kind`:
 *
 *   - `has_headers`     The sheet has clean headers; render the
 *                       app-field → sheet-column pairs and let the user
 *                       confirm or fix any wrong guesses. Each pair is
 *                       tappable — that's the "Fix one" pattern from
 *                       spec §4 (tap-to-fix-with-5-guesses).
 *   - `empty`           Sheet's row 1 is blank. We *will* set up headers
 *                       automatically in the next slice; for now we say
 *                       so and offer to pick a different sheet.
 *   - `looks_like_data` Row 1 has phone/email/long-blob shaped values.
 *                       Spec §4 explicitly forbids auto-overwriting in
 *                       this case — same defer copy as empty.
 *
 * Edit semantics:
 *   - Tapping a row expands an inline picker showing every header in
 *     the sheet plus a "Don't map this column" option. Picking an
 *     alternative updates a *local* copy of the mapping; the original
 *     proposal stays untouched until the user taps "Yes, use these".
 *   - Claim-once invariant: picking header H for field A unclaims H
 *     from any other field that previously held it. Without this you
 *     could end up with two fields trying to write into the same column.
 *   - `unmapped_headers` is recomputed on every edit so the row that
 *     reads "Other columns in your sheet (...)" stays in sync.
 */

import { useMemo, useState } from "react";

import type { ColumnMapping, LeadFieldKey, MappingProposal } from "@/lib/api";

const FIELD_LABELS: Record<LeadFieldKey, string> = {
  name: "Name",
  phone: "Phone",
  email: "Email",
  has_agent: "Has agent?",
  intent: "Intent",
  timeline: "Timeline",
  financing_status: "Financing",
  budget: "Budget",
  area: "Area",
  follow_up: "Follow up",
  notes: "Notes",
};

// Renders in the order a 75-year-old broker scans a row — name first,
// phone second, then the rest. Mirrors the review card's 3-page
// layout so the screens feel the same.
const FIELD_ORDER: LeadFieldKey[] = [
  "name",
  "phone",
  "email",
  "has_agent",
  "intent",
  "timeline",
  "financing_status",
  "budget",
  "area",
  "follow_up",
  "notes",
];

interface MappingConfirmationProps {
  proposal: MappingProposal;
  /** Sheet display name — surfaces in the heading so the user sees what they picked. */
  sheetName: string;
  /**
   * User accepted the (possibly edited) mapping — proceed with the save.
   * Receives the current `ColumnMapping`, which may differ from
   * `proposal.mapping` if the user used "Fix one" to override anything.
   */
  onConfirm: (mapping: ColumnMapping) => void;
  /** User wants to pick a different sheet — re-runs the Picker. */
  onPickAnother: () => void;
}

export function MappingConfirmation({
  proposal,
  sheetName,
  onConfirm,
  onPickAnother,
}: MappingConfirmationProps): React.ReactElement {
  if (proposal.kind === "has_headers" && proposal.mapping !== null) {
    return (
      <HasHeadersView
        proposal={proposal}
        initialMapping={proposal.mapping}
        sheetName={sheetName}
        onConfirm={onConfirm}
        onPickAnother={onPickAnother}
      />
    );
  }
  if (proposal.kind === "empty") {
    return (
      <DeferView
        sheetName={sheetName}
        title="This sheet doesn’t have any headers yet."
        body="We can set them up for you in the next update. For now, pick a sheet that already has a Name / Phone / Email row at the top."
        onPickAnother={onPickAnother}
      />
    );
  }
  // looks_like_data — show the user what we saw so they understand why
  // we're not auto-overwriting.
  return (
    <DeferView
      sheetName={sheetName}
      title="This sheet has data but no header row."
      body="We don’t want to overwrite what’s already there. Add a header row at the top of your sheet (Name, Phone, Email…), or pick a different sheet."
      previewRow={proposal.headers}
      onPickAnother={onPickAnother}
    />
  );
}

// --- has_headers ----------------------------------------------------------

interface HasHeadersViewProps {
  proposal: MappingProposal;
  initialMapping: NonNullable<MappingProposal["mapping"]>;
  sheetName: string;
  onConfirm: (mapping: ColumnMapping) => void;
  onPickAnother: () => void;
}

function HasHeadersView({
  proposal,
  initialMapping,
  sheetName,
  onConfirm,
  onPickAnother,
}: HasHeadersViewProps): React.ReactElement {
  // Local editable copy — independent from `proposal.mapping` so the
  // user can revise repeatedly without losing the original auto-guess.
  // Holds just the `fields` map; `unmapped_headers` is derived from it
  // (see `derivedUnmapped` below) so it can never drift out of sync.
  const [fields, setFields] = useState<Record<LeadFieldKey, string | null>>(
    () => ({ ...initialMapping.fields }),
  );
  const [fixingField, setFixingField] = useState<LeadFieldKey | null>(null);

  // Sheet headers we can offer as alternatives. Memoised so the same
  // array reference is reused unless `proposal.headers` actually changes.
  const allHeaders = useMemo(
    () => proposal.headers.filter((h) => h.trim().length > 0),
    [proposal.headers],
  );

  // Recompute unmapped_headers from the live `fields` map. Memoised
  // because the AlternativesList builds its candidates from this.
  const derivedUnmapped = useMemo(() => {
    const claimed = new Set(
      Object.values(fields).filter((h): h is string => h !== null),
    );
    return allHeaders.filter((h) => !claimed.has(h));
  }, [fields, allHeaders]);

  function pickHeader(field: LeadFieldKey, header: string | null): void {
    setFields((prev) => {
      const next = { ...prev };
      if (header !== null) {
        // Claim-once: if any other field currently holds this header,
        // release it. Otherwise the writer would have two app-fields
        // trying to land in the same column.
        for (const otherKey of Object.keys(next) as LeadFieldKey[]) {
          if (otherKey !== field && next[otherKey] === header) {
            next[otherKey] = null;
          }
        }
      }
      next[field] = header;
      return next;
    });
    setFixingField(null);
  }

  function handleConfirm(): void {
    onConfirm({ fields, unmapped_headers: derivedUnmapped });
  }

  return (
    <section className="mapping-card" aria-labelledby="mapping-heading">
      <h2 id="mapping-heading">We found these columns in {sheetName}</h2>
      <p className="mapping-subtitle">
        Tap any row to fix it, or use what we got.
      </p>

      <ul className="mapping-pairs">
        {FIELD_ORDER.map((field) => {
          const header = fields[field];
          const isFixing = fixingField === field;
          return (
            <li key={field} className="mapping-pair-wrapper">
              <button
                type="button"
                className={
                  header === null
                    ? "mapping-pair mapping-pair--unmatched"
                    : isFixing
                      ? "mapping-pair mapping-pair--fixing"
                      : "mapping-pair"
                }
                aria-expanded={isFixing}
                onClick={() => setFixingField(isFixing ? null : field)}
              >
                <span className="mapping-app-field">{FIELD_LABELS[field]}</span>
                <span className="mapping-arrow" aria-hidden="true">
                  →
                </span>
                {header === null ? (
                  <span className="mapping-sheet-header mapping-sheet-header--missing">
                    Not in this sheet
                  </span>
                ) : (
                  <span className="mapping-sheet-header">{header}</span>
                )}
                <span className="mapping-fix-hint" aria-hidden="true">
                  {isFixing ? "−" : "✎"}
                </span>
              </button>

              {isFixing && (
                <AlternativesPicker
                  field={field}
                  currentHeader={header}
                  allHeaders={allHeaders}
                  onPick={(picked) => pickHeader(field, picked)}
                  onCancel={() => setFixingField(null)}
                />
              )}
            </li>
          );
        })}
      </ul>

      {derivedUnmapped.length > 0 && (
        <p className="mapping-unmapped">
          Other columns in your sheet ({derivedUnmapped.join(", ")}) — we won’t
          touch them.
        </p>
      )}

      <button type="button" className="primary-action" onClick={handleConfirm}>
        Yes, use these
      </button>
      <button type="button" className="link-action" onClick={onPickAnother}>
        Pick a different sheet
      </button>
    </section>
  );
}

// --- inline alternatives picker (the "Fix one" surface) -------------------

interface AlternativesPickerProps {
  field: LeadFieldKey;
  currentHeader: string | null;
  allHeaders: string[];
  onPick: (header: string | null) => void;
  onCancel: () => void;
}

/**
 * Inline list of column-header candidates for a single field. Includes
 * a "Don't map this column" option so the user can explicitly opt out
 * (the value will land in Notes or be dropped per the writer's rules).
 *
 * `currentHeader` is highlighted so the user sees what's already in
 * place — we don't hide it from the list, because re-tapping the
 * current value should be a no-op cancel rather than a confused dead-end.
 */
function AlternativesPicker({
  field,
  currentHeader,
  allHeaders,
  onPick,
  onCancel,
}: AlternativesPickerProps): React.ReactElement {
  return (
    <div className="mapping-fix" role="region" aria-label={`Fix mapping for ${FIELD_LABELS[field]}`}>
      <p className="mapping-fix__label">
        Which column in your sheet has the {FIELD_LABELS[field].toLowerCase()}?
      </p>
      <ul className="mapping-fix__options">
        {allHeaders.map((header) => (
          <li key={header}>
            <button
              type="button"
              className={
                header === currentHeader
                  ? "mapping-fix__option mapping-fix__option--current"
                  : "mapping-fix__option"
              }
              onClick={() => onPick(header)}
            >
              {header}
              {header === currentHeader && (
                <span className="mapping-fix__current-tag">currently</span>
              )}
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            className={
              currentHeader === null
                ? "mapping-fix__option mapping-fix__option--none mapping-fix__option--current"
                : "mapping-fix__option mapping-fix__option--none"
            }
            onClick={() => onPick(null)}
          >
            Not in this sheet
          </button>
        </li>
      </ul>
      <button type="button" className="link-action" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

// --- empty / looks_like_data (shared "we can't proceed yet" view) --------

interface DeferViewProps {
  sheetName: string;
  title: string;
  body: string;
  /** Optional row 1 echo so the user sees what we saw (looks_like_data path). */
  previewRow?: string[];
  onPickAnother: () => void;
}

function DeferView({
  sheetName,
  title,
  body,
  previewRow,
  onPickAnother,
}: DeferViewProps): React.ReactElement {
  return (
    <section className="mapping-card" aria-labelledby="mapping-heading">
      <h2 id="mapping-heading">{title}</h2>
      <p className="mapping-subtitle">In {sheetName}.</p>
      <p className="mapping-body">{body}</p>

      {previewRow && previewRow.length > 0 && (
        <div className="mapping-preview" aria-label="Row 1 of the sheet">
          <p className="mapping-preview-label">Row 1 looks like:</p>
          <ul className="mapping-preview-cells">
            {previewRow.map((cell, index) => (
              // eslint-disable-next-line react/no-array-index-key
              <li key={index}>{cell || <em>(empty)</em>}</li>
            ))}
          </ul>
        </div>
      )}

      <button type="button" className="primary-action" onClick={onPickAnother}>
        Pick a different sheet
      </button>
    </section>
  );
}
