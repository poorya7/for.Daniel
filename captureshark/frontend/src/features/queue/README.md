# `features/queue/` — UI surfaces for the offline-resilient queue

Implements plan §8 (`docs/_spec/offline_queue.md`). Four
components, all parent-driven (the parent owns the queue runner and
threads state down):

| Component         | Spec   | Mount where                                   |
|-------------------|--------|-----------------------------------------------|
| `QueuePill`       | §8.1   | Above the home cluster, inside `HomeScreen`.  |
| `QueueListSheet`  | §8.2   | At the top of the app tree, mounted only when the pill is tapped. |
| `DrainToast`      | §8.3   | Fixed-position layer; mounted by the parent on a non-zero `DrainResult.saved`. |
| `OnlineIndicator` | §8.5   | Inline with the wordmark, inside `HomeScreen`. |

## Data flow (when App.tsx integration lands)

```
startQueueRunner() ──┐
  (lib/queue/        │   isOnline() ── useOnlineState ──► OnlineIndicator
   triggers.ts)      │   subscribeOnline()
                     │
                     └── triggerDrain() ◄─ (UI "Try now", future)

useLiveRecords() ──► summarise() ──► QueuePill { summary, syncingNow, … }
                  ─► records       ──► QueueListSheet { records, onDiscard, … }
```

Wire-up checklist for `App.tsx`:

1. At app boot, call `startQueueRunner()` once. Keep the returned
   `QueueRunner` in app state (it owns the online detector + drain
   triggers).
2. Subscribe to drain results — the runner's `triggerDrain()` returns
   a `DrainResult`; the natural place to fire `DrainToast` is wherever
   the App handles drain side-effects. The drainer emits no event of
   its own today, so the simplest pattern is to wrap each call site
   that invokes `triggerDrain()` and check `result.saved` there. The
   `online` transition path in `triggers.ts` would need a similar
   surface — a small `onDrainComplete` callback option on
   `startQueueRunner()` is the cleanest add when this slice happens.
3. Toast suppression (§8.3 last paragraph): the parent knows whether
   a capture sheet is open, so it gates the toast's mount on
   `!captureSheetIsOpen`. This module deliberately does not import
   any capture-flow state.

## Per-component contracts

### `QueuePill`

- Hidden when `summary.total === 0`. No empty-state UI.
- `syncingNow` drives a ~1.4s pulse on the dot. Pass `true` when ANY
  record in the queue has `state === "syncing"` (use Array.some on
  the records list at the call site).
- `summary.failed_permanent > 0` switches the dot to muted amber and
  appends "· N needs review".
- `summary.failed_auth > 0` mounts a sibling "Sign in to finish
  saving" CTA below the pill.

### `QueueListSheet`

- Backdrop tap + Escape both close.
- `onDiscard` should call `discardCapture(id)` from
  `lib/queue/actions.ts`. The component disables the Discard button
  while `state === "syncing"` (plan §9.9); the action layer enforces
  the same rule defensively.
- `onSaveToDifferentSheet` is optional. Provide a handler only if the
  current connected sheet is available; the row buttons hide when
  the handler is missing.

### `DrainToast`

- Privacy-first copy. Generic count only. Never leak names.
- Auto-dismiss is internal (`DISMISS_MS = 3500`). The parent unmounts
  on `onDismiss`.

### `OnlineIndicator`

- Renders nothing when `state === "online"`. The absence is the
  affordance.
- Grey, not red. Calm; not alarming.

## Why no in-component runner

`startQueueRunner()` lives at the App level for two reasons:

1. It needs to fire at boot regardless of which screen renders first.
2. The runner owns timer + event listeners — re-mounting it on a
   per-component basis would leak handles and miss the
   `visibilitychange` reattach window.

This means all four components in this folder are stateless w.r.t.
the runner: they take props, render. Tests can render them in
isolation without spinning up Dexie or the online detector.
