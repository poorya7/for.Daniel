import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';
import { SEARCH_DEBOUNCE_MS } from '../core/constants.js';
import { Analytics } from '../analytics/analytics.js';
import { Renderer } from './renderer.js';
import { TranscriptBuffer } from './transcript-buffer.js';

/**
 * RecapShark Search Manager
 * Handles transcript search, keyword chips, and highlight management.
 * Single responsibility: search UI and transcript highlighting.
 */
export const SearchManager = (() => {
  const searchInput = document.getElementById('searchInput');
  const searchResults = document.getElementById('searchResults');
  const searchClear = document.getElementById('searchClear');

  function reset() {
    searchInput.value = '';
    searchResults.innerHTML = '';
    searchClear.classList.remove('visible');
    const chips = document.getElementById('searchChips');
    if (chips) chips.innerHTML = '';
  }

  function runSearch() {
    const q = searchInput.value.trim().toLowerCase();
    Analytics.searchUsed(q);
    searchResults.innerHTML = '';
    const fullTranscript = TranscriptBuffer.getActive('transcript');
    if (!q || q.length < 2) {
      if (fullTranscript) fullTranscript.style.display = '';
      searchResults.style.display = 'none';
      return;
    }
    if (fullTranscript) fullTranscript.style.display = 'none';
    searchResults.style.display = '';

    const hits = AppState.transcriptSegments.filter(seg =>
      (seg.text || '').toLowerCase().includes(q)
    );

    if (hits.length === 0) {
      searchResults.innerHTML = '<div class="search-empty">No matches found.</div>';
      return;
    }

    const countEl = document.createElement('div');
    countEl.className = 'search-count';
    countEl.textContent = `${hits.length} match${hits.length !== 1 ? 'es' : ''} found`;
    searchResults.appendChild(countEl);

    hits.forEach(seg => {
      const idx = (seg.text || '').toLowerCase().indexOf(q);
      const RADIUS = 60;
      const start = Math.max(0, idx - RADIUS);
      const end = Math.min(seg.text.length, idx + q.length + RADIUS);
      const prefix = start > 0 ? '...' : '';
      const suffix = end < seg.text.length ? '...' : '';
      const snippet = prefix + seg.text.slice(start, end) + suffix;

      const div = document.createElement('div');
      div.className = 'transcript-line';
      div.innerHTML =
        `<span class="ts-chip" data-time="${seg.startTime}">${Helpers.fmtTime(seg.startTime)}</span>` +
        `<span class="ts-text">${Helpers.highlightQueryInText(snippet, q)}</span>`;
      div.addEventListener('click', () => handleTranscriptSegmentClick(seg, q));
      searchResults.appendChild(div);
    });
  }

  function handleTranscriptSegmentClick(segment, query) {
    Helpers.seekTo(segment.startTime);

    searchInput.value = '';
    searchResults.innerHTML = '';
    searchClear.classList.remove('visible');
    const chips = document.getElementById('searchChips');
    if (chips) chips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    const ft = TranscriptBuffer.getActive('transcript');
    if (ft) ft.style.display = '';

    if (query) highlightTranscriptQuery(query);
    Renderer.showTranscriptAt(segment.startTime);
  }

  function highlightTranscriptQuery(query) {
    const panel = TranscriptBuffer.getActive('transcript');
    if (!panel || !query) return;
    const q = query.trim();
    if (!q) return;
    const rows = panel.querySelectorAll('.ts-text');
    const re = new RegExp(`(${Helpers.escapeRegex(q)})`, 'gi');
    const qLower = q.toLowerCase();
    for (const row of rows) {
      const text = row.textContent;
      if (!text.toLowerCase().includes(qLower)) continue;
      const parts = text.split(re);
      row.innerHTML = parts
        .map(part => (part.toLowerCase() === qLower ? `<mark>${Helpers.escapeHtml(part)}</mark>` : Helpers.escapeHtml(part)))
        .join('');
    }
    _showHighlightPill(query);
  }

  function clearTranscriptHighlight() {
    const panel = TranscriptBuffer.getActive('transcript');
    if (!panel) return;
    const marks = panel.querySelectorAll('.ts-text mark');
    if (!marks.length) return;
    panel.classList.remove('highlight-hidden');
    document.getElementById('fullTranscriptPanel')?.classList.remove('highlight-hidden');
    for (const row of panel.querySelectorAll('.ts-text')) {
      if (row.querySelector('mark')) row.textContent = row.textContent;
    }
    _removeHighlightPill();
  }

  function _showHighlightPill(query) {
    _removeHighlightPill();
    const panel = document.getElementById('tab-transcript');
    if (!panel) return;
    const pill = document.createElement('div');
    pill.id = 'highlightPill';
    pill.className = 'highlight-pill';
    pill.innerHTML = `"${Helpers.escapeHtml(query)}" <button type="button" aria-label="Clear highlight">&times;</button>`;
    pill.querySelector('button').addEventListener('click', clearTranscriptHighlight);
    panel.appendChild(pill);
    TranscriptBuffer.getActive('transcript')?.classList.remove('highlight-hidden');
    _showHighlightToggle(true);
    document.getElementById('highlightToggleBtn')?.classList.remove('off');
  }

  function _removeHighlightPill() {
    const pill = document.getElementById('highlightPill');
    if (pill) pill.remove();
    _showHighlightToggle(false);
  }

  function _showHighlightToggle(show) {
    const btn = document.getElementById('highlightToggleBtn');
    if (!btn) return;
    btn.classList.toggle('visible', !!show);
    // When freshly shown, default to ON (highlight visible).
    // When hidden, drop both state classes.
    if (show) {
      btn.classList.add('on');
      btn.classList.remove('off');
    } else {
      btn.classList.remove('on');
      btn.classList.remove('off');
    }
  }

  function toggleHighlightVisibility() {
    const fullPanel = document.getElementById('fullTranscriptPanel');
    const btn = document.getElementById('highlightToggleBtn');
    if (!fullPanel || !btn) return;
    // The CSS selector is `#fullTranscriptPanel.highlight-hidden .ts-text mark`,
    // so the class must live on #fullTranscriptPanel, not on a child buffer.
    const isHidden = fullPanel.classList.toggle('highlight-hidden');
    btn.classList.toggle('off', isHidden);
    btn.classList.toggle('on', !isHidden);
  }

  /* ── Suggestion Chips ───────────────────────────────── */

  function renderChips() {
    const groups = AppState.videoData.keywords || {};

    function buildChipsHtml() {
      return Object.entries(groups).map(([cat, words]) =>
        `<div class="chip-group">
          <span class="chip-label">${Helpers.escapeHtml(cat)}</span>
          ${words.map(kw => `<button class="chip" data-keyword="${Helpers.escapeHtml(kw)}">${Helpers.escapeHtml(kw)}</button>`).join('')}
        </div>`
      ).join('');
    }

    const searchChips = document.getElementById('searchChips');
    searchChips.innerHTML = buildChipsHtml();

    searchChips.addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const wasActive = chip.classList.contains('active');
      searchChips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      if (wasActive) {
        searchInput.value = '';
        searchResults.innerHTML = '';
        searchClear.classList.remove('visible');
        const fullTranscript = TranscriptBuffer.getActive('transcript');
        if (fullTranscript) fullTranscript.style.display = '';
      } else {
        chip.classList.add('active');
        searchInput.value = chip.dataset.keyword;
        searchClear.classList.add('visible');
        runSearch();
      }
    });
  }

  /* ── Event Listeners ────────────────────────────────── */

  document.getElementById('highlightToggleBtn')?.addEventListener('click', toggleHighlightVisibility);

  searchInput.addEventListener('input', () => {
    clearTranscriptHighlight();
    searchClear.classList.toggle('visible', searchInput.value.length > 0);
    clearTimeout(AppState.searchDebounce);
    if (searchInput.value.trim().length < 2) {
      searchResults.innerHTML = '';
      const ft = TranscriptBuffer.getActive('transcript');
      if (ft) ft.style.display = '';
    } else {
      AppState.searchDebounce = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
    }
  });

  searchClear.addEventListener('click', () => {
    clearTranscriptHighlight();
    searchInput.value = '';
    searchResults.innerHTML = '';
    searchClear.classList.remove('visible');
    const chips = document.getElementById('searchChips');
    if (chips) chips.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    const fullTranscript = TranscriptBuffer.getActive('transcript');
    if (fullTranscript) fullTranscript.style.display = '';
    searchInput.focus();
  });

  return { reset, runSearch, renderChips, clearTranscriptHighlight, highlightTranscriptQuery };
})();
