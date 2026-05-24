// scripts/check-chunk-grid.mjs
//
// Karaoke chunk-grid drift check. Asserts the FIRST_CHUNK_DUR + STEADY_CHUNK_DUR
// constants match between the frontend (src/js/player/karaoke-chunk-loader.js)
// and the backend (pipeline/karaoke/_constants.py). Drift = silent cache-key
// mismatch + every chunk fetch erroring at the FE→BE handshake.
//
// Usage:
//   npm run check:chunk-grid
//   node scripts/check-chunk-grid.mjs
//
// Exit code 0 = match, 1 = mismatch (suitable for CI gating once Phase 5
// of the main cleanup plan wires this in).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const FE_PATH = path.join(repoRoot, 'src', 'js', 'player', 'karaoke-constants.js');
const BE_PATH = path.join(repoRoot, 'pipeline', 'karaoke', '_constants.py');

function extract(filePath, regex, label) {
  const src = fs.readFileSync(filePath, 'utf8');
  const m = src.match(regex);
  if (!m) {
    console.error(`[chunk-grid] FAIL: could not find ${label} in ${path.relative(repoRoot, filePath)}`);
    process.exit(1);
  }
  return Number(m[1]);
}

const fe = {
  first: extract(FE_PATH, /export\s+const\s+FIRST_CHUNK_DUR\s*=\s*(\d+)\s*;/, 'FIRST_CHUNK_DUR'),
  steady: extract(FE_PATH, /export\s+const\s+STEADY_CHUNK_DUR\s*=\s*(\d+)\s*;/, 'STEADY_CHUNK_DUR'),
};
const be = {
  first: extract(BE_PATH, /^FIRST_CHUNK_DUR_SEC\s*=\s*(\d+)/m, 'FIRST_CHUNK_DUR_SEC'),
  steady: extract(BE_PATH, /^STEADY_CHUNK_DUR_SEC\s*=\s*(\d+)/m, 'STEADY_CHUNK_DUR_SEC'),
};

const rows = [
  { name: 'FIRST', fe: fe.first, be: be.first },
  { name: 'STEADY', fe: fe.steady, be: be.steady },
];

console.log('[chunk-grid] checking constants...');
console.log('  | const  | frontend | backend |');
console.log('  |--------|----------|---------|');
for (const r of rows) {
  const ok = r.fe === r.be;
  console.log(`  | ${r.name.padEnd(6)} | ${String(r.fe).padStart(8)} | ${String(r.be).padStart(7)} | ${ok ? 'OK' : 'MISMATCH'}`);
}

const drift = rows.filter(r => r.fe !== r.be);
if (drift.length) {
  console.error(`\n[chunk-grid] FAIL: ${drift.length} constant(s) drifted between FE and BE`);
  console.error('  FE: src/js/player/karaoke-chunk-loader.js');
  console.error('  BE: pipeline/karaoke/_constants.py');
  console.error('  Fix: update both sides to the same value, then re-run.');
  process.exit(1);
}

console.log('\n[chunk-grid] OK — frontend and backend chunk-grid constants match.');
