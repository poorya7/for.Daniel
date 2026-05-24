/**
 * LeadReviewCard — the rendering layer for "review one lead's fields."
 *
 * Three clean layers across the review surface:
 *   1. Data — `Lead` type + adapters (see Lead.ts).
 *   2. Rendering — this file. Pure component, takes a lead, fires events.
 *   3. Logic — the parent (App.canvas right now). Owns where the lead
 *      comes from, what happens on save, how auth gates work, etc.
 *
 * The component knows nothing about:
 *   - Where the lead came from (text capture, voice capture, photo row).
 *   - What the bottom action button does (Save / Back to list / sign-in).
 *     The parent supplies that via the `footer` prop.
 *   - Authentication, saving, the photo flow, the canvas at large.
 *
 * The component DOES own:
 *   - The per-field edit panel state (which field is open, draft text,
 *     focus management, live phone/budget formatting, picker pill state).
 *   - The page layout — name/phone/email/agent on page 1, etc.
 *   - The heading vocabulary — "EXTRACTED" eyebrow, first-name body,
 *     agent pill, optional budget line.
 *
 * Edits propagate via `onCommitField` (a field's value changed) and
 * `onCommitAgent` (the yes / no toggle flipped). The parent merges the
 * change into its lead state and feeds the updated lead back in on the
 * next render — same one-way data flow the rest of the app uses.
 */

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { ReviewPager } from "@/components/ReviewPager/ReviewPager";
import type { InnerDismissResult } from "@/features/dismiss/useDismissFlow";
import { formatBudget } from "@/features/review/formatBudget";
import { formatPhone } from "@/features/review/formatPhone";
import type { Confidence } from "@/lib/api";

import type { AgentState, EditableLeadFieldKey, Lead } from "./Lead";

import "./LeadReviewCard.css";

interface LeadReviewCardProps {
  /** The lead to render — name, phone, email, agent toggle, etc. */
  lead: Lead;
  /**
   * Called when the user commits an edit on one of the text fields
   * (Done button on the edit panel, picker pill tap, Enter on a single-
   * line field). The parent merges the new value into its lead state.
   */
  onCommitField: (key: EditableLeadFieldKey, value: string) => void;
  /**
   * Called when the user taps Yes or No on the agent-status row. The
   * parent merges the new agent state into its lead.
   */
  onCommitAgent: (state: AgentState) => void;
  /**
   * The bottom action area. Provided by the parent because it's
   * context-specific: Save+Discard from the capture flow, "Back to
   * list" from the photo-row tap, the SignInPanel when auth is needed.
   * The card itself is agnostic about WHAT the user does after
   * reviewing — it just renders whatever the parent hands in.
   */
  footer: ReactNode;
}

/**
 * Imperative handle the parent uses to drive the card on backdrop
 * taps. Returns an `InnerDismissResult` describing what (if anything)
 * happened — `none` (no field open), `closed-clean` (closed silently
 * because the draft equals the original), or `has-changes` with
 * commit/discard callbacks the dismiss flow uses to drive its confirm
 * Dialog. The card stays in editing mode while the confirm is up so
 * Cancel can return the user to their in-flight edit.
 */
export interface LeadReviewCardHandle {
  dismissOpenFieldEdit: () => InnerDismissResult;
}

interface PageEntry {
  key: EditableLeadFieldKey | "has_agent";
  label: string;
}

/**
 * 3-page layout for the swipe pager. Matches the legacy review
 * vocabulary: identity + qualification → prioritisation + budget →
 * preferences + follow-up. has_agent sits on page 1 because the agent-
 * status pill in the heading reads off it AND it's the first question
 * NAR ethics make brokers ask at open houses.
 */
const PAGES: PageEntry[][] = [
  [
    { key: "name", label: "Name" },
    { key: "phone", label: "Phone" },
    { key: "email", label: "Email" },
    { key: "has_agent", label: "Agent?" },
  ],
  [
    { key: "intent", label: "Intent" },
    { key: "timeline", label: "Timeline" },
    { key: "financing_status", label: "Financing" },
    { key: "budget", label: "Budget" },
  ],
  [
    { key: "area", label: "Area" },
    { key: "follow_up", label: "Follow up" },
    { key: "notes", label: "Notes" },
  ],
];

type FieldEditor =
  | { kind: "picker"; options: string[] }
  | { kind: "text" };

/**
 * Per-field editor shape. Picker fields render as a row of tap-pills
 * (instant commit on tap); text fields render as a textarea (Done
 * button commits). Phone, Email, Budget are text-shape with special
 * input chrome (numeric keypad, @-pills, multiline + live formatting
 * respectively).
 */
const FIELD_EDITORS: Record<EditableLeadFieldKey, FieldEditor> = {
  name: { kind: "text" },
  phone: { kind: "text" },
  email: { kind: "text" },
  intent: { kind: "picker", options: ["Buyer", "Seller", "Both", "Browsing"] },
  timeline: {
    kind: "picker",
    options: ["ASAP", "1-3 months", "3-6 months", "6-12 months", "Not sure"],
  },
  financing_status: {
    kind: "picker",
    options: ["Pre-approved", "Cash", "Not yet", "Not sure"],
  },
  budget: { kind: "text" },
  area: { kind: "text" },
  follow_up: { kind: "text" },
  notes: { kind: "text" },
};

/**
 * Email domain shortcuts shown inside the email editor's textbox so
 * the pills ride with the input element when the soft keyboard rises.
 * Display drops the `.com` so four pills fit comfortably; the
 * append/replace uses the full domain. Same picks the rest of the app
 * uses — gmail-dominant US real-estate clientele with iCloud / Yahoo /
 * Hotmail covering the older-client tail Linda's persona is built on.
 */
const EMAIL_DOMAINS = [
  "gmail.com",
  "yahoo.com",
  "icloud.com",
  "hotmail.com",
  "aol.com",
] as const;

/**
 * The ReviewRow component below only knows "high" or "medium" — low
 * gets the same "check this" treatment as medium until a polish-pass
 * widens it to a third visual. Undefined defaults to high (no
 * extraction has run yet → no warning needed).
 */
function narrowConfidence(c: Confidence | undefined): "high" | "medium" {
  if (c === undefined) return "high";
  if (c === "high") return "high";
  return "medium";
}

export const LeadReviewCard = forwardRef<
  LeadReviewCardHandle,
  LeadReviewCardProps
>(function LeadReviewCard(
  { lead, onCommitField, onCommitAgent, footer },
  ref,
): ReactElement {
  // Which field (if any) is currently open in the edit panel. Null
  // means we're on the review surface; non-null means the edit panel
  // is covering the review via the `data-editing` attribute on the
  // card root (CSS swaps which side is visible — keeps ReviewPager
  // mounted so scroll position / active slide survive the edit round-
  // trip).
  const [editingField, setEditingField] = useState<EditableLeadFieldKey | null>(
    null,
  );
  // Draft text the user is typing in the edit panel. Picker fields
  // also use this slot to track the currently-selected option for
  // the "tap the selected pill to deselect" gesture.
  const [editDraft, setEditDraft] = useState("");
  // Ref to whichever input / textarea is currently rendered in the
  // text-mode branch. Phone + Budget run uncontrolled to avoid
  // controlled-input caret-jump under live formatting, so we read
  // their value off this ref at commit-time.
  const editInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(
    null,
  );
  // The field's original value at the moment the editor opened. Used by
  // the backdrop-dismiss handle to decide whether the user actually
  // changed anything — equal = silent close, different = raise confirm.
  const editInitialValueRef = useRef<string>("");

  // Focus the input when an editor opens. Picker fields don't need
  // focus (they're tap-targets, not text inputs).
  useEffect(() => {
    if (editingField === null) return;
    const editor = FIELD_EDITORS[editingField];
    if (editor.kind !== "text") return;
    const node = editInputRef.current;
    if (!node) return;
    node.focus();
    const len = node.value.length;
    node.setSelectionRange(len, len);
  }, [editingField]);

  // Stabilise the per-page callbacks so the memoed page components
  // (ContactPage / QualificationPage / PreferencesPage below) don't
  // re-render when only the parent re-runs. Each forwarder reads the
  // latest prop via ref so behaviour stays correct without taking
  // them as memo dependencies.
  const onCommitFieldRef = useRef(onCommitField);
  onCommitFieldRef.current = onCommitField;
  const onCommitAgentRef = useRef(onCommitAgent);
  onCommitAgentRef.current = onCommitAgent;
  const stableOnCommitAgent = useCallback((state: AgentState) => {
    onCommitAgentRef.current(state);
  }, []);

  // openEditor is stable too — the call site passes the field's
  // current value, so the closure doesn't need to capture `lead`.
  // Snapshots initialValue so the dismiss handle can detect changes.
  const openEditor = useCallback(
    (key: EditableLeadFieldKey, initialValue: string): void => {
      setEditDraft(initialValue);
      setEditingField(key);
      editInitialValueRef.current = initialValue;
    },
    [],
  );

  function commitEdit(): void {
    if (editingField === null) return;
    // Phone + Budget run uncontrolled — read directly from the input.
    // Other text fields are controlled via editDraft.
    const value =
      (editingField === "phone" || editingField === "budget") &&
      editInputRef.current
        ? editInputRef.current.value
        : editDraft;
    onCommitField(editingField, value);
    setEditingField(null);
  }

  function commitPickerValue(value: string): void {
    if (editingField === null) return;
    onCommitField(editingField, value);
    setEditingField(null);
  }

  function cancelEdit(): void {
    setEditingField(null);
  }

  // Expose the dismiss handle to the parent. The orchestrator calls
  // this on every backdrop tap; the return value tells the dismiss
  // flow whether the field-edit panel was open AND whether the user
  // had changed anything (so the flow can stay silent on a clean
  // close or raise the Save / Don't Save confirm on a changed one).
  useImperativeHandle(
    ref,
    (): LeadReviewCardHandle => ({
      dismissOpenFieldEdit: () => {
        if (editingField === null) return { kind: "none" };

        // Current draft value — phone + budget run uncontrolled so
        // their live-formatted text lives on the input ref; everything
        // else flows through editDraft.
        const current =
          (editingField === "phone" || editingField === "budget") &&
          editInputRef.current
            ? editInputRef.current.value
            : editDraft;

        // Original value formatted the same way it's displayed in the
        // editor, so a no-typing-yet panel reads as unchanged.
        const originalRaw = editInitialValueRef.current;
        const originalDisplayed =
          editingField === "phone"
            ? formatPhone(originalRaw)
            : editingField === "budget"
              ? formatBudget(originalRaw)
              : originalRaw;

        if (current === originalDisplayed) {
          cancelEdit();
          return { kind: "closed-clean" };
        }

        return {
          kind: "has-changes",
          commit: () => {
            commitEdit();
          },
          discard: () => {
            cancelEdit();
          },
        };
      },
    }),
    [editingField, editDraft],
  );

  // Phone live formatter — every keystroke runs the input value
  // through formatPhone, replaces the input value with the formatted
  // version, and repositions the caret by DIGIT count (not character
  // count) so it stays put relative to what the user typed. Matches
  // iOS Contacts / Messages: parens appear at the 4-digit threshold,
  // dash at 7, etc.
  function handlePhoneInput(event: React.FormEvent<HTMLInputElement>): void {
    const input = event.currentTarget;
    const prevValue = input.value;
    const prevCaret = input.selectionStart ?? prevValue.length;
    let digitsBeforeCaret = 0;
    for (let i = 0; i < prevCaret && i < prevValue.length; i++) {
      if (/\d/.test(prevValue[i] ?? "")) digitsBeforeCaret++;
    }
    const nextValue = formatPhone(prevValue);
    if (nextValue === prevValue) return;
    let nextCaret = nextValue.length;
    let count = 0;
    for (let i = 0; i < nextValue.length; i++) {
      if (/\d/.test(nextValue[i] ?? "")) count++;
      if (count === digitsBeforeCaret) {
        nextCaret = i + 1;
        break;
      }
    }
    input.value = nextValue;
    input.setSelectionRange(nextCaret, nextCaret);
  }

  // Budget live formatter — same pattern as phone, but restores
  // caret by SIGNIFICANT-CHAR count (everything except `$` and `,`).
  // Long-form budget strings preserve user-typed spaces / dashes /
  // words (e.g. "$500k to $700k, flexible") — see formatBudget docs.
  function handleBudgetInput(
    event: React.SyntheticEvent<HTMLTextAreaElement>,
  ): void {
    const input = event.currentTarget;
    const prevValue = input.value;
    const prevCaret = input.selectionStart ?? prevValue.length;
    let significantBefore = 0;
    for (let i = 0; i < prevCaret && i < prevValue.length; i++) {
      const c = prevValue[i];
      if (c !== "$" && c !== ",") significantBefore++;
    }
    const nextValue = formatBudget(prevValue);
    if (nextValue === prevValue) return;
    let nextCaret = nextValue.length;
    let count = 0;
    for (let i = 0; i < nextValue.length; i++) {
      const c = nextValue[i];
      if (c !== "$" && c !== ",") count++;
      if (count === significantBefore) {
        nextCaret = i + 1;
        break;
      }
    }
    input.value = nextValue;
    input.setSelectionRange(nextCaret, nextCaret);
  }

  // The label for the open editor's header ("Edit Phone", "Edit Email").
  const editingLabel: string | null =
    editingField === null
      ? null
      : (PAGES.flat().find((f) => f.key === editingField)?.label ?? null);

  // First-name shown in the heading. The streamed `name` may be
  // "Maria Hernandez" — heading uses just the first token so the
  // top reads as a person, not a sheet entry.
  const firstName = useMemo(() => {
    const trimmed = lead.name.value.trim();
    if (trimmed === "") return "";
    return trimmed.split(/\s+/)[0] ?? trimmed;
  }, [lead.name.value]);

  // Three per-page components keep re-renders surgical: editing a
  // field on page 3 (notes) only re-renders PreferencesPage, not
  // ContactPage or QualificationPage. setLeadField in Lead.ts
  // preserves references for untouched fields, so React.memo's
  // default shallow compare correctly skips pages whose fields
  // didn't change.
  const pages = useMemo<ReactNode[]>(
    () => [
      <ContactPage
        key="contact"
        name={lead.name}
        phone={lead.phone}
        email={lead.email}
        hasAgent={lead.has_agent}
        onOpenEditor={openEditor}
        onCommitAgent={stableOnCommitAgent}
      />,
      <QualificationPage
        key="qualification"
        intent={lead.intent}
        timeline={lead.timeline}
        financingStatus={lead.financing_status}
        budget={lead.budget}
        onOpenEditor={openEditor}
      />,
      <PreferencesPage
        key="preferences"
        area={lead.area}
        followUp={lead.follow_up}
        notes={lead.notes}
        onOpenEditor={openEditor}
      />,
    ],
    [
      lead.name,
      lead.phone,
      lead.email,
      lead.has_agent,
      lead.intent,
      lead.timeline,
      lead.financing_status,
      lead.budget,
      lead.area,
      lead.follow_up,
      lead.notes,
      openEditor,
      stableOnCommitAgent,
    ],
  );

  return (
    <div
      className="lead-review-card"
      data-editing={editingField !== null ? "true" : "false"}
    >
      <section
        className="lead-review-card__review"
        aria-labelledby="lead-review-heading"
      >
        <h2 id="lead-review-heading" className="lead-review-card__heading">
          <span className="lead-review-card__eyebrow">Extracted</span>
          {/* Pill sits on the name row pinned to the right corner. Name
              falls back to "Lead" when nothing extracted; budget line
              just isn't rendered when empty. Matches the locked
              vocabulary the owner approved. */}
          <span className="lead-review-card__name-row">
            <span className="lead-review-card__name">
              {firstName === "" ? "Lead" : firstName}
            </span>
            <AgentPill state={lead.has_agent} />
          </span>
          {lead.budget.value !== "" ? (
            <span className="lead-review-card__budget">
              {formatBudget(lead.budget.value)}
            </span>
          ) : null}
        </h2>

        {/* ReviewPager owns gestures + chrome (disclosure + dots +
            counter inside its viewport so chrome swipes follow the
            finger live) — we only provide the slide content. */}
        <ReviewPager pages={pages} originalNote={lead.original_note} />

        {footer}
      </section>

      {/* Edit panel — covers the review surface when editingField !==
          null. CSS swaps which side is visible via the data-editing
          attribute on the card root, so ReviewPager stays mounted and
          retains its scroll position across edit round-trips. */}
      <div className="lead-review-card__edit">
        <p className="lead-review-card__edit-label">{editingLabel ?? ""}</p>
        {editingField === null ? null : FIELD_EDITORS[editingField].kind ===
          "picker" ? (
          <div
            className="lead-review-card__picker"
            role="radiogroup"
            aria-label={editingLabel ?? ""}
          >
            {(
              FIELD_EDITORS[editingField] as {
                kind: "picker";
                options: string[];
              }
            ).options.map((opt) => (
              <button
                key={opt}
                type="button"
                className={
                  "lead-review-card__picker-option" +
                  (editDraft === opt
                    ? " lead-review-card__picker-option--selected"
                    : "")
                }
                role="radio"
                aria-checked={editDraft === opt}
                onClick={() => {
                  // Tap the selected pill to deselect (commits empty).
                  // Tap any other pill to swap to it.
                  commitPickerValue(editDraft === opt ? "" : opt);
                }}
              >
                {opt}
              </button>
            ))}
          </div>
        ) : editingField === "phone" ? (
          // Uncontrolled <input type="tel"> with live formatPhone +
          // caret restoration. iOS Safari only respects the numeric
          // keypad on type="tel" (not inputMode on a textarea), so
          // this has to be a real <input>.
          <input
            ref={editInputRef as React.RefObject<HTMLInputElement>}
            key={editingField}
            type="tel"
            className="lead-review-card__input lead-review-card__input--single"
            defaultValue={formatPhone(editDraft)}
            onInput={handlePhoneInput}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                cancelEdit();
              }
            }}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label={editingLabel ?? ""}
          />
        ) : editingField === "email" ? (
          // Email: <input> + suggestion pills INSIDE a single styled
          // box. Pills ride with the input element so when the soft
          // keyboard rises, the whole container floats above it and
          // the pills stay tappable.
          <div className="lead-review-card__email-box">
            <input
              ref={editInputRef as React.RefObject<HTMLInputElement>}
              key={editingField}
              type="text"
              inputMode="email"
              className="lead-review-card__email-input"
              value={editDraft}
              onChange={(e) => setEditDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  cancelEdit();
                }
              }}
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-label={editingLabel ?? ""}
            />
            <div className="lead-review-card__email-pills">
              {EMAIL_DOMAINS.map((domain) => (
                <button
                  key={domain}
                  type="button"
                  className="lead-review-card__email-pill"
                  // onMouseDown + preventDefault so the input doesn't
                  // blur on tap (which would dismiss the keyboard mid-
                  // edit). Replaces any existing @-suffix, otherwise
                  // appends.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setEditDraft((d) => {
                      const atIndex = d.indexOf("@");
                      const local = atIndex === -1 ? d : d.slice(0, atIndex);
                      return `${local}@${domain}`;
                    });
                  }}
                >
                  @{domain.replace(/\.com$/, "")}
                </button>
              ))}
            </div>
          </div>
        ) : editingField === "budget" ? (
          // Budget — multiline textarea with live currency formatting.
          // formatBudget on every keystroke (idempotent on already-
          // formatted input). Plain Enter inserts a newline; the Done
          // button commits.
          <textarea
            ref={editInputRef as React.RefObject<HTMLTextAreaElement>}
            key={editingField}
            className="lead-review-card__textarea"
            defaultValue={formatBudget(editDraft)}
            onInput={handleBudgetInput}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                cancelEdit();
              }
            }}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label={editingLabel ?? ""}
          />
        ) : (
          // Default multi-line textarea — Name / Area / Follow up /
          // Notes. Cmd/Ctrl-Enter commits (plain Enter inserts a
          // newline so the user can write multi-sentence notes).
          <textarea
            ref={editInputRef as React.RefObject<HTMLTextAreaElement>}
            key={editingField}
            className="lead-review-card__textarea"
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commitEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                cancelEdit();
              }
            }}
            aria-label={editingLabel ?? ""}
          />
        )}
        {/* Done button — text-shape fields only. Picker fields auto-
            commit on pill tap so they don't need one. */}
        {editingField !== null &&
        FIELD_EDITORS[editingField].kind === "text" ? (
          <button
            type="button"
            className="lead-review-card__done"
            onClick={commitEdit}
          >
            Done
          </button>
        ) : null}
        {editingField !== null ? (
          <button
            type="button"
            className="lead-review-card__cancel"
            onClick={cancelEdit}
          >
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Internal subcomponents — only used inside LeadReviewCard. Kept in this
// file because they're not meaningful outside it.
// ---------------------------------------------------------------------------

// --- Per-page memoed components --------------------------------------------
//
// The 3-page swipe pager renders one of these per slide. Splitting the
// previous monolithic page render into three lets React.memo's default
// shallow compare skip pages whose fields didn't change — so editing
// notes (PreferencesPage) leaves ContactPage and QualificationPage
// untouched. See the `pages` useMemo in LeadReviewCard for the wiring.

interface ContactPageProps {
  name: { value: string; confidence: Confidence | undefined };
  phone: { value: string; confidence: Confidence | undefined };
  email: { value: string; confidence: Confidence | undefined };
  hasAgent: AgentState;
  onOpenEditor: (key: EditableLeadFieldKey, initialValue: string) => void;
  onCommitAgent: (state: AgentState) => void;
}

const ContactPage = memo(function ContactPage({
  name,
  phone,
  email,
  hasAgent,
  onOpenEditor,
  onCommitAgent,
}: ContactPageProps): ReactElement {
  return (
    <div className="lead-review-card__page">
      <dl className="lead-review-card__fields">
        <ReviewRow
          label="Name"
          value={name.value}
          confidence={narrowConfidence(name.confidence)}
          onTap={() => onOpenEditor("name", name.value)}
        />
        <ReviewRow
          label="Phone"
          value={formatPhone(phone.value)}
          confidence={narrowConfidence(phone.confidence)}
          onTap={() => onOpenEditor("phone", phone.value)}
        />
        <ReviewRow
          label="Email"
          value={email.value}
          confidence={narrowConfidence(email.confidence)}
          onTap={() => onOpenEditor("email", email.value)}
        />
        <YesNoRow label="Agent?" value={hasAgent} onChange={onCommitAgent} />
      </dl>
    </div>
  );
});

interface QualificationPageProps {
  intent: { value: string; confidence: Confidence | undefined };
  timeline: { value: string; confidence: Confidence | undefined };
  financingStatus: { value: string; confidence: Confidence | undefined };
  budget: { value: string; confidence: Confidence | undefined };
  onOpenEditor: (key: EditableLeadFieldKey, initialValue: string) => void;
}

const QualificationPage = memo(function QualificationPage({
  intent,
  timeline,
  financingStatus,
  budget,
  onOpenEditor,
}: QualificationPageProps): ReactElement {
  return (
    <div className="lead-review-card__page">
      <dl className="lead-review-card__fields">
        <ReviewRow
          label="Intent"
          value={intent.value}
          confidence={narrowConfidence(intent.confidence)}
          onTap={() => onOpenEditor("intent", intent.value)}
        />
        <ReviewRow
          label="Timeline"
          value={timeline.value}
          confidence={narrowConfidence(timeline.confidence)}
          onTap={() => onOpenEditor("timeline", timeline.value)}
        />
        <ReviewRow
          label="Financing"
          value={financingStatus.value}
          confidence={narrowConfidence(financingStatus.confidence)}
          onTap={() => onOpenEditor("financing_status", financingStatus.value)}
        />
        <ReviewRow
          label="Budget"
          value={formatBudget(budget.value)}
          confidence={narrowConfidence(budget.confidence)}
          onTap={() => onOpenEditor("budget", budget.value)}
        />
      </dl>
    </div>
  );
});

interface PreferencesPageProps {
  area: { value: string; confidence: Confidence | undefined };
  followUp: { value: string; confidence: Confidence | undefined };
  notes: { value: string; confidence: Confidence | undefined };
  onOpenEditor: (key: EditableLeadFieldKey, initialValue: string) => void;
}

const PreferencesPage = memo(function PreferencesPage({
  area,
  followUp,
  notes,
  onOpenEditor,
}: PreferencesPageProps): ReactElement {
  return (
    <div className="lead-review-card__page">
      <dl className="lead-review-card__fields">
        <ReviewRow
          label="Area"
          value={area.value}
          confidence={narrowConfidence(area.confidence)}
          onTap={() => onOpenEditor("area", area.value)}
        />
        <ReviewRow
          label="Follow up"
          value={followUp.value}
          confidence={narrowConfidence(followUp.confidence)}
          onTap={() => onOpenEditor("follow_up", followUp.value)}
        />
        <ReviewRow
          label="Notes"
          value={notes.value}
          confidence={narrowConfidence(notes.confidence)}
          onTap={() => onOpenEditor("notes", notes.value)}
        />
      </dl>
    </div>
  );
});

interface ReviewRowProps {
  label: string;
  value: string;
  confidence?: "high" | "medium";
  onTap: () => void;
}

function ReviewRow({
  label,
  value,
  confidence = "high",
  onTap,
}: ReviewRowProps): ReactElement {
  const isEmpty = value.trim() === "";
  return (
    <div
      className="lead-review-card__row lead-review-card__row--tappable"
      onClick={onTap}
    >
      <dt className="lead-review-card__row-label">{label}</dt>
      <dd
        className={
          "lead-review-card__row-value lead-review-card__row-value--" +
          confidence
        }
      >
        {isEmpty ? (
          <span className="lead-review-card__row-value-text lead-review-card__row-value-text--empty">
            not set
          </span>
        ) : (
          <>
            <span className="lead-review-card__row-value-text">{value}</span>
            {confidence === "medium" ? (
              <span className="lead-review-card__row-confidence">
                check this
              </span>
            ) : null}
          </>
        )}
      </dd>
      <PencilIcon />
    </div>
  );
}

interface YesNoRowProps {
  label: string;
  value: AgentState;
  onChange: (value: AgentState) => void;
}

function YesNoRow({ label, value, onChange }: YesNoRowProps): ReactElement {
  return (
    <div className="lead-review-card__row">
      <dt className="lead-review-card__row-label">{label}</dt>
      <dd className="lead-review-card__row-value">
        <div
          className="lead-review-card__yesno"
          role="radiogroup"
          aria-label={label}
        >
          <button
            type="button"
            className={
              "lead-review-card__yesno-btn" +
              (value === "yes" ? " lead-review-card__yesno-btn--selected" : "")
            }
            aria-pressed={value === "yes"}
            onClick={() => onChange("yes")}
          >
            Yes
          </button>
          <button
            type="button"
            className={
              "lead-review-card__yesno-btn" +
              (value === "no" ? " lead-review-card__yesno-btn--selected" : "")
            }
            aria-pressed={value === "no"}
            onClick={() => onChange("no")}
          >
            No
          </button>
        </div>
      </dd>
      <span />
    </div>
  );
}

interface AgentPillProps {
  state: AgentState;
}

/**
 * Small colour-coded pill below the budget line. Replaces the corner
 * ribbon from the legacy CaptureSheet — on the no-panel canvas there's
 * no corner to anchor a flag to, so the agent-status signal lives
 * inside the heading stack.
 */
function AgentPill({ state }: AgentPillProps): ReactElement {
  const isAgent = state === "yes";
  return (
    <span
      className={
        "lead-review-card__agent-pill" +
        (isAgent
          ? " lead-review-card__agent-pill--agent"
          : " lead-review-card__agent-pill--free")
      }
      role="status"
      aria-label={
        isAgent
          ? "This lead is already represented by an agent"
          : "This lead has no agent — pursueable"
      }
    >
      <span className="lead-review-card__agent-pill-dot" aria-hidden="true" />
      {isAgent ? "Agent" : "Free"}
    </span>
  );
}

function PencilIcon(): ReactElement {
  return (
    <svg
      className="lead-review-card__pencil"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </svg>
  );
}
