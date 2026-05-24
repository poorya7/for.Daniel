// orchestrator/process-url.js
//
// Owns: the `processUrl(url)` public entry point — pure orchestration of
//       the URL → results-view flow. Decides WHEN each step happens; all
//       the WHAT lives in three sibling concern modules:
//
//   - process-url-state.js  — every AppState read + mutation
//   - process-url-fetch.js  — URL parsing, /api/video/meta, cap eval,
//                              streaming pipeline wrapper
//   - process-url-view.js   — every DOM op (toasts, bubbles, title fill,
//                              loading skeletons, the rewind reveal
//                              factory, post-rewind playback choreography,
//                              subsequent-paste prep + kickoff)
//
// Public API: `processUrl(url)` only — `app.js` is the one importer.
//
// Phase 4c #2 (2026-05-08): SRP split. Original 813-LOC mono-function
// decomposed into orchestrator + 3 concern modules. Behaviour preserved
// byte-equivalent (no UX/flow change, no new caps, no new delays). The
// closure-state that the original `switchToResults` nested function
// held is now captured by `view.createResultsReveal({...})`.

import { Analytics } from '../analytics/analytics.js';
import { AppState } from '../core/state.js';
import { RewindEffect } from '../player/rewind.js';
import { FeatureToggle } from '../ui/feature-toggle.js';
import { Renderer } from '../ui/renderer.js';
import { ChatManager } from '../chat/chat.js';
import { colorizeTitle } from '../ui/title-colors.js';
import { fetchFormalInBackground } from '../ui/casual-mode.js';
import { loadFromApi, updateFromApi } from './../api/data-loader.js';
import * as State from './process-url-state.js';
import * as Fetch from './process-url-fetch.js';
import * as View from './process-url-view.js';

export async function processUrl(rawUrl) {
  // ── 1. Validate + normalize the URL ──
  const validated = Fetch.validateAndNormalizeUrl(rawUrl);
  if (!validated.ok) {
    if (validated.reason === 'invalid') View.showInvalidUrlMessage();
    return;
  }
  const { videoId, url } = validated;

  // ── 2. Same-video paste guard ──
  // Compare just the 11-char YouTube video id (wpJ4OCq7oB0, etc.) — the
  // only truly stable identifier (URLs vary by host/params). State module
  // checks four sources in priority order: live YT player → videoData →
  // currentVideoId → processingVideoId.
  const activeId = State.getActiveVideoId();
  if (View.isResultsVisible() && activeId && videoId === activeId) {
    View.showSameVideoToast(State.isInFlight(videoId));
    return;
  }
  // Off the results view (home), still bail silently if a paste collides
  // with an in-flight processUrl for the same video — burst-paste guard.
  if (videoId === State.getActiveVideoId() && State.isInFlight(videoId)) return;

  // ── 3. Mark processing started + kick off bubble erase IMMEDIATELY ──
  // Set processingVideoId early so a concurrent paste invalidates this run.
  State.markProcessingStarted(videoId);
  const { bubble: bubbleForErase, erasePromise } = View.kickOffBubbleErase();

  // Type "Preparing your video…" + fade the input/Recap pill out in
  // parallel with the meta fetch so the home view reacts instantly on
  // tap instead of waiting for the network round-trip. On the rare cap
  // path below, both are reversed (cap message overwrites the bubble,
  // cancelHomeExitTransitions restores the input for retry).
  View.typePreparingBubble(bubbleForErase, erasePromise);
  if (!View.isResultsVisible()) View.runHomeExitTransitions();

  // ── 4. Validate duration BEFORE any visible UI change ──
  // Awaiting /api/video/meta (~1s, YouTube Data API — not yt-dlp) gates
  // the morph/rewind/results transition behind the cap check. The
  // previous fire-and-forget approach raced the page transition: on slow
  // networks the user landed in the results view BEFORE the cap fired,
  // leaving them stuck with a useless toast. metaCheckP is reused
  // downstream for the rewindDuration without re-hitting the endpoint.
  const meta = await Fetch.fetchVideoMeta(url);
  // Stale-paste guard: a newer paste landed while we awaited.
  if (State.isStalePaste(videoId)) return;

  const cap = Fetch.evaluateDurationCap(meta);
  if (cap.capped) {
    View.cancelHomeExitTransitions();
    await View.showCapMessage(cap.message, erasePromise, bubbleForErase);
    State.clearProcessingId();
    return;
  }
  State.applyShortVideoSkip(meta);

  // Karaoke paste-time warm. Fires the first-chunk request immediately so
  // audio download + AsrProvider run in parallel with the rewind/morph + summary
  // pipeline. By the time the user clicks play (~30-40s later) the chunk
  // is cached or in-flight. Backend single-flight dedups with the
  // player-driven request. Gated on the kill switch so a disabled karoake
  // session doesn't burn AsrProvider budget on paste.
  if (AppState.karaokeEnabled) {
    Fetch.warmKaraokeFirstChunk(videoId, meta && meta.duration, meta && meta.lang);
  }

  RewindEffect.abort(); // cancel any running rewind from previous URL
  Analytics.videoProcessed(videoId);

  // ── 5. Populate title + channel synchronously from meta ──
  const homeView = document.getElementById('homeView');
  const resultsView = document.getElementById('resultsView');
  const sharkBubble = document.getElementById('sharkBubble');
  const { videoInfo, colorizeP } = View.populateTitleFromMeta(meta, colorizeTitle);

  // Wrap the already-resolved meta in a promise so reveal() (which awaits
  // metaCheckP for rewindDuration) keeps working without an extra
  // network round-trip.
  const metaCheckP = Promise.resolve(meta);

  // ── 6. Subsequent-paste prep (already on results view) ──
  // True when the user pastes a new URL while already on the results view
  // (the previous video is still playing). We skip the full VHS-rewind
  // morph for these and do a fast 250ms crossfade instead — see CSS rules
  // for `body.paste-fading` and `.video-black-cover` in dashboard.css.
  const isSubsequentPaste = View.isResultsVisible();
  if (isSubsequentPaste) {
    await View.prepareForSubsequentPaste();
  }

  // ── 7. Erase barrier ──
  // typePreparingBubble + runHomeExitTransitions were already fired at
  // step 3 (in parallel with the meta fetch); just await the erase here
  // so the next steps don't race the bubble's stagger-out.
  await erasePromise;

  // ── 8. Rewind decision + skeleton swap ──
  // The full rewind morph fires only on the FIRST paste (from the home
  // view). For subsequent pastes (already on the results view) we use the
  // fast paste-fade path above, so rewindMode stays false here regardless
  // of duration. Optimistic rewind default — almost all videos are >10s.
  // applyShortVideoSkip above already disabled rewind for <10s videos.
  State.setRewindMode(!isSubsequentPaste);
  View.showLoadingSkeletons(videoId);

  if (isSubsequentPaste) {
    // Cue (not play) the new video into the existing iframe. Using
    // cueVideoById here — NOT loadVideoById — so the new video's audio
    // doesn't blast out of the black cover while the pipeline is still
    // fetching chapters/summary/transcript. Playback is kicked off in
    // the finally block below, once the first real content is in the DOM.
    View.cueSubsequentPasteVideo(videoId);
    View.fadeContentBackIn();
  }

  // ── 9. Build the reveal closure (captures dep graph) ──
  // First call runs morph/non-morph swap + rewind setup; subsequent calls
  // are idempotent and return the same rewind promise. We call it from
  // two places below (after first-batch arrival, and end-of-pipeline).
  const reveal = View.createResultsReveal({
    videoId, sharkBubble, homeView, resultsView, metaCheckP,
  });
  let rewindPromise = null;

  // ── 10. Streaming pipeline ──
  let initialLoad = false;

  try {
    // On mobile, when we're swapping to a new video from the results view
    // (subsequent paste), the black cover + paste-fade already make it
    // obvious that a load is in progress — the "Fetching video metadata..."
    // top bar pushes the entire app down a row above the top menu, which
    // looks out of place. Suppress the bar for the whole swap on mobile.
    View.showOrSuppressInitialPipelineBar(isSubsequentPaste);

    const result = await Fetch.runProcessingPipeline(
      url,
      // ── onProgress ──
      status => {
        View.routePipelineProgress(status);
        if (!initialLoad) {
          View.updateHomeProgressText(status.progress);
        }
      },
      // ── onPartialTranscript ──
      async (status) => {
        // No-spoken-content fast path: pipeline signals music-only (no subs at
        // all, or subs dominated by [Music]/[Applause]). There's nothing for
        // the rewind window to mask — abort it so the page reveals immediately
        // instead of staring at a 6.5s VHS effect with no payoff. Also
        // pre-fire the transcript-paint event so the mobile blur-lift gate
        // (process-url-view.js — `rs:transcript-painted` listener) doesn't
        // wait its 5s safety timeout for a panel that's intentionally hidden.
        if (status.is_mostly_music && !AppState.transcriptPainted) {
          AppState.transcriptPainted = true;
          try { window.dispatchEvent(new CustomEvent('rs:transcript-painted')); } catch (_) {}
          try { RewindEffect.abort(); } catch (_) {}
        }
        if (status.chapters && status.chapters.length > 0) {
          State.applyChaptersUpdate(status.chapters);
          // Render chapters into the DOM IMMEDIATELY on data arrival —
          // independent of the `await colorizeP` + `await reveal()`
          // chain below. Without this early call, chapters could sit in
          // hand for 1–2s while the title finishes its colorization
          // promise, and on mobile that means the user watches the
          // rewind end with an empty chapters panel before the data
          // finally paints. Idempotent: loadFromApi → renderTopics will
          // re-render with the same data once the await chain completes;
          // cheap, no flicker.
          Renderer.renderChaptersPreview(status.chapters);
        }
        if (status.upload_date) {
          State.applyUploadDate(status.upload_date);
          View.renderUploadDate(status.upload_date);
        }

        const hasTranscript = status.transcript && status.transcript.segments && status.transcript.segments.length > 0;
        const hasSummary = status.summary && status.summary.length > 0;

        if (status.summary_final && hasTranscript) {
          FeatureToggle.setLangButton(true);
        }
        if (status.summary_final && !hasTranscript) {
          FeatureToggle.setAll(false);
        }

        if (!hasTranscript && !hasSummary) {
          View.routePipelineProgress(status);
          return;
        }

        /* summary_final / chapters_final arrive here only (onPartialTranscript), not on onProgress */
        if (status.summary_final) State.applySummaryFinal();
        if (status.chapters_final) State.applyChaptersFinal();

        if (!initialLoad) {
          initialLoad = true;
          // Wait for colorized title before showing the page (prevents layout jump).
          // For music-only videos the title colorize is irrelevant to first paint
          // (there's no rewind to mask it, and the placeholder is the headline UX)
          // — skip the wait so the "This video is mostly music" message lands
          // immediately instead of staring at an empty pane for ~3s.
          if (!status.is_mostly_music) await colorizeP;
          // Destructure to avoid Promise auto-unwrap — see reveal() comment.
          // Without the wrapper, `await reveal()` would block here until the
          // rewind animation finishes, freezing loadFromApi (which paints the
          // transcript) for the entire rewind window.
          ({ rewindPromise } = await reveal());
          loadFromApi(status.video_id, videoInfo, status.transcript, status.summary, status.chapters, status.lang);
          View.routePipelineProgress(status);
          if (status.chapters?.length) View.enterComponent('#topicsList');
          if (status.summary?.length) View.enterComponent('#summaryDisplayHost');
        } else {
          updateFromApi(status.transcript, status.summary, status.chapters, status.lang);
          View.routePipelineProgress(status);
          if (status.summary_final) Renderer.renderSummary();
          if (status.chapters?.length) View.enterComponent('#topicsList');
          if (status.summary?.length) View.enterComponent('#summaryDisplayHost');
        }

        // Phase 2: stash LLM-generated suggested chat questions on
        // AppState (NOT videoData — it gets rebuilt by every partial
        // transcript update, which would silently nuke them). Refresh
        // the chip rail so the initial pair swaps in. State.applySuggestedQuestions
        // returns true when there were questions to apply.
        if (State.applySuggestedQuestions(status.suggested_questions)) {
          ChatManager.refreshChips();
        }

        if (status.summary_final) {
          fetchFormalInBackground();
        }
      },
      { metaP: metaCheckP }
    );

    State.markProcessingDone();
    // Idempotent re-call — reveal() returns the same wrapped rewindPromise.
    // Destructure to keep auto-unwrap from blocking on the rewind animation.
    ({ rewindPromise } = await reveal());
    View.scheduleMobileChatFabReveal();

    if (result.summary_final) State.applySummaryFinal();
    if (result.chapters_final) State.applyChaptersFinal();

    if (!initialLoad) {
      loadFromApi(result.video_id, videoInfo, result.transcript, result.summary, result.chapters, result.lang);
    } else {
      updateFromApi(result.transcript, result.summary, result.chapters, result.lang);
      if (result.summary_final) Renderer.renderSummary();
    }

    // Final-result path: same chip refresh as the streaming callback
    // above, in case the suggested_questions arrive only with the
    // resolved promise (small videos that finish before any partial
    // emit). With the split-endpoint flow, the result no longer
    // carries questions — they arrive purely via the streaming
    // partial — but we keep this path for any legacy callers.
    if (State.applySuggestedQuestions(result.suggested_questions)) {
      ChatManager.refreshChips();
    }

    View.hidePipelineProgressUi();

    // ── 11. Finalize rewind + start playback ──
    if (rewindPromise) {
      await View.finalizeRewindAndStartPlayback(rewindPromise);
    }
    State.clearRewindMode();
    // Safety: ensure all components are visible
    View.forceAllComponentsEntered();
  } catch (err) {
    console.error('[RecapShark]', err.message);
    // Destructure to avoid Promise auto-unwrap (see reveal() comment).
    ({ rewindPromise } = await reveal());
    let msg = err.name === 'TypeError' && err.message.includes('fetch')
      ? "Can't reach the server — is it running?"
      : err.message || 'Something went wrong. Please try again.';
    if (msg.length > 120 || /statusCode|"message":|"path":|request_id/i.test(msg)) {
      msg = 'Something went wrong. Please try again.';
    }
    View.showPipelineError(msg);
  } finally {
    State.markProcessingDone();
    RewindEffect.abort(); // safety cleanup
    State.clearRewindMode();
    View.forceAllComponentsEntered();
    if (State.hasTotalLines()) Renderer.initSummaryTranscriptToggle();
    State.clearProcessingId();
    // Background prefetch of chat answers for the suggestion chips. Fires
    // 5s after the pipeline finishes so it doesn't compete with playback,
    // animations, or any final renders. Each fixed + LLM-generated chip
    // gets one chatWithVideo call (parallel) — when ready, a chip tap
    // skips the live LLM round-trip and renders the cached answer
    // instantly. See ChatManager.prefetchAnswers for the cache shape and
    // language handling.
    setTimeout(() => {
      try { ChatManager.prefetchAnswers(); } catch (_) {}
    }, 5000);
    View.liftPipelineBarSuppression();
    if (isSubsequentPaste) {
      View.kickoffSubsequentPastePlayback();
    }
  }
}
