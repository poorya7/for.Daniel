// karaoke-constants.js
//
// Tiny, dependency-free constants module. Carved out 2026-05-12 so the
// process-url-fetch.js paste-time warm path can read the chunk-grid values
// WITHOUT pulling the entire karaoke module cluster into the main bundle.
// karaoke.js + sister files now lazy-load on first URL paste; this file is
// the only piece of the cluster that the main bundle imports.
//
// MUST_MATCH: pipeline/karaoke/_constants.py
//   FIRST_CHUNK_DUR  ←→ FIRST_CHUNK_DUR_SEC  (backend)
//   STEADY_CHUNK_DUR ←→ STEADY_CHUNK_DUR_SEC (backend)
// `scripts/check-chunk-grid.mjs` greps THIS file for the FE values. Don't
// move the declarations back into karaoke-chunk-loader.js without also
// updating that script's FE_PATH — drift here means every chunk fetch
// errors at the FE→BE handshake.

// Uniform 600s grid (originally 60/300, then 300, now 600 after PCM slicing
// eliminated the ffmpeg re-encode cost). Constants kept named even when
// equal so reverting to a smaller first chunk is a 1-line change.
export const FIRST_CHUNK_DUR = 600;
export const STEADY_CHUNK_DUR = 600;

// Videos at or below this duration use the single-call short endpoint
// (/api/karaoke-words-short) instead of the chunked loader.
export const SHORT_VIDEO_THRESHOLD_SEC = 300;
