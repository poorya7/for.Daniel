/* ── RecapShark Analytics (GA4) ─────────────────────── */

import { RecapSharkAPI } from '../api/client.js';

// Owner detection — Phase 1.1 (local dev auto-flag).
// Belt-and-suspenders backup for Phase 0.4 (separate GA4 property): if local
// dev ever ends up firing into prod GA, every event still carries owner=true
// so the dashboard's `hide_owner` filter can drop it server-side.
//
// We use BOTH localStorage AND a cookie (dual storage — engineer recommendation):
// - localStorage survives reloads but gets nuked on "clear browsing data"
// - cookie survives across tabs and most clears, lasts 1 year
// Either being set means "this device is the owner".
const OWNER_HOSTS_RE = /^(localhost|127\.0\.0\.1|192\.168\.|10\.)/;
const OWNER_COOKIE = 'rs_is_owner';
const OWNER_LS_KEY = 'rs_is_owner';
const OWNER_SOURCE_LS_KEY = 'rs_owner_source';
const OWNER_SET_AT_LS_KEY = 'rs_owner_set_at';
// Stable Supabase user UUID — written by owner-auth.js whenever a logged-in
// owner session exists. Attached to every GA4 event so the BigQuery owner-scan
// can identify "this was me" deterministically, regardless of how often Safari
// ITP rotates the GA pseudo_id (we observed 22 rotations in 7 days).
const OWNER_USER_ID_LS_KEY = 'rs_owner_user_id';

function readCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function setOwnerFlag(source) {
  const setAt = new Date().toISOString();
  try {
    localStorage.setItem(OWNER_LS_KEY, '1');
    localStorage.setItem(OWNER_SOURCE_LS_KEY, source);
    localStorage.setItem(OWNER_SET_AT_LS_KEY, setAt);
  } catch (_) { /* private mode etc. */ }
  // Cookie: 1 year, all paths, lax for normal nav, secure when on https
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${OWNER_COOKIE}=1; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
}

function clearOwnerFlag() {
  try {
    localStorage.removeItem(OWNER_LS_KEY);
    localStorage.removeItem(OWNER_SOURCE_LS_KEY);
    localStorage.removeItem(OWNER_SET_AT_LS_KEY);
  } catch (_) {}
  document.cookie = `${OWNER_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
}

(function initOwnerFlag() {
  // ?owner=clear — disarm flag (lets owner test what a normal visitor sees)
  const qs = new URLSearchParams(location.search);
  if (qs.get('owner') === 'clear') {
    clearOwnerFlag();
    return;
  }
  // Auto-flag local dev hosts.
  if (OWNER_HOSTS_RE.test(location.hostname)) {
    setOwnerFlag('local_dev');
  }
})();

function getOwnerParams() {
  const flagged = readCookie(OWNER_COOKIE) === '1' ||
                  (() => { try { return localStorage.getItem(OWNER_LS_KEY) === '1'; } catch (_) { return false; } })();
  if (!flagged) return {};
  let source = null;
  let setAt = null;
  let userId = null;
  try {
    source = localStorage.getItem(OWNER_SOURCE_LS_KEY);
    setAt = localStorage.getItem(OWNER_SET_AT_LS_KEY);
    userId = localStorage.getItem(OWNER_USER_ID_LS_KEY);
  } catch (_) {}
  const out = { is_owner: 'true' };
  if (source) out.owner_source = source;
  if (setAt) out.owner_set_at = setAt;
  if (userId) out.owner_user_id = userId;
  return out;
}

export const Analytics = (() => {
  function track(event, params) {
    if (typeof gtag !== 'function') return;
    // Merge owner params into every event automatically.
    const merged = { ...(params || {}), ...getOwnerParams() };
    gtag('event', event, merged);
  }

  function searchStats(query) {
    const q = (query || '').trim();
    return {
      query_length: q.length,
      word_count: q ? q.split(/\s+/).length : 0,
      has_question_mark: q.includes('?') ? 'yes' : 'no',
    };
  }

  // ── Chat text logging (Phase 5d) ─────────────────────────────────────────
  // GA4's ToS forbids PII / free-form user input in event params, and even if
  // it didn't the param strings are capped near 100 chars. So we send the raw
  // question to our own backend (Supabase rs_chat_messages), keyed by the same
  // GA client/session IDs the analytics dashboard groups sessions by.
  // Fire-and-forget — chat UX never blocks on this.
  function _ensureGaIds(cb) {
    if (typeof gtag !== 'function' || !window.RS_GA_ID) {
      cb({ user_pseudo_id: null, ga_session_id: null });
      return;
    }
    let cid = null, sid = null, done = 0;
    const tryFinish = () => { if (++done === 2) cb({ user_pseudo_id: cid, ga_session_id: sid }); };
    try {
      gtag('get', window.RS_GA_ID, 'client_id',  (id) => { cid = id || null; tryFinish(); });
      gtag('get', window.RS_GA_ID, 'session_id', (id) => { sid = id ? Number(id) : null; tryFinish(); });
    } catch (_) {
      cb({ user_pseudo_id: cid, ga_session_id: sid });
    }
  }

  function logChatMessage(message) {
    if (!message) return;
    _ensureGaIds(({ user_pseudo_id, ga_session_id }) => {
      if (!user_pseudo_id) return;   // GA not initialized; nothing meaningful to key on
      // /api/* path centralization (Phase 4a A2): the actual fetch +
      // X-API-Token + keepalive live in `RecapSharkAPI.logChatMessage`.
      // Pre-2026-05-07 the header was missing here → every chat-log POST
      // silently 403'd in prod and Supabase rs_chat_messages stayed empty.
      RecapSharkAPI.logChatMessage({
        user_pseudo_id,
        ga_session_id,
        message,
        page_url: location.pathname + location.search,
      });
    });
  }

  return {
    videoProcessed(videoId)       { track('video_processed', { video_id: videoId }); },
    // Fired once the API has detected the video's source language. Distinct
    // from videoProcessed so we keep the "user pasted a video" signal even
    // when language detection later fails. Stored per-session as `video_lang`
    // (first non-null value chronologically). See pipeline/etl_sessions.py.
    videoLangDetected(videoId, lang) {
      if (!lang) return;
      track('video_lang_detected', { video_id: videoId, video_lang: lang });
    },
    exportOpened()                { track('export_opened'); },
    exportSelected(format)        { track('export_selected', { format }); },
    exportConfirmed(format)       { track('export_confirmed', { format }); },
    languageChanged(lang)         { track('language_changed', { selected_language: lang }); },
    chatSent(msgLength)           { track('chat_sent', { message_length: msgLength }); },
    chatMessageLogged(message)    { logChatMessage(message); },
    tabSwitched(tab)              { track('tab_switched', { tab }); },
    themeChanged(mode, name)      { track('theme_changed', { mode, theme_name: name }); },
    chapterClicked(index, title)  { track('chapter_clicked', { chapter_index: index, chapter_title_length: (title || '').length }); },
    profileMenuOpened()           { track('profile_menu_opened'); },
    searchUsed(query)             { track('transcript_search', searchStats(query)); },
    casualModeToggled(on)         { track('casual_mode_toggled', { enabled: on ? 'on' : 'off' }); },
  };
})();
