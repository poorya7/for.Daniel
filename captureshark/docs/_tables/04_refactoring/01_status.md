# Refactoring punch list — status snapshot

Status as of 2026-05-23 (end of session 4). The May 2026 refactor / cleanup punch list, in the order each phase was actually tackled. One short sentence per phase, plain English.

| # | What changed | Done? |
|---|---|---|
| 1 | Checked how big the app is to download — needed to know this number before adding anything new | yes |
| 2 | When you type or speak a lead and tap Save, the lead is saved on your phone right away — so you don't lose it if signal drops a second later | yes |
| 3 | The check that decides whether you need to sign in now lives in one place — it used to be copy-pasted in two places, which is a recipe for bugs later | yes |
| 4 | When you tap Save All on a photo, all the rows are saved on your phone at the same moment — so if signal drops halfway through, you don't lose any of them | yes |
| 5 | Take a photo with zero signal — the photo is kept on your phone safely until signal comes back | yes |
| 6 | Got rid of old code that used to throw away most of the rows from a photo and keep just one — that whole problem is gone | yes |
| 7 | Threw out old code that was never used in the app — makes the app a little smaller to download | yes |
| 8 | Only one part of the app cleans up extra spaces around what you type now — used to be two places, which could cause weird bugs like a space at the start of a name | yes |
| 9 | Typing in a field on one review page no longer makes the other pages refresh themselves — typing feels faster on slow phones | yes |
| 10 | Moved all the photo-taking code into its own file — it was crammed into one huge file before. Nothing changes for you, but it's easier and safer to work on | yes |
| 11 | Cleaning up how the app keeps track of which screen you're on — nothing changes for you, but adding new screens later will be much easier | yes |

All 11 phases done. App.canvas.tsx 1489 → 805 lines (-46%). 234 tests green.
