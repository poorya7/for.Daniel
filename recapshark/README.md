# RecapShark

YouTube URL → summary, chapters, transcript, and chat — powered by GPT,
with translation into 100+ languages and bilingual transcript display.

Live at [recapshark.com](https://recapshark.com).

---

## About this repo

This is a code-review sample, not the full production source. The
working application is intact and runnable end-to-end with sensible env
vars, but a few pieces have been intentionally trimmed:

- `pipeline/karaoke/` — the word-level subtitle-alignment module (chunked
  transcription with cost-aware per-IP billing + range-fetched audio
  backfill) is replaced with a router stub. All karaoke endpoints
  respond `501 Not Implemented`.
- `pipeline/prompts.py` — the LLM prompt templates are stripped-down
  placeholders. The module shape (constant names, format templates,
  casual/formal split) matches production so call sites are unchanged.
- Provider brand names for the subs / ASR / TTS layers are referred to
  by their generic roles (`SubsProvider`, `AsrProvider`, `TtsProvider`)
  rather than their actual vendor names.

Everything else — frontend, tests, build config, ETL, analytics dashboard,
the rest of the pipeline — is the real code.

---

## Code tour (start here)

If you only read two things, read `01_ARCHITECTURE.md` for the pipeline
shape and `REFACTORING_LESSONS.md` for how the code is organized today.
Everything else below is the recommended order once those frame the
picture.

1. **`docs/_tech/01_ARCHITECTURE.md`** — pipeline flow, file responsibility
   table, frontend / backend split. The best single-file overview.
2. **`docs/_tech/REFACTORING_LESSONS.md`** — durable lessons from the
   four-cycle SRP refactor that broke up the original monolithic
   `routes.py` / `analytics_routes.py` / `karaoke_routes.py`. Probably
   the clearest signal of how the code is organized today.
3. **`pipeline/config.py`** — single source of truth for env-var reads.
   Lazy-getter pattern (with the bug that motivated it documented in
   the module docstring).
4. **`pipeline/server.py`** + **`pipeline/routes.py`** — FastAPI entry
   point + the route surface. Routers are aggregated from subpackages
   (`karaoke/`, `analytics/`) and leaf modules.
5. **`src/js/main.js`** — frontend entry point. Boot bridges
   (`core/sentry.js`, `core/assets.js`) intentionally run inline before
   other modules to avoid module-eval ordering bugs.
6. **`src/js/orchestrator/`** — pipeline coordination on the frontend.
   `process-url.js` is the orchestrator; `*-fetch.js` / `*-view.js` /
   `*-state.js` are the split-responsibility helpers.
7. **`docs/_tech/14_TESTING_HARNESS.md`** + **`tests/e2e/`** — Playwright
   test suite. Real golden-path coverage for paste → pipeline →
   language switch → bilingual → karaoke seek → chat.

---

## Stack

- **Backend:** FastAPI (Python 3.13) on uvicorn, single-worker, behind
  PM2 + nginx
- **Frontend:** Vanilla JS ES modules, Vite build, no framework
- **DB:** Supabase Postgres for sessions / chat history / owner identity
- **Analytics:** GA4 → BigQuery hourly ETL → Supabase cache → local
  dashboard
- **LLM:** OpenAI (gpt-4o-mini default; gpt-4o for an advanced-model
  language set)
- **Observability:** Sentry (frontend + backend), structured logs
- **Process supervisor:** PM2 (`ecosystem.config.js`)

---

## Running locally

```bash
# Frontend
npm install
npm run dev                # vite, http://localhost:5173

# Backend
cd pipeline
python -m venv venv
venv/bin/pip install -r requirements.txt
cp .env.example .env       # fill in OPENAI_API_KEY etc.
uvicorn server:app --reload --port 8001

# Tests
npm run test:e2e           # Playwright e2e
pytest tests/pipeline      # backend tests
```

A `.env.example` lists the env vars the pipeline expects. With at minimum
`OPENAI_API_KEY` set (and the karaoke stubs returning 501), the summary /
chapters / chat / translation paths run end-to-end against a real video.

---

## License

UNLICENSED — all rights reserved. This sample is shared for code-review
purposes only. See `LICENSE`.
