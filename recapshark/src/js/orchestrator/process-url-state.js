// orchestrator/process-url-state.js
//
// Owns: all `AppState` mutations + lookups that the processUrl flow makes.
//       Keeps the orchestrator free of `AppState.foo = ...` assignments
//       so the data-flow contract is one place: every state change goes
//       through a named function with a clear intent.
//
// Reads from AppState: player, videoData, currentVideoId, processingVideoId,
//                      currentLang, currentChapters, suggestedQuestions,
//                      summaryFinal, chaptersFinal, processingDone.
// Writes to AppState: processingVideoId, processingDone, rewindMode,
//                     summaryFinal, chaptersFinal, suggestedQuestions,
//                     currentChapters, currentUploadDate.
// Imports: core/state only. No DOM. No fetch. No timers.
//
// Contract: every exported function is synchronous. Reads return primitives
// or simple objects; writes return void. The orchestrator decides when to
// call these — this module never decides flow on its own.
//
// Phase 4c #2 (2026-05-08): extracted from process-url.js as part of the
// SRP-by-concern split (fetch / state / view).

import { AppState } from '../core/state.js';

/* ── Identity helpers ─────────────────────────────────── */

/**
 * Resolve "what video is the page actually showing right now?" Priority:
 *   1. The YT player itself (getVideoData().video_id) — ground truth, the
 *      actual id loaded in the <iframe>.
 *   2. AppState.videoData.videoId — set after the first /api response.
 *   3. AppState.currentVideoId   — set at the top of loadFromApi (covers
 *      the race where videoData is still the old value).
 *   4. AppState.processingVideoId — set the moment processUrl starts;
 *      cleared only at pipeline end or error.
 * Returns null if none of the above are populated.
 */
export function getActiveVideoId() {
  let activeId = null;
  try {
    activeId = AppState.player?.getVideoData?.().video_id || null;
  } catch (_) { /* player may not be ready */ }
  return (
    activeId
    || AppState.videoData?.videoId
    || AppState.currentVideoId
    || AppState.processingVideoId
    || null
  );
}

/**
 * True iff `videoId` matches the one currently being processed AND is NOT
 * yet committed to videoData / currentVideoId — i.e. processUrl is still
 * mid-flight on this id.
 */
export function isInFlight(videoId) {
  return (
    videoId === AppState.processingVideoId
    && videoId !== AppState.videoData?.videoId
    && videoId !== AppState.currentVideoId
  );
}

/**
 * True iff a fresher paste has invalidated this run. Called after every
 * `await` boundary in processUrl so the stale path can early-return.
 */
export function isStalePaste(videoId) {
  return AppState.processingVideoId !== videoId;
}

/* ── Lifecycle markers ────────────────────────────────── */

export function markProcessingStarted(videoId) {
  AppState.processingVideoId = videoId;
}

export function clearProcessingId() {
  AppState.processingVideoId = null;
}

export function markProcessingDone() {
  AppState.processingDone = true;
}

/* ── Rewind flag ──────────────────────────────────────── */

export function setRewindMode(on) {
  // Pre-checks (applyShortVideoSkip, no-captions detection) may have
  // already disabled rewind for this paste — short videos under 10s, or
  // captionless nature/music videos where the rewind has no payload to
  // mask. Refuse to re-enable rewind in those cases; the orchestrator's
  // unconditional `setRewindMode(!isSubsequentPaste)` would otherwise
  // clobber the earlier decision.
  if (on && AppState.isMostlyMusic) on = false;
  AppState.rewindMode = !!on;
  // Each new paste resets the painted flag so the rewind-end reveal
  // re-waits for THIS video's transcript. Without this, a second paste
  // would skip the wait because the previous video's panel had set the
  // flag, and the placeholder would leak through again.
  if (on) AppState.transcriptPainted = false;
}

export function clearRewindMode() {
  AppState.rewindMode = false;
}

/**
 * Short-video skip: rewind mode is purely cosmetic, and on videos under
 * 10s the rewind animation is longer than the content. Disabled here so
 * downstream choreography branches into the no-rewind path.
 *
 * No-captions skip: YT Data API's contentDetails.caption is a fast (~1s)
 * pre-check exposed via /api/video/meta as `has_captions`. When false, the
 * pipeline will return empty content from SubsProvider anyway (~15s wasted) and
 * the rewind animation has nothing to mask. Skip rewind upfront AND prime
 * AppState.isMostlyMusic so the music-only badge/placeholder render on
 * first paint instead of waiting for the slow pipeline signal.
 */
export function applyShortVideoSkip(meta) {
  if (meta?.duration && meta.duration < 10) {
    AppState.rewindMode = false;
  }
  if (meta && meta.has_captions === false) {
    AppState.rewindMode = false;
    AppState.isMostlyMusic = true;
    AppState.transcriptPainted = true;
  }
}

/* ── Per-status pipeline mutations ────────────────────── */

export function applyChaptersUpdate(chapters) {
  if (chapters && chapters.length > 0) {
    AppState.currentChapters = chapters;
  }
}

export function applyUploadDate(date) {
  if (date) {
    AppState.currentUploadDate = date;
  }
}

export function applySummaryFinal() {
  AppState.summaryFinal = true;
}

export function applyChaptersFinal() {
  AppState.chaptersFinal = true;
}

export function applySuggestedQuestions(questions) {
  if (questions && questions.length > 0) {
    AppState.suggestedQuestions = questions;
    return true;
  }
  return false;
}

/* ── Reads (orchestrator decision inputs) ─────────────── */

export function hasTotalLines() {
  return AppState.totalLines > 0;
}

export function getPlayer() {
  return AppState.player;
}
