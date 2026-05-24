# Read before you deploy

**Last updated:** 2026-05-23 — production photo provider flipped to OpenAI GPT-5 minimal-reasoning. Doc AI is now the rollback target, not the default. §3a, §5b, §6, §7, §9 all updated to match.

**For the operator about to spin up a production (or staging)
instance of CaptureShark.** Read end-to-end before flipping any
switches. Nothing in here is optional — every missing piece either
fails loud (good) or fails subtly (bad).

This doc lives in `_workflow` so it's discoverable from the same
folder as the local-dev setup, OAuth setup, and project rules.
Update it whenever a new env var becomes load-bearing or a new
deploy-day gotcha is found in the wild.

---

## 1. What you're actually deploying (architecture)

Two processes + a few external dependencies:

- **Backend** — Python FastAPI app (`backend/src/captureshark`),
  served by uvicorn (or any ASGI runner). Owns the photo / voice
  / text capture endpoints, the OAuth round-trip, the
  per-row idempotency store (SQLite), and the cost-cap
  middleware. Runs on port 8002 in local dev — pick whatever in
  production but the reverse proxy / hosting platform needs to
  match.
- **Frontend** — Vite-built static SPA (`frontend/`). After
  `pnpm install && pnpm build`, the `dist/` folder is what you
  serve. Any static host (Netlify, S3 + CloudFront, nginx) works.
  Must be served from the SAME ORIGIN as the backend OR you need
  a reverse-proxy that proxies `/api/*` to the backend so the
  same-origin cookies work.
- **External services** the deployed app calls:
  - OpenAI (text extraction, voice Whisper, **photo via GPT-5 minimal-reasoning** — the v1 production vision provider)
  - Google Sheets API (saving rows)
  - Google OAuth (user sign-in)
  - Google Document AI (photo OCR — kept wired as a one-line rollback, not the default; see §7)
  - AssemblyAI (live captions — code-shipped but currently default OFF, see [`09_TODO.md`](09_TODO.md))

The SQLite idempotency store lives at a path the backend writes
to — make sure that path is on a persistent volume in your
deploy environment, not on ephemeral container storage. Otherwise
restarts wipe the dedupe cache and recently-saved retries can
duplicate.

---

## 2. HTTPS is non-negotiable

Camera capture on iOS Safari **only works over HTTPS**. A photo
button that does nothing when tapped on iPhone = your domain is
HTTP. Get a real cert (Let's Encrypt is free) or hide behind a
proxy (Cloudflare) that terminates TLS for you.

This also matters for service-worker / "add to home screen" PWA
mode — both are HTTPS-only on every modern browser.

Localhost dev is the only HTTP exception (browsers exempt
localhost from the secure-context rule, which is why
`http://127.0.0.1:5174` works on your laptop).

---

## 3. Required environment variables

Production needs the same `.env` shape as local dev. The
load-bearing ones split into four groups.

### 3a. Vision provider (photo capture)

Default is OpenAI GPT-5 minimal-reasoning. No env var needed — the
`OPENAI_API_KEY` from §3c also powers the photo path.

```
# VISION_PROVIDER unset, or:
VISION_PROVIDER=openai
```

- `VISION_PROVIDER` picks which AI reads the photo. Default (or any
  unrecognised value) = OpenAI GPT-5 — the v1 production choice as
  of 2026-05-17 (97% accuracy / 2.8s p50 on the structural-challenge
  corpus). See [`07_photo-model-bakeoff.md`](07_photo-model-bakeoff.md)
  for the decision history.
- `docai` flips to Google Document AI Form Parser. **Kept wired as a
  one-line rollback** if OpenAI misbehaves in production — see §7.
  Doc AI was the original 2026-05-16 ship; real-world testing the
  next day showed 0% accuracy on the structural layouts visitors
  actually create, which is what triggered the swap.

If you set `VISION_PROVIDER=docai`, two extra env vars are required:

```
GOOGLE_DOCAI_PROCESSOR_NAME=projects/.../locations/us/processors/...
GOOGLE_DOCAI_SA_PATH=/absolute/path/to/google-service-account.json
```

- `GOOGLE_DOCAI_PROCESSOR_NAME` is the full resource path of the
  Doc AI processor — region (`us`) is parsed out of this path,
  not configured separately.
- `GOOGLE_DOCAI_SA_PATH` points at a Google service-account JSON
  with Doc AI invoker permission on the processor.

If `VISION_PROVIDER=docai` is set but either credential path is
missing/wrong, the photo endpoint returns a clean 503 (not a
mid-stream crash) — by design.

### 3b. Sheets + OAuth (save path)

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
OAUTH_REDIRECT_BASE_URL=https://yourdomain.example.com
GOOGLE_SERVICE_ACCOUNT_PATH=/absolute/path/to/sheets-sa.json
SESSION_SECRET_KEY=<random 32+ bytes>
TOKEN_ENCRYPTION_KEY=<random 32+ bytes>
```

- `OAUTH_REDIRECT_BASE_URL` MUST match the URL the deployed app
  is served at (Google rejects mismatched redirect URIs). The
  callback path `/api/v1/auth/google/callback` is appended
  automatically.
- The two secret keys encrypt session cookies + stored OAuth
  tokens at rest. Rotate by generating fresh values; existing
  sessions will be invalidated (users sign in again — no data
  loss).
- `GOOGLE_SERVICE_ACCOUNT_PATH` (Sheets dev fallback) is for the
  unsigned-in dev save target. In production with real users
  signed in via OAuth, this fallback isn't normally exercised.

### 3c. Voice + live captions (optional but recommended)

```
OPENAI_API_KEY=...
ASSEMBLYAI_API_KEY=...
LIVE_CAPTIONS_ENABLED=true
```

- `OPENAI_API_KEY` powers the Whisper batch fallback when live
  captions don't complete.
- `ASSEMBLYAI_API_KEY` powers the AssemblyAI Universal-3 Pro
  streaming session that drives the calm voice review.
- `LIVE_CAPTIONS_ENABLED=true` flips the feature on for clients.

### 3d. Frontend build-time

```
VITE_USE_EDIT_MORPH=true
```

- Vite reads `VITE_*` vars at build time and bakes them into the
  bundle. The current single flag enables the edit-cell morph
  animation — leave it on for production unless you're
  intentionally rolling back to the older inline-edit panel.
- These vars are NOT runtime-configurable. To change one, rebuild
  the frontend.

### 3e. Stuff that ships but isn't load-bearing on launch day

Other keys in `.env` (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
`DEEPGRAM_API_KEY`, `SUPADATA_API_KEY`,
`GOOGLE_TRANSLATE_API_KEY`, `ELEVENLABS_API_KEY`, `NGROK_AUTHTOKEN`,
`DEV_TEST_SHEET_*`, `SUPABASE_*`) are for experimental / dev /
future paths. Either ship them blank or omit — the production
photo + voice + text + save paths don't read them.

---

## 4. Secret hygiene

- **`.env` is in `.gitignore`. Keep it that way.** Don't commit
  it. Don't commit the Google service-account JSONs either —
  treat them as secrets, not config files.
- **Service-account JSONs need to physically exist on the
  deployed machine** at the path `GOOGLE_DOCAI_SA_PATH` /
  `GOOGLE_SERVICE_ACCOUNT_PATH` point at. Most platforms support
  mounting secret files (Render: Secret Files, Fly: secret
  volumes, Docker: bind mount or build-time copy). Don't bake
  the JSON content into your container image — leak risk.
- **`SESSION_SECRET_KEY` and `TOKEN_ENCRYPTION_KEY` should be
  generated fresh per deploy environment.** Don't reuse the dev
  values in prod. Generate with:
  `python -c "import secrets; print(secrets.token_urlsafe(32))"`.
- **If a secret leaks** — rotate it. For Google service accounts,
  delete the key in Cloud Console and download a fresh one. For
  the session/token keys, just generate new ones; users sign in
  again, no data loss.

---

## 5. Smoke test (before opening to real traffic)

Run AT LEAST these four checks against the deployed instance
before any real user touches it. They're cheap and they catch the
most-common config-drift bugs.

### 5a. Backend reachable

```
curl https://yourdomain.example.com/api/v1/health
```

Expect `200` with a JSON envelope including the build version.
Anything else = backend isn't running or reverse proxy is wrong.

### 5b. Photo path — real OpenAI call

Send a real photo through the deployed `/api/v1/captures/photo`
endpoint. Either via the UI from a phone, or by curl-ing a known
test image. The SSE response's terminal `photo_done` event should
read `"provider": "openai"` (or `"docai"` if you intentionally
flipped the rollback flag — see §7).

If `provider` is unexpected, the `VISION_PROVIDER` env var didn't
take effect (typo, restart needed, or wrong shell loaded). Fix
before going further.

If the call errors with an OpenAI auth/quota message, check
`OPENAI_API_KEY` is set and the account has credits. If you
deliberately flipped to Doc AI and it errors with a Google-side
permission message, check the service account JSON exists at
`GOOGLE_DOCAI_SA_PATH` and has the **Document AI API User** role
on the processor.

Use one of the bake-off corpus photos for a known-good baseline:
`docs/_tests/vision_bakeoff/data/truly_clean/printed/template_01.jpg`
(expected: 1 row, name "Fatima Al-Mansouri").

### 5c. Sheets save — OAuth round-trip

In the deployed app, sign in with a real Google account, pick a
sheet via the Picker, save a manual text capture. Verify the row
lands in the actual sheet.

Common breakage: `OAUTH_REDIRECT_BASE_URL` mismatch with what's
allowlisted in Google Cloud Console → OAuth → Authorized redirect
URIs. The error surfaces in the URL bar after the Google consent
screen.

### 5d. Voice — live captions

Tap voice, record 10 seconds of clear speech, stop. Verify a
review card appears with the extracted fields. If the live
captions don't fire and the Whisper batch fallback also fails,
either `LIVE_CAPTIONS_ENABLED` is off or one of the speech keys
isn't loaded.

### 5e. iPhone PWA mode (if you support "add to home screen")

After installing the app to home screen on iOS:
- Cold-launch the PWA. The first photo / voice tap should prompt
  for camera / mic permissions correctly.
- Background the app, return — the camera should re-acquire
  without a frozen frame.
- Camera permission in PWA mode is per-installation, not shared
  with regular Safari. Users who granted in Safari may need to
  re-grant in PWA.

---

## 6. Privacy disclosure — must update before first real user

If you're going live with real customers (not just a demo), the
in-app privacy section must name **OpenAI** as the photo extraction
provider (current default), or **Google Document AI** if you've
flipped `VISION_PROVIDER=docai` as a rollback.

Suggested copy (OpenAI default):

> Photos of sign-in sheets are sent to OpenAI's vision API for
> text extraction. We delete the photo immediately after
> extraction — OpenAI does not retain it for training under
> their standard API terms.

If you flip to Doc AI rollback, swap the provider name and add the
data-residency note: confirm the Doc AI processor's data residency
setting in Google Cloud Console → Document AI → your processor →
Data residency, and disable content storage if it isn't already.

For a closed demo with no paying customers, this step is
defer­able (low risk of disclosure complaints). For real launch:
non-negotiable.

---

## 7. Rollback procedure (test before you need it)

The Doc AI vision adapter stays in the codebase even though OpenAI
is now the production default — by design, so a one-line rollback
is always possible if OpenAI misbehaves (outage, quota cliff,
unexpected accuracy regression).

To roll back from OpenAI to Doc AI:

1. Edit production `.env`: set `VISION_PROVIDER=docai` (and confirm
   `GOOGLE_DOCAI_PROCESSOR_NAME` + `GOOGLE_DOCAI_SA_PATH` are
   populated — see §3a).
2. Restart the backend process.
3. Verify with the §5b smoke test — `photo_done.provider`
   should now read `docai`.

Photos taken during the Doc AI rollback window will use Doc AI's
Form Parser instead of OpenAI. Accuracy on structural layouts
degrades meaningfully (Doc AI scored 0% on real-world structural
photos in 2026-05-17 testing — see
[`07_photo-model-bakeoff.md`](07_photo-model-bakeoff.md)); the
trade-off is paying ~$0.03/photo for known-broken structural
extraction instead of $0.02/photo for known-good extraction. Only
flip it if OpenAI is genuinely down.

Verify the rollback path works in staging BEFORE you need it in
production. The first time you flip the switch shouldn't be a
crisis.

---

## 8. Process management (restart, logs, recovery)

- **Backend restart** — kill the uvicorn process tree (don't just
  `kill PID`; uvicorn with `--reload` spawns workers that hold
  the socket). On Linux: `pkill -TERM -f 'uvicorn.*captureshark'`
  followed by a fresh start. On Windows: `taskkill /F /T` (the
  `/T` is critical — without it the multiprocessing worker stays
  alive and the port stays bound). Don't run with `--reload` in
  production; it's a dev-only convenience.
- **Logs** — uvicorn logs to stdout. Pipe to a file or your
  hosting platform's log collector. The app itself doesn't log
  PII (names, phones, emails, raw OCR text) by design — only
  structural metadata (counts, dimensions, error kinds, request
  IDs). Logging in PII would be a policy regression.
- **SQLite idempotency store** — back this up if you care about
  surviving instance loss without duplicating saves on retry.
  For most demo deploys, accept the trade-off of "instance lost
  = some retries duplicate" and skip the backup machinery.
- **Process supervision** — pick whatever your platform offers
  (systemd, Docker restart policy, Render/Fly/Railway built-in).
  The backend handles graceful shutdown but expects to be
  restarted on crash.

---

## 9. First-traffic watchlist

When real users first start using the deployed photo path, watch
for these patterns. They're not bugs — they're the documented
trade-offs of the v1 model choice — but they affect what you
respond to.

- **"Reading didn't work" rate.** OpenAI GPT-5 scored 97% on the
  structural-challenge corpus in 2026-05-17 testing. Some
  user-friendly retake prompts are still expected on genuinely
  damaged photos (heavy crumple, coffee-stain, deep glare). If
  you see them on photos that look obviously clean, that's worth
  investigating — could be a prompt regression or a preprocessor
  cap (see [pitfall #25 in 05](05_agent-pitfalls.md)).
- **"No internet" false positives — now fixed via server-sent
  heartbeats.** The original 30-second blanket watchdog was a
  guess-based timer that could falsely flag a slow OpenAI call
  as a network drop. Replaced 2026-05-17 with a heartbeat
  system: the backend wraps the photo route's stream in
  `with_heartbeat` (see
  `backend/src/captureshark/api/sse_heartbeat.py`), emitting a
  tiny `event: heartbeat` SSE frame every 2 seconds while the
  upstream call is in flight. The frontend resets its watchdog
  on each heartbeat — so the watchdog now fires ONLY on true
  6+ seconds of silence (real connection drop), not on slow
  AI calls. Watchdog window is set at 3× the heartbeat interval
  (6s) so a couple of dropped beats during transient signal
  degradation don't trip a false positive. If users report
  watchdog trips on otherwise-fine connections in production,
  the right knobs are `DEFAULT_HEARTBEAT_INTERVAL_SECONDS`
  (backend, currently 2s) and `STREAM_IDLE_TIMEOUT_MS`
  (frontend, currently 6_000 ms) — keep the latter at 3-5× the
  former. The old "bump to 60s" advice no longer applies; that
  was a workaround for the absence of heartbeats.
- **Save route diagnostic logging (added 2026-05-17).** The
  `/sheets/append` route now wraps its whole body in a generic
  try/except that logs `sheets.append.unexpected_failure` via
  `logger.exception(...)` whenever an unhandled exception
  escapes the domain-error path (Google client crash, schema
  mismatch, deep null deref, etc.). The full traceback writes
  to uvicorn's stderr where the operator (or an agent reading
  the terminal) can diagnose it. The log includes structural
  metadata (`source`, `signed_in`, `has_idempotency_key`,
  `dev_path_available`) but is strictly PII-free — no names,
  phones, emails, or tokens. The caller still gets a
  well-formed JSON error envelope (`code: "sheet_save_failed"`,
  the same friendly copy the `SheetsErrorKind.UNEXPECTED` path
  produces), so the frontend renders consistent UX regardless
  of whether the error was domain-raised or an unexpected
  bolt-from-the-blue.
- **OpenAI photo cost.** ~$0.02/photo (GPT-5 minimal-reasoning at
  ~1500px). Multiply by expected daily photo volume to predict
  spend. The cost-cap middleware enforces a per-IP token bucket
  plus an optional daily $-spend kill-switch — see
  [`11_caps_and_costs.md`](11_caps_and_costs.md) for the env vars
  and recommended values.
- **Sheets API quota.** Free tier is 60 read+write requests per
  user per minute. A burst from many saves at once can hit it.
  The save endpoint backs off and retries automatically, but
  watch for `429`-flavoured save errors if you scale fast.
- **Doc AI quota** (if you flipped to the rollback). Default is
  1800 pages/minute per project on Standard tier. Plenty for any
  rollback scenario. Lives at GCP Console → IAM & Admin → Quotas
  → "Document AI API." Worth knowing exists; not worth pre-tuning.

---

## 10. Telemetry posture

Pre-launch decision (still in effect): **no analytics or
telemetry are shipped beyond live-captions structural metrics**
(no transcript text, no audio bytes, only counts + outcome). If
you add telemetry later, follow the same pattern: structural
metadata only, never PII or raw user content.

This is by design — telemetry is parked in the v2 TODO. Don't
add a Mixpanel / Segment / Amplitude SDK before having an
explicit conversation about it.

---

## 11. Multi-agent territory note

If multiple Claude agents are working this checkout in parallel
(see `01b_multi-agent-git-setup.md`), the pre-commit hooks
already prevent cross-agent contamination of the git index. The
deploy still happens off a clean `main` — squash any in-flight
agent work to its own branch / commit before tagging a release.

---

## 12. After deploy — keep this doc current

When a new env var becomes load-bearing, add it to §3. When a
new smoke check earns its keep after catching a real bug, add it
to §5. When something goes wrong in production, write the
post-incident note here under a new section so the next person
doesn't relearn it the hard way.

