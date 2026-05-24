/**
 * PCM capture AudioWorklet processor.
 *
 * Runs in the AudioWorkletGlobalScope (a dedicated audio-rendering thread,
 * NOT the main thread). Receives Float32 audio frames at the browser's
 * native sample rate (typically 48 kHz on desktop, 44.1 kHz on some
 * mobile), downsamples to 16 kHz mono, converts to Int16 PCM, and posts
 * 50 ms chunks back to the main thread via the worklet's MessagePort.
 *
 * Why a worklet (not MediaRecorder + timeslice):
 *   MediaRecorder's `timeslice` mode emits compressed container chunks
 *   (webm or mp4 fragments) that don't always concatenate cleanly,
 *   especially on iOS Safari. AudioWorklet gives us raw PCM — exactly
 *   what AssemblyAI's streaming WebSocket expects.
 *
 * Why downsample here (not on the main thread):
 *   The audio thread is the only place that has all the samples in a
 *   stable cadence. Moving raw 48 kHz Float32 across the MessagePort
 *   and then resampling on the main thread doubles allocation +
 *   latency. The worklet path lets us ship Int16 chunks directly.
 *
 * The processor stays stateful only between calls to `process()` — it
 * holds a small "leftover" buffer of input samples that didn't fill a
 * full output frame on the previous tick. Anything more would belong
 * on the main thread.
 *
 * Outgoing message shape (worklet → main):
 *   { type: "pcm", samples: Int16Array }
 *   sampleRate is fixed at 16000 by contract; the main thread doesn't
 *   need to be told.
 *
 * Important caveat — this file ships AS-IS to the AudioWorkletGlobalScope
 * (Vite imports it via `?url`). Don't add any imports or rely on globals
 * other than the worklet API (`registerProcessor`, `currentTime`, etc.).
 */

const OUTPUT_SAMPLE_RATE = 16000;
// 50 ms at 16 kHz = 800 samples. Matches the AssemblyAI docs' suggested
// chunk size — picking the same size keeps their cadence assumptions
// (partial latency, end-of-turn detection) operating in their tested
// regime.
const OUTPUT_FRAME_SIZE = 800;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Ratio of input samples consumed per output sample. With a 48 kHz
    // input and a 16 kHz output it's 3.0 — every 3rd sample. We use a
    // simple decimating filter (mean of N adjacent input samples) for
    // anti-aliasing; for voice at 16 kHz this is good enough — the
    // information above 8 kHz Nyquist isn't load-bearing for speech.
    this._inputSampleRate = sampleRate; // injected by AudioWorkletGlobalScope
    this._ratio = this._inputSampleRate / OUTPUT_SAMPLE_RATE;
    // Holds Int16 output samples we've computed but not yet sent. When
    // it reaches OUTPUT_FRAME_SIZE we post + reset.
    this._outputBuffer = new Int16Array(OUTPUT_FRAME_SIZE);
    this._outputWriteIndex = 0;
    // Holds the fractional position into the input stream — keeps the
    // decimation cadence stable across `process()` invocations.
    this._inputPosition = 0;
  }

  process(inputs) {
    // `inputs` is `Float32Array[][]` — one entry per input port, each a
    // list of channels. We have one input port (the mic source) and we
    // take the first channel only (mono). If the user's mic is dead the
    // input array is empty; just bail.
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    // Walk through the input channel at `_ratio`-sized steps. For each
    // output sample, average a small window of adjacent input samples
    // — keeps high-frequency aliasing manageable on consumer mics
    // without a full FIR filter.
    let position = this._inputPosition;
    while (position < channel.length) {
      const start = Math.floor(position);
      // Window width = ceil(ratio) so we always sample at least one
      // input frame even if ratio < 1 (shouldn't happen with realistic
      // sample rates, but defensive).
      const windowWidth = Math.max(1, Math.ceil(this._ratio));
      let sum = 0;
      let count = 0;
      for (let i = 0; i < windowWidth && start + i < channel.length; i++) {
        sum += channel[start + i];
        count++;
      }
      const averaged = count > 0 ? sum / count : 0;

      // Float32 [-1, 1] → Int16 [-32768, 32767]. Clamp before scaling so
      // a spike above 1.0 (rare but real on some Bluetooth mics) doesn't
      // wrap around to a huge negative.
      const clamped = Math.max(-1, Math.min(1, averaged));
      this._outputBuffer[this._outputWriteIndex] =
        clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      this._outputWriteIndex++;

      if (this._outputWriteIndex >= OUTPUT_FRAME_SIZE) {
        // Copy out so the main thread holds a stable buffer (postMessage
        // would otherwise share the same underlying memory the worklet
        // is about to overwrite). Slice creates a new Int16Array.
        const chunk = this._outputBuffer.slice(0, OUTPUT_FRAME_SIZE);
        this.port.postMessage({ type: "pcm", samples: chunk }, [chunk.buffer]);
        // Start a fresh output buffer — the previous one's underlying
        // memory was transferred to the main thread.
        this._outputBuffer = new Int16Array(OUTPUT_FRAME_SIZE);
        this._outputWriteIndex = 0;
      }

      position += this._ratio;
    }

    // Keep the fractional remainder so the next tick continues smoothly
    // — important for cadence stability across thousands of process()
    // calls per minute.
    this._inputPosition = position - channel.length;
    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
