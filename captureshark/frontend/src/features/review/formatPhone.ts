/**
 * US-style phone-number display formatter.
 *
 * Used in two places:
 *   - `FieldRow` — for the row's read-state value text.
 *   - `EditMorphCell` — applied progressively as the user types so the
 *     editor shows `(555) 875-4254` building up in lockstep with the
 *     keystrokes. Matches what iOS Contacts / Messages do natively for
 *     phone numbers — older users see this every day in their phones
 *     and expect it. Means the morph end-state matches automatically:
 *     no swap-on-close needed since the cell text is ALREADY formatted
 *     when Done is tapped, so it morphs back to the row position
 *     showing exactly what the row will display on unmount.
 *
 * Progressive shape:
 *   - 0 digits         → ""           (whatever the caller passed)
 *   - 1-3 digits       → "555"        (no parens until area code complete)
 *   - 4-6 digits       → "(555) 8"    (parens appear when prefix starts)
 *   - 7-10 digits      → "(555) 875-4254"
 *   - 11 starting "1"  → "+1 (555) 875-4254"  (canonical US-with-country)
 *   - 11+ otherwise    → "(555) 875-4254 9999"  (extras pushed to tail)
 *
 * Always strips non-digits first, so paste of "(555) 875.4254" or
 * "555-875-4254 ext 99" normalises cleanly.
 */
export function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 0) return value;
  // 11 digits starting with 1 — canonical US-with-country-code, keeps
  // the "+1" readable instead of swallowing it into the area-code slot.
  if (digits.length === 11 && digits[0] === "1") {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  // 11+ digits not starting with 1 — keep 10 in canonical, push extras
  // to a space-separated tail so weirdly long inputs (extensions,
  // mistyped extras) still show the area code + line clearly.
  if (digits.length >= 11) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)} ${digits.slice(10)}`;
  }
  // 7-10 digits — full canonical or partial line.
  if (digits.length >= 7) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  // 4-6 digits — area code + start of prefix.
  if (digits.length >= 4) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  }
  // 1-3 digits — no parens yet, just the digits. Returning `digits` (not
  // the original) normalises away any junk chars the caller passed in.
  return digits;
}
