# CaptureShark

Mobile-first lead-capture app. Real-estate agents (and similar field
roles) capture leads three ways — **photo** of a paper sign-in sheet,
**voice** dictation, or **text** entry — and the structured contact info
lands in the agent's own Google Sheet within seconds.

Currently pre-launch.

---

## About this repo

This is a code-review sample, not the full production source. The
working application is intact and runnable end-to-end with sensible env
vars, but a few pieces have been intentionally trimmed:

- `backend/src/captureshark/prompts/vision_extraction_v1_3_1.txt` — the
  production vision-extraction prompt (the result of multiple weeks of
  iteration against the bake-off corpus + live testing) is stubbed. The
  loading shape is unchanged, so adapter call sites work.
- `docs/_dev/11_caps_and_costs.md` — specific dollar figures and per-call
  cost estimates are stripped. The architecture (per-IP rate limit +
  daily $-spend kill-switch + upgrade triggers) is intact.
- `docs/_tests/` — the raw bake-off corpora (vision + STT eval data,
  prompt-eval sessions, sample inputs) are not included. The bake-off
  methodology + the resulting decisions are documented in
  `docs/_dev/07_photo-model-bakeoff.md`.

Everything else — frontend, backend, hexagonal architecture, tests,
build config, docs (architecture specs, dev setup, agent pitfalls,
testing harness) — is the real code.

---

## Code tour (start here)

If you only read three things, read `docs/_dev/00_README.md` for the
docs map, `docs/_spec/photo_capture.md` for the locked architecture,
and `docs/_dev/07_photo-model-bakeoff.md` for the model-selection
history. Everything below is the recommended order once those frame
the picture.

1. **`docs/_dev/00_README.md`** — the docs index. Tells you which
   numbered file to open for which task.
2. **`docs/_workflow/02_PRINCIPLES.md`** — the persona + the perf bar
   + the one-decision-at-a-time discipline. The lens every UX decision
   is filtered through.
3. **`docs/_spec/photo_capture.md`** — locked tech reference for the
   photo flow: SSE per-row contract, mandatory preprocessor, capability
   guard, error model, failure semantics.
4. **`docs/_spec/live_captions.md`** — voice path tech reference: ASR
   bake-off, temp-token mint architecture, fallback to Whisper batch.
5. **`docs/_dev/07_photo-model-bakeoff.md`** — the vision-provider
   bake-off (6 models × 3 photo tiers), the Doc AI 24-hour ship +
   unship story, the GPT-5 minimal-reasoning replacement that's live in
   prod.
6. **`backend/src/captureshark/`** — hexagonal layout. `domain/` is
   pure, `adapters/` implement ports, `services/` orchestrate, `api/`
   is thin. Start at `main.py` for the FastAPI entry, then `api/deps.py`
   for DI wiring.
7. **`backend/src/captureshark/api/middleware/cost_cap.py`** — per-IP
   token bucket + daily $-spend kill-switch. The actual cap numbers
   are stripped (see `docs/_dev/11_caps_and_costs.md`); the pattern is
   intact.
8. **`frontend/src/`** — Vite + React + TypeScript. Feature folders
   under `features/`, reusable building blocks under `components/`,
   stores under `stores/`, app-state machine + queue in `lib/queue/`.
9. **`docs/_dev/05_agent-pitfalls.md`** — accumulated traps across the
   repo (photo, voice, live-captions). The kind of thing only a real
   build produces.

---

## Stack

- **Backend:** FastAPI (Python 3.12+) + uvicorn, hexagonal architecture
- **Frontend:** Vite + React + TypeScript, mobile-first
- **DB:** SQLite (via SQLAlchemy + Alembic) for auth / session / token store
- **Vision:** OpenAI GPT-5 with `reasoning_effort="minimal"` (Doc AI
  kept in-tree as one-flag rollback target)
- **Voice:** AssemblyAI Universal-3 Pro streaming (live captions) with
  Whisper batch as fallback
- **Auth:** Google OAuth (for the Sheets write path)
- **Dep tool:** [`uv`](https://docs.astral.sh/uv/) (backend),
  [`pnpm`](https://pnpm.io/) (frontend)

---

## Running locally

```bash
# Frontend
cd frontend
pnpm install
pnpm dev                   # http://localhost:5174

# Backend
cd backend
uv sync --extra dev
cp ../.env.example ../.env  # fill in OPENAI_API_KEY etc.
uv run uvicorn captureshark.main:app --host 127.0.0.1 --port 8002 --reload

# Tests
cd backend && uv run pytest
cd frontend && pnpm test
```

`.env.example` lists the env vars the backend expects. With at minimum
`OPENAI_API_KEY` + the Google service-account credentials wired up (see
`docs/_dev/01_sheets-dev-setup.md`), the text + voice + photo paths run
end-to-end against a real photo.

---

## License

UNLICENSED — all rights reserved. This sample is shared for code-review
purposes only.
