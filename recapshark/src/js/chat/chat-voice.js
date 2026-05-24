// chat-voice.js — voice input via Web Speech API + animated waveform overlay.
//
// Owns: SpeechRecognition lifecycle (start / stop / onresult / onend / onerror),
//       voice-overlay show/hide, audio analyser canvas drawing.
// Reads from AppState: videoData.lang (recognition source language).
// Imports allowed: core/state. NO sibling chat-* imports.
// Public API: setupVoice({ chatInput, sendChat, getRecognitionLang? }) —
//             one-time wiring. No-op if SpeechRecognition unavailable.
//
// Original lived inside the chat.js IIFE, captured `chatInput` + `sendChat`
// via closure. After split, the host (chat.js core) passes them in
// explicitly via the setup deps object — keeps voice testable in isolation
// and avoids a chat-voice → chat.js back-import (would create a cycle since
// chat.js imports chat-voice).

import { AppState } from '../core/state.js';

export function setupVoice({ chatInput, sendChat, getRecognitionLang }) {
  const chatMicBtn = document.getElementById('chatMicBtn');
  const voiceOverlay = document.getElementById('voiceOverlay');
  const voiceCanvas = document.getElementById('voiceCanvas');
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!chatMicBtn) return;
  if (!SpeechRecognition) {
    chatMicBtn.style.display = 'none';
    return;
  }

  const resolveLang = typeof getRecognitionLang === 'function'
    ? getRecognitionLang
    : () => (AppState.videoData && AppState.videoData.lang) || 'en';

  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = resolveLang();

  let micActive = false;
  let audioCtx = null;
  let analyser = null;
  let micStream = null;
  let waveRaf = null;
  let smoothLevel = 0;

  const VW = 280, VH = 100;
  const cyanColor = '#06B6D4';

  function drawWave() {
    if (!voiceCanvas) return;
    const ctx = voiceCanvas.getContext('2d');
    const now = Date.now() * 0.003;

    let targetLevel = 0;
    if (analyser) {
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      targetLevel = sum / (data.length * 255);
    }
    smoothLevel += (targetLevel - smoothLevel) * 0.05;

    ctx.clearRect(0, 0, VW, VH);
    const amp = 2 + smoothLevel * 35;

    ctx.beginPath();
    ctx.strokeStyle = 'rgba(6,182,212,0.3)';
    ctx.lineWidth = 12;
    ctx.shadowBlur = 25;
    ctx.shadowColor = cyanColor;
    for (let x = 0; x < VW; x++) {
      const y = VH / 2 + Math.sin(x * 0.035 + now) * amp;
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.beginPath();
    ctx.strokeStyle = cyanColor;
    ctx.lineWidth = 3;
    ctx.shadowBlur = 8;
    for (let x = 0; x < VW; x++) {
      const y = VH / 2 + Math.sin(x * 0.035 + now) * amp;
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    const fade = 40;
    const gL = ctx.createLinearGradient(0, 0, fade, 0);
    gL.addColorStop(0, 'rgba(13,37,53,1)');
    gL.addColorStop(1, 'rgba(13,37,53,0)');
    ctx.fillStyle = gL;
    ctx.fillRect(0, 0, fade, VH);
    const gR = ctx.createLinearGradient(VW - fade, 0, VW, 0);
    gR.addColorStop(0, 'rgba(13,37,53,0)');
    gR.addColorStop(1, 'rgba(13,37,53,1)');
    ctx.fillStyle = gR;
    ctx.fillRect(VW - fade, 0, fade, VH);

    waveRaf = requestAnimationFrame(drawWave);
  }

  function startWaveform() {
    if (!voiceOverlay) return;
    voiceOverlay.classList.add('active');
    requestAnimationFrame(() => { voiceOverlay.style.opacity = '1'; });

    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      micStream = stream;
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);
      drawWave();
    }).catch(() => {
      drawWave();
    });
  }

  function stopWaveform() {
    if (waveRaf) { cancelAnimationFrame(waveRaf); waveRaf = null; }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    analyser = null;
    smoothLevel = 0;
    if (voiceOverlay) {
      voiceOverlay.style.opacity = '0';
      setTimeout(() => { voiceOverlay.classList.remove('active'); }, 300);
    }
  }

  chatMicBtn.addEventListener('click', () => {
    if (micActive) {
      recognition.stop();
    } else {
      recognition.lang = resolveLang();
      recognition.start();
      micActive = true;
      chatMicBtn.classList.add('listening');
      startWaveform();
    }
  });

  // Click anywhere on the listening overlay to stop
  if (voiceOverlay) {
    voiceOverlay.addEventListener('click', () => {
      if (micActive) recognition.stop();
    });
  }

  recognition.onresult = (e) => {
    let transcript = '';
    for (let i = 0; i < e.results.length; i++) {
      transcript += e.results[i][0].transcript;
    }
    if (chatInput) chatInput.value = transcript;
  };

  recognition.onend = () => {
    micActive = false;
    chatMicBtn.classList.remove('listening');
    stopWaveform();
    // Auto-send the transcribed text once listening stops (mic click,
    // overlay click, or natural silence end). sendChat() guards against
    // empty input and concurrent sends.
    if (chatInput && chatInput.value.trim() && typeof sendChat === 'function') sendChat();
  };

  recognition.onerror = (e) => {
    micActive = false;
    chatMicBtn.classList.remove('listening');
    stopWaveform();
    if (e.error !== 'aborted') console.warn('Speech recognition error:', e.error);
  };
}
