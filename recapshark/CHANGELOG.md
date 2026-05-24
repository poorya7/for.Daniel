# Changelog

Notable changes to RecapShark, grouped by phase. Started 2026-05-09 as part
of the cleanup plan; the full commit-level record lives in `git log`.

Releases are tagged `vYYYYMMDD-phase-X` post-deploy. No semver yet — single
product, no public API.

---

## [Unreleased] — May 2026

### Landing-paste flow polish (2026-05-13 → 2026-05-14)

- Yellow `PASTE YOUTUBE URL →` button replaced with a Stripe-style pill
  (white `<input>` + dark `Recap →` button). Two friends reported the old
  button's clipboard-permission popup read as a red flag and one bailed
  without trying the app.
- "Preparing your video…" bubble now updates instantly on tap instead of
  waiting for the `/api/video/meta` round-trip — previously a ~5s gap on
  cold backend that felt broken.

### No-captions videos: skip rewind, music-only placeholder fast (2026-05-13)

Pasting a captionless video used to leave the user staring at a full ~6.5s
VHS rewind, then ghost chapter skeletons forever, then a blank transcript
for ~5 more seconds. Three independent issues, fixed end-to-end:
backend signals `has_captions` from the YT Data API; frontend pipeline
short-circuits without firing `/transcript/subs` or `/summary/*`;
`setRewindMode` now refuses to re-enable rewind once `isMostlyMusic` is
true (the actual root cause, found via Playwright headless debug).

### Karaoke perf pass (2026-05-12)

Three focused tunes on the lazy-karaoke hot path:

- `_runLayoutInvalidate` scoped to visible rows — was doing a doc-wide
  `querySelectorAll('.k-word')` (10k+ spans on a 2h video) just to null a
  cache. Visible-only walk fixes continuous mobile jank on font-load /
  resize / theme events.
- `_PENDING_WAIT_TIMEOUT_SEC` aligned 30s → 65s with the audio-cache
  total deadline so a legitimate slow CDN fetch doesn't trigger a wasted
  retry round-trip.
- Per-char `--k` value integer-cached on `.k-ch` elements via
  `__lastK1000`. Replaces ~1260 string allocs + inline-style reads per
  second on the wave loop with integer compares.

### Karaoke: background backfill + partial-audio downloads (2026-05-11)

Range-fetch only the bytes needed for the requested karaoke chunk instead
of downloading the full audio upfront — first-chunk latency drops from
~15s → ~3s on long videos. Background backfill fires after the first
chunk delivers so subsequent chunks hit the local cache. On-block retry
across the residential-proxy rotation: when yt-dlp returns YouTube's
"Sign in to confirm you're not a bot" challenge, the next attempt
naturally lands on the next proxy in the rotation; `p^4` final failure
rate against a 25%-flagged pool drops to ~0.4%.

### Mobile UX (2026-05-11 → 2026-05-12)

Default mobile tab flipped from Chapters → Transcript with the matching
data-arrival lifecycle hook so the FlatTranscript panel actually
`prepare()`-s without an implicit tap. Morph cream-bg paint chain
documented across `.dashboard`, `#resultsView`, `.home-view.morph-overlay`,
`.tab-pane.active` — each layer needs cream during the home→video morph
or the next-darker ancestor shows through.

---

## [2026-05-09] — Phase 4: full cleanup CLOSED + DEPLOYED

Largest refactor cycle. Four sub-phases across loose coupling, DRY, SRP,
and `window.*` honesty:

- **4a — Loose coupling.** Karaoke star-pattern hub (`karaoke-store.js`)
  introduced as the single owner of all shared mutable state; all
  long-lived bridge refs across consumer modules stay valid across video
  swaps via in-place mutation discipline.
- **4b — DRY.** 5 commits stripping duplicated math, regex, and config.
- **4c — SRP file splits.** 5 commits: `chat.js`, `karaoke-debug.js`,
  `process-url.js`, `flat-transcript.js`, `entity-highlighter.js` each
  fanned out into focused sibling modules. `karaoke.js` slimmed 3,271 → 303 LOC
  across three sub-cycles.
- **4d — `window.*` bridge honesty.** 22 distributed bridges across 15
  modules consolidated into one block in `main.js` (53 explicit
  assignments, 5 documented exceptions).
- **4e — Backend re-audit.** Leaf modules extracted (`traffic_source.py`,
  `_session_filter.py`, `karaoke/stats.py`, `karaoke/_constants.py`),
  shared helpers de-duplicated.

## [2026-05-08] — Phase 3: CSS detox

`dashboard.css` 5929 → 2912 LOC (−51%). Extracted `font-matrix.css`,
`music-only.css`, `brutalist.css`, `mobile-layout.css`. Consolidated 3
`:root` blocks into 1. Stripped one cluster of `!important` only — the
audit's 176 candidates were overconfident; bulk deferred to a per-cluster
verification pass.

## [2026-05-08] — Phase 2: Honesty pass

Single commit covering 5 items: stale terminology (`wheel`/`cylinder`)
rewritten to current names; `.env.example` re-synced with the actual
documented env vars; stale plan-doc cross-references repointed; verified
the build strips dev-only `karaoke-debug.js` from prod; `window.*` surface
consolidated.

## [2026-05-07] — Phase 1: Security P0s

Pinned `pipeline/requirements.txt` + new `requirements-lock.txt`. Vite
sourcemap `true → 'hidden'` (Sentry still resolves stack traces; DevTools
no longer auto-fetches). Fixed a silent 403 on `/api/analytics/chat/log`
(missing token header). Owner routes JWT verification layer added —
`X-API-Token` middleware → Supabase JWT FastAPI dep. nginx CSP deployed
enforcing + `Referrer-Policy: strict-origin-when-cross-origin`.

## [2026-05-03] — Lazy karaoke shipped

The chunked karaoke pipeline went live to prod. Currently kill-switched
off in the frontend pending the user-experience launch decision.

---

## Pre-2026-05

Earlier karaoke iterations + the original mobile 3D-cylinder → flat-scroll
migration aren't backfilled here at the phase level — see `git log` for
the commit-level record.
