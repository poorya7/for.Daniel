# Language & Fonts (i18n)

RecapShark supports 105+ languages end-to-end: source detection, translation
of every panel (title, summary, chapters, transcript, chat), bilingual
display, and correct script-aware font rendering for any combination of
languages on screen — including mixed-script content like a Persian title
quoted inside an English summary.

This doc covers two tightly-coupled systems:

1. **Translation** — Google Translate primary, GPT fallback, bilingual UI,
   bulk transcript path, quality safeguards.
2. **Fonts (i18n)** — `unicode-range`-driven Google Fonts, role-based CSS
   tokens, browser per-codepoint cascade, JS readiness gate, script
   disambiguation.

The two systems are intentionally decoupled: translation produces the
text, the font system makes sure it renders in the right glyphs.

---

## Translation System

### Two-tier translation backend

1. **Google Translate API** (`pipeline/google_translate.py`) — primary path
   for most languages. Fast (~1–2s for entire transcript via batch
   request). Supports all languages except 16 advanced/low-resource ones.
2. **GPT-4o / gpt-4o-mini** (`pipeline/translate.py`) — fallback for 16
   complex-script languages (`TIER_4O_LANGS`: si, my, km, gu, yo, ig, zu,
   xh, mi, sm, haw, lo, am, bo, ti, wo). Also used for title/summary/chapter
   translation where nuance matters.

### Frontend translation flow

1. User selects language in the language panel (`translation-lang-panel.js`).
2. `TranslationManager.setLanguage(langCode)` awaits the script font for
   `langCode` (`awaitFontForLang(langCode, { timeoutMs: 1500 })` — see
   "Font readiness gate" below) so the user never sees the translated
   panels paint in a system-fallback font, then fires parallel API calls
   for title, summary, chapters, and transcript.
3. Backend routes try Google Translate first, fall back to GPT for
   unsupported languages.
4. Results cached in `AppState.translationCache[langCode]` — switching
   back is instant.
5. Formal-register versions fetched asynchronously via `/api/formal-rewrite`.

### Transcript translation (bulk path)

- Preferred: Google Translate v2 API, all lines in 1 request (~1–2s
  even for 4hr podcasts).
- Fallback: chunked GPT with 25-line chunks, max 8 concurrent, progress
  estimation.

### Display modes

`'original'` | `'translated'` | `'bilingual'` | `'bilingual-swapped'`

- `bilingual`: side-by-side, translated text in column 2, original in
  column 3.
- `bilingual-swapped`: columns reversed (original col 2, translated col
  3).

### Bilingual UI (3-button design)

- 🇺🇸 flag button → exits bilingual, shows original language only.
- 🇮🇷 flag button → exits bilingual, shows translated language only.
- 🇺🇸|🇮🇷 dual-flag button → swaps column order (toggles between
  `bilingual` and `bilingual-swapped`, no off state). Flags inside the
  button mirror the current column order.
- Active button gets a teal glow (`drop-shadow` + `inset box-shadow`).

### Bilingual transcript layout (desktop, Option B)

- Each `.transcript-paragraph` becomes its own `display: grid` with
  `grid-template-columns: auto 1fr 1fr`.
- `.bilingual-sub` is a **child** of the paragraph (not a sibling), sits
  in grid column 3.
- Alt-row background applies to the paragraph itself — covers all 3
  columns naturally.
- Column swap uses CSS `order` on `.bilingual-cols-swapped`.

### Paragraph grouping

- Groups computed **once** from the original English `transcriptRawText`
  and stored in `AppState.paragraphGroups`.
- All rendering (desktop paragraphs, mobile flat-transcript rows,
  bilingual annotations) reuses the stored groups.
- This ensures identical paragraph boundaries and timestamps across all
  languages.

### Scroll anchoring on language switch

- On every buffer swap, the **topmost visible row** in the current buffer
  is found by timestamp.
- The same timestamp is located in the new buffer and scroll position is
  set to match.
- Works for all 3 buttons (original, translated, bilingual) — zero visual
  jump.

### Timestamp numerals

Localized to the user's **current display language** via `Intl.NumberFormat`
(cached per locale in `helpers.js`). Persian view shows `۲:۴۵`, Bengali
shows `২:৪৫`, Hindi stays `2:45` (modern Hindi default is Latin in CLDR).
The `data-time="<seconds>"` attribute always stores the raw integer for
tap-to-seek, so display can be any localized form without breaking
parsing. `chipLang` is sourced from `AppState.currentLang` (not
`videoData.lang`) in `renderer.js` so chips re-format on every language
switch.

### Crossfade

300ms for all transcript buffer swaps (language switches, bilingual
toggle). Controlled by `CROSSFADE_MS` in `transcript-buffer.js`.

### Frontend rendering

- `renderCurrentState()` in `casual-mode.js` is the single authoritative
  render function.
- `AppState.getContent(section)` resolves the correct text for the
  active language + casual/formal mode.
- Desktop transcript uses `renderedKey` check (panel + lang + text
  length + bilingual flag) to skip unnecessary DOM rebuilds.
- Other panel is invalidated on render (`renderedLang = ''`,
  `renderedKey = ''`) so it re-renders on next tab switch.
- Font size buttons (A+/A−) affect both `.ts-text` and `.bilingual-sub`.

### Historical note: the Amharic hang problem

The earlier tagged `[L:N] text` format caused the model to hang for
Amharic and Ethiopic-script languages due to constrained decoding
conflicts. This was resolved by migrating to Google Translate as the
primary backend (40x faster) with GPT as fallback only for the hardest
languages.

### Translation endpoints (all in `routes.py`)

| Endpoint | Purpose | Notes |
|----------|---------|-------|
| `POST /api/translate/title` | Translate video title | Dedicated endpoint to prevent hallucination (reusing summary prompt for short text caused the model to generate extra content) |
| `POST /api/translate/summary` | Translate summary text | Preserves `[[name]]` and `**term**` markup |
| `POST /api/translate/chapters` | Translate chapter titles | Returns JSON, uses `response_format: json_object` (OK here because output is small and Latin-compatible keys) |
| `POST /api/translate/transcript` | Translate transcript (tagged format) | Original system, chunked + parallel |
| `POST /api/translate/transcript-chunk` | Translate single chunk (tagged) | Frontend manages parallelism |
| `POST /api/translate/transcript-json` | Translate transcript (JSON format) | New system, no `response_format` constraint |

### Quality safeguards (in `translate.py`)

- **`_fix_repetition()`**: Regex-based truncation of degenerate repetition
  loops (same word/phrase 5+ times). Common failure mode with
  gpt-4o-mini on low-resource languages.
- **`check_quality()`**: Flags translations where >30% of lines end in
  `...` (remnant of truncated repetition) or length ratio is suspicious
  (>3x or <0.15x original).
- **`_strip_prompt_leak()`**: Detects and removes leaked system/user
  prompt instructions from model output. Pattern-matched against known
  prompt phrases.
- **Quality warning banners**: Frontend shows a warning when backend
  returns `"warning": "low_quality"`. (The legacy `_fix_merged_lines()`
  helper that split lines where the LLM merged multiple `[L:N]` tags
  onto one line was removed in Bundle 6 of the cleanup follow-up
  (2026-05-09) — the entire plaintext-tag translation path was deleted
  as dead code; the live frontend uses the JSON-shape path which has
  its own validation via `_validate_json_translation`.)

---

## Font System (i18n)

> Shipped 2026-04-30 as v2.1 of the font architecture. Replaces 5 layers
> of competing per-element / per-lang / per-bilingual / per-theme rules
> + JS inline `font-family` pinning with a single role-based token system
> on top of unicode-range-driven Google Fonts.

### Three pillars

#### Pillar 1 — `unicode-range` `@font-face` (Google Fonts)

A single `<link>` URL in `index.html` declares all 31+ font families:
Inter, Space Grotesk, Unbounded, Syne, Poppins, JetBrains Mono, DM Mono,
Bebas Neue, Fredoka, Lalezar, Vazirmatn, Noto Sans Arabic / Hebrew /
SC / TC / JP / KR / Devanagari / Bengali / Tamil / Telugu / Gujarati /
Kannada / Malayalam / Gurmukhi / Sinhala / Thai / Lao / Khmer / Myanmar /
Ethiopic / Armenian / Georgian.

Google Fonts CSS contains multiple `@font-face` blocks per family, each
scoped by `unicode-range` (e.g. `U+0600–06FF` for Arabic/Persian script).
The browser parses the CSS once but **only fetches a font binary when
the page contains characters in that range**. Persian video → Vazirmatn
fetches automatically. English-only video → no Persian/Arabic/CJK
binaries fetched. Zero JS lazy-loader needed.

CJK families (`Noto Sans SC/TC/JP/KR`) include weight `600` to prevent
synthetic-bold rendering on entity highlights and other 600-weight rules.

#### Pillar 2 — Role-based CSS tokens

In `dashboard.css :root`:

```css
/* The i18n fallback tail. Order = first-match-per-codepoint. */
--font-i18n: 'Vazirmatn', 'Noto Sans Arabic', 'Noto Sans Hebrew',
             'Noto Sans SC', 'Noto Sans TC', 'Noto Sans JP', 'Noto Sans KR',
             'Noto Sans Devanagari', 'Noto Sans Bengali', 'Noto Sans Tamil',
             'Noto Sans Telugu', 'Noto Sans Gujarati', 'Noto Sans Kannada',
             'Noto Sans Malayalam', 'Noto Sans Gurmukhi', 'Noto Sans Sinhala',
             'Noto Sans Thai', 'Noto Sans Lao', 'Noto Sans Khmer',
             'Noto Sans Myanmar', 'Noto Sans Ethiopic', 'Noto Sans Armenian',
             'Noto Sans Georgian', sans-serif;

/* Content roles — safe for any-script user/translated/generated text. */
--font-content-body:    'Inter', var(--font-i18n);
--font-content-heading: 'Space Grotesk', var(--font-i18n);
--font-content-chat:    'Poppins', 'Inter', var(--font-i18n);

/* Brand/UI roles — Latin display only. NEVER on user content. */
--font-brand-display:   'Unbounded', sans-serif;
--font-brand-soft:      'Syne', sans-serif;
--font-brand-condensed: 'Bebas Neue', sans-serif;

--font-mono: 'JetBrains Mono', monospace;
```

User-content elements (`.ts-text`, `.summary-quick-text`, `.context-text`,
`.chapter-name`, `.chat-bubble`, `.chat-input`, `.chat-chip`,
`.video-title-text`, `.vtag`, `.bm-note`, search inputs, lang picker
native names, etc.) use `var(--font-content-*)`. UI/brand elements (nav,
paste button, hero word, app brand) stay hardcoded with their Latin
display fonts.

The browser handles per-codepoint font selection: Latin chars use the
role's primary face (Inter / Space Grotesk / Unbounded), non-Latin
chars fall through `var(--font-i18n)` and find their script's font.
**Mixed-script content** (Persian title quoted inside an English summary)
is handled automatically by this cascade — no per-element scoped rules
needed.

#### Pillar 3 — `awaitFontForLang(lang, sample)` Promise gate

`font-loader.js` exposes `awaitFontForLang(lang, { timeoutMs })` which
returns a Promise resolving to `{ ok, reason, font }`. Internally uses
`document.fonts.load(spec, sample)` with **per-script sample text**
(`'سلام'` for Persian, `'日本語'` for Japanese, etc.) — required for
unicode-range subsets to actually fetch.

Cache strategy: in-flight Promises are memoized on success and
**deleted on failure** so a later call retries. A timed-out fetch may
finish shortly after; the next call gets it. Never permanently caches a
failure.

Call sites:

- `app.js loadFromApi` / `updateFromApi` — `await awaitFontForLang(lang, { timeoutMs: 800 })`
  on source-language detection, before `renderAll()`. 800ms cap because
  recap speed is core UX; a stalled font fetch must never delay first
  paint.
- `translation/translation.js setLanguage()` —
  `await awaitFontForLang(targetLang, { timeoutMs: 1500 })` before the
  wave-transition that paints translated content. 1500ms cap because
  translation already shows a visible loading state.
- User-typed paths (chat input, search input) are **not gated** — by the
  time the language is detected from typed chars, they're already on
  screen. `unicode-range` auto-fetches the script's font on first
  matching codepoint, and the cascade fallback handles the brief flash.

### Theme-level role-var redefinition

Each theme redefines content vars at the body class. Brutalist's redefine
lives at the top of `src/css/brutalist.css` (extracted from `dashboard.css`
2026-05-08 along with the rest of the `body.theme-brutalist` reskin):

```css
body.theme-brutalist {
  --font-content-body:    'Syne', var(--font-i18n);
  --font-content-heading: 'Unbounded', var(--font-i18n);
  --font-content-chat:    'JetBrains Mono', var(--font-i18n);
}
```

Base rules using `var(--font-content-*)` pick up theme overrides via
cascade — so most per-element brutalist `font-family` overrides become
deletable. Adding a new theme = redefine 3-4 vars in one place; no
per-selector overrides needed.

### Script disambiguation

The `unicode-range` cascade alone cannot pick the correct script font when
languages share a Unicode block:

- Arabic + Persian + Urdu + Kurdish + Pashto + Sindhi all use U+0600–06FF
- Japanese + Simplified Chinese + Traditional Chinese share Han ideographs
- Devanagari is shared by Hindi / Marathi / Nepali

The disambiguation block lives in its own file `src/css/font-matrix.css`
(extracted from the bottom of `dashboard.css` 2026-05-08; loaded after
all other CSS so its specificity-0,3,1+ chains keep winning). It forces
the correct face when a container is tagged with the lang class. It
covers
14 surfaces per disambiguated language (mobile + desktop transcript /
summary / chapters / title context / chat bubbles / greeting bubble /
chips / bilingual subs / switched-mode / language picker native names),
across 4 languages: `.lang-ar`, `.lang-ja`, `.lang-zh-tw`, `.lang-ko`.

Trailing fallback uses `var(--font-content-body)` (not `var(--font-i18n)`)
so Latin loanwords inside non-Latin content keep the theme's Latin
display character (Inter / Syne / etc.) instead of falling to
Vazirmatn-Latin or Noto-Arabic-Latin.

### Lang class application

`font-loader.js setLangClass(el, lang)` stamps the canonical `.lang-XX`
class on an element after stripping any prior lang class. Used by:

- `app.js` — on `#resultsView` when source lang is detected.
- `casual-mode.js` — when language switches.
- `renderer.js` — on `.summary-wheel-host`, `#fullSubtitlePanel`,
  `.transcript-buffer` per render.
- `chat.js` and `translation-bilingual.js` — directly on chat bubbles
  and greeting bubbles.
- `title-switcher.js` — on `.ts-display` and `.ts1-wrap` (already used
  the dynamic pattern pre-v2.1).

The plumbing is canonical (zh-Hant → `lang-zh-tw`, zh-Hans → `lang-zh`,
base lang otherwise) so the disambiguation CSS never needs to special-case.

### Hero word per-script pinning (preserved design)

The big colored hero word in the title (`.ts1-hero`) is intentionally
pinned to one script-pure font per language so a non-Latin title's hero
word renders 100% in that script's face — no mixed-font appearance for
Latin loanwords inside it. This is deliberate visual design and lives in
`title.css` with explicit `/* font-system: intentional */` annotations.
Don't generalize these rules into the cascade.

Similarly, brutalist Persian title context lines are pinned to Lalezar
(a chunky display Persian face) for the brutalist aesthetic.

### Boot-time DOM sweep

`main.js` calls `clearStaleInlineFontFamily()` on `DOMContentLoaded`,
once. This removes any inline `font-family` pins left over from a
previously-deployed version of the app (the iteration-5 code path
inlined `font-family !important` on script-tagged elements). bfcache and
service-worker-cached pages can preserve those stale pins across
deploys; the cascade-driven design needs them cleared so the
per-codepoint fallback can do its work.

Safe no-op on a clean first load — no production code paths set inline
`font-family` anymore (the only legitimate writer was
`translation.js`'s overlay snapshot during transitions, but those
overlays are transient and don't exist at boot).

### Mobile transcript size baseline

`mobile-layout.css` (the `@media (max-width: 900px)` block extracted
from `dashboard.css` 2026-05-08) sets a universal
`#fullTranscriptPanel .ts-text { font-size: 15px; line-height: 1.6; }`
baseline so single-lang Latin (English) doesn't render 1px smaller than
single-lang Persian (which had its own 15px rule). Per-script font-face
rules still fire afterward for visual consistency with the
disambiguation block.

### Entity highlight weight

`transcript.css` entity rules (`.tx-name`, `.tx-org`, `.tx-date`, etc.)
use a deliberate `font-weight: 600`. Previously this was
`font-weight: inherit` — but inherit produced cross-script asymmetry:
Latin entities in bilingual mode picked up the 600 weight bump (from
`.bilingual-side-by-side ... :not(.lang-script-dense) { font-weight: 600 }`)
while Persian / Arabic / CJK entities (in dense scripts that don't get
the Latin-only bump) stayed at 500. The same NER name looked bolder
when quoted in English text vs. its native language. A pinned 600 makes
highlights equally prominent in every script + every mode.

### Known limitations

- **Mixed-script quoted spans without a `lang` attribute**: Cascade can't
  fully solve them. Persian-in-English works because Vazirmatn is first
  in `--font-i18n`. Arabic-in-English would render in Vazirmatn (Persian
  glyph variants); Japanese-in-English would render in Noto Sans SC
  (Han-unification glyphs). Full fix requires backend `<span lang="ar">`
  emission on language-tagged spans (entity highlighter, NER), then
  switch CSS to `:lang()` selectors. Tracked as a follow-up; not
  expected to bite for typical content.
- **Marathi / Nepali (Devanagari)**: ship without disambiguation rules.
  Hindi default in `--font-i18n` is acceptable for them; add per-lang
  rules if a native-speaker QA finds visible issues.
- **Urdu (Nastaliq style)**: Urdu traditionally uses Noto Nastaliq Urdu
  rather than Vazirmatn's Naskh. Shipping with Vazirmatn as a usability
  compromise. Add a Nastaliq disambiguation rule + load the Nastaliq
  family if Urdu users report this as wrong.

### File map

| File | Role |
|------|------|
| `src/index.html` | Single Google Fonts `<link>` declaring all 31+ families. Includes weight 600 on Noto SC/TC/JP/KR for synthetic-bold prevention. Loads CSS in cascade-critical order: `dashboard.css` → `mobile-layout.css` → section files → `brutalist.css` → `font-matrix.css` → `music-only.css`. |
| `src/css/dashboard.css` | `:root` role tokens + `body { font-family: var(--font-content-body) }`. (Brutalist theme-level redefinition moved to `brutalist.css` 2026-05-08; script-disambiguation block moved to `font-matrix.css` 2026-05-08.) |
| `src/css/brutalist.css` | Brutalist theme-level redefinition `body.theme-brutalist { --font-content-body: 'Syne', ... }` plus all `body.theme-brutalist` reskin rules. Loaded after section files so the redefine wins via cascade order. |
| `src/css/font-matrix.css` | Comprehensive script-disambiguation block (Arabic / Japanese / Traditional Chinese / Korean per-script font-family chains). Loaded near the end of the cascade — chains are specificity 0,3,1+ but explicit late-load makes intent unambiguous. Every block carries an inline `font-system: intentional` marker; do NOT strip those when touching this file. |
| `src/css/mobile-layout.css` | The big `@media (max-width: 900px)` block including the universal `#fullTranscriptPanel .ts-text` mobile size baseline. |
| `src/css/transcript.css` | `.ts-text`, `.search-input` use `var(--font-content-body)`. Per-buffer `.lang-XX` rules carry layout tweaks (line-height) only. Bilingual weight bump via `:not(.lang-script-dense)`. Entity rules (`.tx-*`) at `font-weight: 600`. |
| `src/css/summary.css` | `.summary-quick-text`, `.context-text`, `.summary-title-label`, `.context-label` use role vars. Per-display `.lang-XX` rules carry layout tweaks only. Brutalist content overrides have `font-family` stripped (theme role var handles). |
| `src/css/chapters.css` | `.chapter-name` (inherits body), `.chapter-num` uses `var(--font-mono)`. Bilingual sub uses `var(--font-content-heading)`. |
| `src/css/title.css` | `.video-title-text` uses `var(--font-content-heading)`. Per-script title context lines + hero word pinned (intentional design). |
| `src/css/home.css` | Landing-page brand fonts unchanged (Unbounded / Fredoka / Syne for hero, paste button, shark bubble). |
| `src/js/ui/font-loader.js` | `SCRIPT_FONTS` table + `awaitFontForLang` + `applyLangStyle` + `setLangClass` + `clearStaleInlineFontFamily`. |
| `src/js/main.js` | Boot-time `clearStaleInlineFontFamily()` call on `DOMContentLoaded`. |
| `src/js/app.js` | `awaitFontForLang(lang, { timeoutMs: 800 })` on source-lang detection. `setLangClass` on `#resultsView`. |
| `src/js/translation/translation.js` | `setLanguage()` is async, awaits `awaitFontForLang(langCode, { timeoutMs: 1500 })` before wave-transition. |
| `src/js/ui/casual-mode.js`, `renderer.js`, `flat-transcript.js`, `flat-transcript-render.js` | `setLangClass` plumbed into all panel renderers. `applyLangStyle` on `.ts-sub` unconditional (no textContent gate) so direction is correct for any source language. |

### Decision log + external review

- Plan + decisions: [`docs/logs/font-system-plan-v2.1.md`](../logs/font-system-plan-v2.1.md)
- Round 1 review: [`docs/logs/1/feedbacks/02.md`](../logs/1/feedbacks/02.md), [`docs/logs/1/feedbacks/04.md`](../logs/1/feedbacks/04.md)
- Round 2 review: [`docs/logs/2/feedbacks/02.md`](../logs/2/feedbacks/02.md), [`docs/logs/2/feedbacks/04.md`](../logs/2/feedbacks/04.md)

---

## Validation checklist (Phase 6)

The 35-case test matrix from the v2.1 plan, marked by who runs each.
Status: shipped 2026-04-30 with informal manual testing; this checklist
is for the formal pre-release pass.

**Legend**:
- 🤖 = AI runs (desktop, async — paste back DevTools output / network log)
- 📱 = User runs (real iOS Safari / mobile network / real device)
- 👀 = Either (manual eyeball verification, can be done by either party)

### Functional / visual

| # | Case | Who | Expected outcome |
|---|------|-----|------------------|
| 1 | English video, English summary | 👀 | Landing + video page identical to baseline `9bb6cdd`; transcript/summary in Inter (or Syne in brutalist). |
| 2 | Persian video, Persian summary | 👀 | Title, hero, transcript, chapters, summary, chat all in Vazirmatn. RTL throughout. |
| 3 | Persian video, English summary | 👀 | Persian channel/title quoted in English summary in Vazirmatn cleanly (the original screenshot bug). |
| 4 | Persian video, English bilingual mode | 👀 | Both columns correct; no font flip on toggle; Persian sub renders RTL. |
| 5 | **Arabic video, Arabic summary** | 👀 | Noto Sans Arabic (NOT Vazirmatn). Disambiguation regression check. |
| 6 | **Japanese video** | 👀 | Noto Sans JP glyphs (NOT Simplified-Chinese variants). Han disambiguation. |
| 7 | **Traditional Chinese (zh-TW) video** | 👀 | TC glyphs (e.g. 體 vs. 体, 國 vs. 国). |
| 8 | Korean (ko) video | 👀 | Noto Sans KR Hangul. |
| 9 | Hindi (hi) video | 👀 | Noto Sans Devanagari. |
| 10 | Thai (th) video | 👀 | Noto Sans Thai. |
| 11 | Brutalist theme | 👀 | All of #1–10 still hold in brutalist; Latin display character preserved on UI elements. |
| 12 | Light theme | 👀 | Same as #11. |
| 13 | Dark theme | 👀 | Same as #11. |
| 14 | Mobile (Cloudflare Tunnel) | 📱 | All of #1–10 work on real iOS Safari. |

### Failure modes

| # | Case | Who | Expected outcome |
|---|------|-----|------------------|
| 15 | Slow-3G throttling | 🤖 | `awaitFontForLang` timeout fires cleanly at 800ms / 1500ms; no infinite hang; fallback paints with `console.warn` logged. (DevTools → Network → Slow 3G + Throttling.) |
| 16 | Block `fonts.gstatic.com` in DevTools | 🤖 | Page renders with cascade fallback; visible warning in console; no crash. |
| 17 | Cold session, switch to Japanese mid-translation | 👀 | First-time JP font: gate works, no FOUT, correct glyphs. Loading state visible during the await. |
| 18 | Mid-session toggle Persian → Arabic | 👀 | Disambiguation kicks in correctly across the toggle (Vazirmatn → Noto Sans Arabic). |

### Performance / network

| # | Case | Who | Expected outcome |
|---|------|-----|------------------|
| 19 | **FCP + LCP delta vs. baseline `9bb6cdd`** on English-only video, cold-cache mobile throttling (slow 3G) | 📱 | Median FCP regression ≤50ms AND median LCP regression ≤50ms across 3 runs. |
| 20 | Network panel, fresh cache, English video | 🤖 | Zero Noto / Vazirmatn binary fetches. Latin display fonts only. (Caveat: hidden DOM with non-Latin chars *will* trigger fetches — verify no such hidden DOM on landing.) |
| 21 | Network panel, fresh cache, Persian video | 🤖 | Vazirmatn binary fetches; Noto SC/JP/etc. do NOT fetch. |
| 22 | Google Fonts CSS payload — measure baseline + post-change | 🤖 | Run `curl -s -H 'Accept-Encoding: gzip' -H 'User-Agent: <prod-UA>' -o /dev/null -w 'size: %{size_download}\n' '<URL>'` on the new and old URLs. Acceptance: post-change gzipped delta ≤20KB. Over 30KB gzipped = consider splitting CSS URL. |

### Infra / platform

| # | Case | Who | Expected outcome |
|---|------|-----|------------------|
| 23 | **CSP audit** | 🤖 | Confirm any active `Content-Security-Policy` header allows `font-src https://fonts.gstatic.com` and `style-src https://fonts.googleapis.com`. (RecapShark already uses Google Fonts — likely fine.) |
| 24 | **iOS Safari 26+** specifically | 📱 | `document.fonts.load()` and `font-display` work; gate fires; no font flash. |
| 25 | **Service worker / Netlify cache** | 🤖 | Confirmed: no service worker (Phase 0 audit). Netlify CDN handles invalidation on deploy. Document in PR. |
| 26 | **Synthetic-bold weight gap** | 🤖 | `grep -r "font-weight: 600" src/css \| grep -v var\(` — audit each user-content rule. CJK weight 600 added to Google Fonts URL in Phase 1; verify no synthetic-bold rendering on Chinese/Japanese/Korean entity highlights. |
| 27 | **Language picker dropdown** | 👀 | Open lang picker, scroll. Native names like فارسی, 中文, 日本語, हिन्दी render in correct script. |

### Regression-specific

| # | Case | Who | Expected outcome |
|---|------|-----|------------------|
| 28 | Landing page | 👀 | Hero, shark bubble, paste button, stats row visually identical to baseline. **Was broken in iteration 4; explicit regression test.** |
| 29 | Video title hero word in Persian video | 👀 | Pinned to Vazirmatn even if Latin chars present in title (visual design preserved). |
| 30 | **`.lang-script-dense` flow** | 🤖 | DevTools Elements: pick a `.lang-fa` panel → confirm `.lang-script-dense` class present; pick an `.lang-en` panel → confirm class absent. Verifies `applyLangStyle` is firing. Mixed-content children (Persian span in English container) intentionally do NOT get this class — Option A from v2.1 plan. |
| 31 | **Bilingual swap acceptance test** | 🤖 | Run before AND after toggling bilingual swap mode in DevTools console:<br>`[...document.querySelectorAll('.ts-text, .bilingual-sub, .summary-quick-text, .context-text, .chapter-name, .chat-bubble')].map(el => ({text: el.textContent.trim().slice(0,40), className: el.className, lang: el.getAttribute('lang'), font: getComputedStyle(el).fontFamily, dir: getComputedStyle(el).direction}))`<br>Every element's computed `font` matches its actual text language; classes/text move together — no "English text inside `.lang-fa` container" or vice versa. |
| 32 | **Brutalist Arabic content with Latin loanwords** | 👀 | Arabic transcript line containing an English channel handle (e.g. "@ChannelName"). Arabic glyphs in Noto Sans Arabic AND Latin glyphs in Syne (theme content body), not Noto-Arabic-Latin. |
| 33 | **Mid-session fetch failure recovery** | 🤖 | DevTools → block `fonts.gstatic.com` on first attempt → unblock → trigger another translation. Second attempt actually retries (`_pendingLoads.delete()` on failure means cache doesn't permanently hold the failure). |
| 34 | **Source-language detection edge cases** (defensive) | 👀 | Load a video where backend lang detection is wrong. App doesn't crash; RTL flip degrades gracefully; fallback chain produces readable output. If backend detection accuracy <99% in production → add confidence guard (skip `applyLangStyle` on low confidence). |
| 35 | **Synthetic-bold weight gap audit** (Phase 0 task) | 🤖 | `grep -r "font-weight: 600" src/css/`. Identify rules that target user-content selectors. CJK weight 600 already added in Phase 1. Verify visually for any Chinese/Japanese/Korean test video. |

### Computed-style smoke (DevTools console — desktop)

🤖 Run on a Persian video page after first paint:

```js
['.summary-quick-text', '.ts-text', '.chapter-name', '.chat-bubble', '.video-title-text']
  .map(s => ({sel: s, font: getComputedStyle(document.querySelector(s)).fontFamily}))
```

Expected: every entry contains the role stack with i18n fallback (Inter or Syne or Poppins, then Vazirmatn / Noto Sans Arabic / etc., then sans-serif). Brand selectors (`.paste-btn`, `.ts1-hero`, `.nav-brand`) should NOT contain the i18n tail.

### How to run this

Easiest flow when ready: load each test video in your local browser, work through the table top-to-bottom. For 🤖 cases, paste me the DevTools output (Network tab screenshot, console output, or computed-style results) and I'll verify. For 📱 cases, you eyeball + screenshot, paste back. Cases 1–14 are mostly visual eyeballing — bulk-run through them in one session.

Test videos:
- 🇺🇸 English: https://youtu.be/qADTr7d6gMU
- 🇮🇷 Persian: https://youtu.be/H9sEgX8vGdU
- 🇸🇦 Arabic, 🇯🇵 Japanese, 🇨🇳 / 🇹🇼 Chinese, 🇰🇷 Korean, 🇮🇳 Hindi, 🇹🇭 Thai — pick any popular video in each language from YouTube.
