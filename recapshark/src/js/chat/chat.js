import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';
import { RecapSharkAPI } from '../api/client.js';
import { Analytics } from '../analytics/analytics.js';
import { highlightTextNodes } from '../ui/entity-highlighter.js';
import { debugLog } from '../core/debug-log.js';
import { ChatChips, FIXED_CHIPS } from './chat-chips.js';
import { ChatPrefetch } from './chat-prefetch.js';
import { setupVoice } from './chat-voice.js';
import { _applyBubbleDirection, _gbs } from '../translation/translation-bilingual.js';

/**
 * RecapShark Chat Manager — core coordinator.
 *
 * Owns: send/receive cycle (sendChat), bubble DOM (appendMsg, _showTyping),
 *       smooth scroll-to-bottom, timestamp parser, click delegation
 *       (chip taps + transcript timestamp jumps), reset() lifecycle,
 *       repaint after late entity arrivals, public ChatManager facade
 *       wired onto window in main.js.
 *
 * Delegates to:
 *   - ChatChips: all chip rendering / sizing / language-switch handling.
 *   - ChatPrefetch: background answer prefetch + cached-answer resolution.
 *   - setupVoice: Web Speech API wiring (one-time, fire and forget).
 *
 * Public API (window.ChatManager) intentionally byte-identical to the
 * pre-split surface — same 11 methods exposed, just delegated internally.
 */
export const ChatManager = (() => {
  const chatInput = document.getElementById('chatInput');
  const chatSendBtn = document.getElementById('chatSendBtn');
  const chatMessages = document.getElementById('chatMessages');

  const PAUSE_BEFORE_TYPING = 1100;
  // Minimum typing-bubble visible time when sendChat is fed a precomputed
  // (prefetched) answer. Without it, the AI bubble would slam into view the
  // instant the typing dots appear because Promise.resolve() resolves on the
  // next microtask — visually inconsistent with the live LLM path where the
  // user watches the dots for a couple of seconds. Picked at 800ms: long
  // enough for the eye to register the shark "thinking", short enough that
  // the prefetch's perceived snappiness still wins over a live call.
  const CACHED_THINKING_MS = 800;
  const SCROLL_DURATION = 750;
  function _ease(t) { return 1 - Math.pow(1 - t, 5); }
  let _activeScrollAnim = null;

  function scrollToBottom(el) {
    el = el || chatMessages;
    if (!el) return;
    const end = el.scrollHeight - el.clientHeight;
    const start = el.scrollTop;
    const distance = end - start;
    if (distance <= 0) return;
    if (_activeScrollAnim) _activeScrollAnim.cancelled = true;
    const anim = { cancelled: false };
    _activeScrollAnim = anim;
    const startTime = performance.now();
    function tick(now) {
      if (anim.cancelled) return;
      const t = Math.min((now - startTime) / SCROLL_DURATION, 1);
      el.scrollTop = start + distance * _ease(t);
      if (t < 1) requestAnimationFrame(tick);
      else if (_activeScrollAnim === anim) _activeScrollAnim = null;
    }
    requestAnimationFrame(tick);
  }

  let chatHistory = [];

  function _parseTimestamps(html) {
    let out = html.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, (match, ts) => {
      const parts = ts.split(':').map(Number);
      let secs;
      if (parts.length === 3) secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
      else secs = parts[0] * 60 + parts[1];
      return `<a href="#" class="chat-ts" data-seconds="${secs}"><svg class="chat-ts-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>${ts}</a>`;
    });
    out = out.replace(/\[(\d+)s?\]/g, (match, n) => {
      const secs = parseInt(n, 10);
      if (secs < 1 || secs > 86400) return match;
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      const ts = h > 0
        ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
        : `${m}:${String(s).padStart(2,'0')}`;
      return `<a href="#" class="chat-ts" data-seconds="${secs}"><svg class="chat-ts-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>${ts}</a>`;
    });
    return out;
  }

  // One-time wiring of the chip module — stashes the chatMessages DOM ref
  // and installs the resize listener + ResizeObserver. Must run before
  // any reset() / renderRail() call.
  ChatChips.setup({ chatMessages });

  /* Repaint entity highlights across every already-rendered chat
   * surface — user bubbles, AI bubbles, and chips (initial rail +
   * follow-up rails). Called from `fetchEntitiesForLang` after
   * /api/entities resolves with a non-empty list, so a chat message
   * the user sent BEFORE the entity fetch finished retroactively
   * picks up its name highlights. Mirrors how transcript /
   * subtitle rows already get repainted via `highlightAllInContainer`.
   *
   * Idempotent: `highlightTextNodes`' default skipSelector skips text
   * inside already-wrapped `.tx-*` spans, so re-running on a bubble
   * that's already partially highlighted only colors the still-plain
   * text. Same `types` arrays used at original render time so the
   * second pass paints with the same palette as the first. */
  function repaintHighlights() {
    if (!chatMessages) return;
    const TYPES = ['date', 'num', 'name', 'org', 'gpe', 'event', 'discourse', 'exclaim', 'punct'];
    chatMessages.querySelectorAll('.bubble-user, .bubble-ai').forEach(bubble => {
      highlightTextNodes(bubble, { types: TYPES });
    });
    ChatChips.highlightAll(chatMessages);
  }

  // Stamp the bubble with creation-time language + direction classes so its
  // typography stays frozen at the language it was *written* in, even after
  // the user switches translated languages later. CSS rules `.chat-bubble.
  // lang-fa { ... }` etc. drive font/direction per bubble, so old bubbles
  // keep their original Persian font even when the rest of the UI is in
  // English (and vice versa). Without this stamp every bubble would re-font
  // every language switch via the body[data-translate-lang]-scoped rules.
  function _tagBubbleLang(div) {
    const lang = AppState.currentLang || 'en';
    const base = lang.split('-')[0];
    div.classList.add('lang-' + base);
    div.classList.add(Helpers.isRTL(lang) ? 'rtl' : 'ltr');
  }

  function appendMsg(text, role) {
    const div = document.createElement('div');
    if (role === 'user') {
      div.className = 'chat-bubble bubble-user chat-bubble-enter';
      div.innerHTML = '<div class="bubble-label">You</div>' + Helpers.escapeHtml(text);
      /* Same NER + regex highlight palette as AI bubbles — chat is a
       * conversation, so names/places/numbers in the user's question
       * read better when colored the same way they'll be colored when
       * the LLM echoes them back in its reply. */
      highlightTextNodes(div, {
        types: ['date', 'num', 'name', 'org', 'gpe', 'event', 'discourse', 'exclaim', 'punct'],
      });
    } else {
      div.className = 'chat-bubble bubble-ai chat-bubble-enter';
      // Two-or-more newlines (paragraph break in the LLM's output) → double
      // <br> so there's a visible empty line between paragraphs. Single
      // newlines stay a single <br> (line break, no extra space).
      let escaped = Helpers.escapeHtml(text).replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
      escaped = Helpers.applySummaryHighlights(escaped);
      div.innerHTML = '<div class="bubble-label"><img src="' + window.RS_ASSETS.sharky + '" alt="" class="label-shark"> RecapShark.com</div>' + _parseTimestamps(escaped);
      // Full entity highlighting via the NER-driven pipeline (PERSON,
      // ORG, GPE, EVENT) plus the regex-based date/num/discourse/exclaim/
      // punct passes. Names from the LLM's `[[...]]` / `((...))` markers
      // (already wrapped via applySummaryHighlights into .summary-highlight)
      // are skipped automatically by highlightTextNodes' default
      // skipSelector — no double-marking. Bracket + stretch types are
      // intentionally excluded: they appear in transcripts but rarely
      // in chat replies. */
      highlightTextNodes(div, {
        types: ['date', 'num', 'name', 'org', 'gpe', 'event', 'discourse', 'exclaim', 'punct'],
      });
    }
    _tagBubbleLang(div);
    chatMessages.appendChild(div);
    requestAnimationFrame(() => div.classList.remove('chat-bubble-enter'));
    scrollToBottom(chatMessages);
    if (typeof window.applyFontSizes === 'function') setTimeout(() => window.applyFontSizes(), SCROLL_DURATION + 50);
    return div;
  }

  function _showTyping() {
    const div = document.createElement('div');
    div.className = 'chat-bubble bubble-ai chat-bubble-enter chat-typing';
    div.innerHTML = '<div class="bubble-label"><img src="' + window.RS_ASSETS.sharky + '" alt="" class="label-shark"> RecapShark.com</div><span class="typing-dots"><span></span><span></span><span></span></span>';
    // Tag now — sendChat reuses this same element as the AI bubble after
    // the API resolves, so the lang/dir classes need to be present on it
    // from creation, not added later.
    _tagBubbleLang(div);
    chatMessages.appendChild(div);
    requestAnimationFrame(() => div.classList.remove('chat-bubble-enter'));
    scrollToBottom(chatMessages);
    return div;
  }

  let chatSending = false;
  async function sendChat(opts) {
    const msg = chatInput.value.trim();
    if (!msg || chatSending) return;
    chatSending = true;
    // Drop suggested-chips on every send (initial rail + any follow-up
    // rail under the previous answer). No-op once they're gone, so safe
    // to call unconditionally. The next AI answer appends a fresh
    // follow-up rail with the next pair of unused questions.
    ChatChips.removeRail();
    ChatChips.removeFollowupRails();
    Analytics.chatSent(msg.length);
    // Phase 5d: persist the question text to our own backend (not GA4 — its ToS
    // forbids PII in event params). Fire-and-forget; chat UX never waits on it.
    Analytics.chatMessageLogged(msg);

    appendMsg(msg, 'user');
    chatInput.value = '';
    if (chatClearBtn) chatClearBtn.classList.remove('visible');
    chatSendBtn.disabled = true;
    // Mobile only: blur() to dismiss the on-screen keyboard after submit
    // so the user can read the response. Must run synchronously inside
    // the user-gesture (the click/keydown that triggered sendChat) — iOS
    // ignores blur from async contexts. On desktop we leave focus alone
    // so power users can immediately keep typing.
    if (Helpers.isNarrowViewport()) chatInput.blur();

    const videoLang = AppState.videoData?.lang || 'en';
    const lang = document.body.dataset.translateLang || videoLang;

    // Cached-answer fast path: caller resolved a prefetched answer for a
    // chip tap (ChatManager.prefetchAnswers populates AppState.chatAnswerCache
    // in the background once the pipeline completes; chip clicks try the
    // cache first and pass the answer through here when it's ready). Skip
    // the live chatWithVideo call — the rest of the render pipeline (typing
    // pause, AI bubble, follow-up rail) is identical, so cached and live
    // answers feel the same on screen.
    let apiPromise;
    const _isCached = !!(opts && typeof opts.precomputedAnswer === 'string' && opts.precomputedAnswer);
    if (_isCached) {
      apiPromise = Promise.resolve({ answer: opts.precomputedAnswer });
    } else {
      const dur = AppState.videoData?.durationEstimate || 0;
      const info = AppState.currentVideoInfo;
      const summary = AppState.videoData?.summary;
      const summaryText = Array.isArray(summary) ? summary.join('\n\n') : (summary || '');

      const translationCache = lang !== videoLang ? AppState.translationCache[lang] : null;
      const transcript = translationCache?.transcript || AppState.formattedTranscript || '';
      const chatSummary = translationCache?.summary || summaryText;

      debugLog('[CHAT DEBUG] lang:', lang, 'videoLang:', videoLang, 'usingTranslatedContent:', !!translationCache);

      apiPromise = RecapSharkAPI.chatWithVideo({
        formattedTranscript: transcript,
        segments: transcript ? [] : (AppState.subtitleSegments || []),
        question: msg,
        history: chatHistory.filter(h => !h.lang || h.lang === lang),
        lang,
        videoLang,
        videoDuration: dur,
        videoTitle: info?.title || '',
        videoChannel: info?.channel || '',
        summary: chatSummary,
        casual: AppState.casualMode,
      });
    }

    await new Promise(r => setTimeout(r, PAUSE_BEFORE_TYPING));
    const typingEl = _showTyping();

    try {
      const data = await apiPromise;
      // Hold the typing bubble for a beat on the cached path — see the
      // CACHED_THINKING_MS comment up top for the rationale.
      if (_isCached) await new Promise(r => setTimeout(r, CACHED_THINKING_MS));

      // Paragraph breaks → double <br> so an empty line shows between
      // paragraphs. Single newlines stay a single <br>. Same treatment
      // as the streaming chunk path above so the final answer matches
      // what the user saw mid-stream.
      let escaped = Helpers.escapeHtml(data.answer).replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
      escaped = Helpers.applySummaryHighlights(escaped);
      typingEl.classList.remove('chat-typing');
      typingEl.innerHTML = '<div class="bubble-label"><img src="' + window.RS_ASSETS.sharky + '" alt="" class="label-shark"> RecapShark.com</div>' + _parseTimestamps(escaped);
      highlightTextNodes(typingEl, {
        types: ['date', 'num', 'name', 'org', 'gpe', 'event', 'discourse', 'exclaim', 'punct'],
      });
      scrollToBottom(chatMessages);
      if (typeof window.applyFontSizes === 'function') setTimeout(() => window.applyFontSizes(), SCROLL_DURATION + 50);
      chatHistory.push({ question: msg, answer: data.answer, lang });
      ChatChips.appendFollowups({ scrollToBottom });
    } catch (err) {
      const errText = 'Something went wrong — ' + (err.message || 'try again.');
      typingEl.classList.remove('chat-typing');
      typingEl.innerHTML = '<div class="bubble-label"><img src="' + window.RS_ASSETS.sharky + '" alt="" class="label-shark"> RecapShark.com</div>' + Helpers.escapeHtml(errText);
      scrollToBottom(chatMessages);
    } finally {
      chatSending = false;
      chatSendBtn.disabled = false;
      // Desktop only: refocus so the user can keep typing follow-ups
      // without clicking. On mobile we deliberately skip focus() — iOS
      // won't reopen the keyboard outside a user gesture, and the
      // attempted focus can shift scroll/viewport. The user taps the
      // input to type again.
      if (!Helpers.isNarrowViewport()) chatInput.focus();
    }
  }

  chatMessages?.addEventListener('click', e => {
    // Suggested-question chip tap: drop the rail, prefill the input,
    // and submit. Synchronous so iOS treats the keyboard-blur as a
    // user gesture (matches how the Send button behaves).
    const chip = e.target.closest('.chat-chip');
    if (chip) {
      e.preventDefault();
      const q = chip.dataset.chipQ || chip.textContent.trim();
      const sourceQ = chip.dataset.chipSrc;
      ChatChips.removeRail();
      chatInput.value = q;
      // Prefetched-answer fast path — if prefetchAnswers() already filled
      // chatAnswerCache for this chip's canonical source AND (if needed)
      // the translation cache for the user's current language is populated,
      // skip the live LLM call. ChatPrefetch.resolve returns null when any
      // piece is missing, falling through to the standard sendChat() path.
      const cached = ChatPrefetch.resolve(sourceQ);
      sendChat(cached ? { precomputedAnswer: cached } : undefined);
      return;
    }
    const tsLink = e.target.closest('.chat-ts');
    if (tsLink) {
      e.preventDefault();
      const secs = parseInt(tsLink.dataset.seconds, 10);
      if (!isNaN(secs)) {
        Helpers.seekTo(secs);
        Renderer.showTranscriptAt(secs);
      }
    }
  });

  if (chatSendBtn) chatSendBtn.addEventListener('click', sendChat);
  if (chatInput) chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });

  /* ── Clear Input Button ────────────────────────────── */
  const chatClearBtn = document.getElementById('chatClearBtn');
  function toggleClearBtn() {
    if (chatClearBtn) chatClearBtn.classList.toggle('visible', chatInput && chatInput.value.length > 0);
  }
  if (chatInput) chatInput.addEventListener('input', toggleClearBtn);
  if (chatClearBtn) chatClearBtn.addEventListener('click', () => {
    if (chatInput) { chatInput.value = ''; chatInput.focus(); }
    toggleClearBtn();
  });

  /* ── Voice Input ────────────────────────────────────── */
  // Wire up Web Speech API + waveform overlay. setupVoice is a no-op when
  // the browser doesn't expose SpeechRecognition (e.g. Firefox).
  setupVoice({ chatInput, sendChat });

  /* ── Chat Prefill (home page demo) ─────────────────── */
  const CHAT_PREFILL = [
    { role: 'user', text: 'Summarize the podcast for me' },
    { role: 'ai', text: 'He starts by talking about his morning routine and how he almost didn\'t make it to the studio on time.' },
    { role: 'user', text: 'What about the guest?' },
    { role: 'ai', text: 'The guest is a nutritionist who specializes in gut health. They get into probiotics pretty early on.' },
    { role: 'user', text: 'Any funny moments?' },
    { role: 'ai', text: 'Yeah he accidentally knocks over his coffee around the 20 minute mark and they both crack up for a solid minute.' },
  ];
  if (chatMessages) {
    CHAT_PREFILL.forEach(m => {
      const div = document.createElement('div');
      div.className = `chat-bubble ${m.role === 'user' ? 'bubble-user' : 'bubble-ai'}`;
      const label = m.role === 'user' ? 'You' : '<img src="' + window.RS_ASSETS.sharky + '" alt="" class="label-shark"> RecapShark.com';
      div.innerHTML = `<div class="bubble-label">${label}</div>${Helpers.escapeHtml(m.text)}`;
      chatMessages.appendChild(div);
    });
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function reset() {
    chatHistory = [];
    // New video → new dynamic question pool will arrive shortly via
    // refreshChips(). Wipe the used-set so the initial chips draw from
    // the fresh pool, and follow-ups don't skip questions that were
    // "used" against a stale pool from the previous video.
    ChatChips.resetState();
    // Prefetched chat-answer caches belong to the previous video — wipe
    // unconditionally. prefetchAnswers() will refill these once the new
    // video's pipeline finishes.
    AppState.chatAnswerCache = {};
    AppState.chatAnswerTranslations = {};
    if (chatMessages) {
      // Double-buffered greeting: host + two stacked bubble slots (grid-stacked
      // via .gb-host CSS). Crossfade handled by window._gbs (greeting switcher
      // in translation-bilingual.js).
      const label = '<div class="bubble-label"><img src="' + window.RS_ASSETS.sharky + '" alt="" class="label-shark"> RecapShark.com</div>';
      const defaultGreeting = 'Hey! I\'ve watched the full video for you. Ask me anything — key moments, context, opinions, or anything you missed.';
      // Greeting now pins to the TOP of the chat (YouTube / Google
      // Gemini pattern), so we drop the .chat-spacer that previously
      // pushed it to the bottom. Suggested-question chips render right
      // below the greeting; first user message removes them.
      chatMessages.innerHTML =
        '<div class="gb-host" id="greetingBubbleHost">' +
          '<div class="chat-bubble bubble-ai gb-display gb-display-active" id="greetingBubbleA">' + label + defaultGreeting + '</div>' +
          '<div class="chat-bubble bubble-ai gb-display gb-display-standby" id="greetingBubbleB"></div>' +
        '</div>' +
        ChatChips.renderRail();
      // Seed greetingLang on the active slot so the switcher takes the crossfade path
      // on the first lang switch (instead of "first apply" instant).
      // Also apply inline 'en' direction/font so body[data-translate-lang="X"] CSS
      // can never re-style the active bubble out from under us during a lang switch.
      const activeA = document.getElementById('greetingBubbleA');
      if (activeA) {
        activeA.dataset.greetingLang = 'en';
        _applyBubbleDirection(activeA, 'en');
      }
      // Reset switcher state so A is active and no fade is in progress.
      _gbs._activeId = 'A';
      chatMessages.scrollTop = chatMessages.scrollHeight;
      requestAnimationFrame(ChatChips.sizeRail);
    }
  }

  // Public-API thin wrappers — keep window.ChatManager surface byte-identical.

  function refreshChips() { ChatChips.refresh(); }
  function relocalizeChips() { ChatChips.relocalize(); }
  function handleLanguageChange(langCode, sourceLang) {
    ChatChips.handleLanguageChange(langCode, sourceLang);
  }

  // prefetchAnswers stays the public entry point app.js calls. Internally
  // it now orchestrates two concerns: chip-side fixed-text translation +
  // answer prefetch. Keeps Prefetch and Chips decoupled — neither needs to
  // know about the other for this flow.
  function prefetchAnswers() {
    ChatChips.ensureFixedInVideoLang();
    ChatPrefetch.prefetchAnswers({ fixedChips: FIXED_CHIPS });
  }

  function getHistory() { return chatHistory; }
  function getMessagesEl() { return chatMessages; }

  return { sendChat, appendMsg, scrollToBottom, reset, getHistory, getMessagesEl, refreshChips, relocalizeChips, handleLanguageChange, prefetchAnswers, repaintHighlights };
})();
