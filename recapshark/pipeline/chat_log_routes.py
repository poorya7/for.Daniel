"""
Chat-message logging endpoint.

Why a separate endpoint instead of pushing chat text into GA4:
  * GA4 ToS forbids personally identifiable information / free-form user input
    in event parameters. Chat questions are exactly that.
  * GA4 caps event-param strings at ~100 chars anyway.
  * Storing in our own Supabase keeps full control + makes deletion requests
    trivial (one DELETE row).

Wire-up: POST /api/analytics/chat/log
  body: { user_pseudo_id, ga_session_id, message, page_url? }

The frontend sends this in fire-and-forget mode alongside the existing
`chat_sent` GA4 event (which still carries length only). If this endpoint is
down or returns an error, chat still works — we just lose that one log entry.
"""

from __future__ import annotations

from typing import Optional
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel, Field, field_validator

import supabase_owner_store as _supa


router = APIRouter(prefix="/analytics/chat", tags=["analytics-chat"])


# Hard cap so a runaway client can't dump megabytes per call. 4000 chars covers
# any realistic question (the chat UI's textarea has no fixed limit but a real
# question is rarely >500 chars). Truncated rather than rejected so we don't
# silently lose the start of a long message.
_MAX_MESSAGE_CHARS = 4000


class ChatLogIn(BaseModel):
    user_pseudo_id: str = Field(..., min_length=1, max_length=128)
    ga_session_id: Optional[int] = None
    message: str = Field(..., min_length=1)
    page_url: Optional[str] = Field(None, max_length=500)

    @field_validator("user_pseudo_id")
    @classmethod
    def _strip_uid(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("user_pseudo_id required")
        return v

    @field_validator("message")
    @classmethod
    def _trim_msg(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("message required")
        return v[:_MAX_MESSAGE_CHARS]


@router.post("/log")
def log_chat_message(payload: ChatLogIn, request: Request):
    """Persist a single chat question to rs_chat_messages.

    Returns {"ok": true} on success. Failures (Supabase down, schema mismatch)
    return ok=false with a short reason — caller treats this as best-effort
    and never retries (we'd rather drop one log line than blow up the chat UX).
    """
    if not _supa.is_configured():
        raise HTTPException(status_code=503, detail="analytics store unavailable")

    ua = request.headers.get("user-agent", "")[:300] or None
    body = {
        "user_pseudo_id": payload.user_pseudo_id,
        "ga_session_id":  payload.ga_session_id,
        "message":        payload.message,
        "message_length": len(payload.message),
        "page_url":       payload.page_url,
        "user_agent":     ua,
        "sent_at":        datetime.now(timezone.utc).isoformat(),
    }

    url = f"{_supa.supabase_url()}/rest/v1/rs_chat_messages"
    headers = {**_supa.service_headers(), "Prefer": "return=minimal"}
    try:
        with httpx.Client(timeout=5.0) as c:
            resp = c.post(url, headers=headers, json=body)
        if resp.status_code >= 400:
            # Don't leak Supabase error text to the public; log server-side.
            print(f"[chat_log] supabase {resp.status_code}: {resp.text[:200]}", flush=True)
            return {"ok": False, "reason": "store_error"}
    except httpx.HTTPError as e:
        print(f"[chat_log] httpx error: {e}", flush=True)
        return {"ok": False, "reason": "network_error"}

    return {"ok": True}
