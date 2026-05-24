# Start here — new-session onboarding

You're a Claude agent starting a session on CaptureShark. **Read
the three files below in order, then stop and wait for the owner to
tell you the task.** Do not pre-load anything else — you'll open
task-specific docs only as the work touches them.

If you skip any of these three, the owner WILL have to repeat
instructions, which has caused real session-ending frustration in
the past. Treat the list as non-negotiable.

## Read first — every session, in this order

1. **[`_workflow/01_PROJECT_RULES.md`](_workflow/01_PROJECT_RULES.md)** —
   How to collaborate with the owner. The single most important
   file in the repo. What needs explicit confirmation, the
   communication style (ADHD-friendly, no walls of text, no
   grovelling apologies), the 1–2-tool-call check-in cadence, the
   `🚨 PROD/UX CHANGE` ask format.

2. **[`_workflow/01b_multi-agent-git-setup.md`](_workflow/01b_multi-agent-git-setup.md)** —
   How `git` works on this repo. Multiple agents may share one
   local checkout of `main`; bare `git commit` sweeps in another
   agent's staged work. Explains the territory split + the
   pre-commit hook install. **Mandatory before you run any `git`
   command, ever.**

3. **[`_workflow/02_PRINCIPLES.md`](_workflow/02_PRINCIPLES.md)** —
   The persistent product principles. Persona (Linda — a
   75-year-old broker on a slow phone with bad signal), ASMR feel,
   above-the-fold rule, one decision at a time, plain English,
   old-phone perf bar. Every spec in the repo defers to this.

**After those three, wait.** Don't open anything else until the
owner names the task.

## Also live before the first message

You also have a per-project auto-memory directory outside the repo
at
`C:\Users\<you>\.claude\projects\D--misc-c0de-cursor-CaptureShark\memory\`.
`MEMORY.md` there is auto-loaded into your context at session
start and indexes durable feedback rules + project facts learned
across sessions. Trust those rules — they exist because something
hurt. Save new ones when a lesson clearly carries forward.

## Open ONLY when the task touches that area

| Folder | When to open it |
|---|---|
| [`_dev/`](_dev/) | Touching code — setup, deploy checklist, repo-wide pitfalls, polish backlog, TODO, BUGS, test pages, photo-model bakeoff history. Has its own [`00_README.md`](_dev/00_README.md) index. |
| [`_spec/`](_spec/) | Durable architecture references for the subsystems that need them — [`photo_capture.md`](_spec/photo_capture.md) (vision contract + camera lifecycle), [`live_captions.md`](_spec/live_captions.md) (AssemblyAI streaming pipeline), and [`dismiss_flow.md`](_spec/dismiss_flow.md) (Dialog primitive + per-phase backdrop-tap policy + inner-dismiss escape hatch). Product/UX rules live in [`_workflow/02_PRINCIPLES.md`](_workflow/02_PRINCIPLES.md). The offline-queue subsystem is documented by its code + tests under `frontend/src/lib/queue/` plus the "never lose Linda's data" principle. |
| [`_tests/`](_tests/) | Touching research / bakeoff harnesses (photo, vision, STT, prompt-eval) or sample-input fixtures. |
| [`_tables/`](_tables/) | Writing a status snapshot, progress checkpoint, or eval-result table for the owner's phone. See its [`README.md`](_tables/README.md) for the chronological-numbering rules. |
| [`_brand/`](_brand/) | Touching wordmarks or shark-family reference art. |
| [`_marketing/`](_marketing/) | Marketing-side copy / assets. |

## If you can't find what you need

Search the repo before guessing — `grep` / `Glob`. The owner has
been burned multiple times by agents inventing file paths that
don't exist.
