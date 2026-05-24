/**
 * RecapShark Pipeline UI
 * Handles the loading/progress display when processing a video.
 * Single responsibility: visual feedback for pipeline state.
 */
export const PipelineUI = (() => {
  const STATUS_MESSAGES = {
    queued: 'Fetching video metadata...',
    downloading: 'Extracting audio...',
    transcribing: 'Generating transcript...',
    done: 'Done!',
    error: 'Something went wrong.',
  };

  let statusEl = null;
  let messageEl = null;
  let transcribeRealPct = 0;
  let transcribeDisplayPct = 0;
  let transcribeLastRealAt = 0;
  let transcribeTimer = null;
  let transcribeChunksDone = 0;
  let transcribeChunksTotal = 0;

  function getElements() {
    if (!statusEl) statusEl = document.getElementById('pipelineStatus');
    if (!messageEl) messageEl = document.getElementById('pipelineMessage');
  }

  function showTopBar(text) {
    if (statusEl) { statusEl.style.display = ''; statusEl.classList.remove('hidden'); }
    if (messageEl) messageEl.textContent = text;
  }

  function hideTopBar() {
    if (statusEl) { statusEl.style.display = 'none'; statusEl.classList.add('hidden'); }
  }

  function resetTranscribeProgress() {
    transcribeRealPct = 0;
    transcribeDisplayPct = 0;
    transcribeLastRealAt = 0;
    transcribeChunksDone = 0;
    transcribeChunksTotal = 0;
    if (transcribeTimer) {
      clearInterval(transcribeTimer);
      transcribeTimer = null;
    }
  }

  function normalizeBaseProgressText(progressText) {
    const raw = (progressText || '').trim();
    if (!raw) return STATUS_MESSAGES.transcribing;
    return raw.replace(/\s*\d+%\s*$/, '').trim();
  }

  function deriveRealTranscribePct(jobStatus) {
    const total = Number(jobStatus.chunks_total || 0);
    const done = Number(jobStatus.chunks_done || 0);
    if (total > 0) {
      return Math.max(0, Math.min(100, Math.floor((done / total) * 100)));
    }
    const progressText = String(jobStatus.progress || '');
    const m = progressText.match(/(\d+)%/);
    if (m) return Math.max(0, Math.min(100, Number(m[1])));
    return 0;
  }

  function getSmoothCap(realPct) {
    const total = Number(transcribeChunksTotal || 0);
    if (total <= 0) return Math.min(95, realPct + 20);
    const step = 100 / total;
    const slack = Math.max(2, Math.floor(step) - 1);
    return Math.min(99, realPct + slack);
  }

  function formatTranscribeMessage(jobStatus, shownPct) {
    const base = normalizeBaseProgressText(jobStatus.progress);
    const total = Number(jobStatus.chunks_total || 0);
    const done = Number(jobStatus.chunks_done || 0);
    if (total > 0) {
      return `${base} ${shownPct}% (${done}/${total} chunks)`;
    }
    return `${base} ${shownPct}%`;
  }

  function updateTranscribeProgress(jobStatus) {
    const now = Date.now();
    transcribeChunksDone = Number(jobStatus.chunks_done || 0);
    transcribeChunksTotal = Number(jobStatus.chunks_total || 0);
    const realPct = deriveRealTranscribePct(jobStatus);
    if (!transcribeLastRealAt) transcribeLastRealAt = now;
    if (realPct > transcribeRealPct) {
      transcribeRealPct = realPct;
      transcribeLastRealAt = now;
    }

    if (transcribeDisplayPct < transcribeRealPct) {
      transcribeDisplayPct = transcribeRealPct;
    }

    if (!transcribeTimer) {
      transcribeTimer = setInterval(() => {
        if (!transcribeLastRealAt) return;
        const idleMs = Date.now() - transcribeLastRealAt;
        if (idleMs < 1200) return;
        const cap = getSmoothCap(transcribeRealPct);
        if (transcribeDisplayPct < cap) transcribeDisplayPct += 1;
      }, 250);
    }

    const shownPct = Math.max(0, Math.min(99, Math.floor(transcribeDisplayPct)));
    return formatTranscribeMessage(jobStatus, shownPct);
  }

  function show(text) {
    getElements();
    if (!statusEl || !messageEl) return;
    resetTranscribeProgress();
    statusEl.style.display = '';
    statusEl.classList.remove('hidden', 'error', 'success');
    messageEl.textContent = text || 'Processing...';
  }

  function update(jobStatus) {
    getElements();
    const msg = jobStatus.progress || STATUS_MESSAGES[jobStatus.status] || 'Processing...';

    if (statusEl) statusEl.classList.remove('error', 'success');

    if (jobStatus.status === 'transcribing') {
      const progressText = updateTranscribeProgress(jobStatus);
      const transcriptPane = document.getElementById('tab-transcript');
      const tabVisible = transcriptPane && transcriptPane.classList.contains('active');
      if (tabVisible) {
        hideTopBar();
      } else {
        showTopBar(progressText);
      }
    } else {
      resetTranscribeProgress();
      showTopBar(msg);
      if (jobStatus.status === 'error' && statusEl) statusEl.classList.add('error');
      if (jobStatus.status === 'done' && statusEl) statusEl.classList.add('success');
    }
  }

  function hide() {
    getElements();
    resetTranscribeProgress();
    hideTopBar();
  }

  function showError(message) {
    show(message);
    if (statusEl) statusEl.classList.add('error');
  }

  function getTranscribeText(jobStatus) {
    getElements();
    return updateTranscribeProgress(jobStatus);
  }

  return { show, update, hide, showError, getTranscribeText, hideTopBar };
})();
