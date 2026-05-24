/**
 * Translation module shared state.
 * Leaf file — no imports from other translation modules.
 *
 * displayMode values:
 *   'original'         — show only the video's original language
 *   'translated'       — show only the selected translation (DEFAULT when a language is selected)
 *   'bilingual'        — side by side: original (col 2) + translation (col 3)
 *   'bilingual-swapped' — side by side swapped: translation (col 2) + original (col 3)
 */

export const tState = {
  langToggleBtn: null,
  bilingualControls: null,
  displayMode: 'original',   // 'original' | 'translated' | 'bilingual' | 'bilingual-swapped'
  pendingRequest: null,
};

export const greetingCache = {};
