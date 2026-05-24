/**
 * formatBudget — display normalisation for the Budget field.
 *
 * Two consumers today:
 *   1. The hero line in the review-card heading (the big amber italic).
 *   2. The Budget row's `.review-value` span inside the field list.
 * Plus the no-panel canvas's live editor — runs on every keystroke
 * while the broker is typing, so the function MUST be idempotent and
 * MUST cope with mid-typing states where existing commas are stale.
 *
 * The LLM is instructed to emit budgets as standard US currency
 * (`$600,000`, `$1,200,000-$1,500,000`, etc.) but it sometimes passes
 * a bare-digit string through ("373838" instead of "$373,838") —
 * especially for unusual amounts that don't match its "looks like
 * real-estate shorthand" heuristics. Rather than tightening the prompt
 * to chase every edge case (and slowing the stream), the frontend
 * normalises the displayed text at the seam between data and pixels:
 * any 4-or-more-digit run gets thousands commas, and a missing `$`
 * prefix is added when the value reads as a pure-numeric currency.
 *
 * The persisted value (what lands in the Google Sheet) is whatever
 * the editor commits, which after live-formatting is the polished
 * version (e.g. "$700,000" not "700000"). The formatter is idempotent
 * so re-displaying the saved value reads the same.
 *
 * Behaviour examples (the live-typing failure modes are explicit):
 *   "373838"                  → "$373,838"
 *   "$500,000"                → "$500,000"        (idempotent)
 *   "500000-700000"           → "$500,000-$700,000"
 *   "under 600000"            → "under $600,000"
 *   "$1,0000"                 → "$10,000"          (mid-typing: stale comma)
 *   "$1,00000"                → "$100,000"         (mid-typing: stale comma)
 *   "$500k-$700k"             → "$500k-$700k"      (shorthand preserved)
 *   "around 1.5m"             → "around 1.5m"     (shorthand preserved)
 *   "12"                      → "12"               (under the 4-digit floor)
 *   "TBD"                     → "TBD"              (no digits)
 *   null / ""                 → ""                 (caller renders missing state)
 *
 * The mid-typing fixes are the load-bearing piece for the live editor:
 * the previous implementation skipped formatting whenever a digit run
 * was preceded by a comma, which meant any comma the formatter itself
 * had injected on a prior keystroke locked future digits out of being
 * re-grouped. The new pass treats digit-and-comma runs as a single
 * "currency token", strips the commas, and re-groups from scratch.
 */
export function formatBudget(value: string | null | undefined): string {
  if (!value) return "";

  // DO NOT trim the input — when this runs on every keystroke of the
  // live editor the broker's spaces, newlines, dashes, punctuation are
  // meaningful keystrokes that must round-trip. Display callers that
  // want whitespace stripped can call `.trim()` themselves on the way
  // in. Earlier versions of this function trimmed and that broke the
  // ability to type a space at all in the live editor.

  // Walk the string, finding "currency tokens" — runs that start at
  // a digit and continue through digits and embedded commas. Each
  // token gets its commas stripped, its length checked, and if it
  // qualifies (≥4 digits) gets re-grouped with thousands separators.
  // Tokens followed by k / K / m / M (shorthand suffix) or preceded
  // by `.` (decimal portion) are left untouched.
  let result = "";
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < value.length && /[0-9,]/.test(value[j])) j++;
      // Trim a trailing comma off the token — a comma at the very end
      // of a digit run is a user-typed separator, not part of the
      // number itself (e.g. "$500, flexible").
      let tokenEnd = j;
      while (tokenEnd > i && value[tokenEnd - 1] === ",") tokenEnd--;
      const token = value.slice(i, tokenEnd);
      const digits = token.replace(/,/g, "");
      const before = value[i - 1];
      const after = value[tokenEnd];
      const partOfDecimal = before === ".";
      const hasUnitSuffix = /[kKmM]/.test(after);
      const shouldFormat =
        digits.length >= 4 && !partOfDecimal && !hasUnitSuffix;
      if (shouldFormat) {
        result += withThousandsCommas(digits);
      } else {
        // Preserve the original (including any user-typed commas)
        // when the run doesn't qualify for currency formatting.
        result += token;
      }
      // Copy any trailing comma(s) we trimmed off above.
      result += value.slice(tokenEnd, j);
      i = j;
    } else {
      result += ch;
      i++;
    }
  }

  // Second pass: add a `$` prefix to any digit run that isn't already
  // preceded by `$` or a decimal point, AND strip any `$` immediately
  // trailing a digit run (the dollar sign belongs at the front of a
  // number — never at both ends). Handles ranges like
  // "500,000-700,000" → "$500,000-$700,000" by treating each digit run
  // independently.
  let prefixed = "";
  let k = 0;
  while (k < result.length) {
    const ch = result[k];
    if (/[0-9]/.test(ch)) {
      const prev = result[k - 1];
      const needsDollar = prev !== "$" && prev !== ".";
      if (needsDollar) prefixed += "$";
      while (k < result.length && /[0-9,]/.test(result[k])) {
        prefixed += result[k];
        k++;
      }
      // Swallow any `$` that landed right after the number — it would
      // read as a trailing dollar sign in the rendered output.
      while (k < result.length && result[k] === "$") k++;
    } else {
      prefixed += ch;
      k++;
    }
  }
  return prefixed;
}

function withThousandsCommas(digits: string): string {
  // Standard left-to-right thousands grouping. Pre-condition: input is
  // an unsigned integer string with no embedded commas.
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
