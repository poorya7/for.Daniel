/**
 * Lead — the canonical domain type for "a single capture's worth of
 * extracted fields, ready to display, edit, or save."
 *
 * This is the data layer for the review surface. It deliberately lives
 * separate from any UI code: nothing in this file knows about React,
 * the canvas, the photo flow, auth, or the save endpoint. It just
 * describes WHAT a lead is and provides the adapters that translate
 * between Lead and the surrounding shapes the app already speaks
 * (StreamingResult from extraction, PhotoRow from the multi-row photo
 * stream, SaveRowPayload for the sheets-append wire).
 *
 * Field naming: snake_case to mirror the wire types (ExtractedFields,
 * PhotoRow, SaveRowPayload). One naming convention end-to-end means
 * the adapters here are trivial 1:1 mappings — no renaming layer.
 *
 * has_agent shape: deliberately NOT a free-text confidence-bearing
 * field. The capture surface treats it as a yes / no toggle (the
 * agent-status pill / the Yes-No segmented row), so the Lead type
 * commits to that semantics directly. The streaming extractor sends
 * it as a confidence-bearing string for compatibility, but by the
 * time it reaches Lead we've parsed it.
 */

import type {
  Confidence,
  ExtractedField,
  ExtractedFields,
  PhotoRow,
  SaveRowPayload,
  StreamingFields,
  StreamingResult,
} from "@/lib/api";

/**
 * A single extracted field on a lead — what the model thinks the
 * value is, plus its confidence in that read. Confidence drives
 * the row's visual treatment ("check this" hint on medium / low).
 *
 * `value: ""` is the canonical "not extracted / cleared by user"
 * marker. Adapters out (e.g. `leadToSavePayload`) convert this to
 * `null` for the wire so the backend treats it as "field is empty"
 * instead of "field is an empty string."
 *
 * Whitespace policy: this layer never trims. A value of `"Maria "`
 * goes to the wire as `"Maria "`; the backend's `_clean` helper
 * (`services/sheets_service.py`) is the single source of truth for
 * stripping and for null-coalescing whitespace-only strings. Keeping
 * one trim layer means there's no "checked one way, saved another"
 * mismatch to maintain — both adapters here null-coalesce on the
 * exact-empty-string sentinel only, consistent with each other.
 */
export interface LeadField {
  value: string;
  /** `undefined` = no extraction has run yet (initial / empty state). */
  confidence: Confidence | undefined;
}

/**
 * The yes / no segmented control's two states. Used directly by the
 * canvas's YesNoRow component.
 */
export type AgentState = "yes" | "no";

/**
 * The full lead — eleven extracted slots plus the original note the
 * model saw (for the "Show the original note" disclosure).
 *
 * Field names mirror ExtractedFields / SaveRowPayload exactly so the
 * adapters are 1:1. The one exception is `original_note` (vs the wire
 * `original_text`) — `note` reads better in UI prose ("show the
 * original note") and the adapter renames it on the way out.
 */
export interface Lead {
  name: LeadField;
  phone: LeadField;
  email: LeadField;
  has_agent: AgentState;
  intent: LeadField;
  timeline: LeadField;
  financing_status: LeadField;
  budget: LeadField;
  area: LeadField;
  follow_up: LeadField;
  notes: LeadField;
  /** Raw text the extractor saw, echoed back by the server. */
  original_note: string;
}

/**
 * The text fields — everything except has_agent (which is a toggle,
 * not a text editor). Used by the per-field edit panel to enumerate
 * what can be edited as free text.
 */
export type EditableLeadFieldKey =
  | "name"
  | "phone"
  | "email"
  | "intent"
  | "timeline"
  | "financing_status"
  | "budget"
  | "area"
  | "follow_up"
  | "notes";

/** Empty LeadField — used as the default cell when nothing extracted yet. */
const EMPTY_FIELD: LeadField = { value: "", confidence: undefined };

/** A pristine lead — every field empty, no agent set, no original note. */
export const EMPTY_LEAD: Lead = {
  name: { ...EMPTY_FIELD },
  phone: { ...EMPTY_FIELD },
  email: { ...EMPTY_FIELD },
  has_agent: "no",
  intent: { ...EMPTY_FIELD },
  timeline: { ...EMPTY_FIELD },
  financing_status: { ...EMPTY_FIELD },
  budget: { ...EMPTY_FIELD },
  area: { ...EMPTY_FIELD },
  follow_up: { ...EMPTY_FIELD },
  notes: { ...EMPTY_FIELD },
  original_note: "",
};

// ---------------------------------------------------------------------------
// Adapters — translate between Lead and the surrounding wire / domain shapes.
// Pure functions, no side effects.
// ---------------------------------------------------------------------------

/**
 * Adapt the streaming extraction result (text / voice capture done)
 * into a Lead. Each ExtractedField becomes a LeadField; the has_agent
 * free-text value is parsed to the yes / no toggle.
 */
export function streamingResultToLead(result: StreamingResult): Lead {
  const liftField = (field: ExtractedField | null): LeadField =>
    field === null
      ? { ...EMPTY_FIELD }
      : { value: field.value ?? "", confidence: field.confidence };
  return {
    name: liftField(result.fields.name),
    phone: liftField(result.fields.phone),
    email: liftField(result.fields.email),
    has_agent: parseHasAgent(
      result.fields.has_agent === null ? null : result.fields.has_agent.value,
    ),
    intent: liftField(result.fields.intent),
    timeline: liftField(result.fields.timeline),
    financing_status: liftField(result.fields.financing_status),
    budget: liftField(result.fields.budget),
    area: liftField(result.fields.area),
    follow_up: liftField(result.fields.follow_up),
    notes: liftField(result.fields.notes),
    original_note: result.original_text,
  };
}

/**
 * Adapt a PhotoRow (one entry from the multi-row photo extraction)
 * into a Lead so the SAME review surface can render and edit it. The
 * row's idempotency_key + row_confidence stay on the original
 * PhotoRow — those belong to the photo layer, not to the lead the
 * user sees.
 */
export function photoRowToLead(row: PhotoRow): Lead {
  const liftField = (field: ExtractedField): LeadField => ({
    value: field.value ?? "",
    confidence: field.confidence,
  });
  return {
    name: liftField(row.fields.name),
    phone: liftField(row.fields.phone),
    email: liftField(row.fields.email),
    has_agent: parseHasAgent(row.fields.has_agent.value),
    intent: liftField(row.fields.intent),
    timeline: liftField(row.fields.timeline),
    financing_status: liftField(row.fields.financing_status),
    budget: liftField(row.fields.budget),
    area: liftField(row.fields.area),
    follow_up: liftField(row.fields.follow_up),
    notes: liftField(row.fields.notes),
    /* Photo rows are individual entries from one captured image; the
       image's original text doesn't belong to any single row. */
    original_note: "",
  };
}

/**
 * Merge edits made on a Lead back into the originating PhotoRow,
 * preserving the photo-layer fields (idempotency_key, row_confidence,
 * raw_text, alternatives on each field) that aren't part of the Lead.
 *
 * `originalRow` is what the row was when we adapted it INTO a Lead —
 * we use it to keep the photo-only metadata intact. The Lead may have
 * been edited in any field; we write those back over the row's values
 * while leaving every non-value slot untouched.
 */
export function applyLeadEditsToPhotoRow(
  originalRow: PhotoRow,
  lead: Lead,
): PhotoRow {
  const writeField = (
    key: keyof PhotoRow["fields"],
    leadField: LeadField | AgentState,
  ): PhotoRow["fields"][typeof key] => {
    const value =
      typeof leadField === "string" ? leadField : leadField.value;
    return {
      ...originalRow.fields[key],
      value: value === "" ? null : value,
    };
  };
  return {
    ...originalRow,
    fields: {
      ...originalRow.fields,
      name: writeField("name", lead.name),
      phone: writeField("phone", lead.phone),
      email: writeField("email", lead.email),
      has_agent: writeField("has_agent", lead.has_agent),
      intent: writeField("intent", lead.intent),
      timeline: writeField("timeline", lead.timeline),
      financing_status: writeField("financing_status", lead.financing_status),
      budget: writeField("budget", lead.budget),
      area: writeField("area", lead.area),
      follow_up: writeField("follow_up", lead.follow_up),
      notes: writeField("notes", lead.notes),
    },
  };
}

/**
 * Build the wire payload for POST /sheets/append. Empty-string field
 * values become null so the backend treats them as "not extracted"
 * rather than empty cells. Whitespace stripping lives on the backend
 * (`services/sheets_service.py::_clean`) — see the `LeadField`
 * docstring above for why this layer never trims.
 */
export function leadToSavePayload(
  lead: Lead,
  source: "text" | "voice" | "photo",
): SaveRowPayload {
  const orNull = (field: LeadField): string | null =>
    field.value === "" ? null : field.value;
  return {
    source,
    name: orNull(lead.name),
    phone: orNull(lead.phone),
    email: orNull(lead.email),
    has_agent: lead.has_agent,
    intent: orNull(lead.intent),
    timeline: orNull(lead.timeline),
    financing_status: orNull(lead.financing_status),
    budget: orNull(lead.budget),
    area: orNull(lead.area),
    follow_up: orNull(lead.follow_up),
    notes: orNull(lead.notes),
  };
}

/**
 * Project a Lead onto the `ExtractedFields` shape the queue layer
 * stores. Used by the submit-time enqueue path (Item 0 onward) — the
 * drainer expects `record.extracted.fields` to be a plain
 * `ExtractedFields` and then maps to the wire payload from there.
 *
 * Same wrapping rules as `leadToStashStreamingResult`: empty string →
 * null, missing confidence defaults to "high" (the user already saw +
 * confirmed the value, so we don't surface a "check this" prompt on a
 * field they accepted as-is).
 */
export function leadToExtractedFields(lead: Lead): ExtractedFields {
  const wrap = (field: LeadField): ExtractedField => ({
    value: field.value === "" ? null : field.value,
    confidence: field.confidence ?? "high",
    alternatives: [],
  });
  return {
    name: wrap(lead.name),
    phone: wrap(lead.phone),
    email: wrap(lead.email),
    has_agent: { value: lead.has_agent, confidence: "high", alternatives: [] },
    intent: wrap(lead.intent),
    timeline: wrap(lead.timeline),
    financing_status: wrap(lead.financing_status),
    budget: wrap(lead.budget),
    area: wrap(lead.area),
    follow_up: wrap(lead.follow_up),
    notes: wrap(lead.notes),
  };
}

/**
 * Pack the Lead into a StreamingResult so it can round-trip through
 * lib/pendingCapture during the OAuth sign-in flow. The validator on
 * pendingCapture deep-checks ExtractedField shape, so each LeadField
 * is wrapped with the synthesised "high" confidence default + empty
 * alternatives if the lead didn't carry a confidence yet.
 */
export function leadToStashStreamingResult(lead: Lead): StreamingResult {
  const wrap = (field: LeadField): ExtractedField => ({
    value: field.value === "" ? null : field.value,
    confidence: field.confidence ?? "high",
    alternatives: [],
  });
  const fields: StreamingFields = {
    name: wrap(lead.name),
    phone: wrap(lead.phone),
    email: wrap(lead.email),
    has_agent: { value: lead.has_agent, confidence: "high", alternatives: [] },
    intent: wrap(lead.intent),
    timeline: wrap(lead.timeline),
    financing_status: wrap(lead.financing_status),
    budget: wrap(lead.budget),
    area: wrap(lead.area),
    follow_up: wrap(lead.follow_up),
    notes: wrap(lead.notes),
  };
  return { fields, original_text: lead.original_note };
}

/**
 * Reverse of leadToStashStreamingResult — used when the OAuth round-
 * trip lands and we restore the stashed capture as a Lead.
 */
export function stashedResultToLead(result: StreamingResult): Lead {
  return streamingResultToLead(result);
}

/**
 * Unused right now but exported because the lifted-StreamingFields
 * shape might be useful when wiring streaming-deltas into a partially-
 * populated Lead in a future polish slice (progressive reveal).
 *
 * Drops to EMPTY_LEAD if every slot is null (no extraction yet).
 */
export function streamingFieldsToLead(
  fields: StreamingFields,
  originalText: string,
): Lead {
  return streamingResultToLead({ fields, original_text: originalText });
}

/**
 * Pick the editable text fields off a Lead — used by the per-field
 * edit panel when it needs the current value of whichever field the
 * user just tapped.
 */
export function leadEditableField(lead: Lead, key: EditableLeadFieldKey): LeadField {
  return lead[key];
}

/**
 * Set the value of one editable text field on a Lead, returning a new
 * Lead. Pure — never mutates the input. The confidence stays put
 * (a user edit doesn't change the model's confidence in its own read).
 */
export function setLeadField(
  lead: Lead,
  key: EditableLeadFieldKey,
  value: string,
): Lead {
  return {
    ...lead,
    [key]: { ...lead[key], value },
  };
}

/**
 * Set the agent toggle on a Lead, returning a new Lead.
 */
export function setLeadAgent(lead: Lead, has_agent: AgentState): Lead {
  return { ...lead, has_agent };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * has_agent comes back from the wire as a free-form string (the model
 * just writes "yes" / "no" / "with agent" / etc). Map common positive
 * answers to "yes"; everything else (including null / empty) defaults
 * to "no" — the safer assumption for the agent-status pill (FREE =
 * pursueable lead, NAR-ethics-wise).
 *
 * Exported so test files can assert against the same mapping.
 */
export function parseHasAgent(value: string | null): AgentState {
  if (!value) return "no";
  const lower = value.toLowerCase().trim();
  if (
    lower === "yes" ||
    lower === "true" ||
    lower.includes("has agent") ||
    lower.includes("with agent") ||
    lower.includes("represented")
  ) {
    return "yes";
  }
  return "no";
}

/* unused-but-exported placeholder so the editor count doesn't drift if
   ExtractedFields gains a field — TypeScript would catch a missing key
   anywhere we destructure / rebuild. Re-exported for downstream
   consumers that want to enumerate the field keys without re-deriving. */
export const EDITABLE_LEAD_FIELD_KEYS: readonly EditableLeadFieldKey[] = [
  "name",
  "phone",
  "email",
  "intent",
  "timeline",
  "financing_status",
  "budget",
  "area",
  "follow_up",
  "notes",
] as const;

// Re-export the underlying ExtractedFields shape ONLY for the rare
// places that need to bridge to the wire types (e.g. the photo summary
// row uses raw ExtractedField for its row-confidence indicator). Most
// consumers should reach for Lead instead.
export type { ExtractedFields };
