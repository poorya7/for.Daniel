import { defineConfig } from 'vite';
import { sentryVitePlugin } from '@sentry/vite-plugin';

// Source-map upload to Sentry runs ONLY when SENTRY_AUTH_TOKEN is set in the
// environment at build time. Without the token, the plugin is omitted entirely
// (build still emits source maps to dist/, just doesn't upload them). This way
// dev builds + token-less prod builds still work — no auth-token = degraded
// debugging on Sentry (minified line numbers in stack traces) but everything
// else works. The token is a SECRET and must NEVER be committed; add to `.env`
// on the droplet alongside VITE_SENTRY_DSN_FRONTEND.
const sentryPlugin = process.env.SENTRY_AUTH_TOKEN
  ? sentryVitePlugin({
      org: 'gcp-PROJECT-ID',
      project: 'recapshark-frontend',
      authToken: process.env.SENTRY_AUTH_TOKEN,
      // Default release name is the git SHA (auto-detected). Override via
      // SENTRY_RELEASE if needed for manual deploys.
      release: process.env.SENTRY_RELEASE
        ? { name: process.env.SENTRY_RELEASE }
        : undefined,
      // Don't fail the build if upload errors — degraded Sentry > broken deploy.
      errorHandler: (err) => {
        // eslint-disable-next-line no-console
        console.warn('[sentry-vite-plugin] source-map upload failed:', err.message);
      },
    })
  : null;

export default defineConfig({
  root: 'src',
  // Read .env from repo root (one source of truth shared with the Python
  // backend), not from `src/`. Without this Vite would look in `src/.env`
  // because of the `root: 'src'` setting above and silently ignore the
  // real `.env` at repo root — VITE_*_ vars would never reach client code.
  envDir: '..',
  server: {
    proxy: {
      '/api': 'http://localhost:8001',
    },
    // Allow the Cloudflare Tunnel hostname for mobile testing over HTTPS
    // (replaces ngrok as of 2026-05-09). Stable URL — no per-session
    // restart, no allowlist drift. Tunnel runs as a Windows service.
    allowedHosts: ['dev.example.com'],
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // 'hidden': source maps ARE emitted to dist/ (so the Sentry vite plugin
    // can upload them when SENTRY_AUTH_TOKEN is set, and Sentry stack traces
    // resolve to real source line numbers), but the `//# sourceMappingURL=`
    // comment is stripped from the generated JS files. End users' DevTools
    // therefore won't auto-fetch the maps and won't show the readable source
    // — minified bundle only. Determined attackers can still guess the .map
    // URLs (they're served by nginx alongside the JS), but the bar is raised
    // from "open DevTools" to "manual reverse-engineering."
    // Switched from `true` → `'hidden'` 2026-05-07 in Phase 1 security pass.
    sourcemap: 'hidden',
    rollupOptions: {
      input: {
        main: 'src/index.html',
        ownerLogin: 'src/owner-login.html',
        privacy: 'src/privacy.html',
      },
    },
  },
  plugins: sentryPlugin ? [sentryPlugin] : [],
});
