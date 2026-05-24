# Subtitle Karaoke — Progressive Lag (Open)

**Status:** open, investigated 2026-05-12, root cause hypothesized but unverified, no fix shipped yet.
**Related ticket:** [`../OPEN_BUGS.md`](../OPEN_BUGS.md) → "Mobile karaoke micro-lag" (2026-05-11). This folder is the deeper investigation handoff.

---

## Symptom

On mobile, with the **Subtitles tab** active, karaoke + auto-scroll degrade progressively during playback:
- First ~10–15s of playback: fps holds 55–60, feels smooth
- From ~15–30s onward: fps drops to 6–15 and **stays there** for the remainder of the session
- Visible result: karaoke wave stutters, scroll hiccups, jumps on row advance

The **Transcript tab** is unaffected — same code path, same JS work per frame, holds 60 fps for the entire session.

## Quantitative baseline

Both numbers below are **post-Fix-#5** (current prod after `karaoke-wave.js` integer cache):

| Metric | Transcript tab (clean) | Subtitle tab (clean) |
|---|---|---|
| `fps_avg` | 60.0 | **13.85** |
| `frame_p50_ms` | 17 | 26 |
| `frame_p95_ms` | 17 | **167** |
| `frame_max_ms` | 26 | 175 |
| `lit_avg` per frame | 22.0 | 21.1 |
| `lit_max` per frame | 43 | 43 |

**Same lit (wave) count on both tabs. Same JS work per frame. Different fps by 4–10x.** The bottleneck is NOT in the karaoke JS wave loop.

## What's been ruled out

1. **Leaked `_wordElsByKey` refs.** Diagnose dump (`diagnose-dump.txt`) shows clean state:
   - 1937 `.k-word` spans on transcript panel
   - 1936 `.k-word` spans on subtitle panel
   - `_words.length = 1896` (AsrProvider words)
   - Ratio: ~2 entries per word's key (one per panel, as expected). No accumulation of stale detached spans.

2. **Per-frame style-read on hot path (`getPropertyValue('--k')` + `toFixed(3)`).** Fix #5 (this commit on subtitle) cached the last-set value as `__lastK1000` integer on each `.k-ch` element, removing the per-frame style read + string alloc (~1260 ops/sec on the hot path).
   - Measured impact on subtitle: `fps_avg` 13.40 → 13.85. **Noise.** The opt is correct but the bottleneck is elsewhere.

3. **Doc-wide `qSA('.k-word')` in `_runLayoutInvalidate`.** Fix #1 scoped both the `__kmids = null` walk and the re-measure pass to visible rows only. Fixed continuous lag on the **transcript** tab. No effect on subtitle progressive degradation.

4. **Backend chunk endpoint slowness.** Fix #4 aligned `_PENDING_WAIT_TIMEOUT_SEC` with `_TOTAL_DEADLINE_SEC`. Unrelated to UI rendering lag — purely a same-key concurrent-request fix on the chunk endpoint. Subtitle lag persists with cached chunks.

## Leading hypothesis (untested)

**Compositor / GPU memory pressure from `will-change: transform` on a tall content layer.**

DOM-size delta between panels on a 1h video:
- Transcript panel: ~276 paragraph rows × ~80px = **~9600px tall** content
- Subtitle panel: ~1268 segment rows × ~30px = **~36000px tall** content (~4× taller)

In follow-mode, the scroll engine applies `will-change: transform` to the entire `.flat-transcript-content` container (see `flat-transcript-scroll.js` → `enterFollowMode`, line ~252):

```js
function enterFollowMode() {
  ...
  state.content.style.willChange = 'transform';
  state.content.style.transform = `translate3d(0, ${-state.y}px, 0)`;
  ...
}
```

iOS Safari is documented to allocate a composited GPU texture sized to the entire `will-change` element. Rough back-of-envelope:
- Transcript layer: 9600px × 440px × 4 bytes = ~17 MB
- Subtitle layer: 36000px × 440px × 4 bytes = **~63 MB**

The progressive-degradation symptom shape matches this hypothesis well:
- Early playback: only a few rows' worth of memory has been "touched" by `.lit` class toggles → cheap
- As playback progresses and the wave moves through more rows, more of the 63 MB texture gets paint-state changes per frame → cascading compositor work → fps tanks

The transcript tab's 17 MB layer fits comfortably in iOS compositor budget; the subtitle 63 MB layer doesn't.

## Recommended next steps

In order of preference:

### 1. Verify the hypothesis with an iOS Safari profile (requires Mac)

Connect iPhone to a Mac via USB, open Safari Web Inspector → Timeline → record a CPU profile during the degraded state on subtitles. Look for:
- High time in `Composite` or `Layer Tree` work (confirms hypothesis)
- High time in `Paint` (confirms — if growing over time)
- vs. high time in JS execution (would refute hypothesis)

Without this profile, all fixes below are educated guesses.

### 2. Virtualize the subtitle list (preferred, biggest blast radius win)

Render only the rows in the viewport (+ a small buffer of ~20 rows above/below). Replaces 1268 DOM rows with ~50 at any time. Spacer divs above/below preserve scroll position.

- Touch: `flat-transcript-render.js` `renderRows` becomes scroll-driven; `flat-transcript-scroll.js` already computes visible-row index via `findItemForTime` + `state.rows`.
- Risk: scroll feel might shift (rows mount/unmount as user scrolls); needs careful UX testing.
- Side benefit: eliminates `_kmids` re-measure cost on long videos entirely.

### 3. Scope `will-change: transform` to wave-window rows only (lighter alternative)

Instead of `will-change: transform` on the entire `.flat-transcript-content`, apply it only to the ~10 rows in the karaoke radius. The scroll's `translate3d` would still apply to the content as a whole but without the `will-change` hint, iOS doesn't pre-allocate a giant layer.

- Touch: `flat-transcript-scroll.js` `enterFollowMode` / `exitFollowMode`.
- Risk: scroll smoothness may degrade slightly (iOS will composite on-demand instead of pre-allocating).
- Smaller change than virtualization.

### 4. Throttle wave loop on subtitle tab (fallback)

If subtitle layer pressure is unavoidable, run the wave loop at 30fps instead of 60fps **only on the subtitle tab**. Halves the paint-state churn rate.

- Touch: `karaoke-wave.js` `loopTick` — add a skip-every-other-frame gate when subtitle tab is active.
- Risk: visible wave smoothness loss — not enterprise-grade quality.
- Last resort.

## Reproduction steps

URL (replace cache buster with today's date):
```
https://dev.example.com/?cb=YYYY-MM-DD&url=https://youtu.be/xLR3SaA0xTY&perf=1
```

Optional: append `&karaoke_debug=1` to get the diagnose panel.

Procedure:
1. Open URL on iPhone (or iOS Safari with mobile viewport)
2. Wait for paste to land + transcript to render
3. Tap **Subtitles** tab immediately
4. Press play; **do not switch tabs**
5. Watch fps in the `?perf=1` overlay top-right
6. Expect: fps starts ~60, degrades to ~10 within 15–30s, stays there

Test video: `xLR3SaA0xTY` (Oprah/Kristin Cabot interview, 1h02m, English). Has ~1200 subtitle segments, enough to trigger the layer-size issue.

## Relevant code paths

| File | Role for this bug |
|---|---|
| `src/js/ui/flat-transcript-scroll.js` | **Top suspect.** `enterFollowMode` line ~252 applies `will-change: transform` to the entire content layer. |
| `src/js/ui/flat-transcript-render.js` | `renderRows` builds the full 1200-row DOM upfront. Top virtualization target. |
| `src/js/ui/flat-transcript.js` | FlatTranscript orchestrator. Owns the state passed to render + scroll engines. |
| `src/js/player/karaoke-wave.js` | rAF wave loop. Confirmed NOT the bottleneck (same lit count both tabs, transcripts fine). |
| `src/js/player/karaoke-dom.js` | `applyWordSpansForActivePanel` — fires on chunk arrival, walks all rows of both panels. Possibly an amplifier but not the steady-state bottleneck. |

## Attached data

| File | What it is |
|---|---|
| `perf-baseline-subtitle.json` | Original subtitle-tab session before any fixes. fps_avg 13.4, frame_p95 186ms. |
| `perf-control-transcript.json` | Transcript-tab control session, post-Fix-#5. fps_avg 60, frame_p95 17ms. Same lit count as subtitle. |
| `perf-mixed-after-fix5.json` | Post-Fix-#5 session with tab switching during the run. Misleading averages because of mixed tabs. Kept for completeness. |
| `perf-subtitle-only-after-fix5.json` | **Conclusive test.** Post-Fix-#5, subtitle tab only, no switching. fps_avg 13.85 — proves Fix #5 had no measurable impact on this bug. |
| `diagnose-dump.txt` | `?karaoke_debug=1` Diagnose panel output during a laggy subtitle session. Used to rule out the `_wordElsByKey` leak hypothesis. |

## Fix history (none of these solved this bug)

| Fix | Commit | Did it help here? |
|---|---|---|
| #1 — Scope layout-invalidate to visible rows | `a9f340a` | No effect on subtitle progressive lag. Fixed transcript continuous lag. |
| #4 — Bump backend `_PENDING_WAIT_TIMEOUT_SEC` 30→65 | `b4f5c28` | Backend tuning; unrelated to UI rendering. |
| #5 — JS-side `__lastK1000` integer cache on `.k-ch` | _this commit's range_ | Saves ~1260 string allocs/sec on hot path. Measurable impact on subtitle: **noise** (13.4 → 13.85 fps_avg). Right pattern, wrong bottleneck. |

---

**Last updated:** 2026-05-12
