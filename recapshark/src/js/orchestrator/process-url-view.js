// orchestrator/process-url-view.js
//
// Owns: every DOM/UI operation that the processUrl flow performs. Toasts,
//       shark-bubble messages, title/channel population, home→results
//       transitions, the giant `revealResults` reveal choreography
//       (rewind setup + watchdog + staggered reveal + mobile blur stages),
//       per-component enter helpers, post-rewind playback start, and the
//       streaming-progress→panel-progress routing rule.
//
// Reads from AppState: rewindMode, player (read-only — no writes here).
// Writes to AppState: nothing.
// Imports allowed: ui/*, player/*, chat/*, core/*. No api/*. No state mutators.
//
// Contract: every exported function is a "view command" — it manipulates
// the DOM (or schedules timers/animations on the DOM) and returns either
// void or a promise the orchestrator can await. None of these decide
// flow; the orchestrator decides when to call them.
//
// Phase 4c #2 (2026-05-08): extracted from process-url.js as part of the
// SRP-by-concern split (fetch / state / view). The biggest piece is the
// `createResultsReveal` factory which captures the closure state that the
// original `switchToResults` nested function held inside processUrl.

import { AppState } from '../core/state.js';
import { Helpers } from '../core/helpers.js';
import { Renderer } from '../ui/renderer.js';
import { PipelineUI } from '../ui/pipeline-ui.js';
import { PlayerManager } from '../player/player.js';
import { ChatManager } from '../chat/chat.js';
import { RewindEffect } from '../player/rewind.js';
import {
  showLoadingState,
  animateSharkBubble,
  eraseSharkBubble,
  scheduleBlackCoverRemoval,
} from '../ui/loading-state.js';
import { runStaggeredMorph } from './morph.js';

/* ══════════════════════════════════════════════════════
   PIPELINE PROGRESS → PANEL PROGRESS ROUTING
   ══════════════════════════════════════════════════════ */

/**
 * Translate one streaming-pipeline status into the corresponding
 * panel-progress UI changes. Decides which of three progress surfaces
 * (transcript progress bar / summary progress bar / top pipeline bar)
 * is appropriate for a given status string.
 *
 * Pure view command — no state mutations, no flow decisions.
 *
 * @param {object} status
 */
export function routePipelineProgress(status) {
  const prog = status.progress || '';
  if (status.status === 'transcribing') {
    const text = PipelineUI.getTranscribeText(status);
    Renderer.showSummaryProgress(text);
    PipelineUI.hideTopBar();
  } else if (prog.includes('Updating transcript')) {
    Renderer.showTranscriptProgress(prog);
    Renderer.hideSummaryProgress();
    PipelineUI.hideTopBar();
  } else if (
    /summary/i.test(prog)
    || prog.includes('Generating full')
    || prog.includes('Generating short')
    || prog.includes('Fetching subtitles')
    || prog.includes('Fetching transcript')
  ) {
    Renderer.showSummaryProgress(prog);
    Renderer.hideTranscriptProgress();
    PipelineUI.hideTopBar();
  } else if (prog) {
    Renderer.hideSummaryProgress();
    Renderer.hideTranscriptProgress();
    PipelineUI.update(status);
  }
}

/* ══════════════════════════════════════════════════════
   USER-FACING MESSAGES (toasts / bubbles)
   ══════════════════════════════════════════════════════ */

/**
 * Show a non-destructive warning to the user. On the results view we use
 * a toast (shark bubble isn't visible there); on the home view we type
 * the message into the shark bubble. Either way the page stays exactly
 * as it was — NO fade, NO player stop — so the user just gets feedback
 * without losing their current video.
 */
export function showInvalidUrlMessage() {
  const msg = "Hmm, that doesn't look like a YouTube link. Try another URL.";
  if (document.body.classList.contains('results-visible')) {
    if (typeof window.showToast === 'function') window.showToast(msg);
  } else {
    const bubble = document.getElementById('sharkBubble');
    if (bubble) animateSharkBubble(bubble, msg, { noSpinner: true });
  }
}

export function showSameVideoToast(isInFlight) {
  const msg = isInFlight
    ? "This video is already loading."
    : "You're already watching this video.";
  if (typeof window.showToast === 'function') window.showToast(msg);
}

/**
 * Show the duration-cap message. On the home view the bubble already has
 * "Preparing your video…" typed in from the early parallel fire in the
 * orchestrator, so we erase + retype the cap text here. (The cap path is
 * rare — only Tier-4O languages over the duration limit — so the brief
 * "Preparing…" flash before the cap text appears is acceptable.)
 */
export async function showCapMessage(message, erasePromise, bubbleForErase) {
  if (document.body.classList.contains('results-visible')) {
    if (typeof window.showToast === 'function') window.showToast(message);
  } else if (bubbleForErase) {
    await animateSharkBubble(bubbleForErase, message, { noSpinner: true });
  }
}

/* ══════════════════════════════════════════════════════
   BUBBLE ERASE / EARLY FEEDBACK
   ══════════════════════════════════════════════════════ */

/**
 * Kick off bubble erase IMMEDIATELY for instant feedback. The user sees
 * the chars start fading the moment they paste. The actual text we'll
 * type next depends on the meta-fetch result (cap message vs "Preparing
 * your video..."), so we run the erase in parallel with the meta await
 * and resolve the right text once both are done. Without this, the
 * bubble sat frozen for ~1s while we awaited meta — felt unresponsive.
 *
 * Returns the bubble element (or null on results view) and the erase
 * promise so the orchestrator can stitch them into the cap-message and
 * "Preparing your video…" branches.
 */
export function kickOffBubbleErase() {
  const bubble = !document.body.classList.contains('results-visible')
    ? document.getElementById('sharkBubble')
    : null;
  if (bubble) {
    bubble._originalHTML = bubble.innerHTML;
  }
  const erasePromise = bubble ? eraseSharkBubble(bubble) : Promise.resolve();
  return { bubble, erasePromise };
}

/**
 * Type "Preparing your video…" into the shark bubble after waiting for
 * the in-flight erase. Skips erase phase since we already started it
 * upstream — otherwise the bubble would erase twice.
 */
export async function typePreparingBubble(sharkBubble, erasePromise) {
  if (!sharkBubble) return;
  await erasePromise;
  animateSharkBubble(sharkBubble, 'Preparing your video…', { skipErase: true });
}

/* ══════════════════════════════════════════════════════
   TITLE / CHANNEL POPULATION
   ══════════════════════════════════════════════════════ */

/**
 * Populate every title/channel surface from the awaited /api/video/meta
 * payload. Replaced the previous noembed.com call which is now bot-blocked
 * by YouTube (KB3 fix). Population is synchronous — no extra round-trip
 * and no async settle phase, so the title flashes in faster than before.
 *
 * Returns the videoInfo object the pipeline downstream needs PLUS the
 * colorize promise (so the orchestrator can `await colorizeP` before
 * revealing the results view, preventing layout jump from non-colorized
 * → colorized title).
 *
 * @param {object|null} meta
 * @param {Function}    colorizeTitle  ../ui/title-colors.js entry point;
 *                                     passed in to keep this view module
 *                                     free of the colorizer import
 *                                     (orchestrator already imports it).
 */
export function populateTitleFromMeta(meta, colorizeTitle) {
  if (!meta) return { videoInfo: null, colorizeP: Promise.resolve() };
  const title = meta.title || '';
  const channel = meta.channel || '';
  const videoInfo = { title, channel };

  const titleData = document.getElementById('videoTitleData');
  if (titleData) titleData.textContent = title;
  const chEl = document.getElementById('videoChannel');
  if (chEl) chEl.textContent = channel;
  const nwTitle = document.querySelector('.nw-title');
  const nwMeta = document.querySelector('.nw-meta');
  if (nwTitle) nwTitle.textContent = title;
  if (nwMeta) nwMeta.textContent = channel;

  const colorizeP = title ? colorizeTitle(title) : Promise.resolve();
  return { videoInfo, colorizeP };
}

/**
 * Render the upload date into the videoDate slot.
 */
export function renderUploadDate(uploadDate) {
  if (!uploadDate) return;
  const dateEl = document.getElementById('videoDate');
  if (!dateEl) return;
  const [y, m, day] = uploadDate.split('-').map(Number);
  const d = new Date(y, m - 1, day);
  dateEl.textContent = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  dateEl.style.display = '';
}

/* ══════════════════════════════════════════════════════
   SUBSEQUENT-PASTE PREP (already on results view)
   ══════════════════════════════════════════════════════ */

/**
 * True iff the user is already on the results view (the previous video is
 * still playing). Used to branch into the fast-crossfade path instead of
 * the full home→results morph.
 */
export function isResultsVisible() {
  return document.body.classList.contains('results-visible');
}

/**
 * Subsequent-paste prep: stop + mute the OLD video, drop a black cover,
 * fade out content. Awaits the 250ms fade-out so when control returns,
 * downstream code can clear the panels in showLoadingState without the
 * old content snapping to skeletons mid-animation.
 */
export async function prepareForSubsequentPaste() {
  // 1. Stop AND mute the OLD video. stopVideo() kills the audio of the
  //    current playback; mute() is belt-and-suspenders against a YT
  //    API quirk where calling cueVideoById() shortly after stopVideo()
  //    on a player that was just playing sometimes autoplays the new
  //    video anyway. We unmute later when we actually want playback to
  //    start (see kickoffSubsequentPastePlayback).
  if (AppState.player) {
    try { AppState.player.stopVideo(); } catch (_) {}
    try { AppState.player.mute(); } catch (_) {}
  }
  // 2. Drop a black cover over the video frame. The .visible class is
  //    added on the next frame so the CSS opacity transition fires
  //    (going straight from inserted-with-class-already to visible
  //    would skip the animation in some browsers).
  const videoFrame = document.querySelector('.video-frame');
  if (videoFrame && !document.getElementById('pasteBlackCover')) {
    const cover = document.createElement('div');
    cover.className = 'video-black-cover';
    cover.id = 'pasteBlackCover';
    videoFrame.appendChild(cover);
    requestAnimationFrame(() => cover.classList.add('visible'));
  }
  // 3. Fade out title + content. body.paste-fading is the single switch;
  //    the CSS rule list lives in dashboard.css.
  document.body.classList.add('paste-fading');
  // 4. Wait for the 250ms fade-out to finish before clearing the panels
  //    in showLoadingState (otherwise old content snaps to skeletons
  //    mid-animation and the fade reads as a glitch instead of a fade).
  await new Promise(r => setTimeout(r, 250));
}

/**
 * Cue the new video into the existing iframe (no autoplay). Audio kicks
 * in from `kickoffSubsequentPastePlayback` once content is loaded.
 */
export function cueSubsequentPasteVideo(videoId) {
  PlayerManager.swapVideo(videoId, { autoplay: false });
}

/**
 * Fade content back in after subsequent-paste prep. Done on the next
 * frame so any DOM mutations from showLoadingState (skeletons inserted
 * into now-empty panels) are committed first — otherwise the transition
 * can be skipped in some browsers when the element's old computed
 * opacity (0) is already gone by the time the class flips.
 */
export function fadeContentBackIn() {
  requestAnimationFrame(() => document.body.classList.remove('paste-fading'));
}

/* ══════════════════════════════════════════════════════
   HOME-VIEW EXIT TRANSITIONS
   ══════════════════════════════════════════════════════ */

/**
 * Animate the home-view paste prompt + status row out of view. Called
 * synchronously from the orchestrator on tap so the input + Recap pill
 * fade out immediately (not after the meta fetch). The visibility:hidden
 * setTimeout handle is tracked so the cap path can cancel it via
 * cancelHomeExitTransitions and restore the input for retry.
 */
let _homeExitTimeoutId = null;
export function runHomeExitTransitions() {
  const homePaste = document.getElementById('homePastePrompt');
  const homeStatus = document.getElementById('homeStatus');
  const homeStatusText = document.getElementById('homeStatusText');
  if (homePaste) {
    homePaste.classList.add('exiting');
    if (_homeExitTimeoutId) clearTimeout(_homeExitTimeoutId);
    _homeExitTimeoutId = setTimeout(() => {
      homePaste.style.visibility = 'hidden';
      _homeExitTimeoutId = null;
    }, 450);
  }
  if (homeStatus) homeStatus.classList.add('hidden');
  if (homeStatusText) homeStatusText.textContent = 'Preparing...';
}

/**
 * Reverse runHomeExitTransitions. Used by the cap path to restore the
 * input + Recap pill so the user can retry with a different URL instead
 * of being stuck on the home view with no way back.
 */
export function cancelHomeExitTransitions() {
  const homePaste = document.getElementById('homePastePrompt');
  if (_homeExitTimeoutId) {
    clearTimeout(_homeExitTimeoutId);
    _homeExitTimeoutId = null;
  }
  if (homePaste) {
    homePaste.classList.remove('exiting');
    homePaste.style.visibility = '';
  }
}

/**
 * Update the home-view status text + the loading bubble text mid-pipeline.
 * No-op once the results view has been switched in (homeStatusText is then
 * gone from the visible UI).
 */
export function updateHomeProgressText(progress) {
  if (!progress) return;
  const homeStatusText = document.getElementById('homeStatusText');
  if (homeStatusText) homeStatusText.textContent = progress;
  // Skip bubble updates during rewind — keep "Preparing your video…" until exit.
  if (!AppState.rewindMode) {
    const bubbleText = document.querySelector('.bubble-loading-text');
    if (bubbleText) bubbleText.textContent = progress;
  }
}

/* ══════════════════════════════════════════════════════
   LOADING STATE / SKELETONS
   ══════════════════════════════════════════════════════ */

export function showLoadingSkeletons(videoId) {
  showLoadingState(videoId);
}

/* ══════════════════════════════════════════════════════
   PIPELINE TOP BAR
   ══════════════════════════════════════════════════════ */

/**
 * Decide whether to show the "Fetching video metadata..." top bar at the
 * start of the pipeline. On mobile during a subsequent paste, the bar
 * pushes the entire app down a row above the top menu, which looks out
 * of place on top of the existing black cover + paste-fade. Suppress the
 * bar for the whole swap on mobile in that case.
 *
 * Returns true if we suppressed (the orchestrator passes that flag to
 * the lift call in the finally block).
 */
export function showOrSuppressInitialPipelineBar(isSubsequentPaste) {
  const isMobileSwap = isSubsequentPaste && Helpers.isNarrowViewport();
  if (isMobileSwap) {
    // Add body.suppress-pipeline-bar so any later PipelineUI.update() calls
    // (e.g. unrouted progress strings) can't sneak the bar back in.
    document.body.classList.add('suppress-pipeline-bar');
    return true;
  }
  PipelineUI.show('Fetching video metadata...');
  return false;
}

export function liftPipelineBarSuppression() {
  // Safe to call unconditionally — classList.remove is a no-op if the class
  // isn't present (i.e. desktop or first-load paths).
  document.body.classList.remove('suppress-pipeline-bar');
}

export function hidePipelineProgressUi() {
  Renderer.hideSummaryProgress();
  Renderer.hideTranscriptProgress();
  PipelineUI.hide();
}

export function showPipelineError(msg) {
  PipelineUI.showError(msg);
}

/* ══════════════════════════════════════════════════════
   COMPONENT-ENTER HELPERS (rewind mode reveal)
   ══════════════════════════════════════════════════════ */

/**
 * Animate a single component in during rewind mode. Skipped while rewind
 * is still running — the staggered reveal handles those during its
 * scheduled cadence (see createResultsReveal).
 */
export function enterComponent(selector) {
  if (!AppState.rewindMode) return;
  if (RewindEffect.isRunning()) return;
  const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
  if (el && el.classList.contains('component-enter')) el.classList.add('entered');
}

/**
 * Force every component-enter element into the entered state. Used as a
 * safety net at end-of-pipeline + finally (covers error paths where the
 * staggered reveal never ran).
 */
export function forceAllComponentsEntered() {
  document.querySelectorAll('.component-enter').forEach(el => el.classList.add('entered'));
}

/* ══════════════════════════════════════════════════════
   RESULTS REVEAL (the big one — was switchToResults closure)
   ══════════════════════════════════════════════════════ */

const _REWIND_WATCHDOG_MS = 10000;
// Desktop delay timeline:
//   left-panel slide-end (1910) + 400ms beat (2310)
//   + 300ms title fade   (2610) + 300ms breathing room = 2910
// Rewind fires 300ms after the title text fade completes — long enough
// for the eye to register the title, short enough that it doesn't feel
// like a stall.
const _DESKTOP_REWIND_DELAY = 2910;
// Cadence (cumulative from rewind end):
//   100   title + chapters colorize           (+100)
//   400   center-panel (desktop) / chat (mob) (+300)
//   500   nw-left                             (+100)
//   1200  #mechPanel (controls)               (+700)
const _REVEAL_DELAYS = [100, 400, 500, 1200];

/**
 * Build a results-reveal closure that captures the deps the orchestrator
 * has assembled (videoId, sharkBubble, the meta-check promise, and the
 * home/results view roots). Returns a single function `reveal()` that:
 *   - Is idempotent: calling it twice is the same as calling it once.
 *   - On the first call, runs the home→results swap (morph or hard cut).
 *   - In rewind mode, kicks off `RewindEffect.prepare` immediately +
 *     `RewindEffect.start` after `_DESKTOP_REWIND_DELAY` (mobile = 0ms),
 *     guarded by a 10s watchdog so a stuck rewind can't strand the UI.
 *   - Returns the rewind promise (or `null` when rewind is off) so the
 *     orchestrator can `await` it and run post-rewind playback choreography.
 *
 * Equivalent to the `switchToResults` nested function in the original
 * process-url.js, with the closure state extracted into the factory.
 *
 * @param {{ videoId: string, sharkBubble: HTMLElement|null, homeView: HTMLElement|null, resultsView: HTMLElement|null, metaCheckP: Promise<object|null> }} deps
 */
export function createResultsReveal(deps) {
  const { videoId, sharkBubble, homeView, resultsView, metaCheckP } = deps;
  let revealed = false;
  let rewindPromise = null;

  async function reveal() {
    // Return an OBJECT wrapping rewindPromise so the caller's `await reveal()`
    // doesn't auto-unwrap it. JavaScript Promise resolution auto-unwraps nested
    // Promises — if we returned rewindPromise directly, `await reveal()` would
    // block until the entire rewind animation completes, freezing every step
    // after it (loadFromApi → transcript paint) for the whole rewind window.
    // The wrapper object breaks the unwrap chain. Caller destructures.
    if (revealed) return { rewindPromise };
    revealed = true;

    // NOTE: subsequent-paste playback (unmute + playVideo + lift the black
    // cover) is intentionally NOT done here. reveal() can fire as early as
    // the first chapters/summary batch — the user wants playback to start
    // only when ALL content is loaded. The kick-off lives in
    // `kickoffSubsequentPastePlayback` (called from finally block).

    // Restore shark bubble — skip during rewind transition so bubble keeps
    // "Preparing your video…" text. Mobile path restores after homeView hides.
    const keepBubbleForTransition = homeView && AppState.rewindMode;
    if (sharkBubble && sharkBubble._originalHTML && !keepBubbleForTransition) {
      sharkBubble.innerHTML = sharkBubble._originalHTML;
      sharkBubble._originalHTML = null;
    }

    // In rewind mode, hide components BEFORE showing the page (prevents flash).
    // Exception: #fullTranscriptPanel on mobile when Transcript is the default
    // tab — the placeholder skeleton inside it (.flat-transcript-placeholder)
    // is meant to ride in WITH the morph as a visible "loading transcript"
    // card, not fade in after data lands. Without this exception, the parent
    // panel sits at opacity:0 during the rewind window, hiding the skeleton.
    if (AppState.rewindMode) {
      const isMobile = Helpers.isNarrowViewport();
      const transcriptIsDefault = isMobile && document.getElementById('tab-transcript')?.classList.contains('active');
      document.querySelectorAll('#topicsList, #summaryDisplayHost, #fullTranscriptPanel').forEach(el => {
        if (transcriptIsDefault && el.id === 'fullTranscriptPanel') return;
        el.classList.add('component-enter');
      });
    }

    // Animated transition: staggered morph for both desktop + mobile rewind.
    // Mobile uses a different set of enter targets (see runStaggeredMorph).
    const isMorph = homeView && AppState.rewindMode;
    if (isMorph) {
      runStaggeredMorph(homeView, resultsView, sharkBubble);
    } else {
      if (homeView) homeView.style.display = 'none';
      if (resultsView) {
        resultsView.classList.remove('hidden');
        resultsView.style.display = '';
        resultsView.scrollTop = 0;
      }
    }
    document.body.classList.add('results-visible');
    // resultsView just became visible — re-trigger the title-switcher so the
    // plain-text title fallback (set by renderMeta before the un-hide) renders
    // immediately, instead of staying invisible until the colorize LLM call
    // returns. Without this, the title host sits at 0px height for the entire
    // rewind window and the user sees an empty white row above the video.
    if (window._tss?.update) window._tss.update();
    if (typeof window.initFontSizes === 'function') setTimeout(window.initFontSizes, 100);
    requestAnimationFrame(() => {
      const el = ChatManager.getMessagesEl();
      if (el) el.scrollTop = el.scrollHeight;
    });

    // Resolve rewindDuration NOW, lazily — metaCheckP fires in parallel with
    // subs at the top of processUrl, so by the time reveal() runs (after
    // first partial transcript) it's almost always settled. If it isn't
    // yet, await it briefly to get the duration before pre-warm.
    const meta = await metaCheckP;
    const rewindDuration = meta?.duration || 0;

    if (AppState.rewindMode) {
      _setupRewindStartAndReveal({ videoId, rewindDuration, isMorph });
    }

    return { rewindPromise };

    function _setupRewindStartAndReveal({ videoId, rewindDuration, isMorph }) {
      // Black cover immediately so no empty frame shows during delay.
      // Defensive: also wipe any leftover .rewind-cover from a prior
      // run that escaped cleanup (e.g. pipeline errored before
      // RewindEffect.start() ran, so abort()'s _removeOverlays had
      // a null _cover ref and couldn't remove the orphan). Without
      // this we could end up with TWO covers stacked.
      const vf = document.querySelector('.video-frame');
      if (vf) {
        vf.querySelectorAll('.rewind-cover').forEach(el => el.remove());
        const earlyCover = document.createElement('div');
        earlyCover.className = 'rewind-cover rewind-cover--thumbnail';
        earlyCover.id = 'rewindEarlyCover';
        // Paint the YouTube poster onto the early cover so the user
        // never sees a plain black square during the rewindDelay gap
        // (~3s desktop). Mirrors RewindEffect._injectOverlays —
        // hqdefault loads instantly, maxresdefault swaps in async if
        // it exists. When _injectOverlays later claims this cover,
        // it re-applies the same class + bg-image (idempotent).
        const hqUrl  = 'https://img.youtube.com/vi/' + videoId + '/hqdefault.jpg';
        const maxUrl = 'https://img.youtube.com/vi/' + videoId + '/maxresdefault.jpg';
        earlyCover.style.backgroundImage = 'url(' + hqUrl + ')';
        const maxProbe = new Image();
        maxProbe.onload = () => { earlyCover.style.backgroundImage = 'url(' + maxUrl + ')'; };
        maxProbe.src = maxUrl;
        vf.appendChild(earlyCover);
      }
      // Pre-warm the YT iframe NOW (right after resultsView un-hides so
      // #ytPlayer's container is rendered — autoplay+seek+pause can be
      // flaky in display:none parents). The iframe loads in parallel with
      // the morph animation, and by the time the rewindDelay timer fires
      // below, the player is sitting paused at 95% ready to go. start()
      // then hits its fast path and _beginRewind runs on the next frame
      // instead of waiting 700-1500ms for iframe-load → autoplay → seek
      // → settle. This is what kills the "2 second wait after the title
      // appears" gap the user reported.
      RewindEffect.prepare(videoId, rewindDuration);

      // Mobile stays at 0ms; its rewind-mobile-* blur classes manage the
      // equivalent staging without needing a delay (see runStaggeredMorph
      // step 3).
      const rewindDelay = Helpers.isNarrowViewport() ? 0 : _DESKTOP_REWIND_DELAY;

      // Watchdog: rewind is a visual effect, not a hard dependency. If
      // RewindEffect.start() doesn't resolve within 10s (e.g. an iOS
      // Safari policy update silently breaks YT autoplay again, like
      // 18.7 did), abort the rewind and resolve the promise so the
      // staggered reveal still runs — the user gets a working, playable
      // video instead of a frozen black cover with locked controls.
      rewindPromise = new Promise(resolve => {
        setTimeout(() => {
          let settled = false;
          const resolveOnce = () => { if (!settled) { settled = true; resolve(); } };
          const watchdog = setTimeout(() => {
            if (settled) return;
            console.warn('[rewind] watchdog fired — aborting after ' + _REWIND_WATCHDOG_MS + 'ms');
            try { RewindEffect.abort(); } catch (_) {}
            resolveOnce();
          }, _REWIND_WATCHDOG_MS);
          RewindEffect.start(videoId, rewindDuration).then(() => {
            clearTimeout(watchdog);
            resolveOnce();
          });
        }, rewindDelay);
      });

      // ── Disable everything during rewind ──
      const titleHost = document.getElementById('titleDisplayHost');
      const chaptersBlock = document.querySelector('.chapters-block');

      // B&W elements (title + chapters) — skip when morphing; already applied in runStaggeredMorph
      if (!isMorph) {
        [titleHost, chaptersBlock].filter(Boolean).forEach(el => {
          if (el === chaptersBlock) el.style.position = 'relative';
          el.classList.add('title-bw');
        });
      }

      // Opacity-faded elements — skip when morphing (enter animations handle dim state).
      // Non-morph fallback path: dim the panels directly (e.g., for abort/edge cases).
      const isMobile = Helpers.isNarrowViewport();
      // Desktop: .chat-panel is intentionally OMITTED here. It enters via
      // morph-enter-right-far (non-dim) so it lands fully opaque — there is
      // nothing to fade, and including it would consume a reveal slot doing
      // an opacity:1→1 no-op while delaying nw-left and #mechPanel.
      // Mobile: chat IS dimmed during morph (mobile uses different cls), so
      // it still belongs in the fade list.
      const fadePanels = (isMobile
        ? ['.chat-panel', '.nw-left', '#mechPanel']
        : ['.center-panel', '.nw-left', '#mechPanel']
      ).map(s => document.querySelector(s)).filter(Boolean);
      if (!isMorph) {
        fadePanels.forEach(el => {
          el.style.opacity = '0.3';
          el.style.pointerEvents = 'none';
        });
      }

      // ── Staggered reveal when rewind ends ──
      // Slot 0 → title+chapters colorize.
      // Slots 1..N → fadePanels (one delay per panel, in order).
      //
      // BEFORE the reveal runs, wait for the transcript panel to be
      // painted with real content — otherwise on slower-pipeline videos
      // (transcript fetch >3-6s) the placeholder skeleton is still in
      // the DOM when the blur lifts, and the user sees "ghost text → real
      // text" as the streaming pipeline finally lands. A 5s safety timeout
      // (starting AT rewind animation end) wins if the paint signal never
      // arrives (e.g. transcript API fails) — the staggered reveal runs
      // anyway and the user sees the normal skeleton/error path. NEVER
      // stuck in blur indefinitely; worst case = rewind(6.5s) + wait(5s)
      // = ~11.5s before unblur, which is the same as today's max plus the
      // safety wait. Mobile-only: desktop renders transcript through a
      // different path (TranscriptBuffer crossfade) that doesn't have
      // the placeholder issue.
      rewindPromise.then(async () => {
        if (Helpers.isNarrowViewport() && !AppState.transcriptPainted) {
          await Promise.race([
            new Promise(r => window.addEventListener('rs:transcript-painted', r, { once: true })),
            new Promise(r => setTimeout(() => {
              // eslint-disable-next-line no-console
              console.warn('[recapshark] transcript-paint wait timed out (5s) after rewind end — unblurring with whatever is in the panel');
              r();
            }, 5000)),
          ]);
        }
      }).then(() => {
        // 1. Title + chapters: color sweep
        setTimeout(() => {
          [titleHost, chaptersBlock].filter(Boolean).forEach(el => {
            el.classList.remove('title-bw');
            el.classList.add('title-colorize');
            el.addEventListener('animationend', () => {
              el.classList.remove('title-colorize');
              if (el === chaptersBlock) el.style.position = '';
            }, { once: true });
          });
        }, _REVEAL_DELAYS[0]);

        // 2-5. Faded elements: staggered fade to full
        fadePanels.forEach((el, i) => {
          setTimeout(() => {
            el.style.transition = 'opacity 0.6s ease-out';
            el.style.opacity = '1';
            el.style.pointerEvents = '';
            el.addEventListener('transitionend', () => {
              el.style.cssText = '';
            }, { once: true });
          }, _REVEAL_DELAYS[i + 1]);
        });

        // Desktop: un-blur the chat panel at +800ms (between nw-left at
        // +500ms and #mechPanel at +1200ms). Chat reveals BEFORE the
        // video transport so controls stay the last thing to come alive.
        // The 0.6s CSS transition on .chat-panel handles the visual fade
        // — we just drop the body class.
        if (!isMobile) {
          setTimeout(() => {
            document.body.classList.remove('rewind-desktop-chat');
          }, 800);
        }

        // Mobile: staggered un-blur of three zones (title → menus →
        // controls) so they reveal in sequence instead of all at once.
        // Each zone has its own body class (see dashboard.css); removing
        // a class un-blurs/un-desaturates that zone via a 300ms CSS
        // transition. Center-panel pointer events are restored with the
        // controls (last zone) so nothing tappable appears behind a blur.
        if (isMobile) {
          setTimeout(() => {
            document.body.classList.remove('rewind-mobile-title');
          }, _REVEAL_DELAYS[0]); // 700ms — title colorizes (de-saturates)
          setTimeout(() => {
            document.body.classList.remove('rewind-mobile-menus');
          }, 1000); // tabs/menus un-blur (was 1800ms)
          setTimeout(() => {
            document.body.classList.remove('rewind-mobile-controls');
            const cp = document.querySelector('.center-panel');
            if (cp) cp.style.pointerEvents = '';
          }, 1800); // video + controls un-blur, tappable (was 2800ms)
        }
      });
    }
  }

  return reveal;
}

/* ══════════════════════════════════════════════════════
   POST-REWIND PLAYBACK CHOREOGRAPHY
   ══════════════════════════════════════════════════════ */

/**
 * Final post-rewind handoff. Awaits the rewind promise, transitions the
 * player out of rewind, then runs the desktop tab-swap-then-play
 * choreography. Mobile bails before the tab-swap because autoplay is
 * blocked — leaving the facade up so the user's tap triggers the same
 * dismiss-and-play path on a real gesture.
 *
 * @param {Promise<void>} rewindPromise
 */
export async function finalizeRewindAndStartPlayback(rewindPromise) {
  if (!rewindPromise) return;
  await rewindPromise;
  PlayerManager.transitionFromRewind();

  // Auto-play after everything loads + switch to transcript tab.
  // Last staggered reveal = #mechPanel fade starting at +1200ms with a
  // 600ms transition → fully opaque at +1800ms. We add a 300ms beat so
  // the controls visibly settle before the tab swap, giving the user
  // a clear "controls are in, now we move on" moment. Total = 2100ms.
  setTimeout(() => {
    // Sync volume UI fill bar to match 40% (does not depend on play
    // state, safe to set before/after play). Done early so the bar
    // height is correct by the time controls are visible.
    const volFill = document.getElementById('scrubberVolFill');
    if (volFill) volFill.style.height = '40%';

    const isMobile = Helpers.isNarrowViewport();

    if (isMobile) {
      // Mobile: autoplay is blocked, so calling dismissFacadeAndPlay
      // here would hide the thumbnail and expose the (paused, color)
      // iframe behind it — exactly the visible-jump we're trying to
      // avoid. Leave the facade up; tapping it triggers the same
      // dismiss-and-play routine on a real user gesture.
      return;
    }

    // Desktop choreography: crossfade the .tab-content while we
    // swap from Chapters → Transcript, THEN start playback. The
    // old code clicked the tab and called playVideo() in the same
    // tick, which read as a hard "snap" between the two panes
    // followed by the video unmuting on top of the snap. Now the
    // user's eye sees: chapters fade out → transcript fades in →
    // (small beat) → video plays. Sequential, not stacked.
    //
    // Timeline (within this setTimeout, t=0 = post-reveal +300ms):
    //   t=0    : begin fade-out (200ms)
    //   t=200  : panes are at opacity 0 → click tab (DOM swap is
    //            invisible because opacity is 0)
    //   t=200  : begin fade-in (200ms)
    //   t=400  : fade-in done, tab fully visible
    //   t=500  : start playback (100ms breathing room so the user
    //            registers the new pane before audio kicks in)
    const tabContent = document.querySelector('.tab-content');
    const tTab = document.querySelector('.tab-btn[data-mode="transcript"]');
    const startPlayback = () => PlayerManager.dismissFacadeAndPlay();
    if (!tabContent || !tTab) {
      // Defensive fallback: if the elements aren't there, behave
      // like the old code path — click + play in the same tick.
      if (tTab) tTab.click();
      startPlayback();
      return;
    }

    tabContent.style.transition = 'opacity 200ms ease-out';
    tabContent.style.opacity = '0';
    setTimeout(() => {
      // Tab swap happens while opacity is 0 — no visible snap.
      tTab.click();
      tabContent.style.opacity = '1';
    }, 200);
    setTimeout(() => {
      // Clear inline styles so we don't fight any future tab-switch
      // styling applied by renderer.js.
      tabContent.style.transition = '';
      tabContent.style.opacity = '';
      startPlayback();
    }, 500);
  }, 2100);
}

/* ══════════════════════════════════════════════════════
   SUBSEQUENT-PASTE PLAYBACK KICK-OFF (finally block)
   ══════════════════════════════════════════════════════ */

/**
 * After the pipeline is fully done (success or error) and content is in
 * the DOM, actually start the new video. We unmute first (we muted in
 * `prepareForSubsequentPaste` to silence accidental autoplay during
 * loading), then play, then poll for PLAYING state and lift the black
 * cover once the new video pixels are actually rendering. On error
 * path we still kick off playback + lift the cover so the user isn't
 * stranded behind a dark box with no video.
 */
export function kickoffSubsequentPastePlayback() {
  if (!AppState.player) return;
  try { AppState.player.unMute(); } catch (_) {}
  try { AppState.player.playVideo(); } catch (_) {}
  scheduleBlackCoverRemoval();
}

/* ══════════════════════════════════════════════════════
   MOBILE CHAT FAB
   ══════════════════════════════════════════════════════ */

/**
 * Reveal the mobile chat FAB 1s after pipeline completion. Delay matches
 * the existing UX cadence (was an inline setTimeout in processUrl).
 */
export function scheduleMobileChatFabReveal() {
  setTimeout(() => {
    const fab = document.getElementById('mobileChatFab');
    if (fab) fab.classList.remove('hidden');
  }, 1000);
}
