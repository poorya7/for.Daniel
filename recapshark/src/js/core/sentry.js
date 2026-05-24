/**
 * Sentry frontend SDK initialization.
 *
 * Gated on `import.meta.env.VITE_SENTRY_DSN_FRONTEND` — Vite only exposes
 * env vars to client code if they start with `VITE_`. Without that prefix
 * the DSN would be undefined in the browser bundle and Sentry would
 * silently never report. The DSN itself is publish-only credential
 * (designed to be public), so embedding in the bundle is safe.
 *
 * Why this module exists separately from main.js:
 *   - Initialization should run as early as possible so boot-time errors
 *     get captured. Importing from a dedicated module makes the order
 *     intent explicit ("first thing main.js does").
 *   - Centralizes Sentry config so adding capture sites later (e.g.
 *     Phase 3's `_fetchChunk` catch block) can `import { Sentry } from
 *     './core/sentry.js'` without re-initializing.
 *
 * What this does NOT capture automatically:
 *   - Plan §12 graceful-failure responses (cap_hit, audio_not_ready,
 *     queue_timeout, etc.) — those are 200-with-error-body, NOT thrown
 *     exceptions. Phase 3 will explicitly call `Sentry.captureException`
 *     in the chunk-loader's failure path, with `tags: { feature:
 *     'lazy-karaoke', error_code: ... }` so they surface as their own
 *     issue group instead of polluting the unhandled-error inbox.
 *
 * Dev-only `beforeSend` filter: dropped TypeError / "Failed to fetch" (and
 * similar) so local Vite + tab-visibility recovery does not spam Sentry when
 * the dev server or proxy is briefly unreachable.
 */
import * as Sentry from '@sentry/browser';

const DSN = import.meta.env.VITE_SENTRY_DSN_FRONTEND || '';
const ENV = import.meta.env.MODE || 'development';

let _initialized = false;

if (DSN) {
  try {
    Sentry.init({
      dsn: DSN,
      environment: ENV,
      // Capture 100% of errors at v1 — volume is low, sampling can wait.
      sampleRate: 1.0,
      // Performance traces disabled at v1 (separate from error capture, costs
      // its own quota). Revisit if we need request-timing telemetry.
      tracesSampleRate: 0.0,
      // Filter out browser-extension noise that's nothing to do with us
      // (chrome-extension://, moz-extension://, safari-extension://).
      // Same idea as Sentry's default ignoreErrors, applied to the URL.
      beforeSend(event) {
        const url = event?.request?.url || '';
        if (/^(?:chrome|moz|safari|webkit)-extension:\/\//.test(url)) return null;

        /* Dev-only: `fetch` throws TypeError "Failed to fetch" when the Vite
         * dev server or API proxy is down, the laptop sleeps, or the tab was
         * backgrounded and the browser tore down the connection — especially
         * common right after visibilitychange (karaoke chunk-loader recovery).
         * Those are environmental, not app regressions; they flood Sentry with
         * duplicates. Production keeps these events (offline / CDN blips may
         * warrant ops visibility). */
        if (import.meta.env.DEV) {
          const parts = event?.exception?.values || [];
          for (let i = 0; i < parts.length; i++) {
            const v = parts[i];
            const line = `${v?.type || ''} ${v?.value || ''}`;
            if (/Failed to fetch|fetch failed|NetworkError|Load failed|networkerror/i.test(line)) {
              return null;
            }
          }
        }
        return event;
      },
    });
    _initialized = true;
  } catch (e) {
    // SDK init failure must never break the app. Worst case: no error
    // tracking. Log to console for the dev to spot during local work.
    // eslint-disable-next-line no-console
    console.warn('[sentry] init failed:', e);
  }
}

// BOOT BRIDGE — kept inline (NOT moved to main.js):
// `window.Sentry` must be defined at module-eval time because other
// modules (e.g. karaoke-chunk-loader, karaoke-analytics, karaoke-debug)
// read `window.Sentry.captureException` / `addBreadcrumb` from inside
// IIFEs and module-init code that runs BEFORE main.js's bridge block
// executes. main.js's bridge runs after all imports finish, so it's too
// late for these consumers. Per Phase 2 architectural decision (single
// bridge in main.js), this is one of two documented exceptions; the
// other is `core/assets.js`. Always defined (even when DSN missing) so
// call sites don't have to null-check — when DSN is missing, the
// underlying SDK calls are no-ops.
window.Sentry = Sentry;
window.__sentryInitialized = _initialized;

export { Sentry, _initialized };
