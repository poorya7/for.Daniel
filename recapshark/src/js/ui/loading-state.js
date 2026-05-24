import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';
import { TranslationManager } from '../translation/translation.js';
import { ChatManager } from '../chat/chat.js';
import { SearchManager } from './search.js';
import { PlayerManager } from '../player/player.js';
import { TranscriptBuffer } from './transcript-buffer.js';
import { FeatureToggle } from './feature-toggle.js';
import { Renderer } from './renderer.js';

/**
 * Lang-keyed placeholder titles for the mobile chapters skeleton (rendered
 * blurred during the rewind animation, before real chapters arrive).
 *
 * The skeleton was originally English-only with the assumption that blur
 * fully obscures the text — but on the unblur frame the words become
 * legible for ~50ms, and on a Persian/Arabic/Hebrew video that legible
 * frame is jarring (English text inside an otherwise-RTL page that's
 * about to render in the user's script). Translating the placeholders
 * keeps the visual silhouette identical while ensuring whatever leaks
 * through the blur reads as the right script.
 *
 * Coverage is intentionally narrow: the three non-Latin / RTL scripts
 * we already ship fonts for (fa/ar/he). Latin-script translations would
 * be Sapir-Whorf bikeshed for negligible visual gain — Inter renders
 * "Introduction" and "Introducción" with near-identical letterforms,
 * so the flash isn't perceptible.
 *
 * Translations chosen to be GENERIC (work for any video genre) and
 * roughly-equal-width to the English originals so the skeleton's row
 * widths stay stable across langs.
 */
// Best-effort drafts for ja/zh/ko/hi added 2026-05-10 — closes the
// non-Latin coverage gap so the unblur flash on Japanese / Chinese / Korean /
// Hindi videos doesn't briefly show English text in a non-Latin context.
// Native-speaker review recommended before final merge; semantic accuracy
// matters less than visual silhouette under blur (these are filler words
// the user never reads, only senses).
const _PLACEHOLDER_TITLES_BY_LANG = {
  en: [
    'Introduction', 'Background context', 'The setup',
    'Key insights', 'The challenge', 'Behind the scenes',
    'A closer look', 'What we learned', 'Practical examples',
    'Common questions', 'Closing thoughts', 'Final remarks',
  ],
  fa: [
    'مقدمه', 'پیش‌زمینه', 'شروع',
    'نکات کلیدی', 'چالش', 'پشت صحنه',
    'نگاه دقیق‌تر', 'درس‌ها', 'مثال‌های عملی',
    'پرسش‌های رایج', 'جمع‌بندی', 'سخن پایانی',
  ],
  ar: [
    'مقدمة', 'السياق', 'البداية',
    'النقاط الرئيسية', 'التحدي', 'خلف الكواليس',
    'نظرة أعمق', 'ما تعلمناه', 'أمثلة عملية',
    'أسئلة شائعة', 'خاتمة', 'ملاحظات نهائية',
  ],
  he: [
    'מבוא', 'רקע', 'התחלה',
    'תובנות מרכזיות', 'האתגר', 'מאחורי הקלעים',
    'מבט מעמיק', 'מה למדנו', 'דוגמאות מעשיות',
    'שאלות נפוצות', 'סיכום', 'הערות אחרונות',
  ],
  ja: [
    'はじめに', '背景', '導入',
    '主な要点', '課題', '舞台裏',
    '詳しく見る', '学んだこと', '実例',
    'よくある質問', 'まとめ', '最後に',
  ],
  zh: [
    '简介', '背景', '开始',
    '关键见解', '挑战', '幕后',
    '深入了解', '所学之处', '实际示例',
    '常见问题', '结语', '最后的话',
  ],
  ko: [
    '소개', '배경', '시작',
    '핵심 요점', '도전 과제', '비하인드',
    '자세히 보기', '배운 점', '실제 예시',
    '자주 묻는 질문', '마무리', '맺음말',
  ],
  hi: [
    'परिचय', 'पृष्ठभूमि', 'शुरुआत',
    'मुख्य बिंदु', 'चुनौती', 'पर्दे के पीछे',
    'गहरी नज़र', 'जो सीखा', 'व्यावहारिक उदाहरण',
    'सामान्य प्रश्न', 'समापन विचार', 'अंतिम टिप्पणी',
  ],
};

function _placeholderTitlesFor(lang) {
  if (!lang) return _PLACEHOLDER_TITLES_BY_LANG.en;
  const base = String(lang).split('-')[0];
  return _PLACEHOLDER_TITLES_BY_LANG[base] || _PLACEHOLDER_TITLES_BY_LANG.en;
}

function _renderPlaceholderRows(lang) {
  const titles = _placeholderTitlesFor(lang);
  return titles.map((t, i) =>
    `<div class="chapter-item chapter-item-placeholder">` +
      `<span class="chapter-num">${i + 1}.</span>` +
      `<span class="chapter-name">${t}</span>` +
    `</div>`
  ).join('');
}

/**
 * Mobile transcript-pane skeleton placeholder text — parallel to the
 * chapters placeholders above. Same lang coverage (en + fa/ar/he + ja/zh/
 * ko/hi). Each entry is one paragraph's worth of generic conversational
 * filler — reads as "any podcast / interview / lecture" regardless of the
 * actual video. Lines are roughly equal length so the silhouette under
 * the rewind blur stays stable across scripts.
 *
 * Native-speaker review recommended before final merge for non-Latin
 * langs other than Persian (project owner verifies fa directly).
 */
const _TRANSCRIPT_PLACEHOLDER_BY_LANG = {
  en: [
    'Welcome to the show — today we are going to talk about something I think you will find interesting.',
    'Before we get started, let me give you a bit of context about how this all came together.',
    'So the first thing to understand is the broader picture and what was happening at the time.',
    'Once we have that established, the next piece is figuring out what it actually means in practice.',
    'Now this is where things get interesting, because the conventional view turns out to be incomplete.',
    'Let me walk you through a specific example that I think makes the underlying idea concrete.',
  ],
  fa: [
    'به برنامه خوش آمدید — امروز می‌خواهیم درباره موضوعی صحبت کنیم که فکر می‌کنم برایتان جالب باشد.',
    'قبل از اینکه شروع کنیم، بگذارید کمی درباره چگونگی شکل‌گیری این ماجرا توضیح بدهم.',
    'اولین چیزی که باید بفهمیم، تصویر کلی و آنچه در آن زمان در حال رخ دادن بود است.',
    'پس از روشن شدن این موضوع، گام بعدی این است که بفهمیم در عمل چه معنایی دارد.',
    'و اینجا جایی است که قضیه جالب می‌شود، چون دیدگاه رایج کامل نیست.',
    'بگذارید یک مثال مشخص را با شما در میان بگذارم که ایده اصلی را ملموس‌تر می‌کند.',
  ],
  ar: [
    'مرحبًا بكم في الحلقة — اليوم سنتحدث عن شيء أعتقد أنكم ستجدونه مثيرًا للاهتمام.',
    'قبل أن نبدأ، دعوني أعطيكم بعض السياق حول كيفية جمع كل هذا معًا.',
    'أول شيء يجب فهمه هو الصورة الأوسع وما كان يحدث في ذلك الوقت.',
    'بمجرد أن نحدد ذلك، الجزء التالي هو معرفة ما يعنيه فعليًا في الممارسة.',
    'هنا تصبح الأمور مثيرة للاهتمام، لأن الرأي السائد يتضح أنه غير مكتمل.',
    'دعوني آخذكم خلال مثال محدد أعتقد أنه يجعل الفكرة الأساسية ملموسة.',
  ],
  he: [
    'ברוכים הבאים לתוכנית — היום נדבר על משהו שאני חושב שתמצאו מעניין.',
    'לפני שנתחיל, אני רוצה לתת לכם קצת רקע על איך כל זה התגבש יחד.',
    'הדבר הראשון להבין הוא התמונה הרחבה ומה היה קורה באותו זמן.',
    'אחרי שזה ברור, החלק הבא הוא להבין מה זה אומר בפועל בשטח.',
    'וכאן הדברים נעשים מעניינים, כי הדעה הרווחת מתבררת כלא שלמה.',
    'תנו לי להוביל אתכם דרך דוגמה ספציפית שמבהירה את הרעיון המרכזי.',
  ],
  ja: [
    'ようこそ — 今日は皆さんが興味深いと思うことについてお話しします。',
    '始める前に、これがどのようにまとまったかの背景を少しお伝えします。',
    '最初に理解すべきことは、全体像とその時何が起きていたかです。',
    'それが分かれば、次は実際にそれが何を意味するのかを考えていきます。',
    'ここから面白くなります、なぜなら一般的な見方は完全ではないからです。',
    '具体的な例を通して、根底にある考えを分かりやすく説明しましょう。',
  ],
  zh: [
    '欢迎收看 — 今天我们要聊一个我觉得你会感兴趣的话题。',
    '在我们开始之前,让我先简单介绍一下这一切是怎么聚到一起的。',
    '首先要理解的是更大的背景以及当时正在发生什么。',
    '一旦明确了这一点,下一步就是弄清楚在实际中这究竟意味着什么。',
    '这里就有意思了,因为传统的看法其实并不完整。',
    '让我用一个具体的例子,把背后的核心想法说得更清楚。',
  ],
  ko: [
    '안녕하세요 — 오늘은 여러분이 흥미로워할 만한 이야기를 나누려고 합니다.',
    '시작하기 전에, 이 모든 것이 어떻게 시작되었는지 간단히 말씀드리겠습니다.',
    '먼저 이해해야 할 것은 전체적인 그림과 그때 무슨 일이 일어나고 있었는지입니다.',
    '그게 정해지면 다음 단계는 실제로 그것이 무엇을 의미하는지 알아보는 것입니다.',
    '여기서부터 흥미로워집니다, 기존의 견해가 완전하지 않다는 것이 드러나기 때문입니다.',
    '구체적인 예를 통해 핵심 아이디어를 더 분명하게 전해드리겠습니다.',
  ],
  hi: [
    'शो में आपका स्वागत है — आज हम एक ऐसी चीज़ की बात करेंगे जो आपको दिलचस्प लगेगी।',
    'शुरू करने से पहले, मैं आपको थोड़ा बताऊँगा कि यह सब कैसे एक साथ आया।',
    'पहली बात जो समझनी है वो है बड़ी तस्वीर और उस वक्त क्या हो रहा था।',
    'जब यह साफ हो जाए, तो अगला कदम है समझना कि असल में इसका मतलब क्या है।',
    'और यहाँ बात दिलचस्प होती है, क्योंकि आम राय अधूरी निकलती है।',
    'मैं आपको एक खास उदाहरण के ज़रिए मूल विचार को साफ करके दिखाता हूँ।',
  ],
};

function _transcriptPlaceholderTextFor(lang) {
  if (!lang) return _TRANSCRIPT_PLACEHOLDER_BY_LANG.en;
  const base = String(lang).split('-')[0];
  return _TRANSCRIPT_PLACEHOLDER_BY_LANG[base] || _TRANSCRIPT_PLACEHOLDER_BY_LANG.en;
}

function _renderTranscriptPlaceholderRows(lang) {
  const lines = _transcriptPlaceholderTextFor(lang);
  // Fake timestamps every 30s starting at 0:00. Format matches the real
  // chip output from buildMobilePanelItems → buildTranscriptParagraphHtml.
  // Rows render inside a .flat-transcript-content wrapper so all the real-
  // transcript styling (alt-row zebra tint, no border-top, 8px 14px padding)
  // applies verbatim — placeholder under blur reads identically to the real
  // content that replaces it, just with placeholder text. Odd-indexed rows
  // get .alt-row to match the real alternating-row pattern.
  const rowsHtml = lines.map((text, i) => {
    const t = i * 30;
    const m = Math.floor(t / 60);
    const s = t % 60;
    const chip = `${m}:${s < 10 ? '0' + s : s}`;
    const altCls = i % 2 === 1 ? ' alt-row' : '';
    return (
      `<div class="transcript-paragraph transcript-paragraph-placeholder${altCls}">` +
        `<span class="ts-chip">${chip}</span>` +
        `<span class="ts-text">${text}</span>` +
      `</div>`
    );
  }).join('');
  return `<div class="flat-transcript-content">${rowsHtml}</div>`;
}

/**
 * Swap the chapters-skeleton placeholder titles into `lang` after the
 * pipeline reports the video's actual language. No-op if the skeleton
 * is already gone (real chapters arrived) or never rendered. Idempotent.
 *
 * Called from `loadFromApi` the moment AppState.currentLang is set, so
 * the swap happens during the blur window — by the time the blur lifts,
 * any English placeholder text has already been replaced with the
 * matching script, eliminating the EN→FA flash on Persian/Arabic/Hebrew
 * videos. Falls through silently for langs not in the table.
 */
export function updatePlaceholderTitlesLang(lang) {
  // Chapters skeleton swap (existing behavior).
  const chaptersTab = document.getElementById('chaptersTabList');
  if (chaptersTab) {
    // Only swap if the rows still belong to the placeholder skeleton —
    // never overwrite real chapters that may have already landed.
    const placeholders = chaptersTab.querySelectorAll('.chapter-item-placeholder');
    if (placeholders.length) {
      chaptersTab.innerHTML = _renderPlaceholderRows(lang);
    }
  }

  // Transcript skeleton swap (parallel to chapters). Same idempotency
  // check: only mutates if the placeholder host is still present — gone
  // means FlatTranscript.prepare() already wiped #fullTranscriptPanel
  // and we'd be writing into the wrong DOM.
  const transcriptHost = document.querySelector('#fullTranscriptPanel .flat-transcript-placeholder');
  if (transcriptHost && transcriptHost.querySelector('.transcript-paragraph-placeholder')) {
    transcriptHost.innerHTML = _renderTranscriptPlaceholderRows(lang);
  }
}

export function showLoadingState(videoId) {
  Renderer.destroyAllMobilePanels();
  AppState.reset();
  if (typeof TranslationManager !== 'undefined') TranslationManager.reset();
  FeatureToggle.setAll(true);
  FeatureToggle.setLangButton(false);
  ChatManager.reset();
  AppState.currentChapters = null;
  AppState.currentSummary = null;
  AppState.currentUploadDate = null;
  document.body.classList.add('casual-mode');

  const _loadTitleData = document.getElementById('videoTitleData');
  if (_loadTitleData) _loadTitleData.textContent = 'Loading...';
  const _chBadge = document.getElementById('videoChannel'); if (_chBadge) _chBadge.textContent = '';
  const nwTitle = document.querySelector('.nw-title');
  const nwMeta = document.querySelector('.nw-meta');
  if (nwTitle) nwTitle.textContent = 'Loading...';
  if (nwMeta) nwMeta.textContent = '';

  const dateEl = document.getElementById('videoDate');
  if (dateEl) { dateEl.textContent = ''; dateEl.style.display = 'none'; }
  const skeletonHTML = '<div class="skeleton-wrap skeleton-dark">' +
    '<div class="skeleton-line"></div>'.repeat(3) + '</div>';
  if (typeof window._css !== 'undefined') {
    window._css.reset();
    // Render skeleton inside the active panel's .chapters-list so we don't
    // destroy the header/list scaffolding the switcher depends on.
    const activePanel = window._css.getActivePanel();
    const listEl = activePanel?.querySelector('.chapters-list');
    if (listEl) listEl.innerHTML = skeletonHTML;
    else if (activePanel) activePanel.innerHTML = skeletonHTML;
  } else {
    document.getElementById('topicsList').innerHTML = skeletonHTML;
  }
  // Mobile chaptersTabList placeholder rows. Same .chapter-item structure as
   // real chapters (numbered + title) so the blur silhouette matches exactly
   // what's coming. The .chapter-item-placeholder class neutralizes hover and
   // pointer-events so taps fall through; click handler ignores them anyway
   // (no data-chapter attribute → idx lookup fails). The body.rewind-mobile-menus
   // blur on .tab-content softens these to indecipherable shapes during the
   // VHS rewind. Generous fixed count (12) — the panel doesn't resize on
   // mobile, real chapters can be 3 or 18 and the swap is invisible under blur.
   // Generic placeholder titles work for any video; under blur the actual
   // letterforms vanish, only typography (numbered list, similar widths) shows.
  const chaptersTab = document.getElementById('chaptersTabList');
  if (chaptersTab) {
    chaptersTab.innerHTML = _renderPlaceholderRows('en');
  }

  // Mobile transcript-pane placeholder DISABLED 2026-05-12 (user request).
  // Previously rendered ~6 fake "Welcome to the show…" paragraph rows under
  // the rewind blur. On slower-pipeline videos the real transcript would
  // arrive after rewind ended and the user would visibly see the fake
  // ghost text shift to real text — "weird" per the user. New behavior:
  // panel area stays empty under the blur (the rewind-mobile-* CSS classes
  // blur the panel container itself, so the user sees a blurred empty
  // rectangle), and the wait-for-paint gate in
  // process-url-view.js (rewindPromise.then waits for `rs:transcript-painted`
  // up to 5s) ensures the blur lifts ON real content whenever the pipeline
  // delivers it before the safety timeout. Worst case (5s timeout): blur
  // lifts on empty panel, real content streams in afterward — same as
  // today's "fetching" UX on any normal slow load. The placeholder is
  // intentionally NOT removed from the chapters tab (still useful there,
  // chapters arrive on different timing). If you ever want the transcript
  // placeholder back, restore the old block and remove the wait gate in
  // process-url-view.js to avoid a 5s blur-stuck-on-placeholder window.
  //
  // Any leftover placeholder host from a stale code path or previous video
  // session: wipe it so we never accidentally show stale ghost rows.
  if (Helpers.isNarrowViewport()) {
    const transcriptPanel = document.getElementById('fullTranscriptPanel');
    const staleHost = transcriptPanel && transcriptPanel.querySelector('.flat-transcript-placeholder');
    if (staleHost) staleHost.remove();
  }
  const summaryLabel = document.querySelector('#summaryPanel .section-label');
  if (summaryLabel) summaryLabel.style.display = 'none';
  if (typeof window._sss !== 'undefined') {
    window._sss.reset();
  }
  const summaryPanel = document.getElementById('summaryDisplayA') || document.getElementById('summaryContent');
  if (summaryPanel) summaryPanel.innerHTML = '';
  const oldSkeleton = document.getElementById('summarySkeleton');
  if (oldSkeleton) oldSkeleton.remove();
  const skeletonTarget = document.getElementById('summaryDisplayHost') || document.getElementById('summaryContent');
  if (skeletonTarget) skeletonTarget.insertAdjacentHTML('afterend',
    '<div id="summarySkeleton" class="skeleton-wrap">' +
    '<div class="skeleton-line"></div>'.repeat(4) + '</div>');

  // Clear transcript buffers and show skeleton in the active one
  const skeletonHtml = '<div class="skeleton-wrap" style="padding:8px 0">' +
    '<div class="skeleton-line"></div>'.repeat(4) + '</div>';
  {
    const a = TranscriptBuffer.getActive('transcript');
    const b = TranscriptBuffer.getStandby('transcript');
    if (a) { a.innerHTML = skeletonHtml; a.dataset.renderedKey = ''; a.dataset.renderedLang = ''; }
    if (b) { b.innerHTML = ''; b.dataset.renderedKey = ''; b.dataset.renderedLang = ''; }
    /* K6 (2026-05-07): drop PlayerManager's row-index cache for both buffers
     * — we just wiped their .transcript-line / .transcript-paragraph rows
     * (replaced with skeleton or cleared). Without this the cache holds row
     * refs from the PREVIOUS video for the same panel object until the next
     * full render+invalidate fires. Bridge-pattern call (matches existing
     * window.PlayerManager.* usage). */
    if (a) window.PlayerManager?.invalidateRowIndex?.(a);
    if (b) window.PlayerManager?.invalidateRowIndex?.(b);
  }

  SearchManager.reset();

  const searchSection = document.getElementById('transcriptSearchSection');
  if (searchSection) searchSection.classList.add('hidden');
  const scrollToggle = document.getElementById('autoScrollToggle');
  if (scrollToggle) scrollToggle.classList.add('hidden');

  AppState.processingDone = false;
  AppState.summaryFinal = false;
  const chatFab = document.getElementById('mobileChatFab');
  if (chatFab) chatFab.classList.add('hidden');
  AppState.chaptersFinal = false;
  AppState._lastSummaryKey = '';
  AppState._lastChaptersKey = '';

  // Route the default-tab activation through the central tab router so
  // JS state (RendererMobilePanels._activeMode + _activeMobilePanel) stays
  // in sync with CSS state (.tab-btn.active + .tab-pane.active). Previously
  // this was a manual class flip that only updated CSS, leaving the mobile
  // panel system unaware of which tab was active — fine while the user
  // always tap-switched to transcript at some point (the tap fired the
  // router), but a latent bug when default-tab assumptions changed.
  // setTranscriptMode also uses btn.dataset.mode for matching, sidestepping
  // the old btn.textContent.startsWith() pattern which breaks under i18n.
  const isMobile = Helpers.isNarrowViewport();
  const defaultMode = isMobile ? 'transcript' : 'summary';
  Renderer.setTranscriptMode(defaultMode);

  const transcriptNote = document.getElementById('transcriptNote');
  if (transcriptNote) { transcriptNote.textContent = ''; transcriptNote.style.display = 'none'; }

  const mechCurrent = document.getElementById('mechTimeCurrent');
  const mechTotal = document.querySelector('.mech-time-total');
  if (mechCurrent) mechCurrent.textContent = '0:00';
  if (mechTotal) mechTotal.textContent = '0:00';

  if (videoId && !AppState.rewindMode) PlayerManager.cueVideo(videoId);
}

/* ── animateSharkBubble — letter-cascade erase + type ──
   User-picked design (option 6 from sandbox bubble_animation_test).
   Each non-space char gets wrapped in a `.char` span, then animated
   individually via inline opacity + transform (scale). Erase staggers
   right-to-left, type staggers left-to-right. Highlight elements
   (.mark-red / .mark-yellow / .mark-cyan) animate as ATOMIC units —
   the whole highlight fades/scales as one, otherwise the colored
   background stays visible while the chars inside fade, leaving an
   empty colored box.

   Bubble itself is never touched — no inline styles on the bubble,
   no shadows, no transforms. All animation lives on inner .char
   spans, so the bubble's existing drop-shadow + tail stay clean.

   Layout-stable: chars use `display: inline-block` so their box
   stays the same size at scale(0.5) — surrounding text doesn't
   reflow during the cascade (unlike the old char-by-char innerHTML
   rewrite which collapsed line breaks and "jammed" text together). */
const _BUBBLE_ANIM_MS = 950;
const _BUBBLE_CHAR_TRANSITION = 'opacity 280ms ease-out, transform 280ms ease-out';
const _BUBBLE_ATOMIC_HIGHLIGHTS = ['mark-red', 'mark-yellow', 'mark-cyan'];

function _wrapBubbleChars(html, { atomicHighlights = true } = {}) {
  // atomicHighlights:
  //   true  (default) — .mark-red/.mark-yellow/.mark-cyan elements are
  //     treated as a single .char unit; the whole highlight fades or
  //     scales together. Used by the paste/erase animation so the user
  //     never sees an empty colored box during the cascade.
  //   false — recurse INTO highlight elements and wrap each char
  //     individually. The highlight's background stays solid (it's
  //     painted on the parent .mark-* span), but the chars inside
  //     cascade with the surrounding text. Used by the initial home
  //     reveal for a uniform character-by-character feel.
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  function walk(node) {
    if (node.nodeType === 3) {
      const text = node.textContent;
      const frag = document.createDocumentFragment();
      for (const ch of text) {
        if (/\s/.test(ch)) {
          frag.appendChild(document.createTextNode(ch));
        } else {
          const span = document.createElement('span');
          span.className = 'char';
          span.textContent = ch;
          frag.appendChild(span);
        }
      }
      node.parentNode.replaceChild(frag, node);
    } else if (node.nodeType === 1) {
      if (node.classList && node.classList.contains('bubble-spinner')) return;
      if (atomicHighlights
          && node.classList
          && _BUBBLE_ATOMIC_HIGHLIGHTS.some(c => node.classList.contains(c))) {
        node.classList.add('char');
        return;
      }
      for (const child of [...node.childNodes]) walk(child);
    }
  }
  walk(tmp);
  return tmp.innerHTML;
}

function _applyBubbleCharStyles(chars, transitionMs = 280) {
  // transitionMs controls how long each individual char takes to fade
  // between states. Default 280ms matches the paste/erase animation;
  // the initial cascade-in passes 560ms for a slower, more deliberate
  // intro feel. Stagger duration (between chars) is set separately in
  // _staggerBubbleChars.
  const transition = `opacity ${transitionMs}ms ease-out, transform ${transitionMs}ms ease-out`;
  for (const c of chars) {
    c.style.display = 'inline-block';
    c.style.transition = transition;
    c.style.transformOrigin = 'center';
  }
}

function _staggerBubbleChars(chars, dir, totalMs = _BUBBLE_ANIM_MS) {
  return new Promise(async resolve => {
    if (chars.length === 0) { resolve(); return; }
    const stagger = totalMs / chars.length;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    if (dir === 'out') {
      for (let i = chars.length - 1; i >= 0; i--) {
        chars[i].style.opacity = '0';
        chars[i].style.transform = 'scale(0.5)';
        await sleep(stagger);
      }
    } else {
      for (let i = 0; i < chars.length; i++) {
        chars[i].style.opacity = '1';
        chars[i].style.transform = 'scale(1)';
        await sleep(stagger);
      }
    }
    resolve();
  });
}

/* ── cascadeInBubble — initial reveal for the home greeting ──
   The bubble itself (background, drop-shadow, tail) appears with the
   rest of the landing page — no fade. Only the TEXT inside slides up
   from below + fades in. CSS holds the resting state hidden via
   .bubble-content[data-cascade-init] .bubble-text-inner { translateY(30px); opacity:0 }
   plus overflow:hidden on the cascade-init container so the text
   doesn't poke below the bubble's bottom padding mid-animation.
   JS sets a transition and animates back to translateY(0) + opacity:1.

   Subsequent paste/erase animations use the V6 letter-cascade with
   atomic highlights — see animateSharkBubble below. */
const _BUBBLE_INTRO_SLIDE_MS = 500;

export async function cascadeInBubble() {
  const bubble = document.getElementById('sharkBubble');
  if (!bubble) return;
  const content = bubble.querySelector('.bubble-content[data-cascade-init]');
  if (!content) return;
  const inner = content.querySelector('.bubble-text-inner');
  if (!inner) return;

  // Set transition then force a layout flush so the browser registers
  // the starting state (translateY(30px), opacity:0 from CSS) before we
  // write the target — otherwise a fast browser can collapse the two
  // state changes into a single paint and skip the animation.
  inner.style.transition = `transform ${_BUBBLE_INTRO_SLIDE_MS}ms cubic-bezier(0.4, 0, 0.2, 1), opacity 400ms ease`;
  void inner.offsetHeight;
  inner.style.transform = 'translateY(0)';
  inner.style.opacity = '1';
  await new Promise(r => setTimeout(r, _BUBBLE_INTRO_SLIDE_MS));
  content.removeAttribute('data-cascade-init');
}

/**
 * Erase phase only. Useful when the caller wants to start the bubble
 * fade-out instantly on a user gesture (e.g. paste) and run the type
 * phase later — typically once a network request resolves with the
 * exact text to display. Pair with animateSharkBubble's `skipErase`
 * option so the type call doesn't redundantly re-fade chars that
 * already faded out.
 */
export async function eraseSharkBubble(bubble) {
  let chars = [...bubble.querySelectorAll('.char')];
  if (chars.length === 0) {
    bubble.innerHTML = _wrapBubbleChars(bubble.innerHTML);
    chars = [...bubble.querySelectorAll('.char')];
  }
  _applyBubbleCharStyles(chars);
  await _staggerBubbleChars(chars, 'out');
}

export async function animateSharkBubble(bubble, newText, { noSpinner = false, skipErase = false } = {}) {
  // ── Erase phase ── wrap current content (if not already), stagger
  // fade-out R→L. If the bubble has been animated before, .char spans
  // already exist — reuse them. Skipped when the caller already
  // ran eraseSharkBubble() in parallel with another await (paste flow).
  if (!skipErase) {
    await eraseSharkBubble(bubble);
  }

  // ── Build new content structure ── spinner+text wrapper if requested.
  // textContent is used to write the new text so HTML special chars in
  // the message (apostrophes, etc) are safely escaped without manual
  // escapeHtml — then we wrap the chars in-place.
  bubble.innerHTML = noSpinner
    ? '<span class="bubble-loading"><span class="bubble-loading-text"></span></span>'
    : '<span class="bubble-loading"><span class="bubble-spinner"></span><span class="bubble-loading-text"></span></span>';
  const textEl = bubble.querySelector('.bubble-loading-text');
  for (const ch of newText) {
    if (/\s/.test(ch)) {
      textEl.appendChild(document.createTextNode(ch));
    } else {
      const span = document.createElement('span');
      span.className = 'char';
      span.textContent = ch;
      textEl.appendChild(span);
    }
  }

  // ── Type phase ── new chars start at opacity 0 / scale(0.5), then
  // stagger fade-in L→R.
  const newChars = [...textEl.querySelectorAll('.char')];
  _applyBubbleCharStyles(newChars);
  for (const c of newChars) {
    c.style.opacity = '0';
    c.style.transform = 'scale(0.5)';
  }
  // Force layout flush so the initial state paints before transitions kick in.
  void bubble.offsetHeight;
  await _staggerBubbleChars(newChars, 'in');
}

// Polls AppState.player every 100ms for up to 5s, removing the
// .video-black-cover (added by the subsequent-paste path in processUrl)
// the moment the new video reaches PLAYING. The 5s ceiling is a safety
// net — if YT never reports PLAYING (embed disabled, network stall,
// user denied autoplay) we lift the cover anyway so the page isn't
// permanently dark. Cover fades out via its own 250ms transition, then
// is removed from the DOM after the fade completes.
export function scheduleBlackCoverRemoval() {
  const cover = document.getElementById('pasteBlackCover');
  if (!cover) return;
  let attempts = 0;
  const maxAttempts = 50;
  const tick = setInterval(() => {
    attempts++;
    let isPlaying = false;
    try {
      if (AppState.player && typeof AppState.player.getPlayerState === 'function'
          && typeof YT !== 'undefined' && YT.PlayerState) {
        isPlaying = AppState.player.getPlayerState() === YT.PlayerState.PLAYING;
      }
    } catch (_) {}
    if (isPlaying || attempts >= maxAttempts) {
      clearInterval(tick);
      cover.classList.remove('visible');
      setTimeout(() => { if (cover.parentNode) cover.parentNode.removeChild(cover); }, 300);
    }
  }, 100);
}
