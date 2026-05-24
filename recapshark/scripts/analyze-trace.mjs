// Quick Chrome perf-trace analyzer for the K1 wave-loop perf check.
// Reads a .json.gz trace from DevTools Performance > Save profile.
// Prints: long-task summary, style/layout cost, top JS functions by self-time,
// and karaoke-specific call counts.
//
// Usage: node scripts/analyze-trace.mjs <path/to/trace.json.gz>

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const tracePath = process.argv[2];
if (!tracePath) {
  console.error('Usage: node scripts/analyze-trace.mjs <trace.json.gz>');
  process.exit(1);
}

console.error(`[analyze] reading ${tracePath} ...`);
const gz = fs.readFileSync(tracePath);
const raw = zlib.gunzipSync(gz);
console.error(`[analyze] decompressed: ${(raw.length / 1024 / 1024).toFixed(1)} MB`);
const trace = JSON.parse(raw.toString('utf8'));
const events = Array.isArray(trace) ? trace : trace.traceEvents;
console.error(`[analyze] events: ${events.length.toLocaleString()}`);

// ── Long tasks ────────────────────────────────────────────────────────────
const longTasks = events
  .filter(e => e.name === 'RunTask' && e.dur != null && e.dur > 16000)
  .map(e => ({ ts: e.ts, durMs: e.dur / 1000 }))
  .sort((a, b) => b.durMs - a.durMs);

// ── Style / Layout events (forced-recalc indicators) ──────────────────────
const styleEvents = events.filter(e =>
  e.name === 'UpdateLayoutTree' || e.name === 'RecalculateStyles' || e.name === 'Layout'
);
const styleTotal = styleEvents.reduce((s, e) => s + (e.dur || 0), 0);
const styleByName = {};
for (const e of styleEvents) {
  styleByName[e.name] = (styleByName[e.name] || 0) + (e.dur || 0);
}

// ── JS function calls (FunctionCall + ProfileChunk samples) ───────────────
// Look for karaoke-related and rAF stuff in FunctionCall events.
const fnCalls = events.filter(e => e.name === 'FunctionCall' && e.args && e.args.data);
const karaokeFnCalls = fnCalls.filter(e => {
  const u = e.args.data.url || '';
  return u.includes('karaoke') || u.includes('player');
});
const fnByUrl = {};
for (const e of karaokeFnCalls) {
  const u = e.args.data.url || '';
  const fn = e.args.data.functionName || '<anon>';
  const key = `${path.basename(u)} :: ${fn}`;
  if (!fnByUrl[key]) fnByUrl[key] = { count: 0, totalDur: 0 };
  fnByUrl[key].count += 1;
  fnByUrl[key].totalDur += (e.dur || 0);
}

// ── CPU profile chunks (the V8 sampler) ───────────────────────────────────
// Aggregate self-time per node name across all ProfileChunk events.
const profileChunks = events.filter(e => e.name === 'ProfileChunk' && e.args && e.args.data && e.args.data.cpuProfile);
const nodeHits = {}; // nodeId -> hitCount
const nodeMeta = {}; // nodeId -> { fn, url, lineNumber }
for (const ch of profileChunks) {
  const cp = ch.args.data.cpuProfile;
  if (cp.nodes) {
    for (const n of cp.nodes) {
      const cf = n.callFrame || {};
      nodeMeta[n.id] = {
        fn: cf.functionName || '<anon>',
        url: cf.url || '',
        line: cf.lineNumber || -1,
      };
    }
  }
  if (cp.samples) {
    for (const id of cp.samples) {
      nodeHits[id] = (nodeHits[id] || 0) + 1;
    }
  }
}

// Pull karaoke/player + interesting native nodes
const karaokeHits = Object.entries(nodeHits)
  .map(([id, hits]) => ({ id, hits, ...nodeMeta[id] }))
  .filter(n => n && n.url && (n.url.includes('karaoke') || n.url.includes('player')))
  .sort((a, b) => b.hits - a.hits)
  .slice(0, 30);

const topAllHits = Object.entries(nodeHits)
  .map(([id, hits]) => ({ id, hits, ...nodeMeta[id] }))
  .filter(n => n && n.fn)
  .sort((a, b) => b.hits - a.hits)
  .slice(0, 30);

// ── Output as markdown ─────────────────────────────────────────────────────
const out = [];
out.push('# Trace analysis');
out.push('');
out.push(`File: \`${path.basename(tracePath)}\``);
out.push(`Events: ${events.length.toLocaleString()}`);
out.push('');

out.push('## Long tasks (>16ms = missed frame)');
out.push('');
out.push(`Total long tasks: **${longTasks.length}**`);
if (longTasks.length) {
  out.push('');
  out.push('| Duration (ms) | ts (μs) |');
  out.push('|---:|---:|');
  for (const t of longTasks.slice(0, 20)) {
    out.push(`| ${t.durMs.toFixed(1)} | ${t.ts} |`);
  }
}
out.push('');

out.push('## Style + Layout cost');
out.push('');
out.push(`Total style/layout time: **${(styleTotal / 1000).toFixed(1)} ms** across ${styleEvents.length} events`);
out.push('');
out.push('| Event | Total ms | Count |');
out.push('|---|---:|---:|');
for (const [name, dur] of Object.entries(styleByName).sort((a, b) => b[1] - a[1])) {
  const count = styleEvents.filter(e => e.name === name).length;
  out.push(`| ${name} | ${(dur / 1000).toFixed(1)} | ${count} |`);
}
out.push('');

out.push('## CPU sampler — top karaoke/player nodes (by sample hits)');
out.push('');
out.push(`Total profile chunks: ${profileChunks.length}`);
if (karaokeHits.length) {
  out.push('');
  out.push('| Hits | Function | File:Line |');
  out.push('|---:|---|---|');
  for (const n of karaokeHits) {
    const file = path.basename(n.url || '<unknown>');
    out.push(`| ${n.hits} | \`${n.fn}\` | ${file}:${n.line} |`);
  }
}
out.push('');

out.push('## CPU sampler — top 30 nodes overall (any file)');
out.push('');
out.push('| Hits | Function | File |');
out.push('|---:|---|---|');
for (const n of topAllHits) {
  const file = n.url ? path.basename(n.url) : '(native)';
  out.push(`| ${n.hits} | \`${n.fn || '(idle/native)'}\` | ${file} |`);
}
out.push('');

out.push('## Karaoke/player FunctionCall events');
out.push('');
const fnRows = Object.entries(fnByUrl).sort((a, b) => b[1].totalDur - a[1].totalDur).slice(0, 20);
if (fnRows.length) {
  out.push('| Total ms | Calls | File :: Function |');
  out.push('|---:|---:|---|');
  for (const [k, v] of fnRows) {
    out.push(`| ${(v.totalDur / 1000).toFixed(1)} | ${v.count} | ${k} |`);
  }
} else {
  out.push('_(no FunctionCall events tagged with karaoke/player URLs — sampler data above is the source of truth)_');
}
out.push('');

const reportPath = tracePath.replace(/\.json\.gz$/i, '-analysis.md');
fs.writeFileSync(reportPath, out.join('\n'), 'utf8');
console.error(`[analyze] wrote ${reportPath}`);
