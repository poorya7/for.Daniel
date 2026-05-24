# Tables — mobile-friendly markdown for owner's phone-side triage

This folder is **the one place** for every "give me a markdown table
I can open on GitHub mobile" file in the project. Used to live as two
parallel folders (`docs/reports/` for eval-style numbers, `docs/_status/`
for progress / status snapshots) — that split was a mistake the owner
flagged on 2026-05-17, and both have been folded in here.

## Why this folder exists

The owner does most of his triage on his phone. Long markdown tables
don't render in the Claude Code chat UI on mobile, so they live here
as their own little markdown files — GitHub mobile and Safari →
github.com both render them cleanly. The URLs survive across
sessions and previous tables stay around if he wants to compare.

## How this folder is organised

Everything is grouped by **topic** in sub-folders so the file list
stays readable as new tables land. Two layers of chronological
numbering — highest number = newest at each layer:

- **Sub-folders** are numbered by the order they were created
  (`01_photo_extraction/`, `02_photo_capture/`, ...). When a new
  topic appears, it gets the next number up. The owner can scan
  the folder list on mobile and the highest number = the
  most recently introduced topic.
- **Files inside each sub-folder** are also numbered (`01_`,
  `02_`, ...) — chronological within the topic. Highest number =
  the latest table on that topic.

| Sub-folder | What's in here |
|---|---|
| [`01_photo_extraction/`](01_photo_extraction/) | Prompt-eval headline reports for the photo capture flow (sessions 04 → latest). Each report measures one change to the system prompt / model settings / image-shrink config and compares it to the previous baseline. |
| [`02_photo_capture/`](02_photo_capture/) | Status checkpoints for the photo capture flow (Slice A → E, plus future polish work). Point-in-time "where are we" snapshots. |
| [`03_no_panel_migration/`](03_no_panel_migration/) | Status snapshots for the no-panel migration (canvas replacing the legacy `CaptureSheet`). One row per migration phase, plus next-up + parked items. |

## Adding a new table

1. Decide which sub-folder it belongs in. If the work doesn't fit
   any existing one, create a NEW sub-folder. Look at the existing
   sub-folder names, find the highest folder number, and use the
   next number up: `NN_short_descriptive_name/` (snake_case).
2. Inside the chosen sub-folder, find the highest-numbered file.
   Your new table is the next number up.
3. Filename pattern: `NN_short_descriptive_name.md`. The name
   should make it obvious what the table covers so the owner can
   spot the right one without opening each.
4. Keep the file itself short and table-friendly. Phone reading is
   the bar. The deep-dive version of the work (briefs, methodology,
   raw data, etc.) lives elsewhere — typically the matching
   session folder under `docs/_tests/`.

## What goes in each file

Both flavours of table (eval reports + status snapshots) follow the
same lightweight shape:

- One short paragraph at the top explaining what the file covers +
  the date + the slice / feature it's about.
- The table itself — plain English columns, no code names.
- (Optional) A "where we are right now" sentence at the bottom.

## What does NOT go in here

- Long-form planning, design discussions, architecture writeups
  (those live in `docs/_spec/`).
- Eval result CSVs + raw responses (those land in
  `docs/_tests/prompt_eval/prompt_eval_results/<timestamp>/` and are
  gitignored — too big / too ephemeral to commit). The mobile-
  friendly summaries here capture the topline numbers.
- Permanent reference material (lives in feature folders).

Tables here are inherently point-in-time. They go stale fast. The
authoritative source for "what's actually shipped" stays the
relevant feature's `03_PROGRESS.md` or equivalent.
