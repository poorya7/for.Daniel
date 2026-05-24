/**
 * Saved-summary helpers.
 *
 * The previous visual `SavedConfirmation` component was retired in
 * favour of the merged `OutcomePanel` (which morphs in place from
 * the "Saving" status to "Saved" without a phase swap). What's left
 * here is the structured summary type + builder — still used by
 * `ReviewCard` to package the saved state and by `OutcomePanel` to
 * render the done-line ("Saved Maria from Maple St").
 */

/**
 * Pieces of the personalised "Saved …" headline. Splitting `name`
 * and `area` out as separate fields lets the heading render each
 * one in the brand colour so the personal parts of the sentence
 * pop without dragging the whole copy with them.
 */
export interface SavedSummary {
  /** Opening word ("Saved"). */
  prefix: string;
  /** Extracted name, rendered in the brand colour. `null` when missing. */
  name: string | null;
  /** Connecting copy between name and area (" from " or empty). */
  connector: string;
  /** Extracted area / city, rendered in the brand colour. `null` when missing. */
  area: string | null;
  /** Trailing copy ("your lead" fallback when name missing, otherwise empty). */
  fallback: string;
}

/**
 * Build the personalised "Saved …" summary shown on the confirmation
 * surface. Returns the prefix and the personal parts (name, area) as
 * separate fields so the heading can render each in its own accent.
 * Adapts to whatever fields the AI actually picked up:
 *
 *   name + area  → "Saved" "Maria Lopez" "from" "Maple St"
 *   name only    → "Saved" "Maria Lopez"
 *   area only    → "Saved" "your lead" "from" "Maple St"
 *   neither      → "Saved" "your lead"
 *
 * Multi-row variants ("Saved 30 leads") will land alongside the photo
 * sign-in-sheet flow in step 8.
 */
export function composeSavedSummary(
  name: string | null,
  area: string | null,
): SavedSummary {
  const trimmedName = name?.trim() || null;
  const trimmedArea = area?.trim() || null;
  if (trimmedName && trimmedArea) {
    return {
      prefix: "Saved",
      name: trimmedName,
      connector: " from ",
      area: trimmedArea,
      fallback: "",
    };
  }
  if (trimmedName) {
    return {
      prefix: "Saved",
      name: trimmedName,
      connector: "",
      area: null,
      fallback: "",
    };
  }
  if (trimmedArea) {
    return {
      prefix: "Saved",
      name: null,
      connector: " from ",
      area: trimmedArea,
      fallback: "your lead",
    };
  }
  return {
    prefix: "Saved",
    name: null,
    connector: "",
    area: null,
    fallback: "your lead",
  };
}
