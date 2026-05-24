/**
 * font-loader.js — Script metadata + font readiness gate.
 *
 * Responsibilities (v2.1):
 *   1. SCRIPT_FONTS table — lang code → { font, sample, rtl, dense }
 *   2. awaitFontForLang(lang) — Promise that resolves when the script font
 *      is loaded in the browser. Uses sample text so unicode-range subsets
 *      actually fetch. Times out cleanly, returns {ok, reason}, retries on
 *      failure (caches success only).
 *   3. applyLangStyle(el, lang) — direction + text-align + lang-script-dense
 *      class. Clears any stale inline font-family from a prior code path.
 *      Does NOT pin font-family inline — CSS owns selection now.
 *   4. setLangClass(el, lang) — stamps the canonical `.lang-XX` class on
 *      an element. Used by per-display panel renderers to drive the
 *      script-disambiguation CSS rules.
 *   5. clearStaleInlineFontFamily() — one-time DOM sweep at app boot.
 *      Returning users with bfcache or service-worker-cached pages may
 *      carry inline `font-family !important` pins from a previously
 *      deployed version of this app. The cascade-driven design needs
 *      those cleared so the per-codepoint fallback can do its work.
 *
 * What this file does NOT do:
 *   - Inject Google Font <link> tags (the static <head> link declares all
 *     families now; unicode-range handles per-script lazy fetch).
 *   - Pin font-family inline.
 *   - Know anything about themes (theme role-var redefinition does that).
 */

// Map: lang code → { font, sample, rtl, dense }.
//   - font:   the CSS family name as declared in the static Google Fonts <link>.
//   - sample: representative sample text for the script. REQUIRED for
//             document.fonts.load() to actually trigger the unicode-range
//             subset fetch — passing only the family name doesn't.
//   - rtl:    whether the script reads right-to-left.
//   - dense:  whether the script is visually dense (used by .lang-script-dense
//             class for layout tweaks like line-height / weight bumps in
//             bilingual mode).
export const SCRIPT_FONTS = {
  // Arabic-script
  fa:        { font: 'Vazirmatn',         sample: 'سلام',    rtl: true,  dense: true },
  ur:        { font: 'Vazirmatn',         sample: 'سلام',    rtl: true,  dense: true },
  ku:        { font: 'Vazirmatn',         sample: 'سلام',    rtl: true,  dense: true },
  ar:        { font: 'Noto Sans Arabic',  sample: 'مرحبا',   rtl: true,  dense: true },
  ps:        { font: 'Noto Sans Arabic',  sample: 'پښتو',    rtl: true,  dense: true },
  sd:        { font: 'Noto Sans Arabic',  sample: 'سندھی',   rtl: true,  dense: true },
  // Hebrew
  he:        { font: 'Noto Sans Hebrew',  sample: 'שלום',    rtl: true,  dense: true },
  yi:        { font: 'Noto Sans Hebrew',  sample: 'ייִדיש',   rtl: true,  dense: true },
  // CJK
  zh:        { font: 'Noto Sans SC',      sample: '中文',     rtl: false, dense: true },
  'zh-cn':   { font: 'Noto Sans SC',      sample: '中文',     rtl: false, dense: true },
  'zh-hans': { font: 'Noto Sans SC',      sample: '中文',     rtl: false, dense: true },
  'zh-tw':   { font: 'Noto Sans TC',      sample: '繁體中文',  rtl: false, dense: true },
  'zh-hant': { font: 'Noto Sans TC',      sample: '繁體中文',  rtl: false, dense: true },
  ja:        { font: 'Noto Sans JP',      sample: '日本語',   rtl: false, dense: true },
  ko:        { font: 'Noto Sans KR',      sample: '한국어',   rtl: false, dense: true },
  // Indic
  hi:        { font: 'Noto Sans Devanagari', sample: 'हिन्दी', rtl: false, dense: true },
  mr:        { font: 'Noto Sans Devanagari', sample: 'मराठी',  rtl: false, dense: true },
  ne:        { font: 'Noto Sans Devanagari', sample: 'नेपाली',  rtl: false, dense: true },
  bn:        { font: 'Noto Sans Bengali',    sample: 'বাংলা',  rtl: false, dense: true },
  ta:        { font: 'Noto Sans Tamil',      sample: 'தமிழ்',  rtl: false, dense: true },
  te:        { font: 'Noto Sans Telugu',     sample: 'తెలుగు', rtl: false, dense: true },
  gu:        { font: 'Noto Sans Gujarati',   sample: 'ગુજરાતી', rtl: false, dense: true },
  kn:        { font: 'Noto Sans Kannada',    sample: 'ಕನ್ನಡ',  rtl: false, dense: true },
  ml:        { font: 'Noto Sans Malayalam',  sample: 'മലയാളം', rtl: false, dense: true },
  pa:        { font: 'Noto Sans Gurmukhi',   sample: 'ਪੰਜਾਬੀ', rtl: false, dense: true },
  si:        { font: 'Noto Sans Sinhala',    sample: 'සිංහල', rtl: false, dense: true },
  // Southeast Asian
  th:        { font: 'Noto Sans Thai',     sample: 'ภาษาไทย', rtl: false, dense: true },
  lo:        { font: 'Noto Sans Lao',      sample: 'ລາວ',     rtl: false, dense: true },
  km:        { font: 'Noto Sans Khmer',    sample: 'ខ្មែរ',    rtl: false, dense: true },
  my:        { font: 'Noto Sans Myanmar',  sample: 'မြန်မာ',  rtl: false, dense: true },
  // Other scripts
  am:        { font: 'Noto Sans Ethiopic', sample: 'አማርኛ',   rtl: false, dense: true },
  hy:        { font: 'Noto Sans Armenian', sample: 'Հայերեն', rtl: false, dense: true },
  ka:        { font: 'Noto Sans Georgian', sample: 'ქართული', rtl: false, dense: true },
};

const _RTL_BASES = new Set(['fa', 'ar', 'he', 'ur', 'ps', 'ku', 'sd', 'yi']);

function _norm(lang) {
  if (!lang || typeof lang !== 'string') return '';
  return lang.trim().replace(/_/g, '-').toLowerCase();
}

/**
 * Resolve a lang code to its SCRIPT_FONTS metadata. Returns null for
 * Latin-script langs (en, fr, es, etc.) — those don't need a script font.
 *
 * Handles BCP-47 region/script aliases: zh-Hant → zh-tw, zh-CN → zh, etc.
 *
 * @param {string} lang
 * @returns {{font:string, sample:string, rtl:boolean, dense:boolean} | null}
 */
export function fontMetaForLang(lang) {
  const n = _norm(lang);
  if (!n) return null;
  if (SCRIPT_FONTS[n]) return SCRIPT_FONTS[n];
  if (n.startsWith('zh-hant') || n === 'zh-tw' || n === 'zh-hk') return SCRIPT_FONTS['zh-tw'];
  if (n.startsWith('zh-hans') || n === 'zh-cn' || n === 'zh-sg') return SCRIPT_FONTS.zh;
  return SCRIPT_FONTS[n.split('-')[0]] || null;
}

export function isRTL(lang) {
  const n = _norm(lang);
  if (!n) return false;
  const base = n.split('-')[0];
  if (_RTL_BASES.has(base)) return true;
  const meta = fontMetaForLang(lang);
  return !!(meta && meta.rtl);
}

export function hasScriptFont(lang) {
  return !!fontMetaForLang(lang);
}

/**
 * Resolve the canonical `.lang-XX` CSS class name for a lang. Distinguishes
 * zh-tw from zh-cn (Traditional vs Simplified Chinese render differently
 * even though they share Han codepoints — see disambiguation rules in CSS).
 * Returns null for Latin / unknown langs (no class needed).
 *
 * @param {string} lang
 * @returns {string | null} e.g. 'fa', 'zh-tw', 'ja', or null
 */
export function langClassFor(lang) {
  const n = _norm(lang);
  if (!n) return null;
  if (!fontMetaForLang(lang)) return null;
  if (n === 'zh-tw' || n === 'zh-hant' || n.startsWith('zh-hant')) return 'zh-tw';
  if (n === 'zh-cn' || n === 'zh-hans' || n.startsWith('zh-hans')) return 'zh';
  return n.split('-')[0];
}

const _ALL_LANG_CLASSES = (function () {
  const set = new Set();
  for (const k of Object.keys(SCRIPT_FONTS)) set.add('lang-' + k);
  return Array.from(set);
})();

/**
 * Stamp the canonical `.lang-XX` class on an element, removing any prior
 * lang-XX class first. Used by per-display panel renderers.
 *
 * Safe to call repeatedly. No-op for Latin langs (no class added; any
 * prior lang-XX class still gets stripped).
 *
 * @param {Element} el
 * @param {string} lang
 */
export function setLangClass(el, lang) {
  if (!el) return;
  el.classList.remove(..._ALL_LANG_CLASSES);
  const cls = langClassFor(lang);
  if (cls) el.classList.add('lang-' + cls);
}

// ── Font readiness gate ────────────────────────────────────────────
//
// Memoize the IN-FLIGHT load Promise (not its result) — keyed by font name +
// sample. A successful load resolves once and stays cached. A failed load
// (timeout, network error, check() mismatch) gets DELETED from the cache so
// a later call can retry (E2/E4 round-2 fix: don't permanently poison the
// cache after one timeout).

const _pendingLoads = new Map();

function _spec(meta, weight = 400, size = '16px') {
  return weight + ' ' + size + ' "' + meta.font + '"';
}

function _isLoaded(meta) {
  if (typeof document === 'undefined' || !document.fonts || !document.fonts.check) return true;
  return document.fonts.check(_spec(meta), meta.sample);
}

function _startLoad(meta) {
  const key = meta.font + '::' + meta.sample;
  if (_pendingLoads.has(key)) return _pendingLoads.get(key);

  // document.fonts.load(spec, sample) — sample text triggers the
  // unicode-range subset fetch that the bare-spec form would skip.
  // Resolves with FontFace[] on completion (success OR partial), only
  // rejects on syntactically invalid spec — we always gate on check().
  const p = document.fonts.load(_spec(meta), meta.sample)
    .then(function () {
      const ok = _isLoaded(meta);
      return { ok: ok, reason: ok ? 'loaded' : 'load-resolved-but-check-failed', font: meta.font };
    })
    .catch(function (e) {
      return {
        ok: false,
        reason: 'load-rejected',
        font: meta.font,
        error: String((e && e.message) || e),
      };
    });
  _pendingLoads.set(key, p);
  return p;
}

/**
 * Wait until the script font for `lang` is loaded in the browser.
 *
 * Use 800ms timeout for source-language initial-render path (recap speed
 * is core UX; a stalled font fetch must never delay the first paint).
 * Use the default 1500ms for translation swap path (visible loading state
 * is already shown; longer wait acceptable).
 *
 * Returns a status object — never throws. Caller decides whether to paint
 * anyway on non-OK (recommended: yes; better a brief FOUT than a frozen UI).
 *
 * @param {string} lang
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, reason: string, font: string|null, error?: string}>}
 */
export async function awaitFontForLang(lang, opts) {
  const timeoutMs = (opts && typeof opts.timeoutMs === 'number') ? opts.timeoutMs : 1500;
  const meta = fontMetaForLang(lang);

  if (!meta) return { ok: true, reason: 'no-script-font-needed', font: null };
  if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) {
    return { ok: true, reason: 'no-fontfaceset-api', font: meta.font };
  }
  if (_isLoaded(meta)) return { ok: true, reason: 'already-loaded', font: meta.font };

  const loadPromise = _startLoad(meta);
  const timeoutPromise = new Promise(function (resolve) {
    window.setTimeout(function () {
      resolve({ ok: false, reason: 'timeout', font: meta.font });
    }, timeoutMs);
  });

  const result = await Promise.race([loadPromise, timeoutPromise]);

  // Drop the memoized Promise on non-OK so a later call retries. The
  // underlying browser load may finish shortly after the timeout fires;
  // we don't want to permanently report failure for one slow network blip.
  if (!result.ok) {
    _pendingLoads.delete(meta.font + '::' + meta.sample);
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[font-system] awaitFontForLang non-ok', {
        lang: lang, font: meta.font, reason: result.reason, timeoutMs: timeoutMs,
        sample: meta.sample, error: result.error || null,
      });
    }
  }
  return result;
}

/**
 * Apply layout semantics for a lang-tagged element.
 *
 *   - Clears any inline font-family pinned by a prior code path or prior
 *     call. CSS owns font selection in v2.1; an inline pin from before
 *     would block the cascade (this was the iteration-5 mess).
 *   - Sets direction + text-align with !important. Kept as !important per
 *     Chesterton's Fence: prior implementation used !important; we don't
 *     have evidence the original reason is gone, so defensive.
 *   - Toggles .lang-script-dense for the bilingual-mode weight bump and
 *     line-height tweaks. Container-level only — mixed-content children
 *     (e.g. a Persian span inside an English summary) do NOT get this
 *     class. Per-span density would require backend lang-attribute
 *     emission, which is explicitly out of scope.
 *
 *   Does NOT stamp the .lang-XX class — that's setLangClass(). Most
 *   callers pair them via the legacy applyLangStyle path; some panel
 *   renderers call setLangClass directly.
 *
 * @param {Element} el
 * @param {string} lang
 */
export function applyLangStyle(el, lang) {
  if (!el || !lang) return;
  el.style.removeProperty('font-family');
  const rtl = isRTL(lang);
  el.style.setProperty('direction', rtl ? 'rtl' : 'ltr', 'important');
  el.style.setProperty('text-align', rtl ? 'right' : 'left', 'important');
  el.classList.toggle('lang-script-dense', hasScriptFont(lang));
}

/**
 * One-time DOM sweep at app boot. Returning users with bfcache or
 * service-worker-cached pages may carry inline `font-family !important`
 * pins from a previously deployed version of this app. The cascade-driven
 * design needs those cleared.
 *
 * Safe to run unconditionally — current app uses no inline font-family
 * (the only writer in production code is translation.js's overlay
 * snapshot, but those overlays are transient and don't exist at boot).
 */
export function clearStaleInlineFontFamily() {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('[style*="font-family"]').forEach(function (el) {
    el.style.removeProperty('font-family');
  });
}

/**
 * @deprecated Backward-compatible alias for callers still on the v1 API.
 * Migrate to awaitFontForLang and remove this wrapper after every call
 * site has moved over.
 */
export function ensureFontForLang(lang) {
  return awaitFontForLang(lang);
}

// All public helpers (awaitFontForLang, ensureFontForLang, applyLangStyle,
// setLangClass, fontMetaForLang, langClassFor, clearStaleInlineFontFamily)
// are bound to window._* names from main.js — single bridge surface.
