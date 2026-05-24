# CaptureShark — Backend

FastAPI service that handles AI extraction (text / voice / photo) and orchestrates writes to the user's Google Sheet.

Architecture: hexagonal — `domain/` is pure, `adapters/` implement ports, `services/` orchestrate, `api/` is thin. Photo-capture wire contract in [`/docs/_spec/photo_capture.md`](../docs/_spec/photo_capture.md). Live-captions pipeline in [`/docs/_spec/live_captions.md`](../docs/_spec/live_captions.md).

## Local development

Dependency tool: [`uv`](https://docs.astral.sh/uv/) (fast, reproducible, lockfile-driven).

```bash
# from the repo root
cd backend

# install dependencies into .venv (auto-creates the virtualenv)
uv sync --extra dev

# run the dev server
uv run uvicorn captureshark.main:app --host 127.0.0.1 --port 8002 --reload
```

Health check:

```bash
curl http://127.0.0.1:8002/api/v1/health
# {"status":"ok","service":"captureshark","version":"0.1.0"}
```

## Layout

```
backend/
├── pyproject.toml
├── src/captureshark/
│   ├── main.py                FastAPI app entry; mounts routers
│   ├── config.py              pydantic-settings, reads root .env
│   ├── domain/                pure: no I/O, no framework imports
│   ├── adapters/              implement domain ports (OpenAI, Google Sheets)
│   ├── services/              use cases (orchestrate domain + adapters)
│   └── api/
│       ├── routes/            thin FastAPI routers
│       ├── schemas.py         HTTP DTOs (≠ domain models)
│       └── deps.py            Depends() factories for DI
└── tests/
    ├── unit/
    └── integration/
```

## Conventions

- `domain/` imports nothing from `adapters/`, `services/`, or `api/`.
- `api/` routers are thin: deserialize → call service → serialize. No business logic.
- HTTP DTOs in `api/schemas.py` are not domain models — convert at the boundary.
- Errors as data (Result-style) inside domain + services. Only the API layer maps to HTTP.
- Never log raw PII (names, phones, emails). Log capture IDs and structural metadata only.

## Tooling

- Format + lint: `uv run ruff check . && uv run ruff format .`
- Type-check: `uv run mypy src`
- Test: `uv run pytest`
