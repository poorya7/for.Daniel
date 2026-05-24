import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Vite configuration.
 *
 * - `/api/*` is proxied to the FastAPI backend during dev so the frontend
 *   can call same-origin without CORS. In production both are served from
 *   the same origin, so the proxy is a dev-only shim.
 * - `@/` resolves to `src/` (mirrored in tsconfig.app.json `paths`).
 *
 * **Port + proxy target are env-driven**, so multiple git worktrees on the
 * same machine can each run their own dev stack without editing this file.
 * Defaults match the main checkout's historical setup (5174 + 8002).
 * Worktrees override via a gitignored `.env.local`:
 *
 *     VITE_DEV_PORT=5175
 *     VITE_API_PROXY_TARGET=http://127.0.0.1:8004
 *     VITE_ALLOWED_HOSTS=.trycloudflare.com,dev2.captureshark.com
 *
 * RecapShark holds 5173 + 8001, CaptureShark main holds 5174 + 8002,
 * any worktree should pick something else (e.g. 5175 + 8004) so all three
 * stacks can run side by side. Cloudflare Tunnel hostnames must be
 * whitelisted on `VITE_ALLOWED_HOSTS` (comma-separated); leading-dot
 * entries like `.trycloudflare.com` match any subdomain, which is the
 * right shape for ad-hoc `cloudflared tunnel --url` quick tunnels.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:8002";
  const devPort = env.VITE_DEV_PORT ? Number(env.VITE_DEV_PORT) : 5174;
  const allowedHosts = (env.VITE_ALLOWED_HOSTS ?? "dev.captureshark.com")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);

  return {
    plugins: [
      react(),
      // Offline app shell (plan §10): a service worker precaches the
      // static bundle so the app boots in a dead zone instead of
      // landing on Chrome's "no internet" page. Without this, every
      // other piece of the offline queue work is moot — Linda opens
      // the app at a basement open house, gets the browser error,
      // and never reaches the capture flow.
      //
      // `registerType: "prompt"` means a new SW installs in the
      // background but does NOT skip-waiting — it stays in the
      // `waiting` state until the user fully reloads / closes the
      // tab. That matches plan §10.4's "claims on next reload, not
      // mid-session" rule, so a deploy mid-capture never swaps the
      // bundle out from under an in-flight save. We don't surface
      // the update prompt to the user; the silent next-reload
      // takeover is the right default for the persona.
      //
      // `devOptions.enabled: false` keeps SW out of `vite dev` so
      // Vite's HMR isn't fighting cached responses on every save.
      // Production builds (`pnpm build` → `dist/sw.js`) are the
      // only place the SW activates.
      VitePWA({
        registerType: "prompt",
        injectRegister: "auto",
        includeAssets: [
          "brand/sharky.png",
          "brand/shark-wordmark.png",
        ],
        manifest: {
          name: "CaptureShark",
          short_name: "CaptureShark",
          description:
            "Capture a lead, we'll add it to your Google Sheet.",
          // Match index.html's <meta name="theme-color">; iOS status-
          // bar + Chromium splash blend into the slate-900 canvas.
          theme_color: "#0f172a",
          background_color: "#0f172a",
          display: "standalone",
          orientation: "portrait",
          start_url: "/",
          scope: "/",
          icons: [
            {
              src: "/pwa-192x192.png",
              sizes: "192x192",
              type: "image/png",
              purpose: "any",
            },
            {
              src: "/pwa-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "any",
            },
            // Same 512 file declared with `maskable` purpose so
            // Android adaptive icons crop to the platform mask
            // without bleeding past the safe zone. The icon's
            // generated padding (~14% inset) gives Android room to
            // crop without clipping the mascot.
            {
              src: "/pwa-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          // Precache the built bundle. The plugin auto-globs from
          // `dist/` post-build; the patterns here add the brand
          // assets (mascot, wordmark) that live in `public/` and
          // are copied verbatim. Fonts are loaded from Google's
          // CDN and handled by the runtime cache rule below.
          globPatterns: [
            "**/*.{js,css,html,ico,png,svg,webmanifest}",
          ],
          // Single-page-app navigation fallback. Any same-origin
          // navigation request the SW can't satisfy from precache
          // (e.g. `/sim`, `/settings`) falls back to the cached
          // `index.html` — React Router-style routing keeps
          // working offline.
          navigateFallback: "/index.html",
          // /api/* must always go to network. The backend is the
          // only source of truth for captures, auth, sheet writes,
          // etc. A cached 200 here would be a correctness bug.
          navigateFallbackDenylist: [/^\/api\//],
          runtimeCaching: [
            // Google Fonts CSS — cache-first, short TTL. Avoids a
            // network round-trip on every cold load while still
            // picking up font-loader updates within a day.
            {
              urlPattern:
                /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: "CacheFirst",
              options: {
                cacheName: "google-fonts-stylesheets",
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24, // 1 day
                },
              },
            },
            // Google Fonts WOFF2 binaries — cache-first, long TTL.
            // These are content-hashed by Google so the long expiry
            // is safe; we just want them present after first load.
            {
              urlPattern:
                /^https:\/\/fonts\.gstatic\.com\/.*/i,
              handler: "CacheFirst",
              options: {
                cacheName: "google-fonts-webfonts",
                cacheableResponse: { statuses: [0, 200] },
                expiration: {
                  maxEntries: 30,
                  maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
                },
              },
            },
          ],
        },
        devOptions: {
          enabled: false,
        },
      }),
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
      },
    },
    server: {
      port: devPort,
      strictPort: true,
      allowedHosts,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: false,
        },
      },
    },
    build: {
      outDir: "dist",
      sourcemap: true,
      target: "es2022",
    },
  };
});
