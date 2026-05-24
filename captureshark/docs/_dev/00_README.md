# Code-side docs — start here

**Last updated:** 2026-05-23 — added row for `12_testing.md` (unit-test convention now explicit); previously added `11_caps_and_costs.md`; refreshed cross-ref to pitfalls 22–26 after the May 2026 refactor cleanup.

Everything about the **codebase itself**: dev setup, deploy
checklist, gotchas across the repo, feature-decision history, the
polish-pass backlog, and the test-pages registry. Pure
"collaboration / how we work" docs live next door in
[`docs/_workflow/`](../_workflow/). Product principles live at
[`docs/_workflow/02_PRINCIPLES.md`](../_workflow/02_PRINCIPLES.md).

## Read when the task touches that area

Do **not** read these up-front. Open the one that matches what
you're about to do.

| # | File | Open when… |
|---|------|------------|
| 01 | [`01_sheets-dev-setup.md`](01_sheets-dev-setup.md) | Touching the service-account Sheets write path (the dev save path for smoke tests; real users go through `02_google-oauth-setup.md`). |
| 02 | [`02_google-oauth-setup.md`](02_google-oauth-setup.md) | Touching the real-user Google OAuth sign-in flow. |
| 03 | [`03_polish_pass.md`](03_polish_pass.md) | Working through the deferred polish backlog before v1 ship. |
| 04 | [`04_local-dev-setup.md`](04_local-dev-setup.md) | First time running the stack locally — ports, startup commands, Cloudflare Tunnel, gotchas. |
| 05 | [`05_agent-pitfalls.md`](05_agent-pitfalls.md) | Before any photo / voice / live-captions change. Items 22–26 specifically if touching photo capture. |
| 06 | [`06_read-before-deploy.md`](06_read-before-deploy.md) | About to deploy to staging or production. |
| 07 | [`07_photo-model-bakeoff.md`](07_photo-model-bakeoff.md) | Touching photo capture / picking a vision provider. Current state lives in [`docs/_spec/photo_capture.md`](../_spec/photo_capture.md). |
| 08 | [`08_test-pages.md`](08_test-pages.md) | Adding, removing, or dialling in a standalone scratchpad page (`/extracting-shell`, `/sim`, etc.). |
| 09 | [`09_TODO.md`](09_TODO.md) | Long-tail "nice to have / maybe one day" ideas. Promote out of here into the polish pass when one becomes must-fix. |
| 10 | [`10_BUGS.md`](10_BUGS.md) | Open bug tracker. |
| 11 | [`11_caps_and_costs.md`](11_caps_and_costs.md) | What we spend, what's capped, pre-launch checklist. Read before any deploy that opens to real traffic. |
| 12 | [`12_testing.md`](12_testing.md) | Adding logic (a reducer, hook, lib module). What we test, what we don't, where tests live, how to run them. |

## How this folder is laid out

* Numeric prefixes (`01_`, `02_`, …) match the order they'd
  naturally come up across a project lifecycle (setup → polish →
  deploy → feature deep-dives).
* Cross-references between docs use the numbered filenames; if you
  add a doc, slot it in and update this index.
* Renaming a doc? Update its references too — `grep` catches
  in-repo callsites.

## Neighbouring folders

* [`docs/_workflow/`](../_workflow/) — collaboration / comms rules.
  Read these at session start, every session.
* [`docs/_spec/`](../_spec/) — locked product/UX spec, tech plan,
  feature deep-dives (photo capture, live captions, offline queue).
* [`docs/_tests/`](../_tests/) — research / bakeoff harnesses
  (photo, vision, STT, prompt-eval) + sample input fixtures.
