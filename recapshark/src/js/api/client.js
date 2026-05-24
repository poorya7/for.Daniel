/**
 * RecapShark API Client
 * Low-level HTTP communication with the backend.
 * Single responsibility: fetch wrapper, translation calls, chat call.
 */

// API token used in the `X-API-Token` header for all /api/* calls except
// /api/health — exported so other modules that don't route through the
// `RecapSharkAPI` wrapper (e.g. `analytics.js`'s keepalive chat-log POST)
// can attach the same header without re-hardcoding the literal.
//
// SECURITY: this token is extractable from the minified bundle by any
// visitor — it's a friction layer against trivial scripted abuse, not an
// authentication boundary. The actual auth boundary is server-side
// rate-limiting + Sentry-monitored anomaly detection. Replacing this
// with per-user auth is tracked in the security backlog.
//
// Note: the literal below is a placeholder. The production token is
// injected at build time from an env var and is omitted from this
// code-review sample.
export const API_TOKEN = '__SAMPLE_API_TOKEN__';

export const RecapSharkAPI = (() => {
  let baseUrl = window.location.origin;

  const _API_TOKEN = API_TOKEN;

  async function _fetch(url, opts = {}) {
    const noRetry = opts.noRetry === true;
    if (noRetry) delete opts.noRetry;
    opts.headers = Object.assign({ 'X-API-Token': _API_TOKEN }, opts.headers || {});
    const res = await fetch(url, opts);
    if (res.status === 429 && !noRetry) {
      await new Promise(r => setTimeout(r, 3000));
      return fetch(url, opts);
    }
    return res;
  }

  function userFacingError(detail, fallback) {
    if (!detail || typeof detail !== 'string') return fallback;
    if (detail.length > 120 || /statusCode|"message":|"path":|request_id/i.test(detail)) return fallback;
    return detail;
  }

  function setBaseUrl(url) {
    baseUrl = url.replace(/\/$/, '');
  }

  async function getVideoMeta(videoUrl) {
    const res = await _fetch(`${baseUrl}/api/video/meta?url=${encodeURIComponent(videoUrl)}`)
      .catch(() => null);
    if (!res || !res.ok) return null;
    return res.json().catch(() => null);
  }

  function logChatMessage(body) {
    // keepalive=true lets the request finish even if the page is unloading
    // (e.g. user fires the chat then closes the tab). Failures swallowed —
    // chat MUST continue working even if the analytics POST drops.
    // X-API-Token is required: every /api/* route except /api/health is
    // gated by the server's token middleware (pipeline/server.py).
    try {
      fetch(`${baseUrl}/api/analytics/chat/log`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Token': _API_TOKEN,
        },
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {});
    } catch (_) { /* never break chat over a logging failure */ }
  }

  async function chatWithVideo({ formattedTranscript, segments, question, history, lang, videoLang, videoDuration, videoTitle, videoChannel, summary, casual }) {
    const headers = { 'Content-Type': 'application/json' };
    const res = await _fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        transcript_text: formattedTranscript || '',
        segments: formattedTranscript ? [] : (segments || []),
        question,
        history,
        lang,
        video_lang: videoLang,
        video_duration: videoDuration,
        video_title: videoTitle || '',
        video_channel: videoChannel || '',
        summary: summary || '',
        casual: !!casual,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Chat request failed');
    }
    return res.json();
  }

  // Backend cap-hit error codes returned in the 429 detail body. When we see
  // one of these, throw a typed error with `.code` so the caller can show an
  // informative "daily limit reached" message instead of a generic failure
  // (and not retry — the cap is in effect for the rest of the UTC day).
  const TRANSLATE_CAP_CODES = new Set([
    'global_daily_cap_hit',
    'per_ip_daily_cap_hit',
    'translate_cap_accounting_unavailable',
  ]);

  async function _translateFetch(path, body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // noRetry=true so cap-hit (HTTP 429 with structured detail) surfaces
      // immediately — the global daily 429-retry-after-3s would just hit
      // the same cap again and burn 3s for nothing.
      const res = await _fetch(`${baseUrl}/api/translate/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
        noRetry: true,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const detail = err && err.detail;
        // Backend returns a structured detail on cap_hit / cap_unavailable:
        //   { error_code: 'global_daily_cap_hit' | 'per_ip_daily_cap_hit' | ..., message: '...' }
        if (detail && typeof detail === 'object' && TRANSLATE_CAP_CODES.has(detail.error_code)) {
          const e = new Error(detail.message || 'Daily translation limit reached');
          e.code = detail.error_code;
          throw e;
        }
        const message = (typeof detail === 'string') ? detail : (detail && detail.message) || 'Translation failed';
        throw new Error(message);
      }
      return res.json();
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('Translation timed out');
      throw e;
    }
  }

  function translateTitle(text, sourceLang, targetLang, timeout) {
    return _translateFetch('title', { text, source_lang: sourceLang, target_lang: targetLang }, timeout || 15000);
  }

  function translateSummary(text, sourceLang, targetLang, timeout) {
    return _translateFetch('summary', { text, source_lang: sourceLang, target_lang: targetLang }, timeout || 30000);
  }

  function translateChapters(chapters, sourceLang, targetLang, timeout) {
    return _translateFetch('chapters', { chapters, source_lang: sourceLang, target_lang: targetLang }, timeout || 30000);
  }

  function translateTranscriptJson(lines, sourceLang, targetLang, timeout) {
    return _translateFetch('transcript-json', { lines, source_lang: sourceLang, target_lang: targetLang }, timeout || 90000);
  }

  function translateTranscriptBulk(lines, sourceLang, targetLang) {
    return _translateFetch('transcript-bulk', { lines, source_lang: sourceLang, target_lang: targetLang }, 60000);
  }

  async function generateSummaryInLang(transcriptText, videoUrl, lang) {
    const res = await _fetch(`${baseUrl}/api/summary/full`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript_text: transcriptText, url: videoUrl, lang }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Summary generation failed');
    }
    return res.json();
  }

  async function formalRewrite({ summary, chapters, lang }) {
    const res = await _fetch(`${baseUrl}/api/formal-rewrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: summary || '', chapters: chapters || [], lang: lang || '' }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Formal rewrite failed');
    }
    return res.json();
  }

  /**
   * Fetch one karaoke chunk (~60s for the first chunk, ~300s for steady-state).
   * Returns the raw JSON envelope from /api/karaoke-chunk verbatim:
   *   { words: [...], cached: bool, submitted_audio_seconds: int,
   *     elapsed_ms: int, error: string|null, retryable: bool, cooldown_ms: int }
   * Caller (karaoke.js _fetchChunk) handles error/retry semantics — this
   * wrapper just shapes the URL + parses the response.
   *
   * Notes:
   *  - Server enforces grid alignment (start=0+dur=60 OR start=60+N*300+dur=300).
   *    Mismatched values return HTTP 400.
   *  - Graceful failures (cap_hit, audio_not_ready, queue_timeout, etc.) come
   *    back as HTTP 200 with a non-null `error` field — this wrapper does NOT
   *    throw on those. Only network/parse failures throw.
   *  - The default `_fetch` 429 retry-after-3s would conflict with the chunk
   *    loader's per-key cooldown table, so this wrapper bypasses that path
   *    and surfaces 429 to the caller as an error envelope.
   */
  async function karaokeChunk(videoId, startSec, durSec, lang, videoDurationSec) {
    const params = new URLSearchParams({
      video_id: videoId,
      start: String(startSec),
      dur: String(durSec),
    });
    if (lang) params.set('lang', lang);
    // video_duration is for the [KARAOKE-DAILY] savings metric ONLY. Server
    // uses it for log accuracy; never for billing / validation. Pass it
    // when known; backend gracefully falls back to a chunk-end heuristic
    // when missing.
    if (videoDurationSec && videoDurationSec > 0) {
      params.set('video_duration', String(Math.round(videoDurationSec)));
    }
    const url = `${baseUrl}/api/karaoke-chunk?${params.toString()}`;
    const res = await fetch(url, {
      headers: { 'X-API-Token': _API_TOKEN },
    });
    if (res.status === 429) {
      return {
        words: [],
        cached: false,
        submitted_audio_seconds: 0,
        elapsed_ms: 0,
        error: 'rate_limited',
        retryable: true,
        cooldown_ms: 60000,
      };
    }
    if (!res.ok) {
      throw new Error(`karaoke-chunk HTTP ${res.status}`);
    }
    return res.json();
  }

  /**
   * Fetch karaoke words for a SHORT video (≤300s) in a single call.
   *
   * Phase 4 short-video bypass: skips the chunked loader entirely for short
   * content where chunking has more overhead than value. Server-validates
   * duration (rejects > 300s with HTTP 400) so this wrapper trusts the
   * caller to gate by duration first.
   *
   * Same response envelope as `/api/karaoke-chunk` (words / cached / error /
   * retryable / cooldown_ms / etc.) so the caller can reuse the chunk-arrival
   * code path. Same RPC accounting + same Supabase cache (the row's
   * `start=0, dur=videoDuration` becomes the cache key).
   *
   * Graceful failures (cap_hit, audio_not_ready, etc.) come back as HTTP 200
   * with a non-null `error` — this wrapper does NOT throw on those. Only
   * network/parse failures throw.
   */
  async function karaokeWordsShort(videoId, lang) {
    const params = new URLSearchParams({ video_id: videoId });
    if (lang) params.set('lang', lang);
    const url = `${baseUrl}/api/karaoke-words-short?${params.toString()}`;
    const res = await fetch(url, {
      headers: { 'X-API-Token': _API_TOKEN },
    });
    if (res.status === 429) {
      return {
        words: [],
        cached: false,
        submitted_audio_seconds: 0,
        elapsed_ms: 0,
        error: 'rate_limited',
        retryable: true,
        cooldown_ms: 60000,
      };
    }
    if (!res.ok) {
      throw new Error(`karaoke-words-short HTTP ${res.status}`);
    }
    return res.json();
  }

  async function titleColors(title) {
    const res = await _fetch(`${baseUrl}/api/title-colors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) return null;
    return res.json();
  }

  return {
    _fetch, _getBaseUrl: function() { return baseUrl; }, _userFacingError: userFacingError,
    setBaseUrl, getVideoMeta, logChatMessage, chatWithVideo, generateSummaryInLang, formalRewrite, titleColors,
    translateTitle, translateSummary, translateChapters, translateTranscriptJson, translateTranscriptBulk,
    karaokeChunk, karaokeWordsShort,
  };
})();
