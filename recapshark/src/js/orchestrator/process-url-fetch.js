// orchestrator/process-url-fetch.js
//
// Owns: every network/IO concern in the processUrl flow. URL parsing +
//       normalization, meta fetch (YouTube Data API via /api/video/meta),
//       duration-cap evaluation against tier-4O languages, and a thin
//       wrapper around the streaming pipeline call.
//
// Reads from AppState: nothing.
// Writes to AppState: nothing.
// Imports allowed: api/client, core/helpers, core/constants. No DOM.
//
// Contract: pure data-in / data-out. No DOM mutations, no AppState writes,
// no toasts/bubbles. Returns plain objects describing the result; the
// orchestrator decides what UI to show based on those objects.
//
// Phase 4c #2 (2026-05-08): extracted from process-url.js as part of the
// SRP-by-concern split (fetch / state / view).

import { Helpers } from '../core/helpers.js';
import { RecapSharkAPI } from '../api/client.js';
import { MAX_VIDEO_DURATION_SEC, TIER_4O_LANGS } from '../core/constants.js';
import {
  FIRST_CHUNK_DUR,
  SHORT_VIDEO_THRESHOLD_SEC,
} from '../player/karaoke-constants.js';

/**
 * Validate the user-pasted URL and normalize to the canonical YouTube
 * watch form.
 *
 * @param {string} raw
 * @returns {{ ok: true, videoId: string, url: string } | { ok: false, reason: 'empty' | 'invalid' }}
 */
export function validateAndNormalizeUrl(raw) {
  if (!raw || !raw.trim()) return { ok: false, reason: 'empty' };
  const videoId = Helpers.extractVideoId(raw);
  if (!videoId) return { ok: false, reason: 'invalid' };
  return { ok: true, videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
}

/**
 * Fetch /api/video/meta for the canonical URL. Returns the raw meta object
 * (or null on backend failure). The orchestrator awaits this BEFORE any
 * visible UI change so the duration-cap path can bail without a half-loaded
 * results view (the previous fire-and-forget approach raced the page
 * transition: on slow networks the cap toast landed AFTER morph completed).
 *
 * Note: a stale-paste guard on `processingVideoId` lives in the orchestrator,
 * not here — fetch itself is pure-IO and doesn't know about app state.
 */
export async function fetchVideoMeta(url) {
  return RecapSharkAPI.getVideoMeta(url);
}

/**
 * Tier-4O × long-video gate. ONLY low-resource languages (Sinhala, Burmese,
 * Yoruba, etc.) route summary/translation through gpt-4o (~10× the cost of
 * gpt-4o-mini). A 4h+ video in one of these langs runs $3-5 in OpenAI
 * alone. Everything else (including 10h English music-only videos) is
 * allowed through — no general duration cap.
 *
 * @param {object|null} meta
 * @returns {{ capped: boolean, message?: string }}
 */
export function evaluateDurationCap(meta) {
  if (!meta) return { capped: false };
  const lang = (meta.lang || '').toLowerCase();
  const overCap = meta.duration > MAX_VIDEO_DURATION_SEC && lang && TIER_4O_LANGS.has(lang);
  if (!overCap) return { capped: false };
  const maxH = Math.floor(MAX_VIDEO_DURATION_SEC / 3600);
  return {
    capped: true,
    message:
      `Videos in this language over ${maxH} hours aren't supported during early access yet — `
      + `try a shorter one or paste a different language.`,
  };
}

/**
 * Thin wrapper around the streaming pipeline. The orchestrator passes its
 * own onProgress + onPartialTranscript closures through; we just forward.
 * Kept here so all network entry points are findable in one file (and so
 * a future swap to a different pipeline implementation only touches one
 * call site).
 *
 * @param {string} url
 * @param {Function} onProgress
 * @param {Function} onPartialTranscript
 * @param {object}   opts                   { metaP }
 */
export function runProcessingPipeline(url, onProgress, onPartialTranscript, opts) {
  return RecapSharkAPI.processVideoTestPipeline(url, onProgress, onPartialTranscript, opts);
}

/**
 * Paste-time karaoke warm. Kicks the backend during the ~30-40s pre-play
 * window so audio download (yt-dlp) + first AsrProvider call are already in
 * flight by the time the player requests chunk 0. Backend single-flight
 * dedups with the player-driven request; we discard the response. Routes
 * to the same endpoint the player would use, keyed on duration:
 *   - ≤ SHORT_VIDEO_THRESHOLD_SEC: /api/karaoke-words-short (single-call bypass)
 *   - >  SHORT_VIDEO_THRESHOLD_SEC: /api/karaoke-chunk?start=0&dur=FIRST_CHUNK_DUR
 * Both constants come from karaoke-chunk-loader.js (single source of truth).
 *
 * Errors are swallowed — the play-time fetch will surface real failures
 * via the normal chunk-loader path. This is purely a latency hide.
 */
// Max total time the warm will keep retrying audio_not_ready before giving
// up. Covers the worst-case yt-dlp download for a long podcast (~30s) plus
// safety margin. After this, the player's own retry path takes over.
const _WARM_MAX_TOTAL_MS = 60000;

// Videos this short don't benefit from warming — the player's own
// short-video bypass call would fire ~1 second after play anyway, and the
// backend single-flight + Supabase cache cover any latency gap. Skipping
// here saves an unnecessary AsrProvider call on every tiny-video paste.
const _WARM_MIN_DURATION_SEC = 10;

export function warmKaraokeFirstChunk(videoId, durationSec, lang) {
  if (!videoId || !durationSec || durationSec <= 0) return;
  if (durationSec < _WARM_MIN_DURATION_SEC) return;
  const langCode = lang || '';
  // Route via the SAME constants the player-driven chunk loader uses, so the
  // single-flight cache key matches when the player's request lands. Both
  // sides import from karaoke-constants.js — single source of truth, no
  // drift risk between this warm path and the player-driven chunk loader.
  const isShort = durationSec <= SHORT_VIDEO_THRESHOLD_SEC;
  // First-chunk dur clamps to videoDur so a 7-min video gets dur=420 not
  // FIRST_CHUNK_DUR — backend validator + chunk-loader's _neededChunks both
  // compute the same clamped value, so single-flight cache key matches.
  const firstChunkDur = Math.min(FIRST_CHUNK_DUR, Math.round(durationSec));
  const callOnce = () => isShort
    ? RecapSharkAPI.karaokeWordsShort(videoId, langCode)
    : RecapSharkAPI.karaokeChunk(videoId, 0, firstChunkDur, langCode, durationSec);
  const startWall = Date.now();
  const attempt = () => {
    callOnce().then((res) => {
      // Retry on audio_not_ready so the warm stays alive through yt-dlp
      // download and triggers AsrProvider as soon as audio lands. Tight 1.5s
      // poll — the server's 15s cooldown is tuned for the player's
      // pause-gating, where a delay is fine; the warm wants to catch
      // audio-ready ASAP. Any other outcome ends the warm — single-flight
      // + cache cover the rest.
      if (res && res.error === 'audio_not_ready' && res.retryable
          && (Date.now() - startWall) < _WARM_MAX_TOTAL_MS) {
        setTimeout(attempt, 1500);
      }
    }).catch(() => {});
  };
  attempt();
}
