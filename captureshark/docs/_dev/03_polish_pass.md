# Polish-pass backlog

**Last updated:** 2026-05-23 — refreshed `ReviewCard.tsx` → `LeadReviewCard.tsx` path refs and removed dead `AgentRibbon` content from §6 (no-panel migration killed those surfaces).

Things noted during the build that we deliberately deferred to a polish
pass instead of fixing mid-flight. Don't ship v1 without working
through this list.

The backlog is **for the polish pass after the core capture loop
ships** — i.e. when steps 1–8 are stable enough that layout work
won't get redone three times. Currently parking-lot for items that
keep coming up while we ship feature steps 5d → 6 → 7 → 8.

---

## 1. Sign-in panel — no-scroll layout

**Where:** [`frontend/src/features/auth/SignInPanel.tsx`](../../frontend/src/features/auth/SignInPanel.tsx) +
[`frontend/src/features/review/LeadReviewCard.tsx`](../../frontend/src/features/review/LeadReviewCard.tsx)

**What's wrong now:** When the inline sign-in panel appears (because
the user tapped Save without a session, or skipped the Drive consent
checkbox), it stacks **below** the extracted-fields card. On a small
phone viewport (the 75-year-old broker bar), the page goes vertical
and the sign-in button can fall below the fold. That violates the
spec's "no scroll for primary state" + "one decision at a time" rules.

**Fix:** When `save.kind === "needs-auth"`, collapse the extracted-fields
card into a one-line recap header (e.g. *"Maria, 555-0192, Maple St"* —
non-empty fields concatenated, with confidence labels stripped). The
sign-in panel then becomes the only real focal area on screen, while
the recap line keeps the user oriented about what they're saving.

**Acceptance bar:** the entire screen (header + recap + sign-in panel)
fits above the fold on a 360 × 640 viewport (typical small Android
phone) without scrolling.

**Logged by:** project owner (2026-05-08), explicitly asked to
remember and ship before v1.

**Update (2026-05-09):** The capture flow now lives on the cream
canvas (no more fixed-size CaptureSheet). Body overflow is locked, no
page scroll. But the underlying need still applies INSIDE the review
phase: when the sign-in panel renders, the extracted fields above it
can push the sign-in button below the visible area. Original
recap-line fix still applies; just scope it to the
sheet's `review` phase rather than the full page.

---

## 2. Friendly date format — strip leading zeros — ✅ RESOLVED 2026-05-10

**Status:** landed via §2 of the v2 cleanup pass (commit `14a1eb1`).
See [`docs/_logs/2026-05-10_review_cleanup_plan_v2.md` §2](../_logs/2026-05-10_review_cleanup_plan_v2.md).

**What was done:** the duplicated `_format_captured_at` helper was
collapsed into one public `format_captured_at(dt)` in
[`domain/column_mapping.py`](../../backend/src/captureshark/domain/column_mapping.py),
imported by [`adapters/_sheets_row_format.py`](../../backend/src/captureshark/adapters/_sheets_row_format.py).
The dead-code zero-strip hack was deleted (the slice bound was wrong
*and* the regex targeted the hour zero, not the day zero — two layers
of wrong); replaced with explicit construction:

```python
hour_12 = dt.hour % 12 or 12
return f"{dt.strftime('%b')} {dt.day}, {hour_12}:{dt.minute:02d} {dt.strftime('%p')}"
```

The cleanup pass also added the timezone fix as part of §2: the
formatted cell now reads in the broker's local time (via a `client_tz`
field auto-attached by the frontend), not the server's UTC. New dep:
`tzdata>=2024.2` (Windows + minimal-Linux-container fix for Python's
`zoneinfo`).

**Tests:** `test_project_auto_stamps_date_captured_and_source_columns`
in [`tests/unit/test_column_mapping.py`](../../backend/tests/unit/test_column_mapping.py)
now asserts the right answer (`"May 9, 2:30 PM"`); 8 boundary-case
tests added (midnight, noon, single-digit hour/day, two-zone
formatting, etc.). New `test_date_helpers.py` covers the
`localise_captured_at` service helper and its unrecognised-tz log
branch.

---

## 3. Auto-mapping miss for "Area" → log + extend synonyms

**Where:** [`backend/src/captureshark/domain/column_mapping.py`](../../backend/src/captureshark/domain/column_mapping.py)
(`_SYNONYMS`)

**What's wrong now:** During a browser smoke-test (2026-05-09), `Area` (canonical
sheet header) didn't auto-map to `LeadField.AREA` even though `"area"`
IS in the synonym table. Cause unknown — `_normalise("area")` should
produce `"area"` which is a tuple member. Worth investigating with a
unit test that explicitly feeds the dev-sheet header set; might be a
data-shape issue (whitespace, hidden characters) we missed in the
proposal pipeline.

**Fix:**
1. Add a unit test that pins the exact dev-sheet header list against
   the expected mapping. If it passes, the original miss was a stale
   client-side cache — file the close.
2. If it fails, trace the normalisation. Likely culprit: the live
   sheet has a non-printing character or a different "area" header.
3. While there, audit the `_SYNONYMS` table against real-world
   sheets we've seen. Add anything missing.

**Logged by:** project owner (2026-05-09) during a smoke-test —
caught by Fix-one (which is exactly why Fix-one exists), so it's a
quality-of-auto-mapping issue, not a correctness one.

---

## 4. Pre-existing test_sheets.py failures — STILL OPEN

**Where:** [`backend/tests/integration/test_sheets.py`](../../backend/tests/integration/test_sheets.py)

**What's wrong now:** Two integration tests fail on clean main and
have since before the cream-canvas migration started:
- `test_save_returns_target` — expects `_TARGET.display_name = "Open House Leads"`
  but the live env (`DEV_TEST_SHEET_NAME=CaptureShark Dev Leads`) flows
  through to the response. Test was written against an older fixture.
- `test_permission_denied_maps_to_403_with_friendly_copy` — the test
  hits the dev fallback path (200) instead of the user-OAuth path
  (which would 403). Test was written against an older shape of
  `/sheets/append`.

**Fix:** Either update the tests to assert the current shape, or pin
the env via `app.dependency_overrides` so the tests don't depend on
`.env` state. Likely both — fixtures should be hermetic.

**Logged by:** noticed during a CI sweep (2026-05-09). Skipped
intentionally — they were broken before any of the recent slices and
fixing them is out of scope for the work that surfaced them.

**Update (2026-05-10, after the v2 cleanup pass):** still red on
`main` (commit `b953fcf`) — backend pytest reports 130 passed, 2
failed; the 2 failed are still these. Tracked in
[`docs/_logs/PROGRESS.md`](../_logs/PROGRESS.md) and the v2 plan's
"baseline" note. Fix when next time someone touches this area or as
a dedicated polish slice.

---

## 5. "Cancel" button on the AlternativesPicker isn't great

**Where:** [`frontend/src/features/sheets/MappingConfirmation.tsx`](../../frontend/src/features/sheets/MappingConfirmation.tsx)
(`AlternativesPicker`)

**What's wrong now:** Pressing the same row again already collapses
the inline picker (the row button toggles `fixingField`). The explicit
"Cancel" link inside the picker is therefore redundant and adds visual
weight to a quiet UX. Also: there's no escape-key handler to dismiss.

**Fix:** Drop the Cancel link. Add an `Escape` keydown listener on the
picker so keyboard users can dismiss without clicking.

**Logged by:** post-5d review (2026-05-09).

---

## 6. Personalised review-phase heading — multi-row case

**Where:** [`frontend/src/features/review/LeadReviewCard.tsx`](../../frontend/src/features/review/LeadReviewCard.tsx)
+ [`frontend/src/features/review/PhotoSummaryCard.tsx`](../../frontend/src/features/review/PhotoSummaryCard.tsx)

**Status:** **Single-row case landed 2026-05-09 on the legacy
ReviewCard, then ported to the cream canvas during the no-panel
migration.** The folded `AgentRibbon` corner flag and the
"EXTRACTING/EXTRACTED → first name → budget" 2-line stack are no
longer the current visual — the cream canvas uses a single "Lead"
hero plus inline FREE/AGENT pills inside `LeadReviewCard`.

**What's still pending:** the **multi-row photo case**. When a
sign-in-sheet photo produces N rows, the summary heading should
read like *"Found 20 records · 12 read clearly · 4 need attention
· 2 not readable."* The current heading only handles the single-lead
shape; the multi-row branch needs to read from
`PhotoSummaryCard`'s row list and surface those counts in the
heading instead.

**Logged by:** project owner (2026-05-09). Single-row half closed
out; multi-row half left open until someone wires the count summary
from PhotoSummaryCard up into the heading.

---

## 7. Persistent header — "Saving to: [Sheet]" with Change/Disconnect

**Where:** new component, likely `frontend/src/components/AppHeader.tsx`,
mounted at the top of [`App.canvas.tsx`](../../frontend/src/App.canvas.tsx)
above the home / capture flow.

**What's wrong now:** there's no in-app way for a returning user to
switch which sheet captures land in. They can disconnect via signing
out + back in, but that's heavy and unintuitive. Also no surface for
"who am I signed in as" — a 75-year-old broker who shares a phone
with a spouse needs to be able to tell.

**Fix (per spec §5):** thin persistent header at the very top of the
app, always visible:
- Left: small CaptureShark logo / wordmark.
- Right: **"Saving to: [Sheet name]"** as plain text. Tap → small
  panel slides in with three options: **Change sheet** ·
  **Disconnect** · **About**.
- If no sheet connected yet, the right slot reads *"No sheet
  connected yet"* (not tappable as a setup; setup happens at Save
  time per spec §3).

**Acceptance bar:** a returning user signed in to one sheet can
swap to a different sheet in two taps, without losing any unsaved
captures.

**Update (2026-05-10):** the home-screen connected-sheet UI was
slimmed down to a single quiet text-link (sheet name + ↗) that
opens the sheet in a new tab. The earlier *Use a different sheet*
button was removed — too noisy, and the "switch sheet" affordance
belongs in user settings (when those exist) or in this persistent
header itself. Net effect: this whole item is still open. Change /
Disconnect / About all live here when we ship it.

**Logged by:** project owner (2026-05-10) after noticing the gap on
their own returning-user flow. Defer until the core capture loop
is done; it's a session-management surface, not a capture-flow
blocker.

---

## 8. Pre-existing lint baseline in App.canvas.tsx — ✅ RESOLVED 2026-05-22

Cleared. 10 ESLint errors gone:
- 6 dead defensive checks against TypeScript's view of the types
  (`navigator.mediaDevices` is always defined, `photoRows[index]`
  from a verified index is never undefined, `rows[0]` after a
  `rows.length === 1` check is never undefined).
- 3 inline-onClick / onChange arrow shorthands wrapped in braces
  to satisfy `no-confusing-void-expression`.
- Unused `_contentType` parameter dropped from `handlePhotoCaptured`
  (the callback was wider than the consumer needed).

App.canvas.tsx now lints clean.

---

## 9. Cross-browser pager validation — ✅ RESOLVED 2026-05-22

Pager verified on iPhone during the no-panel migration and on
Samsung Galaxy via the owner's friend on 2026-05-22 (no lag —
the earlier S22/S23 lag report was on the reference clone, not
the shipped pager). Subtle Embla snap-settle lag on iPhone was
already accepted during the migration's lag-consultation pass.

Firefox / Samsung Internet / iPad / Android tablet aren't
explicitly verified yet but the two real-world devices used in
practice (iPhone Safari + Samsung Chrome) are both clean. Treat
this entry as closed unless a new lag report surfaces.

---

## 10. Tooling folder cleanup — `scripts/`, `backend/scripts/`, `logs/` — ✅ RESOLVED 2026-05-22

Owner-approved consolidation: research harnesses all land under
`docs/_tests/` (symmetry with the existing `photo_capture_bakeoff/`).
`scripts/` shrinks to ONLY the git-hooks tooling.

**What landed:**

1. **`scripts/git-hooks/`** → **`.githooks/`** (2026-05-23, second
   pass). Owner asked why `scripts/` was still hanging around alone
   with only `git-hooks/` inside. Moved to the standard `.githooks/`
   convention; the shell wrapper's hardcoded path + Claude Code's
   PreToolUse guard command both updated, and `.git/hooks/pre-commit`
   re-installed from the new source. `scripts/` removed entirely.
2. **`scripts/stt-bakeoff/`** → **`docs/_tests/stt_bakeoff/`** (whole
   harness + providers + vendor-docs + samples). Kept as quarterly
   vendor-swap insurance.
3. **`backend/scripts/vision_bakeoff/`** → **`docs/_tests/vision_bakeoff/`**.
4. **`backend/scripts/prompt_consult{,_round2,_round3}.py`** +
   **`prompt_eval.py`** + **`prompt_eval_results/`** →
   **`docs/_tests/prompt_eval/`**.
5. **`backend/scripts/`** removed entirely (only `__init__.py` +
   `__pycache__/` left, both deleted).
6. **`logs/captureshark.log`** — stale 264-byte dev startup log,
   deleted. `logs/` dir itself stays (still gitignored, uvicorn
   writes there during local dev).

**Code/path updates that came along for the ride:**
- `prompt_eval.py` REPO_ROOT bumped `parents[2]` → `parents[3]`.
- `stt_bakeoff/bakeoff.py` `_ROOT` bumped `parents[2]` → `parents[3]`.
- `.githooks/agent-territories.json` — `photo` agent's exclusive
  path now points at `docs/_tests/vision_bakeoff/`.
- `.gitignore` — vision data/results paths re-rooted; added a
  rule for the prompt-eval results cache.
- Production code comments (3 backend adapters + 1 frontend ts
  module) refreshed to the new paths.
- Workflow docs (`07`, `08`, `09`), `_spec/live_captions.md`,
  `09_TODO.md`, `_tables/README.md`, internal moved-folder READMEs &
  comments — all path refs refreshed.
- Historical eval records under `docs/_tests/photo_capture_bakeoff/
  sessions/*/` and `docs/_tests/prompt_eval/prompt_eval_results/`
  left as-is (frozen-in-time snapshots — rewriting them would
  rewrite history).

**Net effect:** repo root now reads as `backend/` `frontend/`
`docs/` `logs/` plus the standard hidden dirs (`.git/`, `.githooks/`,
`.claude/`) — no more research / tooling clutter alongside app
code.

---

(Add new items below as we find them.)
