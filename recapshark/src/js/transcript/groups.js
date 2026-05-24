// transcript/groups.js
//
// Owns: deriving paragraph-grouped lines from the original transcript text.
// Reads from AppState: transcriptRawText.
// Writes to AppState: paragraphGroups.
// Imports allowed: core/state, core/helpers.

import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';

/* ── Paragraph groups: compute once from original English text ── */
export function computeParagraphGroups() {
  const lines = (AppState.transcriptRawText || '')
    .split('\n').map(l => l.replace(/^- /, '').trim()).filter(Boolean);
  AppState.paragraphGroups = Helpers.groupLinesByParagraph(lines);
}
