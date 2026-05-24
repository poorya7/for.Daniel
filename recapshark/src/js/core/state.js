/**
 * RecapShark Application State
 * Central state container for the entire frontend.
 * Single responsibility: hold and reset shared state.
 */
export const AppState = {
  player: null,
  videoData: null,
  transcriptSegments: [],
  totalLines: 0,
  activeTopicIdx: -1,
  transcriptRawText: '',
  /* NER entities from the backend, deduplicated list of {text, type}.
   * Empty when ENABLE_NER is off server-side. Consumed by entity-
   * highlighter to colorize names/orgs/places/events on top of the
   * regex-based date/num/etc. passes. */
  transcriptEntities: [],
  paragraphGroups: [],
  segmentTimestamps: [],
  subtitleSegments: [],
  formattedTranscript: '',
  apiTranscriptData: null,
  processingDone: false,
  summaryFinal: false,
  chaptersFinal: false,

  currentVideoId: null,
  currentVideoInfo: null,
  currentSummary: null,
  currentChapters: null,
  currentUploadDate: null,

  _lastSummaryKey: '',
  _lastChaptersKey: '',
  processingVideoId: null,

  ytApiLoaded: false,
  trackerInterval: null,
  ccEnabled: false,
  ccInterval: null,
  transcriptSyncInterval: null,
  lastHighlightedRow: null,
  autoScrollEnabled: true,
  searchDebounce: null,

  currentLang: 'en',
  translationCache: {},

  karaokeEnabled: true,
  // Active-line anchor for transcript auto-scroll. When true, the scroll
  // target is anchored on the karaoke active word's TOP within the row,
  // not the row's TOP. Fixes the dual-mode "kissing the top edge" drift
  // (regime-B math: when secondary column > primary column height, the
  // row-top anchor lets karaoke drift up by frac × (secondary − primary)
  // pixels through a paragraph). Falls back to row-top when no
  // .karaoke-active-word exists. Single mode collapses to current
  // behavior. Set to false for instant rollback if a regression appears.
  // See docs/_logs/ACTIVE_LINE_ANCHOR_PLAN.md.
  useActiveLineAnchor: true,
  karaokeWords: null,
  // Lazy karaoke (Phase 2+). 'lazy' = chunked path (production default).
  // 'full' is reserved for the admin-only `/api/admin/karaoke-words-full`
  // endpoint and is never set by production code paths. Phase 4 short-video
  // bypass (≤300s) lives inside the lazy path — it doesn't switch modes.
  karaokeMode: 'lazy',
  // Set true when a non-retryable session-fatal chunk error arrives
  // (cap_hit, circuit_open). Stops the chunk loader from firing more requests
  // for the remainder of the session. Reset between videos.
  karaokeSessionFatal: false,
  // Per-session telemetry counters; logged on session end.
  karaokeChunksRequested: 0,
  karaokeChunksCacheHits: 0,
  karaokeChunksFetched: 0,
  karaokeChunksFailed: 0,

  rewindMode: false,

  // True for the 500ms window after transitionFromRewind issues its
  // seekTo(0) + pauseVideo. The YT iframe propagates those calls
  // asynchronously, so during this window getCurrentTime() can still
  // return the stale rewind-end position. Anything that reads
  // getCurrentTime() to drive a scroll target (showMode mount-scroll,
  // syncActiveToTime auto-follow) must skip while this is true,
  // otherwise the transcript scrolls to that stale position and then
  // visibly jumps back when the seek lands. Set + cleared by
  // PlayerManager.transitionFromRewind.
  postRewindSettling: false,

  // Becomes true the moment a mobile transcript / subtitle panel has been
  // prepared with non-empty real items — i.e. the placeholder skeleton has
  // been replaced with actual transcript content. process-url-view.js'
  // rewind-end reveal waits for this (with a 5s safety timeout) before
  // lifting the blur, so the user never sees the placeholder under
  // a half-lifted blur. Reset to false on each new paste in
  // State.setRewindMode(true).
  transcriptPainted: false,

  // True when the loaded video has essentially no spoken words — transcript
  // is dominated by `[Music]` / `[Applause]` / `[Laughter]` annotations.
  // Set in app.js after transcriptRawText lands. Consumed by the renderer
  // to show a "mostly music" badge on summary/chapters and to replace the
  // transcript-tab content with a friendly placeholder instead of the
  // useless `[Music] [Music] [Music]…` repetition.
  isMostlyMusic: false,

  // LLM-generated suggested chat questions for the current video. Lives
  // here (not on videoData) because videoData is rebuilt every time a
  // partial transcript update lands — keeping the questions out of that
  // object means they survive chapter / summary updates that arrive
  // after the questions endpoint resolves.
  suggestedQuestions: [],

  casualMode: true,
  formalSummary: null,
  formalChapters: null,
  formalFetching: false,
  formalFetched: false,

  getContent(section) {
    const lang = this.currentLang;
    const videoLang = this.videoData?.lang || 'en';
    const casual = this.casualMode;
    const isOriginal = lang === videoLang;

    if (section === 'summary') {
      if (isOriginal) return (!casual && this.formalSummary) ? this.formalSummary : this.currentSummary;
      const cache = this.translationCache[lang];
      if (!cache) return null;
      return (!casual && cache.formalSummary) ? cache.formalSummary : cache.summary;
    }
    if (section === 'chapters') {
      if (isOriginal) return (!casual && this.formalChapters?.length) ? this.formalChapters : this.currentChapters;
      const cache = this.translationCache[lang];
      if (!cache) return null;
      return (!casual && cache.formalChapters?.length) ? cache.formalChapters : cache.chapters;
    }
    if (section === 'title') {
      if (isOriginal) return this.videoData?.title || '';
      const cache = this.translationCache[lang];
      if (!cache?.title) return this.videoData?.title || '';
      return cache.title.replace(/\[\[([^\]]+)\]\]/g, '$1');
    }
    if (section === 'transcript') {
      if (isOriginal) return this.transcriptRawText;
      const cache = this.translationCache[lang];
      if (!cache?.transcriptMap?.size) return this.transcriptRawText;
      // Return cached rebuilt text if available (avoids rebuilding 6700+ lines every call)
      if (cache._rebuiltTranscript && cache._rebuiltMapSize === cache.transcriptMap.size) {
        return cache._rebuiltTranscript;
      }
      // Rebuild and cache. IDs match _getTranscriptLines() which filters empty lines.
      const rawLines = (this.transcriptRawText || '').split('\n');
      let filteredIdx = 0;
      const rebuilt = rawLines.map((line) => {
        const trimmed = line.replace(/^- /, '').trim();
        if (!trimmed) return line;
        const translated = cache.transcriptMap.get(filteredIdx);
        filteredIdx++;
        if (!translated) return line;
        const match = line.match(/^\[(\d[\d:]+)\]/);
        return match ? '[' + match[1] + '] ' + translated : translated;
      }).join('\n');
      cache._rebuiltTranscript = rebuilt;
      cache._rebuiltMapSize = cache.transcriptMap.size;
      return rebuilt;
    }
    return null;
  },

  reset() {
    this.videoData = null;
    this.suggestedQuestions = [];
    this.transcriptSegments = [];
    this.totalLines = 0;
    this.activeTopicIdx = -1;
    this.transcriptRawText = '';
    this.transcriptEntities = [];
    this.paragraphGroups = [];
    this.formattedTranscript = '';
    this.apiTranscriptData = null;
    this.currentLang = 'en';
    this.translationCache = {};
    this.karaokeWords = null;
    // Lazy karaoke per-video state (karaokeMode is config — not reset).
    this.karaokeSessionFatal = false;
    this.karaokeChunksRequested = 0;
    this.karaokeChunksCacheHits = 0;
    this.karaokeChunksFetched = 0;
    this.karaokeChunksFailed = 0;
    this.casualMode = true;
    this.formalSummary = null;
    this.formalChapters = null;
    this.formalFetching = false;
    this.formalFetched = false;
    this.isMostlyMusic = false;
    if (this.trackerInterval) { clearInterval(this.trackerInterval); this.trackerInterval = null; }
    // NOTE: rewindMode is NOT reset here — it's managed by processUrl() manually
    if (typeof window.KaraokeManager !== 'undefined') window.KaraokeManager.reset();
  }
};
