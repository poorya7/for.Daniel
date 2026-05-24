"""One-off script to fetch transcript via SubsProvider SDK. Run via subprocess to avoid Cloudflare 1010 / curl schannel issues in server context.

Returns JSON: {"content": "joined text", "segments": [{text, offset, duration}, ...], "lang": "en"}
"""
import json
import sys

from config import subs_provider_api_key, subs_provider_lang, subs_provider_url

api_key = subs_provider_api_key()
url = subs_provider_url()
# Optional language hint, passed through from /api/transcript/subs based on the
# video's defaultAudioLanguage (YouTube Data API). When set, SubsProvider
# returns the caption track in that language instead of guessing — this
# is what stops English videos with multiple tracks from coming back as
# Arabic / French / etc. Empty = let SubsProvider pick (legacy behavior).
hint_lang = subs_provider_lang()
if not api_key or not url:
    print(json.dumps({"error": "Missing SUBS_PROVIDER_API_KEY or SUBS_PROVIDER_URL"}), file=sys.stderr)
    sys.exit(1)

from subs_provider import SubsProvider
client = SubsProvider(api_key=api_key)


def _extract_segments(content):
    """Normalize content into a list of {text, offset, duration} dicts.
    Handles both list-of-dicts and list-of-Pydantic-objects. Returns [] for string content."""
    if not content or isinstance(content, str):
        return []
    segments = []
    for item in content:
        if isinstance(item, dict):
            segments.append({
                "text": item.get("text", ""),
                "offset": item.get("offset", 0),
                "duration": item.get("duration", 0),
            })
        else:
            segments.append({
                "text": getattr(item, "text", ""),
                "offset": getattr(item, "offset", 0),
                "duration": getattr(item, "duration", 0),
            })
    return segments


def _build_output(t):
    content = getattr(t, "content", None)
    lang = getattr(t, "lang", None)
    if isinstance(content, str):
        # Plain text response (text=True) — no segments
        return {"content": content, "segments": [], "lang": lang}
    segments = _extract_segments(content)
    joined_text = " ".join(s["text"] for s in segments if s.get("text"))
    return {"content": joined_text, "segments": segments, "lang": lang}


def _call(mode):
    """Wrap client.transcript() to include the optional lang hint when set,
    so the same call shape is reused for both modes below."""
    if hint_lang:
        return client.transcript(url=url, mode=mode, lang=hint_lang)
    return client.transcript(url=url, mode=mode)


# Try native mode first (usually faster + higher quality)
try:
    t = _call("native")
    out = _build_output(t)
    if out["content"] or out["segments"]:
        print(json.dumps(out))
        sys.exit(0)
except Exception:
    pass

# Fallback: auto mode
try:
    t = _call("auto")
    out = _build_output(t)
    print(json.dumps(out))
    sys.exit(0)
except Exception as e:
    print(json.dumps({"error": str(e)[:300]}), file=sys.stderr)
    sys.exit(1)
