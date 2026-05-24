// player-subtitles.js
//
// Owns: subtitle overlay (CC) — toggle button wiring, the 200ms sync loop,
//       long-segment chunking + display-text resolution, binary-search
//       lookup of the active segment for a given time.
// Reads from AppState: player, subtitleSegments, ccEnabled, ccInterval.
// Imports allowed: ../core/state.
// Coupling notes: standalone — no sibling imports, no callbacks needed
//                 from player.js core. The mech CC button hooks into
//                 toggleCC + startSubtitleSync via the controls module.

import { AppState } from '../core/state.js';

// Threshold (in chars) above which a single subtitle segment is treated as
// "abnormally long" and gets time-sliced into smaller display chunks. 50
// chars ≈ a short clause, which already wraps to 2 lines on a typical
// mobile video frame. Anything above that gets sliced so a single segment
// never spans 3+ lines and chews up the video.
const LONG_SEGMENT_TEXT_THRESHOLD = 50;
// Words per displayed chunk when slicing kicks in. 7 words ≈ 1 line on
// mobile / 1 line on desktop at the overlay's font-size. Keeps every
// chunk visually glanceable without obscuring the picture.
const SUBTITLE_CHUNK_WORDS = 7;
// Minimum time (seconds) each chunk stays on screen before rotating to
// the next. Without this, a short segment with lots of text would
// produce many chunks that flash past too fast to read — that's the
// "missing words" symptom on Persian-source videos where individual
// segments are long. Merge chunks until every one gets ≥ this time.
const MIN_CHUNK_DURATION_S = 1.6;

function initSubtitles() {
  const btn = document.getElementById('ccToggle');
  const mechCc = document.getElementById('mechCcBtn');
  if (!btn && !mechCc) return;
  if (AppState.subtitleSegments.length === 0) {
    if (btn) btn.style.display = 'none';
    return;
  }
  if (btn) { btn.style.display = 'block'; btn.onclick = toggleCC; }
  AppState.ccEnabled = false;
}

function toggleCC() {
  AppState.ccEnabled = !AppState.ccEnabled;
  const btn = document.getElementById('ccToggle');
  const mechCc = document.getElementById('mechCcBtn');
  const overlay = document.getElementById('subtitleOverlay');
  if (btn) btn.classList.toggle('active', AppState.ccEnabled);
  if (mechCc) mechCc.classList.toggle('on', AppState.ccEnabled);
  if (AppState.ccEnabled) {
    startSubtitleSync();
  } else {
    stopSubtitleSync();
    if (overlay) overlay.style.display = 'none';
  }
}

function startSubtitleSync() {
  if (AppState.ccInterval) return;
  AppState.ccInterval = setInterval(syncSubtitle, 200);
}

function stopSubtitleSync() {
  if (AppState.ccInterval) { clearInterval(AppState.ccInterval); AppState.ccInterval = null; }
}

/**
 * Split a long subtitle segment's text into display-sized chunks. Tries to
 * preserve sentence boundaries first (so a chunk doesn't end mid-thought
 * when possible); any sentence still longer than SUBTITLE_CHUNK_WORDS gets
 * further split into word groups. The result is what syncSubtitle indexes
 * into based on the user's current playback position within the segment.
 */
function _chunkLongSegmentText(text, durationS) {
  if (!text) return [];
  // Match sentences ending in . ! ? plus any trailing tail without punctuation.
  // Works for English and translated text — punctuation marks are language-
  // agnostic enough for our purposes (Persian/Arabic also use . ! ?).
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|\S+[^.!?]*$/g) || [text];
  let chunks = [];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    const words = s.split(/\s+/);
    if (words.length <= SUBTITLE_CHUNK_WORDS) {
      chunks.push(s);
    } else {
      for (let i = 0; i < words.length; i += SUBTITLE_CHUNK_WORDS) {
        chunks.push(words.slice(i, i + SUBTITLE_CHUNK_WORDS).join(' '));
      }
    }
  }
  if (!chunks.length) chunks = [text];

  // Cap chunk count by duration: every chunk must stay on screen for at
  // least MIN_CHUNK_DURATION_S so the user can actually read it. If the
  // segment is short relative to its text, merge adjacent chunks until
  // the time budget per chunk is met. Without this cap, a 5s segment
  // with 30 words gets sliced into 5 chunks of ~1s each — too fast to
  // read, so the user sees half the words "go missing".
  if (durationS && durationS > 0 && chunks.length > 1) {
    const maxChunks = Math.max(1, Math.floor(durationS / MIN_CHUNK_DURATION_S));
    while (chunks.length > maxChunks) {
      const merged = [];
      for (let i = 0; i < chunks.length; i += 2) {
        merged.push(i + 1 < chunks.length ? chunks[i] + ' ' + chunks[i + 1] : chunks[i]);
      }
      chunks = merged;
    }
  }
  return chunks;
}

/**
 * Pick the visible text for the overlay given the current playback time.
 * Short segments are returned as-is; long segments are sliced and we pick
 * the chunk whose share of the segment's [start, end) range contains `t`.
 * Chunks are memoized on the segment under `_chunks` (keyed by `_chunksFor`
 * so a language switch / translation that mutates seg.text invalidates the
 * cache automatically).
 */
function _displayTextForSegment(seg, t) {
  if (!seg || !seg.text) return '';
  if (seg.text.length <= LONG_SEGMENT_TEXT_THRESHOLD) return seg.text;
  if (seg._chunksFor !== seg.text) {
    // Bug fix (translated subtitles): when the user picks a translation
    // language, _updateSubtitles maps each ORIGINAL segment to its
    // translated transcript LINE — and translation often groups multiple
    // original segments into one paragraph. Result: 3+ adjacent segments
    // can share the exact same translated text. Without grouping, each
    // segment chunks independently and the user sees chunk 0→1→2 then
    // chunk 0 again at the next segment boundary — looks like the
    // overlay "goes back" or "missing words". Group adjacent
    // same-text segments so chunk progression spans the whole group.
    const segs = AppState.subtitleSegments;
    let i = segs.indexOf(seg);
    let gs = seg.start, ge = seg.end;
    if (i >= 0) {
      for (let j = i - 1; j >= 0 && segs[j].text === seg.text; j--) gs = segs[j].start;
      for (let j = i + 1; j < segs.length && segs[j].text === seg.text; j++) ge = segs[j].end;
    }
    seg._groupStart = gs;
    seg._groupEnd = ge;
    // Pass the GROUP duration so chunk-merging caps chunk count by
    // available reading time across the whole group, not just one
    // original segment. Critical for Persian-source videos where each
    // segment is long-text-short-time and individual segments would
    // produce too-fast chunks (the "missing words" symptom).
    seg._chunks = _chunkLongSegmentText(seg.text, ge - gs);
    seg._chunksFor = seg.text;
  }
  const chunks = seg._chunks;
  if (!chunks || chunks.length <= 1) return chunks && chunks[0] || seg.text;
  const gs = seg._groupStart;
  const ge = seg._groupEnd;
  const dur = Math.max(0.001, ge - gs);
  const progress = Math.max(0, Math.min(0.9999, (t - gs) / dur));
  const idx = Math.min(chunks.length - 1, Math.floor(progress * chunks.length));
  return chunks[idx];
}

function syncSubtitle() {
  const overlay = document.getElementById('subtitleOverlay');
  if (!overlay || !AppState.player || typeof AppState.player.getCurrentTime !== 'function') return;
  const t = AppState.player.getCurrentTime();
  const seg = findSubtitleAt(t);
  const text = seg ? _displayTextForSegment(seg, t) : '';
  const span = overlay.querySelector('span');
  if (!span) { overlay.textContent = text; overlay.style.display = seg ? 'block' : 'none'; return; }
  if (seg) {
    span.textContent = text;
    overlay.style.display = 'block';
  } else {
    overlay.style.display = 'none';
  }
}

function findSubtitleAt(t) {
  let lo = 0, hi = AppState.subtitleSegments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const s = AppState.subtitleSegments[mid];
    if (t >= s.start && t < s.end) return s;
    if (t < s.start) hi = mid - 1;
    else lo = mid + 1;
  }
  return null;
}

export const PlayerSubtitles = {
  initSubtitles,
  toggleCC,
  startSubtitleSync,
  stopSubtitleSync,
  syncSubtitle,
  findSubtitleAt,
};
