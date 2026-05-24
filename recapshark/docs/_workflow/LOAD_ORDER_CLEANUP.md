# Load-order cleanup (post-review tracking doc)

Findings from the 2026-05-11 review of the paste-to-video-page load order (orchestrator + pipeline + lazy karaoke first-chunk warm). All bugs in this list cluster around the karaoke-warm ↔ chunk-loader interface; the non-karaoke parts (subs / meta / summary / chapters streaming, rewind choreography, subsequent-paste fade) reviewed clean.

All fixes here are **pure refactor / dedup — zero user-visible change today**. The risk these bugs guard against is: if anyone touches the chunk-grid or short-video threshold in the future, things break silently from the user's perspective.

---

## Bugs — what the user would see if not fixed

- **Bug 1 — Hardcoded `600` (warm first-chunk size) in two places.** If anyone reverts the first chunk to a smaller size (the chunk-loader is built to allow this in one line), the warm path keeps sending `dur=600` while the player sends e.g. `dur=300`. From the user's side: karaoke shows up much later on the very first play (the 30-second pre-warm latency hide collapses; both calls bill AsrProvider separately, no single-flight dedup). Worst case, a cap_hit toast appears for the player's call even though the warm already succeeded.

- **Bug 2 — Hardcoded `300` (short-video threshold) in two places.** If anyone changes the short-video cutoff in one place but not the other, mid-length videos go to one endpoint via warm and a different endpoint via the player. User sees: karaoke stutters in late (or doesn't appear at all on some videos) because the two responses don't share a cache, and on long-ish videos the warm hits a server-side 300s validator and fails outright — the player has to start from scratch when they press play.

- **Bug 3 — Stale comment "dual-size grid (60s first chunk + 300s steady)".** User sees nothing. Risk is a future bug: an agent reads the comment, trusts it, and writes code against a 60s first chunk that doesn't exist. Result later = mystery karaoke timing bug nobody can trace.

- **Bug 4 — Stale comment "uniform 300s grid".** Same as Bug 3 — invisible to users, but a tripwire for future agents trying to reason about chunk math.

- **Bug 5 — Warm fires on `<10s` videos too.** User sees nothing. Tiny waste: each `<10s` paste fires one unnecessary AsrProvider call that the player would have made ~1 second later anyway. Pennies of cost per video and a small bit of unnecessary load on the backend; not a real user-impact item.

- **Bug 6 — Dead `isMobile` branch in karaoke lookahead init.** User sees nothing. Both branches return `-150`, so the ternary is a no-op. Pure dev-confusion: a reader thinks the code does platform-specific tuning and goes hunting for behavior that isn't there.

---

## Plan

### Bundle 1 — dedup constants + fix stale comments (Bugs 1–4) — ✅ DONE 2026-05-11
- [x] Promoted `FIRST_CHUNK_DUR` + `STEADY_CHUNK_DUR` + `SHORT_VIDEO_THRESHOLD_SEC` from `_debugInternals`-only to proper module exports on `KaraokeChunkLoader`.
- [x] Imported them in `process-url-fetch.js`, dropped magic `600` and `300` (code + comment).
- [x] Fixed both stale comments in `karaoke-chunk-loader.js` ("dual-size grid" → "uniform 600s grid"; "300s grid" → "600s grid").
- [x] `npm run check:chunk-grid` → OK. `npm run build` → clean.
- [ ] User smoke test: paste a short video + long video on local + confirm karaoke arrives normally.

Estimate: ~20 LOC, one commit.

### Bundle 2 — skip warm on `<10s` videos (Bug 5) — ✅ DONE 2026-05-11
- [x] Guard `if (durationSec < _WARM_MIN_DURATION_SEC) return;` added in `warmKaraokeFirstChunk` (with named constant `_WARM_MIN_DURATION_SEC = 10`).
- [ ] User smoke test: paste a `<10s` video; karaoke should still appear on play (via the player's short-video bypass).

### Bundle 3 — drop dead `isMobile` branch (Bug 6) — ✅ DONE 2026-05-11
- [x] Simplified `_initHighlightLookahead` to `return -150`; `?karaoke_lookahead=N` override path preserved.

---

## Verification

Before / after each bundle, paste these URLs and confirm karaoke arrives normally:

- Short: `https://youtu.be/qADTr7d6gMU` (any short video)
- Long: a 2h+ podcast video
- `<10s` video (after Bundle 2): warm should NOT fire; chunk-loader's short-video bypass should pick up at play-time

---

## Status

2026-05-11 — review done, bug list re-framed for user-impact, plan drafted.
2026-05-11 — Bundle 1 landed (Bugs 1–4). Chunk-grid check + Vite build pass.
2026-05-11 — Bundles 2 + 3 landed (Bugs 5–6). Vite build pass.
2026-05-11 — mobile smoke test green. Committed `9e1a056` + pushed to main, deployed to droplet (frontend rebuild, no pm2 restart since no backend changes).
2026-05-11 — follow-up doc sweep: corrected stale "dual-size grid" / "300s grid" references in `01_ARCHITECTURE.md` + `pipeline/karaoke/routes.py`. CHANGELOG.md entry added. **Cleanup complete.**
