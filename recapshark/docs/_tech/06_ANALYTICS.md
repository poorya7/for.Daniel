# RecapShark — Analytics System

## Overview

RecapShark uses **Google Analytics 4 (GA4)** for client-side event tracking →
**BigQuery** for raw event-level data (auto-export from GA4) → **Supabase
Postgres** for a precomputed `rs_sessions` cache → a local dashboard at
`/api/analytics/bq/dashboard`. A separate Supabase table captures chat text
that GA4 isn't allowed to see (PII / GA4 ToS), feeding into per-session
prose narratives.

**Pipeline (one direction):**

```
GA4 (browser tags)  ──► BigQuery auto-export       ┐
                        events_YYYYMMDD             │  ETL (hourly cron, droplet)
                        events_intraday_YYYYMMDD    │  python -m pipeline.etl_sessions 2
                                                    │
chat input (browser) ─► POST /api/analytics/chat/log ─► Supabase rs_chat_messages
                                                    │
                                                    ▼
                                          Supabase rs_sessions ──► dashboard
                                                                    (local only,
                                                                     port 8001)
```

**GA tracking added:** March 2026
**Analytics V2 (BigQuery + Supabase + narratives) shipped:** April 2026

### GA4 properties (dev/prod split)

| Property | Measurement ID | Used when | BigQuery export |
|---|---|---|---|
| **Prod** | `G-YYYYYYYYYY` | non-localhost hosts | ✅ on — daily + streaming intraday |
| **Dev** | `G-XXXXXXXXXX` | `localhost`, `127.0.0.1`, `192.168.*`, `10.*` | ❌ off (cost-saving — dev events aren't analyzed) |

**Selection logic** lives in `src/index.html` `<head>`. The hostname regex
picks the ID before `gtag.js` is loaded, so every event automatically routes
to the correct property. Both IDs are inlined — Measurement IDs are public
by design (visible in any browser's Network tab).

**Why the split exists:** before it, localhost testing polluted the prod
BigQuery dataset, making owner filtering hard. After, prod BQ contains only
real visitor data; owner filtering only has to handle the rare case of
testing prod from a real device.

**GA4 Property ID (prod, for BigQuery API):** `<omitted>`

---

## Events Tracked

All events are fired via `gtag()` in `src/js/analytics/analytics.js`.

| Event Name | Parameters | What It Tracks |
|---|---|---|
| `video_processed` | `video_id`, `video_title` | User loads a video for processing |
| `language_changed` | `selected_language` | User picks a translation language |
| `tab_switched` | `tab` | User switches between summary/transcript/subtitles/chat |
| `chat_sent` | `message_length` | User sends a chat message (length only — text goes to Supabase) |
| `chapter_clicked` | `chapter_index`, `chapter_title_length` | User clicks a chapter (length only — title text omitted as PII) |
| `transcript_search` | `query_length`, `has_question_mark`, `word_count` | User searches in transcript (no raw text — PII boundary) |
| `theme_changed` | `mode`, `theme_name` | User changes theme |
| `casual_mode_toggled` | `enabled` | User toggles casual/formal mode |
| `export_opened` | — | User opens export dialog |
| `export_selected` | `format` | User picks an export format |
| `export_confirmed` | `format` | User confirms export |
| `profile_menu_opened` | — | User opens profile menu |

Plus owner-flag merging: when the owner is logged in (Supabase Auth) or on
a known dev host, every event auto-merges `is_owner: 'true'`,
`owner_source: 'login' | 'local_dev'`, `owner_set_at: <iso>`.

### PII boundary

GA4 only ever sees enums + counts + lengths. Free-form text (chat questions,
search queries) never leaves the browser as a GA4 event param — it either
stays client-side or goes to our own Supabase store via authenticated API.

### Parameter rename history

- `language` was renamed to `selected_language` on 2026-04-02 because
  `language` is a reserved GA4 parameter (browser locale). Old events
  still have the built-in `language` value, not the user-selected language.
- `query` (raw search text) was replaced with
  `query_length` / `has_question_mark` / `word_count` in Phase 0.2
  (2026-04-21) to remove a PII leak.

---

## Data sources

### 1. BigQuery — primary source for V2

- **Linked:** 2026-04-02 (daily export, US region)
- **Streaming intraday:** enabled 2026-04-22 (Phase 4d) — today's events land
  in `events_intraday_YYYYMMDD` within ~minutes
- **Project / dataset:** `gcp-PROJECT-ID.analytics_PROPERTY_ID`
- **Tables read by ETL & dashboard:**
  - `events_YYYYMMDD` — daily, lands ~24-72h after the day ends
  - `events_intraday_YYYYMMDD` — today's data, streaming
- **SQL helper:** the `SUFFIX_WHERE` constant in
  `pipeline/analytics/filters.py` and `pipeline/etl_sessions.py` matches
  both shard types in one filter.
- **Auth:** service account `recapshark-analytics@gcp-PROJECT-ID.iam.gserviceaccount.com`
- **Key file:** `pipeline/service-account.json` (gitignored on local,
  copied to droplet via SCP — never via git)
- **Cost:** free tier covers RecapShark's traffic comfortably.

### 2. Supabase Postgres — precompute + privacy-protected stores

| Table | Purpose | Populated by |
|---|---|---|
| `rs_sessions` | One row per `(user_pseudo_id, ga_session_id)`. Aggregated meta + full `raw_events JSONB` blob + generated `narrative` text. Also carries `traffic_source` / `traffic_medium` / `landed_via` (added 2026-04-22, see `pipeline/migrations/2026_04_22_add_traffic_source_and_video_lang.sql`) and `video_lang` for the source language of the pasted video. | `pipeline/etl_sessions.py` (hourly cron) |
| `rs_etl_runs` | Audit log of every ETL run (id, started_at, finished_at, status, rows_read/written, error). Drives dashboard "Last sync" badge. | ETL writes one row per run |
| `rs_owner_identities` | Confirmed (and suspected, `confirmed=false`) owner `user_pseudo_id`s. | Owner-scan endpoint (auto-confirms strong-signal hits) |
| `rs_owner_user_ids` | Stable Supabase user UUIDs registered as owner accounts. The cross-device anchor that makes pseudo-ID detection robust to Safari ITP rotation. | One-time SQL insert per owner account |
| `rs_revoked_owner_ids` | Pseudo IDs explicitly marked "not the owner". Scan skips these forever. | Manual revoke (currently API-only) |
| `rs_chat_messages` | Raw chat text (user_pseudo_id, ga_session_id, sent_at, message, page_url, user_agent). 4000-char cap per message. | `POST /api/analytics/chat/log` (fire-and-forget from `chat.js`) |
| `rs_video_titles` | YouTube oEmbed cache (video_id PK, title, channel, fetched_at). Forever cache. | `pipeline/video_titles.py` on first lookup |

**Auth:** service-role key on the backend (`SUPABASE_SERVICE_ROLE_KEY`) for
writes; anon key for any future public reads. Both in `.env`.

### 3. Hourly ETL — `pipeline/etl_sessions.py`

- **Cron:** PM2 `etl-sessions` process on the droplet, fires at `:05` every
  hour (`--cron-restart "5 * * * *"`, `--no-autorestart`).
- **Window:** last 2 days (today + yesterday). Idempotent — re-running just
  upserts.
- **What it does:** one BQ aggregation query → groups by
  `(user_pseudo_id, ga_session_id)` → joins with chat text + video titles +
  visit history → builds narrative → upserts into `rs_sessions`.

#### Schema migrations

The `rs_sessions` schema lives in Supabase (managed via the SQL editor, not
Alembic). Migration files in `pipeline/migrations/` are run **manually** before
deploying the matching ETL/route changes. Each file is idempotent
(`ADD COLUMN IF NOT EXISTS` etc.) so re-running is safe.

| When | File | Adds |
|---|---|---|
| 2026-04-22 | `pipeline/migrations/2026_04_22_add_traffic_source_and_video_lang.sql` | `traffic_source`, `traffic_medium`, `landed_via`, `video_lang` columns + indexes on `landed_via` and `device`. **Run this before bumping the ETL** or the next ETL run will fail with "column does not exist" on the upsert. |

**Backfill strategy after this migration:**
- `traffic_source` / `traffic_medium` / `landed_via`: re-run the ETL for the
  past N days you care about (`POST /etl/sessions/run?days=30`); GA4 has the
  raw data so the columns will populate retroactively.
- `video_lang`: **cannot be backfilled** — historical sessions never fired the
  `video_lang_detected` event. Only sessions starting after the frontend deploy
  will have this populated.

### 4. GA4 Web UI (Explorations)

- **URL:** https://analytics.google.com/analytics/web/#/analysis/aXXXXXXXXXpYYYYYYYYY
- **User Explorer:** per-user event streams, location, device.
- **Free Form:** custom tables.
- Only useful for ad-hoc poking — the V2 dashboard reads from BQ/Supabase
  directly, not from this UI.

### Deprecated sources (removed 2026-04-22)

The old V1 stack — `pipeline/analytics_routes.py` (GA4 Data API dashboard at
`/api/analytics/dashboard`), `pipeline/pull_analytics.py` (CSV puller), and
`pipeline/parse_logs.py` (PM2 server-log parser) — was deleted as part of the
Phase 8 cleanup. All analytics now flow through the V2 pipeline documented
above.

---

## Local Dashboard

**URL:** `http://localhost:8001/api/analytics/bq/dashboard`
**Auth:** none locally (the global API token middleware short-circuits when
`RECAPSHARK_API_TOKEN` is empty in the local `.env`).
**Production access:** intentionally blocked. The dashboard URL on
`recapshark.com` returns `{"detail": "Forbidden"}` because the token
middleware can't be passed via a browser URL bar. This is by design —
analytics aren't exposed to the public internet. Owner views the dashboard
locally; Supabase is shared with prod, so local sees fresh prod data
automatically.

### Data flow

```
browser ──► GET /api/analytics/bq/dashboard               (HTML page)
            GET /api/analytics/bq/dashboard/bundle?days=N (one call,
                  returns {overview, sessions, users, etl} in parallel)
                                                          │
            GET /api/analytics/bq/feed                ────┤── reads from
            GET /api/analytics/bq/timeline/{uid}      ────┼── Supabase rs_sessions
            GET /api/analytics/bq/users/{uid}         ────┘   (60s TTL cache)
                                                              BQ fallback for any
                                                              row not yet ETL'd
```

### Bundle endpoint + in-memory cache (Phase 8a)

`GET /dashboard/bundle` is the primary load path. Server fans out
`overview` / `sessions` / `users` / `etl` sub-fetches in parallel
(`asyncio.gather`) and returns a single JSON payload. Frontend caches the
result keyed by the full filter query string and renders **both** the
Sessions and Users tab panes from cache on first paint, so tab switches and
filter-preserving clicks are instant (no spinner, no network call).

A silent background refresh re-fetches the bundle for the active filter
every 30 minutes, and immediately when the tab regains visibility if the
cached data is older than 5 minutes. Skeleton placeholders cover the only
remaining loading state — the very first fetch on page open.

The Live Feed tab is intentionally excluded from the bundle and still
hits `/feed` on demand — it's the one place where truly fresh data
matters more than instant tab switching.

The individual `overview` / `sessions` / `users` / `etl/runs` endpoints
still exist (the bundle wraps them) and are used as a fallback path if
the bundle call ever fails.

### Tabs

1. **Sessions** (default) — per-session cards, newest first. Each card shows
   relative time, event count, duration, location pill, device pill, video
   chips, suspect chip if applicable, and a 1-3 sentence prose narrative
   ("Visit #3 (first was 2 days ago). Came in via direct link, watched
   MrBeast, asked 2 questions, left after 4 min."). Click to expand the
   full event timeline (cached after first open).
2. **Users** — paginated table of unique `user_pseudo_id`s. Click a UID
   badge to open the cross-visit profile modal (aggregate stats + every
   session for that visitor, each with the same narrative).
3. **Live Feed** — raw event firehose, kept for real-time debugging.

### Hero block

4-card grid at the top: `Unique visitors` (huge), `Sessions`, `Events`,
`Countries`. All driven by one `/overview` BQ scan, respecting the same
date range + filters.

### Date pills

`[Today] [3d] [7d] [30d] [90d]`. Pills change `?days=N` on every tab fetch.

### Filters

- **Hide me** — filters out confirmed owner pseudo IDs (default ON)
- **Show suspected** — toggles visibility of `confirmed=false` rows in
  `rs_owner_identities` (default ON; see Owner Filtering below)
- **Hide unknown cities** — drops rows with city `(not set)`
- **City / country exclusion lists** — multi-select dropdowns
- **Source toggle** (`auto` / `supabase` / `bq`) — debug tool to force a
  data path. Default `auto` = Supabase first, BQ fallback.

### Footer health badge

Reads `/etl/runs?limit=1` and color-codes:
- 🟢 success and < 36 h old (cron healthy)
- 🟡 success but ≥ 36 h old (cron slipped)
- 🔴 last run errored or `/etl/runs` itself unreachable

Hover shows the timestamp + row count or the error message. A second pill
next to it shows whether the active tab's data came from Supabase or fell
back to live BQ.

---

## Owner Filtering

Multi-layer, biased toward **showing** sessions (false positives — hiding
real visitors — are more costly than false negatives).

### Layer 1 — Owner Supabase Auth (Phase 1.2)

Owner has a Supabase account (`owner@example.com`). On any device,
visiting `/owner-login.html` and signing in:

1. Stores a Supabase session in `localStorage` (`@supabase/supabase-js`
   default).
2. `initOwnerAuth()` checks email matches `OWNER_EMAIL`, then sets:
   - `localStorage.rs_is_owner = '1'`
   - cookie `rs_is_owner=1; Max-Age=31536000; SameSite=Lax`
3. Every analytics event from that browser auto-merges
   `is_owner: 'true'`, `owner_source: 'login'`.

Sign out via the same page calls `supabase.auth.signOut()`. The
`?owner=clear` URL trigger wipes the local flags without ending the
Supabase session.

### Layer 2 — Local-dev auto-flag (Phase 1.1)

Hostname regex in `analytics.js` matches `localhost`, `127.0.0.1`,
`192.168.*`, `10.*` → same flag set with `owner_source: 'local_dev'`.
Mostly redundant after the GA4 dev-property split; kept as
belt-and-suspenders.

### Layer 3 — Supabase-resolved pseudo-ID filter (Phase 1.3 + 1.5)

`rs_owner_identities` holds the canonical list. The dashboard's BQ query
filters out every `user_pseudo_id` where `confirmed=true`:

```sql
WHERE user_pseudo_id NOT IN UNNEST(@owner_user_pseudo_ids)
```

The list is TTL-cached (60s) in `pipeline/supabase_owner_store.py` so the
filter costs ~1 round-trip per minute, not per request. Originally a
hardcoded Python list; deleted in Phase 1.5 — Supabase is the only source
of truth now.

### Layer 4 — Stable owner user_id anchor (2026-04-22)

The previous layers identified the owner by `user_pseudo_id` (a GA4 cookie).
Safari ITP clamps that cookie to ~7 days max and often rotates it sooner
under aggressive cross-site tracking heuristics. Field measurement on a
single iPhone Safari device showed **22 distinct pseudo_ids in 7 days** —
each one looks like a brand-new visitor unless we manually mark each one as
the owner. That doesn't scale.

Layer 4 fixes the root cause by adding a **stable identifier** the owner
controls: their Supabase user UUID. That UUID never rotates, survives ITP,
survives VPN switches, survives `localStorage.clear()`, survives a phone
swap (re-login restores it). The pipeline:

1. **Frontend** — `owner-auth.js` reads `session.user.id` from Supabase Auth
   on login (or session rehydrate) and writes it to
   `localStorage.rs_owner_user_id`.
2. **Frontend** — `analytics.js` reads that key inside `getOwnerParams()`
   and adds `owner_user_id: '<uuid>'` to every GA4 event the device sends.
3. **Backend** — `rs_owner_user_ids` (one row per owner account) is the
   allow-list of UUIDs that count as owner.
4. **Backend** — the `/owners/scan` query is two-signal: it surfaces
   pseudo_ids that have *either* a legacy `is_owner='true'` event **or** an
   `owner_user_id` event-param matching a known owner UUID.
5. **Auto-confirm** — pseudo_ids matched by the **strong** signal
   (owner_user_id) are upserted as `confirmed=true` directly. Pseudo_ids
   matched only by the weak signal (`is_owner='true'` alone, no UUID — e.g.
   sessions from before this layer landed) stay `confirmed=false`
   (suspected) for operator review.

Net effect: any new pseudo_id Safari mints for a logged-in owner is
auto-confirmed within one scan tick. Zero manual click per pseudo_id.

The scan runs **automatically every hour** as part of the `etl-sessions`
PM2 cron (`pipeline/etl_sessions.py` calls `owner_routes.run_owner_scan`
before its session aggregation). A scan failure is logged but never breaks
the session ETL — owner filtering being an hour stale is a smaller harm
than the dashboard losing fresh sessions.

### One-time setup per owner account

Run this once in the Supabase SQL editor with your own user UUID
(grab it from the Supabase Dashboard → Auth → Users, or by reading
`localStorage['rs-supabase-auth']` in DevTools after logging in):

```sql
CREATE TABLE IF NOT EXISTS rs_owner_user_ids (
  user_id    TEXT PRIMARY KEY,
  note       TEXT,
  added_at   TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO rs_owner_user_ids (user_id, note)
VALUES ('<your-supabase-user-uuid-here>', 'primary owner account')
ON CONFLICT (user_id) DO NOTHING;
```

After this, every device where you've logged in as owner will have its
pseudo_ids auto-discovered + auto-confirmed by the next `/owners/scan`
tick, regardless of how often Safari rotates them.

### Suspected-owner UX (legacy weak-signal hits)

For backward compatibility, sessions that fired `is_owner='true'` *without*
an `owner_user_id` (older builds, or when the owner browsed without being
logged in) still get inserted as `confirmed=false` (suspected). These are
operator-reviewable via the API:

- `POST /api/analytics/bq/owners/{id}/confirm` → promote to confirmed.
- `POST /api/analytics/bq/owners/{id}/revoke` → move to `rs_revoked_owner_ids`.

The dashboard surfaces a yellow "⚠ suspected" chip on these rows; clickable
confirm/revoke buttons in the UI are still on the roadmap (until then, hit
the API directly via `curl` or Postman).

### Why two signals

Belt-and-suspenders. The strong (UUID) signal is precise but only fires
when the owner is logged in at event time. The weak (is_owner cookie)
signal still fires from sessions where the cookie persists but the
Supabase JWT has expired — those legacy events shouldn't be silently lost.

---

## Narrative engine (`pipeline/narrative.py`)

Pure template, no LLM. Walks `raw_events` for one session and emits 1-3
sentences. Pulls in:

- **Visit context** — first visit / Visit #N (first was 2 days ago) — from
  `supabase_sessions_store.fetch_visit_history`.
- **Arrival** — relative time, city, device.
- **Per-tab dwell time** — computed from `tab_switched` deltas.
- **Video pasted** — title + channel from `rs_video_titles` (YouTube
  oEmbed, cached forever).
- **Chat questions** — up to 3 verbatim, smart-quoted, capped at 160 chars
  each, "and N more" trailer. Pulled from `rs_chat_messages`.
- **Language changes, theme/chapter/search counts.**
- **Departure** — relative time + duration.

Generated inside the ETL (`_attach_narratives`) so it's written into
`rs_sessions.narrative` once per session and rendered as static text by
the dashboard.

LLM polish (Phase 5f) is reserved as a future option, with sanitized
inputs only.

---

## Scripts & Files

### Active (V2)

| File | Purpose |
|---|---|
| `pipeline/analytics/` | Subpackage owning all `/api/analytics/bq/*` endpoints (split out of the old `bq_analytics_routes.py` in cycle 2 of the SRP refactor — 2026-05-06). Contains: `__init__.py` (shared FastAPI router), `bq_client.py`, `filters.py`, `owner_resolver.py`, `pagination.py`, `response_cache.py`, `feed.py` (facets + live feed), `overview.py`, `users.py` (users + timeline + profile + per-user sessions), `sessions_list.py`, `session_detail.py`, `dashboard.py` (HTML page + parallel-fetch bundle endpoint), `templates/dashboard.html` (extracted UI template). The original `pipeline/bq_analytics_routes.py` was deleted in the same cycle once the last caller (`routes.py`) was re-pointed at this package. |
| `pipeline/etl_sessions.py` | Hourly BQ → Supabase ETL (CLI + module) |
| `pipeline/owner_routes.py` | Owner confirm/revoke/scan endpoints |
| `pipeline/supabase_owner_store.py` | TTL-cached reads from `rs_owner_identities` / `rs_owner_user_ids` / `rs_revoked_owner_ids` |
| `pipeline/supabase_sessions_store.py` | TTL-cached reads from `rs_sessions` + visit history |
| `pipeline/narrative.py` | Template-based session narrative generator |
| `pipeline/video_titles.py` | YouTube oEmbed lookup + Supabase cache |
| `pipeline/chat_log_routes.py` | `POST /api/analytics/chat/log` endpoint |
| `pipeline/chat_messages_store.py` | Bulk fetch chat text by `(uid, ga_session_id)` for ETL |
| `src/js/owner/owner-auth.js` | Supabase Auth init + owner flag wiring |
| `src/js/owner/supabase-client.js` | Supabase JS client singleton (`@supabase/supabase-js`) |
| `src/owner-login.html` | Owner login/logout UI |
| `src/privacy.html` | Privacy disclosure page — GA4, Supabase, all 9 third-party processors, GDPR/CCPA notice |
| `pipeline/service-account.json` | GCP service-account key (gitignored) |

### Removed (V1, deleted 2026-04-22)

The V1 stack (`pipeline/analytics_routes.py`, `pipeline/pull_analytics.py`,
`pipeline/parse_logs.py`) was deleted along with its `routes.py` mount as
part of the Phase 8 cleanup. Any leftover `analytics_data/*.csv` or
`parsed_logs.json` snapshots on a local machine are inert and can be deleted
freely.

---

## Required `.env` variables

| Variable | Used by |
|---|---|
| `SUPABASE_URL` | All Supabase HTTP clients |
| `SUPABASE_ANON_KEY` | `owner_routes.py` (anon-readable lookups) |
| `SUPABASE_SERVICE_ROLE_KEY` | `supabase_owner_store.py`, `supabase_sessions_store.py`, ETL writes |
| `RECAPSHARK_BQ_KEY_PATH` | Optional — overrides default path to the GCP key file |

The standard `RECAPSHARK_API_TOKEN`, `OPENAI_API_KEY`, etc. are also
required by the rest of the FastAPI app.

---

## Architectural decisions worth not re-litigating

1. **Dashboard is local-only by design.** Production blocks browser access
   via the global API token middleware. Don't reopen unless you actually
   want public dashboard access.
2. **Templates beat LLM for narratives.** Cheaper, faster, deterministic,
   no PII risk.
3. **Owner filtering uses semi-manual confirm UI, not auto-learning.**
4. **Storage hierarchy:** GA4 = pipe (no raw text), BigQuery = warehouse
   (don't query on hot path), Supabase = OLTP store (read from here).
5. **Don't send free-form text to GA4.** Lengths and shape only.
6. **`user_pseudo_id` is the canonical owner-identity key.** Don't invent
   parallel names.

---

---

## Last Updated

2026-05-06 — file inventory refreshed after cycle 2 of the SRP refactor split
`bq_analytics_routes.py` into the `pipeline/analytics/` subpackage.
