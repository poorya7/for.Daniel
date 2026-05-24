# CaptureShark — Frontend

Vite + React 19 + TypeScript + Framer Motion. PWA-installable, mobile-first, custom-minimal components (no heavy UI libraries). Product principles in [`/docs/_workflow/02_PRINCIPLES.md`](../docs/_workflow/02_PRINCIPLES.md). Photo-capture durable contract in [`/docs/_spec/photo_capture.md`](../docs/_spec/photo_capture.md).

Package manager: [`pnpm`](https://pnpm.io/) (faster than npm, strict deps, monorepo-friendly).

## Local development

```bash
# from the repo root
cd frontend

# install deps
pnpm install

# run the dev server (port 5174, --host so the Cloudflare Tunnel can reach it)
pnpm dev
```

Then open http://localhost:5174 — the page shows the backend's `/api/v1/health` response, proving the stack is wired end-to-end.

The Vite dev server proxies `/api/*` → `http://127.0.0.1:8002` (FastAPI), so calls are same-origin in the browser. Make sure the backend is running. (RecapShark uses 8001 — we run on 8002 so both projects coexist locally.)

## Layout

```
frontend/
├── package.json
├── vite.config.ts            dev server + /api proxy
├── tsconfig.{app,node}.json  strict TS, project references
├── eslint.config.js          flat config, strict-type-checked
├── index.html
├── src/
│   ├── main.tsx              app bootstrap (mounts <AppCanvas /> + the QueueRunner)
│   ├── App.canvas.tsx        orchestrator — wires the screen-state machine to side effects
│   ├── features/             one folder per feature (app-state / photo-capture / review / auth / queue / sheets)
│   ├── components/           shared UI primitives (CanvasVoice, PhotoCapture, SharkLoader, …)
│   ├── lib/                  cross-cutting helpers (api client, queue, liveCaptions, photoConsent, …)
│   ├── stores/               zustand stores (auth, features)
│   ├── types/                hand-written types + generated (from backend OpenAPI later)
│   └── styles/               global tokens + base styles
└── ...
```

## Conventions

- **Custom-minimal first.** Reach for Radix _primitives_ only when accessibility/correctness demand it (focus management, dialog focus traps).
- **No prop-drilling beyond 2 levels.** Use a Zustand store instead.
- **Component size cap ~150 lines.** Split before it grows.
- **Path alias `@/*` → `src/*`** (mirrored in `tsconfig.app.json` and `vite.config.ts`).
- **Errors normalised at the `lib/api.ts` layer** — components consume `ApiError` instances, never raw `fetch` exceptions.

## Scripts

| Command          | Purpose                                   |
| ---------------- | ----------------------------------------- |
| `pnpm dev`       | Vite dev server with HMR                  |
| `pnpm build`     | Type-check + production build             |
| `pnpm preview`   | Preview the production build locally      |
| `pnpm lint`      | ESLint (flat config, strict-type-checked) |
| `pnpm format`    | Prettier write                            |
| `pnpm typecheck` | `tsc -b --noEmit`                         |
| `pnpm test`      | Vitest (jsdom + @testing-library/react)   |
