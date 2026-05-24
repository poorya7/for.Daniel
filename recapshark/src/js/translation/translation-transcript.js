import { TranslationLangMeta } from './lang-meta.js';
import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';
import { Renderer } from '../ui/renderer.js';

const { SECTIONS } = TranslationLangMeta;

/* ── Gather helpers ──────────────────────────────────── */

export function _getTranscriptLines() {
  return (AppState.transcriptRawText || '')
    .split('\n')
    .map(l => l.replace(/^- /, '').trim())
    .filter(Boolean);
}

export function _buildParagraphGroupMap() {
  return AppState.paragraphGroups;
}

/* ── Transcript parsing helpers ─────────────────────── */

export function _parseLine(line) {
  const match = line.match(/^\[([^\]]+)\]\s*(.*)/);
  if (match) {
    const parts = match[1].split(':').map(Number);
    let seconds = 0;
    if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    else if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
    return { seconds, text: match[2] };
  }
  return { seconds: -1, text: line };
}

export function _transcriptLineHTML(line, idx) {
  const p = _parseLine(line);
  if (p.seconds >= 0) {
    return '<div class="transcript-line" data-idx="' + idx + '">' +
      '<span class="ts-chip" data-time="' + p.seconds + '">' + Helpers.fmtTime(p.seconds, AppState.currentLang || '') + '</span>' +
      '<span class="ts-text">' + Helpers.escapeHtml(p.text) + '</span>' +
    '</div>';
  }
  return '<div class="transcript-line" data-idx="' + idx + '">' +
    '<span class="ts-text">' + Helpers.escapeHtml(p.text) + '</span>' +
  '</div>';
}

/* _buildTranscriptHTML removed — dead code. Rendering handled by renderer.js. */

/* ── Hidden translated container (data store) ───────── */

export function _ensureTranslatedContainer(sectionKey) {
  const section = SECTIONS[sectionKey];
  const original = document.getElementById(section.contentId);
  if (!original) return null;

  const containerId = section.contentId + '-translated';
  let container = document.getElementById(containerId);
  if (!container) {
    container = document.createElement('div');
    container.id = containerId;
    container.className = original.className;
    container.style.display = 'none';
    original.after(container);
  }
  container.style.display = 'none';
  return container;
}

export function _removeTranslatedContainers() {
  Object.keys(SECTIONS).forEach(key => {
    const el = document.getElementById(SECTIONS[key].contentId + '-translated');
    if (el) el.remove();
  });
}

/* ── Render to hidden container ─────────────────────── */

export function _renderSummaryToContainer(summaryText) {
  const container = _ensureTranslatedContainer('summary');
  if (container && summaryText) {
    container.classList.remove('translation-ghost');
    const paragraphs = summaryText.split('\n\n').filter(p => p.trim());
    container.innerHTML = Renderer.summaryHTML(paragraphs);
  }
}

export function _renderChaptersToContainer(chapters) {
  const container = _ensureTranslatedContainer('chapters');
  if (container && chapters) {
    container.classList.remove('translation-ghost');
    const lang = AppState.videoData?.lang || '';
    container.innerHTML = chapters.map((ch, i) =>
      '<div class="chapter-item" data-chapter="' + i + '">' +
        '<span class="chapter-num">' + Helpers.localizeNum(i + 1, lang) + '.</span>' +
        '<span class="chapter-name">' + Helpers.escapeHtml(ch.title || '') + '</span>' +
      '</div>'
    ).join('');
  }
}

/* _renderTranscriptToContainer and _renderTranscriptChunkToContainer removed — dead code.
   Transcript rendering is handled by renderer.js buildTranscriptParagraphHtml(). */
