# Local dev setup

**Last updated:** 2026-05-23 — backend tooling switched from `venv` to `uv`; entrypoint is now `captureshark.main:app`, not `server:app`.

Everything you need to run CaptureShark on your machine and test it on your phone. Read this before [`01_sheets-dev-setup.md`](01_sheets-dev-setup.md) and [`02_google-oauth-setup.md`](02_google-oauth-setup.md) — those are about specific Google integrations once your local stack is humming.

---

## TL;DR — daily startup

Two commands in two terminals:

```powershell
# terminal 1 — backend (FastAPI on :8002)
cd <repo>\backend
uv run uvicorn captureshark.main:app --host 127.0.0.1 --port 8002 --reload

# terminal 2 — frontend (Vite on :5174, /api/* proxied to backend)
cd <repo>\frontend
pnpm dev    # alias of `vite --host`
```

First time on a fresh checkout: `cd backend && uv sync --extra dev` once
to materialise the virtualenv at `backend/.venv/` (auto-created by `uv`).
After that, just `uv run …` — no activation step needed.

That's it. The Cloudflare Tunnel is **always-on** as a Windows service — no extra command needed for mobile testing.

- Desktop dev: http://localhost:5174
- Mobile (or any device, anywhere): https://dev.captureshark.com

---

## What's running and where

| Process | Port | Purpose | How to start | How to stop |
|---|---|---|---|---|
| FastAPI backend | `:8002` | API + Sheets/OAuth glue | `uv run uvicorn captureshark.main:app …` | Ctrl+C |
| Vite dev server | `:5174` | Frontend + HMR + `/api/*` proxy → 8002 | `pnpm dev` | Ctrl+C |
| `cloudflared` | n/a | Tunnels `dev.captureshark.com` → `localhost:5174` | Auto-starts on boot (Windows service) | `Stop-Service cloudflared` |

### Why these specific ports?

RecapShark — same dev's other shark project — runs on **`:8001` (backend)** and **`:5173` (Vite default)**. CaptureShark uses **`:8002`** and **`:5174`** so both projects' dev servers can run at the same time without colliding.

---

## Frontend

Vite + React 19 + TypeScript + Framer Motion. PWA-installable, mobile-first.

- **`/api/*` is proxied** to `http://127.0.0.1:8002` (configured in `vite.config.ts`). Frontend code uses relative URLs like `/api/v1/health`; Vite's proxy rewrites them server-side. In production both are same-origin so the proxy is a dev-only shim.
- **`server.allowedHosts`** in `vite.config.ts` whitelists `dev.captureshark.com`. Vite 5+ blocks unknown Host headers by default — without the whitelist, requests through the tunnel return *"Blocked request. This host is not allowed."* If you add another tunnel hostname (staging, etc.), add it here too.
- **`--host` flag** makes Vite listen on `0.0.0.0` so anything on the LAN — including the local cloudflared process — can reach it.

See [`frontend/README.md`](../../frontend/README.md) for the deeper layout / conventions tour.

---

## Backend

FastAPI + uvicorn, managed by [`uv`](https://docs.astral.sh/uv/). Virtualenv at `backend/.venv/` (created by `uv sync`).

- Entrypoint: `backend/src/captureshark/main.py` → `app` instance, imported as `captureshark.main:app`.
- Dependency tool: `uv` (no pip / no manual venv activation). `uv sync --extra dev` installs everything from the lockfile; `uv run <cmd>` runs inside the venv without needing to activate it.
- Config: env vars loaded from `.env` at the repo root. Required keys for OAuth + Sheets are documented in [`01_sheets-dev-setup.md`](01_sheets-dev-setup.md) and [`02_google-oauth-setup.md`](02_google-oauth-setup.md). Cost-cap knobs live in [`11_caps_and_costs.md`](11_caps_and_costs.md).
- After editing `.env`, **restart uvicorn** — the dotenv is read on import, not per-request.
- See [`backend/README.md`](../../backend/README.md) for the deeper architecture tour (hexagonal layout, domain / adapters / services / api boundaries).

---

## Cloudflare Tunnel — mobile testing

We dropped ngrok in favour of a Cloudflare Tunnel on **2026-05-09**. Reasons: stable URL (no rotating hostnames eating OAuth re-config), free since the user owns `captureshark.com`, runs as a Windows service so it auto-starts.

### Live setup

- **Public URL:** https://dev.captureshark.com (HTTPS, Cloudflare-issued cert, no setup)
- **Tunnel name:** `captureshark-dev`
- **Tunnel ID:** `<tunnel-id>`
- **Forwards to:** `http://localhost:5174` (Vite)
- **Service name:** `cloudflared` (Windows service, `LocalSystem`, Automatic startup)
- **Install method:** `cloudflared service install <tunnel-token>` — token-based, **NOT** the `--config <path>` form. The latter looks fine on install but Windows doesn't persist the flag in the service's `ImagePath`, so the service starts with no args and can't find the config. Token-based install embeds credentials in the service registration itself.

### File locations

- `C:\Users\<you>\.cloudflared\cert.pem` — account auth (used by `cloudflared tunnel ...` CLI)
- `C:\Users\<you>\.cloudflared\<tunnel-id>.json` — tunnel credentials
- `C:\Users\<you>\.cloudflared\config.yml` — tunnel config (legacy from initial setup; the running service uses the token, not this file)

### Verifying the tunnel is healthy

```powershell
# Service is running?
Get-Service cloudflared            # Status should be "Running"

# Connections to Cloudflare's edge?
cloudflared tunnel info captureshark-dev   # Expect 4 connections (Miami POPs)

# End-to-end smoke?
curl -I https://dev.captureshark.com
# 200 if Vite is up, 530 if Vite is down (tunnel works, origin doesn't)
```

### Adding a new tunneled hostname (e.g. staging)

```powershell
cloudflared tunnel route dns captureshark-dev staging.captureshark.com
# Then add an entry in the cloudflared config / re-issue token
# AND add `staging.captureshark.com` to vite.config.ts allowedHosts
# AND add the URL pair to OAuth Client (origins + redirect URIs)
```

---

## Common gotchas

- **`localhost:5174` doesn't load** → Vite isn't running. `pnpm dev` in `frontend/`.
- **`localhost:5174` works, `dev.captureshark.com` returns HTTP 530** → Cloudflare reached the origin but the origin (Vite or the tunnel-to-Vite hop) is down. `Get-Service cloudflared` and check Vite is on `:5174`.
- **`dev.captureshark.com` returns *"Blocked request. This host is not allowed."*** → Vite's `allowedHosts` doesn't include the hostname. Add it to `vite.config.ts` and restart Vite.
- **`/api/*` calls 404 on the frontend** → Vite proxy isn't picking up the request. Check `vite.config.ts` `server.proxy` block. Also verify backend is up on `:8002`.
- **Backend env var change isn't taking effect** → uvicorn reads `.env` on startup. Restart it.
- **OAuth `redirect_uri_mismatch`** → the URL the backend redirected to doesn't *exactly* match an entry in Google Cloud Console → APIs & Services → Credentials → CaptureShark Web Client → Authorized redirect URIs. Trailing slashes, `http` vs `https`, ports — all matter.
- **OAuth `access_denied`** → user isn't in the test-user list (the app isn't Google-verified yet). Add their email to the OAuth consent screen test users (max 100).

---

## Where to read next

- [`01_sheets-dev-setup.md`](01_sheets-dev-setup.md) — service-account Sheets setup (the dev save path for smoke tests)
- [`02_google-oauth-setup.md`](02_google-oauth-setup.md) — Google OAuth client setup (real-user sign-in)
- [`03_polish_pass.md`](03_polish_pass.md) — open polish backlog
- [`11_caps_and_costs.md`](11_caps_and_costs.md) — what we spend, what's capped, pre-launch checklist
- [`docs/_workflow/02_PRINCIPLES.md`](../_workflow/02_PRINCIPLES.md) — product principles + perf bar
- [`docs/_spec/photo_capture.md`](../_spec/photo_capture.md) — durable photo-capture architecture reference
