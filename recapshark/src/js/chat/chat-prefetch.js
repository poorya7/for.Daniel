// chat-prefetch.js — background prefetch of chat answers + cached-answer
// resolution + on-demand translation of cached answers.
//
// Owns: AppState.chatAnswerCache (per-source-question answers in video lang)
//       AppState.chatAnswerTranslations (per-target-lang translations of those)
// Reads from AppState: videoData, currentVideoInfo, formattedTranscript,
//                      subtitleSegments, casualMode, suggestedQuestions,
//                      currentLang.
// Imports allowed: core/state, api/client. NO sibling chat-* imports.
// Public API: prefetchAnswers({fixedChips}), resolve(sourceQ),
//             prefetchTranslations({targetLang, sourceLang, fixedChips}).
//
// Caller (chat.js core or chat-chips' handleLanguageChange) passes
// `fixedChips` array. Avoids a chat-prefetch ↔ chat-chips import cycle.

import { AppState } from '../core/state.js';
import { RecapSharkAPI } from '../api/client.js';

// Background prefetch of chat answers — fires after the pipeline finishes
// so it doesn't compete with the user-facing load (transcript + summary +
// chapters + rewind animation). For each fixed + LLM-generated suggestion,
// we send one chatWithVideo call in the video's source language and stash
// the answer in AppState.chatAnswerCache, keyed by the canonical question
// string. When the user later taps a chip, the click handler short-circuits
// through sendChat({ precomputedAnswer }) — instant render, zero LLM round
// trip. Translations of cached answers happen lazily (translateOne).
//
// Idempotent and best-effort. Pending entries get a '__pending__' marker
// so concurrent calls don't spawn duplicate requests; failures wipe the
// marker so a retry on the next prefetch cycle is allowed.
function prefetchAnswers({ fixedChips = [] } = {}) {
  if (!AppState.videoData || !AppState.videoData.videoId) return;
  if (!AppState.chatAnswerCache) AppState.chatAnswerCache = {};

  const videoLang = AppState.videoData.lang || 'en';
  const dur = AppState.videoData.durationEstimate || 0;
  const info = AppState.currentVideoInfo;
  const summary = AppState.videoData.summary;
  const summaryText = Array.isArray(summary) ? summary.join('\n\n') : (summary || '');
  const transcript = AppState.formattedTranscript || '';
  const segments = transcript ? [] : (AppState.subtitleSegments || []);
  if (!transcript && !segments.length) return; // nothing to ground on

  const questions = [];
  fixedChips.forEach(q => questions.push(q));
  if (Array.isArray(AppState.suggestedQuestions)) {
    AppState.suggestedQuestions.forEach(q => {
      if (typeof q === 'string' && q.trim()) questions.push(q);
    });
  }
  if (!questions.length) return;

  questions.forEach(q => {
    if (AppState.chatAnswerCache[q]) return; // already cached or pending
    AppState.chatAnswerCache[q] = '__pending__';

    RecapSharkAPI.chatWithVideo({
      formattedTranscript: transcript,
      segments,
      question: q,
      history: [],
      lang: videoLang,
      videoLang,
      videoDuration: dur,
      videoTitle: info?.title || '',
      videoChannel: info?.channel || '',
      summary: summaryText,
      casual: AppState.casualMode,
    })
      .then(data => {
        if (!AppState.chatAnswerCache) return;
        const answer = (data && data.answer) || '';
        AppState.chatAnswerCache[q] = answer;
        // If the user is currently on a translated language, also kick off
        // a translation of this fresh answer so a chip tap will hit the
        // translated cache instead of falling back to live LLM.
        const currentLang = AppState.currentLang;
        if (answer && currentLang && currentLang !== videoLang) {
          translateOne(q, answer, videoLang, currentLang);
        }
      })
      .catch(() => {
        if (AppState.chatAnswerCache && AppState.chatAnswerCache[q] === '__pending__') {
          delete AppState.chatAnswerCache[q];
        }
      });
  });
}

// Resolve a chip click into a precomputed answer in the user's CURRENT
// language. Returns null when there's no usable cached value (either the
// source-language answer hasn't arrived yet, or the user is on a translated
// language and that translation isn't ready). null = caller should fall
// through to the live LLM path.
function resolve(sourceQuestion) {
  if (!sourceQuestion) return null;
  const sourceAnswer = AppState.chatAnswerCache && AppState.chatAnswerCache[sourceQuestion];
  if (!sourceAnswer || sourceAnswer === '__pending__') return null;

  const videoLang = AppState.videoData?.lang || 'en';
  const lang = AppState.currentLang || videoLang;
  if (lang === videoLang) return sourceAnswer;

  const translated = AppState.chatAnswerTranslations
    && AppState.chatAnswerTranslations[lang]
    && AppState.chatAnswerTranslations[lang][sourceQuestion];
  if (translated && translated !== '__pending__') return translated;
  return null;
}

// Translate a single cached answer into a target language. Uses the same
// translateSummary endpoint we use for the summary — it's well-suited to
// multi-paragraph plain text. Stores under AppState.chatAnswerTranslations
// [lang][sourceQuestion]. '__pending__' marker prevents duplicate calls.
function translateOne(sourceQuestion, sourceAnswer, sourceLang, targetLang) {
  if (!targetLang || targetLang === sourceLang) return;
  if (!AppState.chatAnswerTranslations) AppState.chatAnswerTranslations = {};
  if (!AppState.chatAnswerTranslations[targetLang]) AppState.chatAnswerTranslations[targetLang] = {};
  const cache = AppState.chatAnswerTranslations[targetLang];
  if (cache[sourceQuestion]) return;
  cache[sourceQuestion] = '__pending__';
  RecapSharkAPI.translateSummary(sourceAnswer, sourceLang || 'en', targetLang)
    .then(data => {
      if (!AppState.chatAnswerTranslations || !AppState.chatAnswerTranslations[targetLang]) return;
      AppState.chatAnswerTranslations[targetLang][sourceQuestion] = (data && data.summary) || sourceAnswer;
    })
    .catch(() => {
      if (AppState.chatAnswerTranslations
          && AppState.chatAnswerTranslations[targetLang]
          && AppState.chatAnswerTranslations[targetLang][sourceQuestion] === '__pending__') {
        delete AppState.chatAnswerTranslations[targetLang][sourceQuestion];
      }
    });
}

// Sweep all cached answers and ensure each has a translation in the new
// target language. Called from chat-chips.handleLanguageChange so that
// switching to a translated language proactively kicks off the translation
// work in the background — by the time the user taps a chip, the
// translation is (hopefully) ready and the cached fast-path fires.
function prefetchTranslations(targetLang, sourceLang) {
  if (!targetLang) return;
  const videoLang = (AppState.videoData && AppState.videoData.lang) || sourceLang || 'en';
  if (targetLang === videoLang) return; // source already cached; no translation needed
  if (!AppState.chatAnswerCache) return;
  Object.keys(AppState.chatAnswerCache).forEach(q => {
    const ans = AppState.chatAnswerCache[q];
    if (!ans || ans === '__pending__') return;
    translateOne(q, ans, videoLang, targetLang);
  });
}

export const ChatPrefetch = {
  prefetchAnswers,
  resolve,
  prefetchTranslations,
};
