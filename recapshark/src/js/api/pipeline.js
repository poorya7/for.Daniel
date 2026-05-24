import { RecapSharkAPI } from './client.js';
import { Helpers } from '../core/helpers.js';

/**
 * RecapShark Pipeline Orchestration
 * Manages the multi-step video processing flow.
 * Extends RecapSharkAPI (must load after client.js).
 */
(function() {
  const _fetch = RecapSharkAPI._fetch;
  const _getBaseUrl = RecapSharkAPI._getBaseUrl;
  const userFacingError = RecapSharkAPI._userFacingError;

  function _subsToSegments(text, durationSec) {
    const sentences = text.match(/[^.!?]+[.!?]+[\s]*/g) || [text];
    const CHUNK_SIZE = 4;
    const chunks = [];
    for (let i = 0; i < sentences.length; i += CHUNK_SIZE) {
      chunks.push(sentences.slice(i, i + CHUNK_SIZE).join('').trim());
    }
    if (!chunks.length) chunks.push(text);
    const totalLen = chunks.reduce((sum, c) => sum + c.length, 0) || 1;
    let cursor = 0;
    const segments = chunks.map(c => {
      const start = Math.round((cursor / totalLen) * durationSec);
      cursor += c.length;
      const end = Math.round((cursor / totalLen) * durationSec);
      return { text: c, start, end };
    });
    return { segments, duration: durationSec };
  }

  RecapSharkAPI.processVideoTestPipeline = async function(videoUrl, onProgress, onPartialTranscript, { metaP: sharedMetaP } = {}) {
    const baseUrl = _getBaseUrl();
    const videoId = Helpers.extractVideoId(videoUrl);
    if (!videoId) throw new Error('Invalid YouTube URL');

    let videoDurationSec = 0;

    const NO_SUBS_MIN_LENGTH = 100;
    const SUBS_TIMEOUT_MS = 5000;

    const subsP = _fetch(`${baseUrl}/api/transcript/subs?url=${encodeURIComponent(videoUrl)}`)
      .then(r => r.ok ? r.json() : null).catch(() => null);
    // Reuse the /video/meta promise that processUrl() already kicked off for
    // its duration check (app.js: metaCheckP) — same endpoint, same payload,
    // both fire on paste. Dedupes a redundant yt-dlp roundtrip per paste,
    // which on slow YT responses can be a 5-10s win on its own. Falls back
    // to firing our own if no shared promise was passed (test harnesses,
    // direct callers, etc.).
    const metaP = sharedMetaP || _fetch(`${baseUrl}/api/video/meta?url=${encodeURIComponent(videoUrl)}`)
      .then(r => r.ok ? r.json() : null).catch(() => null);

    // Fast-path: YT Data API contentDetails.caption (exposed as
    // has_captions on /api/video/meta) is a ~1s pre-check vs. ~15s for
    // a full SubsProvider empty-response round-trip. When false, there's
    // nothing for the pipeline to fetch — emit the music-only partial
    // immediately and bail. Orchestrator already disables rewindMode
    // via applyShortVideoSkip in this case, so the user sees the
    // results view without the VHS rewind animation. Both subsP and
    // metaP keep firing in parallel (subsP just gets discarded) so
    // videos WITH captions don't pay any latency for this check.
    const earlyMeta = await metaP.catch(() => null);
    if (earlyMeta && earlyMeta.has_captions === false) {
      const msg = 'This video is mostly music — no real spoken content to summarise.';
      onProgress?.({ progress: msg });
      const emptyTranscript = { segments: [], duration: earlyMeta.duration || 0, is_mostly_music: true };
      onPartialTranscript?.({
        video_id: videoId,
        summary: [msg],
        chapters: [],
        transcript: emptyTranscript,
        summary_final: true,
        chapters_final: true,
        lang: earlyMeta.lang || 'en',
        is_mostly_music: true,
      });
      return {
        video_id: videoId,
        summary: [msg],
        chapters: [],
        transcript: emptyTranscript,
        summary_final: true,
        chapters_final: true,
        lang: earlyMeta.lang || 'en',
        is_mostly_music: true,
      };
    }

    const timeoutP = new Promise(r => setTimeout(() => r(null), SUBS_TIMEOUT_MS));

    let subsData = await Promise.race([subsP, timeoutP]);
    let usedMetaFallback = false;

    if (!subsData || (subsData.content || '').trim().length < NO_SUBS_MIN_LENGTH) {
      // No-subs preview: read title/channel from the same /api/video/meta
      // promise the orchestrator passed in. Pre-2026-05-08 (Phase 4a) this
      // path awaited a parallel noembed.com call; that third-party endpoint
      // is now bot-blocked by YouTube (KB3) and the meta promise carries
      // the same fields anyway.
      const metaForPreview = await metaP.catch(() => null);
      if (metaForPreview && (metaForPreview.title || metaForPreview.channel)) {
        usedMetaFallback = true;
        const previewText = metaForPreview.title || 'Loading summary...';
        onPartialTranscript?.({
          video_id: videoId,
          summary: [previewText],
          chapters: [],
          transcript: { segments: [], duration: videoDurationSec },
          summary_final: false,
          chapters_final: false,
          lang: 'en',
        });
        onProgress?.({ progress: 'Fetching transcript...' });
      }
      subsData = await subsP;
    }

    let subsOk = !!subsData;
    const subsContent = (subsData?.content || '').trim();
    const noSubs = !subsOk || subsContent.length < NO_SUBS_MIN_LENGTH;

    if (noSubs) {
      // Videos with no captions at all (nature footage, ambient/music, silent
      // clips, dog-TV "Virtual Walk" videos) ride the same "mostly music" UX
      // state as caption-but-no-speech videos: badge on summary/chapters,
      // friendly placeholder in transcript, no skeleton ghosts. Signalled via
      // is_mostly_music on the partial so data-loader can force the flag even
      // though the raw text is empty (detectMostlyMusic guards against
      // false-positives on <20 chars). Skip all downstream LLM/NER/suggested-
      // questions calls — there's no spoken content to feed them.
      const msg = 'This video is mostly music — no real spoken content to summarise.';
      onProgress?.({ progress: msg });
      const emptyTranscript = { segments: [], duration: videoDurationSec, is_mostly_music: true };
      onPartialTranscript?.({
        video_id: videoId,
        summary: [msg],
        chapters: [],
        transcript: emptyTranscript,
        summary_final: true,
        chapters_final: true,
        lang: 'en',
        is_mostly_music: true,
      });
      return {
        video_id: videoId,
        summary: [msg],
        chapters: [],
        transcript: emptyTranscript,
        summary_final: true,
        chapters_final: true,
        lang: 'en',
        is_mostly_music: true,
      };
    }

    const realSegs = (subsData.segments || []).filter(s => s.text);
    const subsTranscript = realSegs.length > 0
      ? { segments: realSegs, duration: videoDurationSec }
      : _subsToSegments(subsContent, videoDurationSec);
    /* NER metadata from /test/subs (graceful no-op when ENABLE_NER is off
     * server-side — both fields will be empty/null and downstream code
     * just does nothing with them). entities is a deduplicated list of
     * {text, type} the entity-highlighter uses to colorize names. */
    subsTranscript.entities = subsData.entities || [];

    const cleaned = subsContent.replace(/\s*>>\s*/g, ' ').replace(/\s*<<\s*/g, ' ').replace(/\s+/g, ' ').trim();
    // Music-only short-circuit: if the transcript is dominated by [Music] /
    // [Applause] / [Laughter] annotations (real spoken words < 100 across the
    // whole thing), replace the raw "[Music] [Music] [Music]…" preview with a
    // friendly placeholder. The real summary still streams in afterwards and
    // overwrites this preview; if the user switches language during that
    // window, the translation pipeline picks up the substituted text rather
    // than the music-token spam. Mirrors `_detectMostlyMusic` in app.js
    // (intentional duplication — pipeline.js lives below the view layer).
    const _withoutAnnotations = cleaned.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
    const _realWords = _withoutAnnotations.match(/[\p{L}\p{N}]{2,}/gu) || [];
    const _isMostlyMusic = cleaned.length >= 20 && _realWords.length < 100;
    const lang = subsData.lang || '';

    // Music-only short-circuit: nothing to summarise, chapter, NER, or chat
    // over. Emit the placeholder + is_mostly_music flag, mark both final, and
    // bail before any /api/summary/* /api/chapters/* or suggested-questions
    // call fires. Mirrors the no-subs branch above — same UX state, same
    // efficiency.
    if (_isMostlyMusic) {
      const msg = 'This video is mostly music — no real spoken content to summarise.';
      onProgress?.({ progress: msg });
      subsTranscript.is_mostly_music = true;
      onPartialTranscript?.({
        video_id: videoId,
        summary: [msg],
        chapters: [],
        transcript: subsTranscript,
        summary_final: true,
        chapters_final: true,
        lang,
        is_mostly_music: true,
      });
      return {
        video_id: videoId,
        summary: [msg],
        chapters: [],
        transcript: subsTranscript,
        summary_final: true,
        chapters_final: true,
        lang,
        is_mostly_music: true,
      };
    }

    const subsPreview = cleaned.slice(0, 1000) + (cleaned.length > 1000 ? '…' : '');
    const segPayload = realSegs.map(s => ({ text: s.text, start: s.start, duration: s.duration || 0 }));
    const headers = { 'Content-Type': 'application/json' };

    onPartialTranscript?.({
      video_id: videoId,
      summary: [subsPreview],
      chapters: [],
      transcript: subsTranscript,
      summary_final: false,
      chapters_final: false,
      lang,
    });

    onProgress?.({ progress: 'Generating summary + chapters...' });

    let currentChapters = [];
    let currentSummary = [];
    let summaryFinal = false;
    let chaptersFinal = false;

    function _hmsToSec(str) {
      const parts = String(str || '').split(':').map(s => parseInt(s, 10));
      if (parts.some(isNaN)) return 0;
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      return parts[0] || 0;
    }

    // ── Speculative parallel chapters (description vs LLM) ──
    // Old behavior: await meta → check description chapters → fire v3 only if
    // none. That's sequential — for non-description videos, chapters arrive at
    // ~meta + v3 (often 10-20s). New behavior: fire v3 RIGHT NOW with a
    // duration estimated from the last subs segment, in parallel with meta.
    //
    // When meta lands we settle the real duration AND check description
    // chapters; description always wins (creator-curated, free) so we abort
    // the in-flight v3 if so. For non-description videos, chapters arrive at
    // ~max(meta, v3) instead of ~meta + v3 — typically 5-10s saved. Cost of
    // an aborted LLM call is small; the v3 endpoint sees the abort signal
    // (best-effort but usually before token spend).
    let _estDuration = 0;
    if (realSegs.length) {
      const _lastSeg = realSegs[realSegs.length - 1];
      _estDuration = _lastSeg.end || (_lastSeg.start + (_lastSeg.duration || 0)) || 0;
    }
    const v3Abort = new AbortController();
    const v3ChaptersP = _fetch(`${baseUrl}/api/chapters/v3`, {
      method: 'POST', headers,
      signal: v3Abort.signal,
      body: JSON.stringify({ transcript_text: subsContent, segments: segPayload, lang, video_duration: _estDuration }),
    }).then(r => r.ok ? r.json() : null).catch(() => null);

    // Resolution coordinator: description chapters always win when present.
    // If meta returns first with description chapters, emit + abort v3.
    // If meta returns first WITHOUT description chapters, wait for v3 then emit.
    // If v3 returns first, hold the result until meta confirms there's no
    // description chapters (otherwise we'd flash LLM chapters that get
    // immediately replaced when description chapters land — jarring).
    let _metaResolved = false;
    let _v3Resolved = false;
    let _v3Result = null;
    function _emitV3IfReady() {
      if (chaptersFinal) return;
      if (!_metaResolved || !_v3Resolved) return;
      if (!_v3Result?.chapters?.length) return;
      currentChapters = _v3Result.chapters;
      chaptersFinal = true;
      onPartialTranscript?.({
        video_id: videoId,
        summary: currentSummary,
        chapters: currentChapters,
        transcript: subsTranscript,
        summary_final: summaryFinal,
        chapters_final: true,
        lang,
      });
    }

    const metaSettledP = metaP.then(meta => {
      _metaResolved = true;
      if (meta?.duration) {
        videoDurationSec = meta.duration;
        subsTranscript.duration = videoDurationSec;
      }
      const _metaChapters = Array.isArray(meta?.chapters) ? meta.chapters : [];
      // Description chapters short-circuit: only honour the creator's
      // chapters when they're substantial (≥10). Many creators only put
      // a sparse 4-6 chapters in the description for a 10-min video,
      // which leaves the chapter panel feeling under-populated. Falling
      // back to the LLM (which is prompted to return 10-15) gives a
      // denser, more navigable list. The 10-threshold matches the LLM's
      // own "MUST return AT LEAST 10" rule in pipeline/worker.py so
      // both paths produce a comparable UX.
      if (_metaChapters.length >= 10) {
        try { v3Abort.abort(); } catch (e) { Helpers.reportError(e, 'pipeline.v3Abort'); }
        currentChapters = _metaChapters.map(c => ({
          title: c.title || '',
          start_time: _hmsToSec(c.time),
        }));
        chaptersFinal = true;
        onPartialTranscript?.({
          video_id: videoId,
          summary: currentSummary,
          chapters: currentChapters,
          transcript: subsTranscript,
          summary_final: false,
          chapters_final: true,
          lang,
        });
      } else {
        // No description chapters — let v3 emit if it's already resolved,
        // otherwise its .then handler below will pick up the slack.
        _emitV3IfReady();
      }
      return meta;
    });

    v3ChaptersP.then(data => {
      _v3Resolved = true;
      _v3Result = data;
      _emitV3IfReady();
    });

    const fullSummaryP = _fetch(`${baseUrl}/api/summary/full`, {
      method: 'POST', headers,
      body: JSON.stringify({ transcript_text: subsContent, url: videoUrl, lang }),
    }).then(r => r.ok ? r.json() : r.json().then(e => { throw new Error(userFacingError(e.detail, 'Couldn\'t generate full summary.')); }));

    // Suggested chat questions run on a SEPARATE endpoint, fired in
    // parallel here, so they never block the summary render. Any latency
    // overlap is hidden behind the rewind animation. If they're slow or
    // fail, the chat UI falls back to its static chip pair.
    const suggestedQuestionsP = _fetch(`${baseUrl}/api/chat/suggested-questions`, {
      method: 'POST', headers,
      body: JSON.stringify({ transcript_text: subsContent, url: videoUrl, lang }),
    }).then(r => r.ok ? r.json() : null).catch(() => null);

    // Settle the real duration before falling through to the rest of the
    // function (fullData emit uses videoDurationSec via subsTranscript).
    await metaSettledP;
    if (!videoDurationSec && realSegs.length) {
      const lastSeg = realSegs[realSegs.length - 1];
      videoDurationSec = lastSeg.end || (lastSeg.start + (lastSeg.duration || 0)) || 0;
    }

    const fullData = await fullSummaryP;
    const fullSummary = Array.isArray(fullData.summary)
      ? fullData.summary
      : fullData.summary ? [fullData.summary] : [];
    currentSummary = fullSummary;
    summaryFinal = true;

    onPartialTranscript?.({
      video_id: videoId,
      summary: fullSummary,
      chapters: currentChapters,
      transcript: subsTranscript,
      summary_final: true,
      chapters_final: chaptersFinal,
      lang,
    });

    // Suggested chat questions stream in via a separate partial update
    // whenever they arrive — usually around the same time as the summary,
    // sometimes a beat later. ChatManager.refreshChips() in app.js swaps
    // them into the chip rail if the user hasn't typed yet.
    suggestedQuestionsP.then(qData => {
      const suggestedQuestions = Array.isArray(qData?.questions)
        ? qData.questions.filter(q => typeof q === 'string' && q.trim())
        : [];
      if (suggestedQuestions.length) {
        onPartialTranscript?.({
          video_id: videoId,
          summary: currentSummary,
          chapters: currentChapters,
          transcript: subsTranscript,
          summary_final: true,
          chapters_final: chaptersFinal,
          lang,
          suggested_questions: suggestedQuestions,
        });
      }
    });

    return {
      video_id: videoId,
      summary: fullSummary,
      chapters: currentChapters,
      transcript: subsTranscript,
      summary_final: true,
      chapters_final: true,
      lang,
    };
  };

  async function _runAsrProviderWithProgress(videoUrl, videoDurationSec, onProgress, lang) {
    const baseUrl = _getBaseUrl();
    const estimatedSec = (videoDurationSec / 60) * 1.5 + 8;
    const phase1End = estimatedSec * 0.3;
    const phase2End = estimatedSec * 0.95;
    let t0 = performance.now();
    let asr_providerDone = false;
    const pctInterval = setInterval(() => {
      if (asr_providerDone) return;
      const elapsed = (performance.now() - t0) / 1000;
      let pct;
      if (elapsed <= phase1End) {
        pct = (elapsed / phase1End) * 50;
      } else {
        pct = 50 + ((elapsed - phase1End) / (phase2End - phase1End)) * 48;
      }
      pct = Math.min(100, Math.floor(pct));
      onProgress?.({ progress: `Video has no subtitles — extracting transcript from audio… ${pct}%` });
    }, 1000);

    const langParam = lang ? `&lang=${encodeURIComponent(lang)}` : '';
    const asr_providerRes = await _fetch(`${baseUrl}/api/transcript/asr_provider?url=${encodeURIComponent(videoUrl)}${langParam}`);
    asr_providerDone = true;
    clearInterval(pctInterval);

    if (!asr_providerRes.ok) {
      const err = await asr_providerRes.json().catch(() => ({}));
      throw new Error(userFacingError(err.detail, 'Audio transcription wasn\'t available for this video.'));
    }
    const tData = await asr_providerRes.json();
    const segs = tData.segments || [];
    return {
      segments: segs,
      duration: segs.length ? segs[segs.length - 1].end : videoDurationSec,
    };
  }

  RecapSharkAPI._runNoSubsPipeline = async function(videoUrl, videoId, videoDurationSec, onProgress, onPartialTranscript) {
    const baseUrl = _getBaseUrl();
    const placeholderSummary = 'Video has no subtitles — extracting transcript from audio…';
    onProgress?.({ progress: placeholderSummary });

    const emptyTranscript = { segments: [], duration: videoDurationSec };
    onPartialTranscript?.({
      video_id: videoId,
      summary: [placeholderSummary],
      chapters: [],
      transcript: emptyTranscript,
      summary_final: false,
      chapters_final: true,
    });

    try {
      onProgress?.({ progress: 'Getting preview from video info…' });
      const previewRes = await _fetch(`${baseUrl}/api/summary/preview-from-meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: videoUrl }),
      });
      if (previewRes.ok) {
        const previewData = await previewRes.json();
        const previewSummary = previewData.summary || [];
        if (previewSummary.length > 0) {
          onPartialTranscript?.({
            video_id: videoId,
            summary: previewSummary,
            chapters: [],
            transcript: emptyTranscript,
            summary_final: false,
            chapters_final: true,
          });
        }
      }
    } catch (e) { Helpers.reportError(e, 'pipeline.previewSummaryFromMeta'); }

    const asr_providerTranscript = await _runAsrProviderWithProgress(videoUrl, videoDurationSec, onProgress);
    const transcriptText = (asr_providerTranscript.segments || [])
      .map(s => (s.text || '').trim())
      .filter(Boolean)
      .join('\n');

    if (transcriptText.length < 50) {
      onPartialTranscript?.({
        video_id: videoId,
        summary: ['Could not generate a summary from audio.'],
        chapters: [],
        transcript: asr_providerTranscript,
        summary_final: true,
        chapters_final: true,
      });
      return {
        video_id: videoId,
        summary: ['Could not generate a summary from audio.'],
        chapters: [],
        transcript: asr_providerTranscript,
        summary_final: true,
        chapters_final: true,
      };
    }

    onProgress?.({ progress: 'Generating short summary + chapters...' });
    const shortRes = await _fetch(`${baseUrl}/api/summary/short-with-chapters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript_text: transcriptText,
        lang: 'en',
        segments: asr_providerTranscript.segments || [],
        video_duration: videoDurationSec,
      }),
    });
    if (!shortRes.ok) {
      const err = await shortRes.json().catch(() => ({}));
      throw new Error(userFacingError(err.detail, 'Couldn\'t generate summary. Please try again.'));
    }
    const shortData = await shortRes.json();
    const shortSummary = Array.isArray(shortData.short_summary)
      ? shortData.short_summary
      : shortData.short_summary ? [shortData.short_summary] : [];
    const chapters = shortData.chapters || [];

    onPartialTranscript?.({
      video_id: videoId,
      summary: shortSummary,
      chapters,
      transcript: asr_providerTranscript,
      summary_final: false,
      chapters_final: true,
    });

    onProgress?.({ progress: 'Generating full summary...' });
    const fullRes = await _fetch(`${baseUrl}/api/summary/full`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript_text: transcriptText, url: videoUrl }),
    });
    if (!fullRes.ok) {
      const err = await fullRes.json().catch(() => ({}));
      throw new Error(userFacingError(err.detail, 'Couldn\'t generate full summary. Please try again.'));
    }
    const fullData = await fullRes.json();
    const fullSummary = Array.isArray(fullData.summary)
      ? fullData.summary
      : fullData.summary ? [fullData.summary] : [];

    onPartialTranscript?.({
      video_id: videoId,
      summary: fullSummary,
      chapters,
      transcript: asr_providerTranscript,
      summary_final: true,
      chapters_final: true,
    });

    return {
      video_id: videoId,
      summary: fullSummary,
      chapters,
      transcript: asr_providerTranscript,
      summary_final: true,
      chapters_final: true,
      lang: 'en',
    };
  };
})();
