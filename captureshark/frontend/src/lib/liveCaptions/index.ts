/**
 * Live-captions public surface — one import path for consumers.
 *
 * Caller (e.g. VoicePhase) only needs the React hook + its types. The
 * lower-level audio + WS modules are internal but re-exported here for
 * tests and future telemetry hooks.
 */

export {
  useLiveCaptions,
  type LiveCaptionStatus,
  type LiveCaptionTranscript,
  type UseLiveCaptionsResult,
} from "./useLiveCaptions";
export {
  openAssemblyAIClient,
  type AssemblyAIClient,
  type AssemblyAIClientHandlers,
  type AssemblyAIMessage,
  type BeginMessage,
  type TurnMessage,
  type TerminationMessage,
} from "./assemblyaiClient";
export {
  startPcmCapture,
  type PcmCaptureHandle,
  type PcmCaptureOptions,
} from "./audioCapture";
export {
  createStablePartialBuffer,
  type StablePartialBuffer,
  type StablePartialBufferOptions,
} from "./stablePartialBuffer";
