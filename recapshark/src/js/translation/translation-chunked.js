/**
 * RecapShark Translation — Chunked GPT Transcript Translation Fallback
 *
 * Called from the bulk-translation path's `.catch` (and `.then` when the
 * backend signals `data.fallback`). Splits the transcript into N-line
 * chunks and translates them via gpt-4o(-mini) with a faux-progress timer
 * that interpolates between real chunk completions so the percentage
 * never freezes for users on advanced (slower) languages.
 *
 * Self-contained except for shared deps imported at top + a few callbacks
 * passed in from the orchestrator. The chunk size, concurrency, and
 * per-chunk timeout are unchanged from the original (12 lines for advanced
 * langs / TRANSLATION_JSON_CHUNK_LINES otherwise; TRANSLATION_MAX_CONCURRENT
 * parallel requests; tChunk timeout passed through from advanced-lang
 * detection).
 *
 * Extracted from translation.js as part of Phase 4c #3 (SRP file split).
 * Behaviour byte-identical.
 */
import { tState } from './translation-state.js';
import * as UI from './translation-ui.js';
import { TranslationLangMeta } from './lang-meta.js';
import { TRANSLATION_JSON_CHUNK_LINES, TRANSLATION_MAX_CONCURRENT } from '../core/constants.js';
import { RecapSharkAPI } from '../api/client.js';
import { Renderer } from '../ui/renderer.js';
import { scheduleRender } from '../ui/casual-mode.js';

const { ADVANCED_MODEL_LANGS } = TranslationLangMeta;

/**
 * Chunked GPT translation — fallback for advanced languages or when the
 * Google bulk endpoint reports unavailable.
 *
 * @param {Object} args
 * @param {Array}    args.allLines           — [{id, text}, ...] lines to translate
 * @param {Object}   args.cache              — translation cache object (mutates `transcriptMap`)
 * @param {string}   args.sourceLang         — ISO code of the source language
 * @param {string}   args.langCode           — ISO code of the target language
 * @param {string}   args.requestId          — used to no-op late callbacks if user switched lang
 * @param {number}   [args.tChunk]           — per-chunk request timeout (ms); undefined for default
 * @param {Function} args.onSectionDone      — () => void; fires when transcript section completes
 * @param {Function} args.onTranscriptComplete — () => void; fires when ALL chunks done (entity hook)
 */
export function translateChunked(args) {
  const { allLines, cache, sourceLang, langCode, requestId, tChunk, onSectionDone, onTranscriptComplete } = args;

  // Advanced langs route to gpt-4o on the backend, which is meaningfully
  // slower per call than gpt-4o-mini. Fewer lines per chunk = each call
  // finishes faster and is far less likely to hit the per-attempt timeout.
  // Without this, Amharic/Tibetan/etc. would 500 every chunk and end up
  // with an empty cache (no translated transcript or subtitles). 12 lines
  // is the sweet spot from observation: small enough to stay under the
  // backend's 60s per-call cap on gpt-4o, large enough to keep total
  // request count manageable. Non-advanced langs that ever land here
  // (rare — they normally go through the bulk Google path) keep the
  // default 25-line chunks.
  const isAdvanced = ADVANCED_MODEL_LANGS.has(langCode);
  const chunkLines = isAdvanced ? 12 : TRANSLATION_JSON_CHUNK_LINES;
  const chunks = [];
  for (let i = 0; i < allLines.length; i += chunkLines) {
    chunks.push(allLines.slice(i, i + chunkLines));
  }

  let chunksDone = 0;
  let displayedPct = 0;
  let lastChunkTime = Date.now();
  let estimatedChunkMs = 6000;
  let pctTimer = null;
  let hasQualityWarning = false;

  function _realPct() { return Math.round((chunksDone / chunks.length) * 100); }
  function _showPct(pct) { displayedPct = Math.min(pct, 99); UI._showTranslateProgress(displayedPct); }

  function _startPctTimer() {
    _stopPctTimer();
    const basePct = _realPct();
    const nextPct = Math.min(Math.round(((chunksDone + 1) / chunks.length) * 100), 95);
    if (basePct >= nextPct) return;
    const pctRange = nextPct - basePct;
    const tickInterval = 400;
    const totalTicks = Math.max(Math.floor(estimatedChunkMs / tickInterval), 1);
    const pctPerTick = pctRange / totalTicks;
    let ticks = 0;
    pctTimer = setInterval(() => {
      ticks++;
      const fakePct = Math.min(basePct + Math.round(pctPerTick * ticks), nextPct);
      if (fakePct > displayedPct) _showPct(fakePct);
      if (ticks >= totalTicks) _stopPctTimer();
    }, tickInterval);
  }

  function _stopPctTimer() { if (pctTimer) { clearInterval(pctTimer); pctTimer = null; } }

  /**
   * Final-chunk cleanup. Called from BOTH the success-final branch
   * (_onChunkDone) and the catch-final branch (_fetchChunk). Without
   * this called from both, all-chunks-errored runs (e.g. Amharic on a
   * flaky gpt-4o day) left the per-tab "Translating transcript to X…"
   * banners hanging forever — the original code only hid them on the
   * success-final branch.
   *
   * Mark-ready + entity-hook fire only if we actually got some content;
   * a zero-success run shouldn't lie that the section is ready.
   */
  function _finalizeTranscriptDone() {
    _stopPctTimer();
    Renderer.hidePanelProgress('tab-transcript');
    if (cache.transcriptMap.size > 0) {
      UI._markSectionReady('transcript');
      if (typeof onTranscriptComplete === 'function') onTranscriptComplete();
    }
    onSectionDone();
  }

  function _onChunkDone(lines) {
    for (const item of lines) {
      cache.transcriptMap.set(Number(item.id), item.text);
    }
    chunksDone++;
    const now = Date.now();
    const elapsed = now - lastChunkTime;
    lastChunkTime = now;
    estimatedChunkMs = chunksDone > 1 ? Math.round(estimatedChunkMs * 0.4 + elapsed * 0.6) : elapsed;
    scheduleRender();
    if (chunksDone >= chunks.length) {
      _finalizeTranscriptDone();
      return;
    }
    _showPct(_realPct());
    _startPctTimer();
  }

  function _fetchChunk(idx) {
    return RecapSharkAPI.translateTranscriptJson(chunks[idx], sourceLang, langCode, tChunk)
      .then(data => {
        if (tState.pendingRequest !== requestId) return;
        if (data.warning === 'low_quality') hasQualityWarning = true;
        _onChunkDone(data.lines || []);
      })
      .catch(err => {
        console.error('[Translation:json-chunk:' + idx + ']', err);
        chunksDone++;
        if (chunksDone >= chunks.length) { _finalizeTranscriptDone(); }
        else { _showPct(_realPct()); _startPctTimer(); }
      });
  }

  function _processChunksParallel(startIdx) {
    const queue = [];
    for (let i = startIdx; i < chunks.length; i++) queue.push(i);
    let running = 0, queueIdx = 0;
    function _next() {
      while (running < TRANSLATION_MAX_CONCURRENT && queueIdx < queue.length) {
        running++;
        const ci = queue[queueIdx++];
        _fetchChunk(ci).then(() => { running--; _next(); });
      }
    }
    _next();
  }

  _showPct(0);
  _startPctTimer();
  _fetchChunk(0).then(() => { _processChunksParallel(1); });
}
