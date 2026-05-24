import os
from pathlib import Path
from openai import OpenAI

from config import openai_api_key


def get_client() -> OpenAI:
    # Defensive .env load: server.py loads .env before importing routes, so
    # the production code path doesn't need this — but ad-hoc scripts that
    # `from openai_client import get_client` without going through server.py
    # boot would otherwise see OPENAI_API_KEY=''. setdefault preserves the
    # shell-env-wins-over-.env semantic used everywhere else in this codebase.
    project_root = Path(__file__).resolve().parent.parent
    env_path = project_root / ".env"

    if env_path.exists():
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, val = line.split("=", 1)
                    os.environ.setdefault(key.strip(), val.strip())

    key = openai_api_key()
    if not key:
        raise RuntimeError("OPENAI_API_KEY not found")

    return OpenAI(api_key=key)
