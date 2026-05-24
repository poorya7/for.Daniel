# Caps & costs — what's capped, what's monitored

**Read before any deploy that opens the app to real traffic.** This doc
explains the cost-cap architecture; specific dollar figures and per-call
cost estimates have been stripped for this code-review sample.

CaptureShark is pre-launch and demo-realistic. There's one paid line
(OpenAI vision/audio) and a kill-switch already shipped.

---

## Current external services

| Service | What it does | Pays | Status |
|---|---|---|---|
| OpenAI | Text extraction, voice transcription, photo extraction | Per-call | Live, the only real cost line |
| Google OAuth / Sheets / Drive Picker | User sign-in + writing to the user's own sheet | Free (quota-based) | Live |
| Live-captions ASR | Live captions during voice capture | Per-second | Code-shipped, default OFF until paid-tier opt-out lands |
| Google Document AI | Photo OCR rollback target | Per-page | Wired but not the default |
| Cloudflare Tunnel | Mobile dev access | Free | Live |

---

## The cost-cap middleware (what's shipped today)

Per-IP token bucket + daily $-spend kill-switch, in-memory, single
process. Lives at
[`backend/src/captureshark/api/middleware/cost_cap.py`](../../backend/src/captureshark/api/middleware/cost_cap.py)
and is wired into
[`backend/src/captureshark/main.py`](../../backend/src/captureshark/main.py).

### Per-IP rate limit

Two-bucket leak: per-minute + per-hour. Both configurable via env
(`RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_PER_HOUR`). Returns HTTP 429 with
`code: "rate_limited_ip"` when either overflows. Defaults are tuned for
a real broker doing rapid-fire field capture; lethal for a bot loop.

### Daily $-spend kill-switch

Cumulative estimated USD spend per UTC day. When exceeded, every
`/captures*` request returns HTTP 429 with `code: "daily_spend_capped"`
until 00:00 UTC. Default is `None` = OFF (safe for dev). For any
production deploy, this MUST be set.

### What it doesn't cover (yet)

- **Per-user caps** — no user accounts yet. When auth-by-user lands, add
  a per-user-daily-credit cap alongside the per-IP one.
- **Vendor dashboard budget** — second line of defence against estimate
  drift. Recommend a low monthly soft alert + auto-recharge OFF.
- **Inbound abuse** — no auth on `/captures*` means the per-IP cap is
  the only mitigation. Authn or a static API-token header is a v2 move.

---

## Pre-launch watchlist

Before opening to real traffic:

- [ ] Set the daily spend cap in production `.env`.
- [ ] Confirm `auto recharge = OFF` in the vendor dashboard.
- [ ] Configure vendor dashboard alerts at 50% / 75% / 100% of the
      monthly budget.
- [ ] Verify live-captions is OFF until paid-tier opt-out is on file.
      Free-tier audio is training-eligible per their ToS.

---

## Upgrade triggers

When real traffic shows up, the next moves are well-defined:

| Signal | Action |
|---|---|
| Daily spend regularly hits the cap | Raise the cap after confirming volume is legit |
| Multi-worker uvicorn deploy needed | Replace in-memory state with Redis-backed limits |
| Real user accounts ship | Add per-user-daily-credit cap as a second axis |
| Vendor cost above a threshold | Review per-call cost estimates against actual `usage` field |
| Live captions flipped back ON | Add an ASR daily-second cap in the same middleware |
