import { AppState } from './state.js';
import { PARAGRAPH_TARGET_CHARS, PARAGRAPH_MAX_LINES } from './constants.js';
import { uiString } from './ui-strings.js';

/**
 * RecapShark Helpers
 * Pure utility functions used across the application.
 * Single responsibility: stateless transformations and shared actions.
 */
// Single source of truth for the mobile/narrow breakpoint. Any change here
// must be mirrored in the CSS @media (max-width: 900px) blocks (see top of
// `src/css/mobile-layout.css` for the canonical comment). Phase 4b/B2
// (2026-05-08) consolidated ~39 inline `matchMedia('(max-width: 900px)')`
// reads across 18 files into Helpers.isNarrowViewport() / Helpers.NARROW_VIEWPORT_MEDIA.
const NARROW_VIEWPORT_MEDIA = '(max-width: 900px)';

export const Helpers = (() => {

  /* ── waveReplace generation tracking ─────────────────── */
  const _waveGen = new WeakMap();

  function cancelWaveReplace(container) {
    _waveGen.set(container, (_waveGen.get(container) || 0) + 1);
  }

  function waveReplace(container, newHTML, onDone, opts) {
    const gen = (_waveGen.get(container) || 0) + 1;
    _waveGen.set(container, gen);

    const oldItems = Array.from(container.children);
    if (!oldItems.length) {
      container.innerHTML = newHTML;
      if (onDone) onDone();
      return;
    }

    const STAGGER = 150;
    const FADE_OUT = 0.78;
    const GAP = 490;
    const FADE_IN = 0.73;
    const BLUR = 1;

    const tmp = document.createElement('div');
    tmp.innerHTML = newHTML;
    const newItems = Array.from(tmp.children);
    const count = Math.max(oldItems.length, newItems.length);
    const totalTime = (count - 1) * STAGGER + GAP + FADE_IN * 1000 + 50;

    const cols = (opts && opts.columnMajor && opts.columns) || 0;
    const order = cols > 0 ? columnMajorOrder(count, cols) : null;
    const indices = order || Array.from({ length: count }, (_, i) => i);

    for (let animIdx = 0; animIdx < count; animIdx++) {
      const i = indices[animIdx];
      const row = oldItems[i];
      const fresh = newItems[i];

      if (row) {
        setTimeout(() => {
          if (_waveGen.get(container) !== gen) return;
          row.style.transition = `opacity ${FADE_OUT}s, filter ${FADE_OUT}s`;
          row.style.opacity = '0';
          row.style.filter = `blur(${BLUR}px)`;
        }, animIdx * STAGGER);
      }

      setTimeout(() => {
        if (_waveGen.get(container) !== gen) return;
        if (row && fresh) {
          row.innerHTML = fresh.innerHTML;
          for (const attr of fresh.attributes) row.setAttribute(attr.name, attr.value);
          row.style.filter = `blur(${BLUR}px)`;
          row.style.opacity = '0';
          requestAnimationFrame(() => {
            row.style.transition = `opacity ${FADE_IN}s, filter ${FADE_IN}s`;
            row.style.opacity = '1';
            row.style.filter = 'blur(0)';
          });
        } else if (!row && fresh) {
          fresh.style.opacity = '0';
          fresh.style.filter = `blur(${BLUR}px)`;
          container.appendChild(fresh);
          requestAnimationFrame(() => {
            fresh.style.transition = `opacity ${FADE_IN}s, filter ${FADE_IN}s`;
            fresh.style.opacity = '1';
            fresh.style.filter = 'blur(0)';
          });
        } else if (row && !fresh) {
          row.remove();
        }
      }, animIdx * STAGGER + GAP);
    }

    if (onDone) setTimeout(onDone, totalTime);
  }

  function columnMajorOrder(n, cols) {
    const out = [];
    for (let c = 0; c < cols; c++) {
      for (let i = c; i < n; i += cols) out.push(i);
    }
    return out;
  }

  function fmtTime(seconds, lang) {
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    let result;
    if (h > 0) result = `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    else result = `${m}:${String(sec).padStart(2, '0')}`;
    return lang ? result.replace(/\d/g, d => localizeNum(d, lang)) : result;
  }

  function lineToTime(lineNum) {
    if (AppState.segmentTimestamps.length > 0 && lineNum < AppState.segmentTimestamps.length) {
      return Math.floor(AppState.segmentTimestamps[lineNum]);
    }
    if (!AppState.videoData || !AppState.totalLines) return 0;
    return Math.floor((lineNum / AppState.totalLines) * AppState.videoData.durationEstimate);
  }

  function seekTo(seconds) {
    if (AppState.player && AppState.player.seekTo) {
      AppState.player.seekTo(seconds, true);
      // First-play path: if the YT thumbnail facade is still covering the
      // iframe (user hasn't tapped play yet), seeking + playVideo() alone
      // would start audio under a hidden video — thumbnail and play button
      // stay visible because nothing dismisses them. Route through the
      // centralized dismissFacadeAndPlay() helper so chapter/transcript
      // clicks behave identically to a regular play tap. Subsequent seeks
      // (facade already hidden) take the cheap playVideo() branch and
      // don't re-touch unmute/volume — preserves any user-set volume.
      const facade = document.getElementById('ytFacade');
      const facadeVisible = facade && facade.style.display !== 'none';
      if (facadeVisible && window.PlayerManager && window.PlayerManager.dismissFacadeAndPlay) {
        window.PlayerManager.dismissFacadeAndPlay();
      } else {
        AppState.player.playVideo();
      }
    } else {
      const vid = AppState.videoData?.videoId || AppState.currentVideoId;
      if (vid) {
        AppState._pendingSeek = seconds;
        window.PlayerManager._activatePlayer(vid);
      }
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function extractVideoId(url) {
    const patterns = [
      /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
      /[?&]v=([a-zA-Z0-9_-]{11})/,
      /\/embed\/([a-zA-Z0-9_-]{11})/,
      /\/shorts\/([a-zA-Z0-9_-]{11})/,
    ];
    for (const re of patterns) {
      const m = url.match(re);
      if (m) return m[1];
    }
    return null;
  }

  /** Get video duration via hidden YT player (from subs_provider-test). */
  function getYTDuration(url) {
    return new Promise((resolve, reject) => {
      const vid = extractVideoId(url);
      if (!vid) return reject(new Error('no video id'));

      function tryCreate() {
        const container = document.getElementById('ytPlayerHidden');
        if (!container) return reject(new Error('ytPlayerHidden not found'));
        const div = document.createElement('div');
        div.id = 'ytTempPlayer';
        container.appendChild(div);

        new YT.Player('ytTempPlayer', {
          videoId: vid,
          events: {
            onReady: (e) => {
              const dur = e.target.getDuration();
              e.target.destroy();
              resolve(dur);
            },
            onError: () => reject(new Error('yt error')),
          },
        });
      }

      if (typeof YT !== 'undefined' && typeof YT.Player === 'function') {
        tryCreate();
      } else {
        const deadline = Date.now() + 15000;
        const check = setInterval(() => {
          if (Date.now() > deadline) {
            clearInterval(check);
            reject(new Error('YT API timeout'));
            return;
          }
          if (typeof YT !== 'undefined' && typeof YT.Player === 'function') {
            clearInterval(check);
            tryCreate();
          }
        }, 100);
      }
    });
  }

  function highlightQueryInText(text, query) {
    if (!query || query.trim().length === 0) return escapeHtml(text);
    const q = query.trim();
    const re = new RegExp(`(${escapeRegex(q)})`, 'gi');
    const parts = text.split(re);
    const qLower = q.toLowerCase();
    return parts
      .map(part => (part.toLowerCase() === qLower ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)))
      .join('');
  }

  function highlightTitleKeywords(title) {
    const allKeywords = Object.values(AppState.videoData.keywords || {}).flat();
    allKeywords.sort((a, b) => b.length - a.length);
    let html = escapeHtml(title);
    for (const kw of allKeywords) {
      const re = new RegExp(`(${escapeRegex(kw)})`, 'gi');
      html = html.replace(re, '<span class="accent">$1</span>');
    }
    return html;
  }

  function relativeDate(dateStr) {
    if (!dateStr) return '';
    const published = new Date(dateStr + 'T00:00:00');
    const now = new Date();
    const days = Math.floor((now - published) / 86400000);
    if (days < 0) return '';
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    if (days < 14) return 'About a week ago';
    if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
    if (days < 60) return 'About a month ago';
    if (days < 365) return `${Math.floor(days / 30)} months ago`;
    const years = Math.floor(days / 365);
    return years === 1 ? 'About a year ago' : `${years} years ago`;
  }

  function estimateReadTime(paragraphs) {
    const words = paragraphs.join(' ').split(/\s+/).length;
    const seconds = Math.round(words / 4);
    if (seconds < 60) {
      const rounded = Math.round(seconds / 10) * 10 || 10;
      return `${rounded}-second`;
    }
    const mins = Math.round(seconds / 60);
    return `${mins}-minute`;
  }

  // Chat greeting now resolves through the static UI_STRINGS dict (see
  // ui-strings.js) — was an English-only constant + runtime translateSummary
  // API call per language. Static lookup is instant and consistent.
  function chatGreeting(lang) {
    return uiString('chatGreeting', lang || 'en');
  }

  const RTL_LANGS = new Set(['fa', 'ar', 'he', 'ur', 'ps', 'ku']);
  function isRTL(lang) {
    if (!lang) return false;
    return RTL_LANGS.has(lang.split('-')[0].toLowerCase());
  }

  // Cache Intl.NumberFormat per locale — fmtTime calls localizeNum once per
  // digit (via .replace), so without caching we'd allocate a fresh formatter
  // for every digit of every timestamp.
  const _numFmtCache = new Map();
  function _getNumFmt(lang) {
    if (_numFmtCache.has(lang)) return _numFmtCache.get(lang);
    let fmt = null;
    try { fmt = new Intl.NumberFormat(lang, { useGrouping: false }); } catch (_) { fmt = null; }
    _numFmtCache.set(lang, fmt);
    return fmt;
  }
  function localizeNum(n, lang) {
    if (!lang) return String(n);
    const fmt = _getNumFmt(lang);
    if (!fmt) return String(n);
    // Browser picks the locale's preferred numbering system per CLDR — fa
    // becomes ۰۱۲۳, ar becomes ٠١٢٣, bn becomes ০১২৩, hi stays 0123 (modern
    // Hindi default), etc. No per-language hardcoding needed.
    return fmt.format(Number(n));
  }

  function groupLinesByParagraph(texts, targetChars, maxPerGroup) {
    targetChars = targetChars || PARAGRAPH_TARGET_CHARS;
    maxPerGroup = maxPerGroup || PARAGRAPH_MAX_LINES;
    var groups = [];
    var current = [];
    var chars = 0;
    var firstIdx = 0;
    for (var i = 0; i < texts.length; i++) {
      current.push(i);
      chars += texts[i].length + 1;
      if (chars >= targetChars || current.length >= maxPerGroup || i === texts.length - 1) {
        groups.push({ firstIdx: firstIdx, lineIndices: current.slice() });
        current = [];
        chars = 0;
        firstIdx = i + 1;
      }
    }
    if (current.length) {
      groups.push({ firstIdx: firstIdx, lineIndices: current.slice() });
    }
    return groups;
  }

  function applySummaryHighlights(escaped) {
    // Tolerate LLM marker typos: it sometimes emits [Name]] or [[Name]
    // instead of the correct [[Name]]. Normalize 1-or-2 brackets to
    // exactly 2 when the content starts with a capital letter (excludes
    // timestamps like [2:01], which start with a digit). Parens are NOT
    // normalized — that would break ordinary English parentheticals
    // like "(see above)".
    escaped = escaped.replace(
      /\[{1,2}([A-Z][^\[\]<>]{0,80})\]{1,2}/g,
      '[[$1]]'
    );
    return escaped
      .replace(/\[\[([^\]]+)\]\]/g, '<mark class="summary-highlight summary-highlight-name">$1</mark>')
      .replace(/\(\(([^)]+)\)\)/g, '<mark class="summary-highlight summary-highlight-place">$1</mark>')
      .replace(/%%([^%]+)%%/g, '<mark class="summary-highlight summary-highlight-date">$1</mark>')
      .replace(/\*\*([^*]+)\*\*/g, '<mark class="summary-highlight">$1</mark>');
  }

  function isNarrowViewport() {
    return window.matchMedia(NARROW_VIEWPORT_MEDIA).matches;
  }

  // ── reportError ────────────────────────────────────────────────────────
  // Standardized "silent but inspectable" error sink for defensive
  // catches across the codebase. The vast majority of `try { ... } catch (_) {}`
  // sites in RecapShark are intentional — operations that may legitimately
  // fail (player not ready, localStorage disabled, abort signal already
  // aborted, PerformanceObserver entry types unsupported, etc.) and where
  // there is nothing the app can do at runtime besides keep going. Plain
  // `catch (_) {}` made debugging those flakes painful: if a real bug ever
  // hid behind one of these catches, you had to manually grep + add
  // console.warns to find it. Phase 4b/B6 (2026-05-08) replaced ~15 of the
  // most diagnostic-relevant catches with `Helpers.reportError(e, 'context')`
  // so a developer can flip `window.RECAPSHARK_DEBUG_ERRORS = true` in the
  // console (or via the perf debug panel) and see what's flapping. Default
  // off → no log spam in prod, byte-for-byte the same runtime behavior as
  // the bare empty catch.
  //
  // Convention:
  //   } catch (e) { Helpers.reportError(e, 'PlayerManager.showFacade'); }
  // The context string should identify the call site cheaply (function name,
  // module, or one-word reason). Don't pass user-PII strings — these may end
  // up in browser console logs that users could share with us.
  function reportError(err, ctx) {
    if (!err) return;
    try {
      if (window.RECAPSHARK_DEBUG_ERRORS) {
        console.warn('[reportError]', ctx || '(no-context)', err);
      }
    } catch (_) {
      // reportError must NEVER throw — it's the last line of defense.
    }
  }

  return {
    waveReplace, cancelWaveReplace, fmtTime, lineToTime, seekTo,
    escapeHtml, escapeRegex, extractVideoId, getYTDuration,
    highlightQueryInText, highlightTitleKeywords,
    relativeDate, estimateReadTime, chatGreeting,
    localizeNum, isRTL, applySummaryHighlights, groupLinesByParagraph,
    isNarrowViewport, NARROW_VIEWPORT_MEDIA,
    reportError,
  };
})();
