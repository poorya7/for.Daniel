# Google OAuth setup — real user sign-in

**Last updated:** 2026-05-09 — Cloudflare Tunnel went live; OAuth client now has desktop + mobile origins/redirects. Audited 2026-05-23, no further changes needed.

This is the **real-user OAuth flow** setup, used by the live app.
Different from [01_sheets-dev-setup.md](01_sheets-dev-setup.md), which
is the service-account dev path used for backend smoke tests.

Real users will sign in with Google here, grant the narrow `spreadsheets.file`
permission, and pick a sheet via the Google Picker.

---

## What we're setting up (high-level)

1. **OAuth consent screen** — what users see on the Google sign-in page (app
   name, scopes requested, logo, support email).
2. **OAuth 2.0 Client ID (Web application)** — the client_id + client_secret
   the backend uses to talk to Google's OAuth servers.
3. **Authorized redirect URIs** — the URLs Google is allowed to bounce users
   back to after they sign in (localhost for desktop dev + Cloudflare Tunnel
   hostname for mobile).
4. **Test users** — until Google verifies the app, only listed Google accounts
   can sign in (100-user cap). Real launch waits on verification.
5. **Two env vars in `.env`**.

Total: **~15 minutes**, one-time. We **reuse the same Google Cloud project** as
the service-account setup (`captureshark-dev`).

---

## Live values (filled in as you set up)

Recording the non-secret identifiers here so future-me doesn't dig through
Cloud Console. The actual `GOOGLE_CLIENT_SECRET` stays in `.env` only.

- **Cloud project:** `captureshark-dev` (reused from step 3)
- **OAuth client name:** `CaptureShark Web Client`
- **OAuth client_id:** stored in `.env` as `GOOGLE_CLIENT_ID` (created
  2026-05-08; not echoed here to avoid drift between doc and `.env`)
- **OAuth consent app name:** `CaptureShark`
- **Support email:** `dev@captureshark.com`
- **Test users:** `dev@captureshark.com`
  *(`dev@captureshark.com` couldn't be added — not a real Google account
  yet. Register it as a Google account if you want to test multi-user.)*
- **Scopes requested:**
  - `https://www.googleapis.com/auth/drive.file` *(Picker + Sheets — narrow)*
  - *(NOTE: `spreadsheets.file` is NOT a real Google scope — `drive.file`
    alone covers Sheets API access for files the user picks via the
    Picker. The v1 sketch + tech plan reference `spreadsheets.file` —
    treat that as a doc bug, fixed here.)*
  - `openid` / `userinfo.email` / `userinfo.profile` — *(skipped in the
    new Google Auth Platform UI; OpenID identity claims come back via
    the id_token regardless. Add later only if backend needs the
    standalone userinfo endpoint.)*

---

## Step-by-step

### 1. Open your existing Cloud project

- Go to https://console.cloud.google.com
- Top bar → project picker → pick `captureshark-dev`
  (the project from `01_sheets-dev-setup.md`)

### 2. Enable the APIs we need

- Left nav → **APIs & Services** → **Library**
- Enable each (search → click → **Enable**):
  - **Google Sheets API** *(should already be enabled from step 3 — confirm)*
  - **Google Drive API** *(needed for the Picker to list sheets)*
  - **Google Picker API**

### 3. Configure the OAuth consent screen

- Left nav → **APIs & Services** → **OAuth consent screen**
- **User Type** → **External** → **Create**
- Fill in:
  - **App name:** `CaptureShark`
  - **User support email:** `dev@captureshark.com`
  - **App logo:** *(skip for now — can add later before verification)*
  - **App home page:** `https://captureshark.com` *(it's fine if the site
    isn't live yet — just needs to look sane on the consent screen)*
  - **App privacy policy:** `https://captureshark.com/privacy`
    *(we'll create this page before filing for verification — for now
    it can 404, the dev consent screen still works)*
  - **App terms of service:** *(skip optional)*
  - **Authorized domains:** `captureshark.com`
  - **Developer contact:** `dev@captureshark.com`
- **Save and continue**

### 4. Add scopes (consent screen, screen 2)

- Click **Add or remove scopes**
- Filter / paste each of these and check the box:
  - `.../auth/userinfo.email`
  - `.../auth/userinfo.profile`
  - `openid`
  - `.../auth/drive.file` ← *the narrow Drive scope, NOT full `drive`*
  - `.../auth/spreadsheets.file` ← *the narrow Sheets scope, NOT full `spreadsheets`*
- **Update** → **Save and continue**

> The `.file` variants only let CaptureShark see/write files **the user
> specifically opens via the Picker or the app creates** — much less scary
> than full Drive/Sheets access, and required for the consent-screen copy
> to read like *"see and edit only the Google Sheets you use with this app"*.

### 5. Add test users (consent screen, screen 3)

- **Add users** →
  - `dev@captureshark.com`
  - `dev@captureshark.com`
  - *(add anyone else who'll sign in to test before verification)*
- **Save and continue**

> Until the app is Google-verified, only these emails can complete sign-in
> (capped at 100). Anyone else gets blocked at the consent screen.

### 6. Create the OAuth 2.0 Client ID

- Left nav → **APIs & Services** → **Credentials** → **+ Create credentials**
  → **OAuth client ID**
- **Application type:** **Web application**
- **Name:** `CaptureShark Web Client`
- **Authorized JavaScript origins:** *(for the Picker JS SDK)*
  - `http://localhost:5174`
  - *(mobile tunnel URL — add later once we pick a tunnel; see "Tunnel
    decision (deferred)" below)*
- **Authorized redirect URIs:** *(where Google bounces users back after sign-in)*
  - `http://localhost:5174/api/v1/auth/google/return`
  - *(mobile tunnel URL — add later, same path: `/api/v1/auth/google/return`)*
- **Create**
- A modal pops up with **Client ID** and **Client secret**. **Copy both now**
  — the secret is only shown once.

### 7. Add env vars to `.env`

Open `<repo>/.env` and fill in:

```
GOOGLE_CLIENT_ID=<paste client ID — looks like 1234-abc.apps.googleusercontent.com>
GOOGLE_CLIENT_SECRET=<paste client secret — looks like GOCSPX-abc...>
```

### 8. Restart the backend

uvicorn needs to re-read `.env`. With `--reload` on, saving the file may
auto-pick it up; if not, kill and restart.

### 9. Smoke test (once the backend OAuth code lands)

- Open http://localhost:5174
- Type a note → extract → tap **Save to sheet**
- You should be redirected to Google sign-in
- Sign in as `dev@captureshark.com` (or any test user)
- See the consent screen — it should say *"CaptureShark wants to: see your
  email, see/edit only the Google Sheets you use with this app"*
- Approve → land back inside the canvas on the **review** phase with **Save** armed
- Picker integration is part of the same flow — first-time users will be
  asked to pick a sheet right after sign-in; returning users go straight
  to the connected sheet they picked previously.

---

## Tunnel — Cloudflare (live since 2026-05-09)

**Decision:** Cloudflare Tunnel. ngrok was uninstalled the same day.

**Live state:**
- Public URL: `https://dev.captureshark.com` → Cloudflare → laptop's Vite (`localhost:5174`)
- captureshark.com is on Cloudflare DNS (free plan); registrar is still Porkbun
- cloudflared runs as a Windows service named `cloudflared` (auto-starts on boot)
- OAuth Client now has both desktop + mobile origins/redirects:
  - JS origins: `http://localhost:5174`, `https://dev.captureshark.com`
  - Redirect URIs: `http://localhost:5174/api/v1/auth/google/return`, `https://dev.captureshark.com/api/v1/auth/google/return`

**Why Cloudflare over paid ngrok:** Free, stable URL (no rotating
hostnames eating OAuth re-config every restart), and the user already
owned the domain. Setup details (tunnel ID, file paths, the gotcha
where `cloudflared service install --config <path>` doesn't persist
the flag on Windows so token-based install is required) are captured
in agent memory under `reference_cloudflare_tunnel.md`.

---

## Common gotchas

- **`redirect_uri_mismatch` error** → the URL the backend redirected to
  doesn't EXACTLY match one in Authorized redirect URIs. Trailing slashes,
  http vs https, port numbers all matter. Copy from Cloud Console exactly.
- **`access_denied` error** → user isn't on the test-users list. Add their
  email and retry.
- **Consent screen says "unverified app — proceed at your own risk"** →
  expected, until we file Google verification. Test users see this; click
  **Advanced → Continue** to proceed.
- **Cookie not persisting across redirect on iOS Safari** → ITP /
  partitioned cookies behavior. The backend code uses `SameSite=Lax` +
  `Secure` (over HTTPS via the tunnel) which is the safest combo. If captures
  vanish across the redirect, that's the bug to investigate.

---

## Coming later (NOT now): Google verification

Verification is what removes the *"unverified app"* warning and lifts the
100-test-user cap. Filing requires:

- A working OAuth flow (we have one — covered in this doc)
- A live privacy policy page at `https://captureshark.com/privacy`
- Domain ownership verified in Search Console
- A demo video showing the consent screen + the app using each scope
- Filling out a justification form for each sensitive scope

Timeline is **4-8 weeks of Google review** once filed. We'll file once the
OAuth flow works end-to-end and we have a privacy page up. Don't worry
about it for now.

---

**End of OAuth setup.** Hand control back to dev once `.env` has the two
new keys filled in.
