/**
 * RecapShark Entity Highlighter — async fetcher
 * ----------------------------------------------
 * Wraps `POST /api/entities` for the per-language NER cache. Used when the
 * active language has no entities yet — typically when the video's original
 * language has no spaCy model (Persian / Arabic / Hindi / Korean / Thai /
 * Vietnamese / etc.), or when the user switches to a translation we
 * haven't extracted entities for yet.
 *
 * Design (matches docs/logs/2026-04-29_multilingual_ner_plan.md):
 *
 *   - Non-blocking: never delays the fast first paint. Caller schedules
 *     this via `setTimeout(0)` AFTER renderAll() returns, so the user
 *     sees the page in ~2s and names "fade in" a few seconds later
 *     (3-5s typical, up to 10-15s for very long transcripts).
 *
 *   - Idempotent: a second call for the same lang while one is in flight
 *     is a no-op; a call after entities are already registered is also
 *     a no-op. Both safe to call from multiple code paths (load, lang
 *     switch, bilingual sync) without coordination.
 *
 *   - Self-healing: on success it pushes entities into EntityHighlighter
 *     under the right lang AND re-runs `highlightAllInContainer(document)`
 *     so already-rendered transcript / subtitle rows pick up the new
 *     coloring. The repaint is cheap because the highlighter's regex
 *     pass + DOM mutation only touches `.ts-text` / `.bilingual-sub`
 *     spans.
 *
 *   - Fail-safe: any error path is silent (logged once). The page
 *     keeps working with no name highlights — exactly the same UX as
 *     when ENABLE_LLM_NER is off on the server.
 */
import { RecapSharkAPI } from './client.js';
import { debugLog } from '../core/debug-log.js';
import { EntityHighlighter } from '../ui/entity-highlighter.js';

// Track which langs are currently being fetched so concurrent triggers
// (e.g. a streaming `updateFromApi` chunk arriving mid-fetch) collapse
// to a single network call.
const _inFlight = new Set();

/**
 * Fetch entities for `(videoId, lang)` and apply them to the highlighter.
 *
 * @param {string} videoId          - YouTube video ID, used for cache key.
 * @param {string} lang             - Lang code matching what the highlighter
 *                                    will activate (e.g. 'fa', 'ar').
 * @param {string} transcriptText   - The transcript text the user is
 *                                    currently viewing in `lang`. For the
 *                                    original language this is the raw
 *                                    transcript; for translations it's the
 *                                    translated text. The server hashes
 *                                    this and uses it as the cache key.
 * @param {object} [opts]
 * @param {boolean} [opts.makeActive=false]  - If true, call setActiveLang(lang)
 *   before re-highlighting. Use this when the lang the user just switched
 *   TO is the one we're fetching for; skip when pre-warming entities for
 *   a non-active lang (e.g. bilingual second slot).
 */
export async function fetchEntitiesForLang(videoId, lang, transcriptText, opts = {}) {
  if (!videoId || !lang || !transcriptText) return;
  if (transcriptText.trim().length < 20) return;

  // Already have entities for this lang? Nothing to do.
  if (EntityHighlighter?.hasEntitiesFor?.(lang)) {
    if (opts.makeActive) EntityHighlighter.setActiveLang?.(lang);
    return;
  }

  // De-dupe concurrent calls for the same lang.
  const key = `${videoId}|${lang}`;
  if (_inFlight.has(key)) return;
  _inFlight.add(key);

  try {
    const baseUrl = RecapSharkAPI._getBaseUrl();
    const res = await RecapSharkAPI._fetch(`${baseUrl}/api/entities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_id: videoId,
        lang,
        transcript_text: transcriptText,
      }),
    });
    if (!res || !res.ok) {
      // Server-side rate limit or transient error — silently no-op. The
      // user sees no name highlights for this lang, matches today's UX
      // for unsupported langs.
      console.warn('[entities] fetch failed', res?.status, lang);
      return;
    }
    const data = await res.json();
    const entities = Array.isArray(data?.entities) ? data.entities : [];

    /* `unsupported` source means the server has no spaCy model AND
       LLM is disabled. Cache the empty result anyway so we don't keep
       refiring on every paint — registering an empty list under the
       lang flips `hasEntitiesFor` to false (it requires non-empty),
       so to truly mark-as-checked we need a separate flag. We accept
       the small cost of refiring across page-loads; for in-page lang
       switches the in-flight set + cached registration is enough. */
    if (EntityHighlighter) {
      EntityHighlighter.setEntities?.(lang, entities);
      if (opts.makeActive) {
        EntityHighlighter.setActiveLang?.(lang);
      }
    }

    if (entities.length > 0) {
      // Re-sweep the document so already-rendered rows pick up the new
      // entity coloring. Cheap — single regex pass per row, mutates
      // existing spans in place rather than rebuilding the DOM.
      EntityHighlighter?.highlightAllInContainer?.(document);
      // `highlightAllInContainer` only targets transcript/subtitle rows;
      // chat bubbles + chips use a different render path (preserves
      // inline HTML like `<a>` timestamps) and need their own repaint.
      // Without this, a chat message sent BEFORE /api/entities returned
      // would render plain and stay plain forever — the entity arrival
      // never reaches the bubble. ChatManager.repaintHighlights walks
      // every bubble + chip and re-applies highlightTextNodes so the
      // newly-registered names fade in across the chat surface.
      window.ChatManager?.repaintHighlights?.();
    }

    debugLog(
      `[entities] applied lang=${lang} count=${entities.length} ` +
      `source=${data.source} active=${!!opts.makeActive}`
    );
  } catch (e) {
    console.warn('[entities] fetch error', lang, e);
  } finally {
    _inFlight.delete(key);
  }
}
