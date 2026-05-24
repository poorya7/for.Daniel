"""YouTube metadata and preview summary routes."""
import re

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from config import youtube_api_key, recapshark_yt_proxy_url
from deps import limiter
from get_audio import extract_video_id

youtube_router = APIRouter()


_CAPTION_TRACKS_NONEMPTY_RE = re.compile(r'"captionTracks"\s*:\s*\[\s*\{')
_BOT_CHALLENGE_MARKERS = ("Sign in to confirm", "/recaptcha/")

# Round-robin pointer shared across calls so the proxy pool gets evenly
# distributed and a single flagged IP doesn't trap every visitor on it.
# Mirrors the pattern in pipeline/audio_cache.py ProxiedYtDlpProvider.
_CAPTION_PROXY_IDX = 0


def _video_has_caption_tracks(video_id: str) -> bool:
    """Detect whether a YouTube video has ANY caption tracks (manual or
    auto-generated/ASR). Parses the watch page's embedded ytInitialPlayerResponse
    for a non-empty `captionTracks` array — the same source the YouTube web
    player uses to render the [CC] button.

    Replaces the earlier YT Data API `contentDetails.caption` check, which
    only reflects MANUALLY uploaded captions and returned False for podcasts
    with auto-only captions, causing them to be misflagged as 'mostly music'
    (caught 2026-05-13 on the 'World podcast' paste — ZO8X7IYGk0A).

    Uses curl via subprocess intentionally — httpx + the residential proxy
    triggers YouTube's bot challenge ("Sign in to confirm...") on datacenter
    IPs even with browser-like headers, likely due to TLS fingerprinting.
    curl's TLS fingerprint passes through cleanly via the same residential
    proxy pool we use for yt-dlp. No new dependencies — curl ships in the
    Ubuntu base and Windows System32.

    Rotates across the full RECAPSHARK_YT_PROXY_URL pool (round-robin) and
    retries on bot-challenge responses, same retry pattern as the audio
    cache's yt-dlp invocations. Without rotation a single flagged IP would
    trap every paste on it. Cap: 4 attempts (matches audio_cache cap).

    Conservative fallback: on total failure return True so the pipeline
    proceeds to SubsProvider rather than false-flagging a real video as
    music-only — the no-subs branch downstream catches genuinely
    captionless videos anyway, just ~13s slower than this pre-check.
    Total budget: ~1-3s typical (one attempt), up to ~8s worst case (all
    retries used up on a rare bot-storm).
    """
    global _CAPTION_PROXY_IDX
    import subprocess
    proxy_pool_raw = recapshark_yt_proxy_url()
    proxies = [p.strip() for p in proxy_pool_raw.split(",") if p.strip()]
    # Always try at least once even if no proxy configured (local dev).
    attempts = max(1, min(4, len(proxies))) if proxies else 1
    for _ in range(attempts):
        proxy = ""
        if proxies:
            proxy = proxies[_CAPTION_PROXY_IDX % len(proxies)]
            _CAPTION_PROXY_IDX += 1
        cmd = [
            "curl", "-sS", "--max-time", "5",
            "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
            "-H", "Accept-Language: en-US,en;q=0.9",
        ]
        if proxy:
            cmd += ["--proxy", proxy]
        cmd += [f"https://www.youtube.com/watch?v={video_id}"]
        try:
            # capture_output as bytes — on Windows Python defaults decoding
            # stdout to cp1252, which dies on YouTube HTML bytes like 0x90.
            # utf-8 errors='replace' is safe since we only scan for ASCII.
            r = subprocess.run(cmd, capture_output=True, timeout=7)
        except Exception:
            continue
        if r.returncode != 0 or not r.stdout:
            continue
        body = r.stdout.decode("utf-8", errors="replace")
        if any(m in body for m in _BOT_CHALLENGE_MARKERS):
            # This IP is currently flagged — try the next one in the pool.
            continue
        # Clean response — definitive answer.
        return bool(_CAPTION_TRACKS_NONEMPTY_RE.search(body))
    # Every attempt was bot-blocked / failed. Don't false-positive the
    # video as music-only; let SubsProvider be the source of truth.
    return True


def fetch_youtube_meta(video_id: str) -> dict:
    """Fetch title, description, and top comments from YouTube Data API v3."""
    import httpx

    api_key = youtube_api_key()
    if not api_key:
        raise HTTPException(status_code=500, detail="YOUTUBE_API_KEY not set in .env")

    base = "https://www.googleapis.com/youtube/v3"
    out = {"title": "", "description": "", "channel_title": "", "chapters": [], "comments": []}

    with httpx.Client(timeout=15.0) as client:
        # videos.list
        r = client.get(
            f"{base}/videos",
            params={"part": "snippet,contentDetails", "id": video_id, "key": api_key},
        )
        r.raise_for_status()
        data = r.json()
        items = data.get("items", [])
        if not items:
            return out
        sn = items[0].get("snippet", {})
        out["title"] = sn.get("title", "")
        out["description"] = sn.get("description", "")
        out["channel_title"] = sn.get("channelTitle", "")
        # Original audio language (BCP-47, e.g. "en", "fa-IR"). Falls back
        # to defaultLanguage when defaultAudioLanguage is missing (common on
        # older uploads). Consumed by the frontend cap-check to gate 4h+
        # videos against the gpt-4o tier-4O low-resource languages.
        out["lang"] = (sn.get("defaultAudioLanguage") or sn.get("defaultLanguage") or "").split("-")[0].lower()

        # Has-captions pre-check.
        #
        # YT Data API's contentDetails.caption only reflects MANUAL uploads
        # (returns 'false' for ASR-only videos like most podcasts), which
        # caused podcasts to be misflagged as mostly-music. Two-tier strategy:
        #   - If YT Data API says 'true', captions definitely exist — done,
        #     zero extra latency for the common case (creator-captioned
        #     videos: Daily Show, big channels, etc.).
        #   - If YT Data API says 'false', we still don't know — could be
        #     genuinely captionless (Dog TV, music loops) OR ASR-only. Parse
        #     the watch page's captionTracks for the definitive answer
        #     (~1-2s extra, only on this ambiguous path).
        # Net effect: captioned videos pay ~1s as before; captionless +
        # auto-only-captioned videos pay ~2-3s instead of the 15s SubsProvider
        # round-trip that the false-flag bug otherwise wasted. Frontend
        # treats has_captions=False as the existing 'mostly music' UX state:
        # badge + placeholder, no LLM calls, no skeleton ghosts.
        _yt_manual_captions = (items[0].get("contentDetails", {}).get("caption", "false") == "true")
        out["has_captions"] = _yt_manual_captions or _video_has_caption_tracks(video_id)

        # Parse ISO 8601 duration (e.g. PT1H24M16S) to seconds
        iso_dur = items[0].get("contentDetails", {}).get("duration", "")
        if iso_dur:
            dur_match = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso_dur)
            if dur_match:
                h = int(dur_match.group(1) or 0)
                m = int(dur_match.group(2) or 0)
                s = int(dur_match.group(3) or 0)
                out["duration"] = h * 3600 + m * 60 + s

        # Parse description for chapter-like lines (e.g. "0:00 Intro" or
        # "1:23 - Topic" or "5:00 | Section name"). Creators format these
        # inconsistently, so after capturing the title we strip any leading
        # bullet/separator characters (dashes, em-dashes, pipes, colons,
        # asterisks, bullet dots, arrows) plus surrounding whitespace so
        # every chapter renders the same regardless of the source format.
        #
        # We also enforce strictly-ascending timestamps so that bilingual
        # descriptions ("0:00 Intro / 1:00 Topic / ... / 0:00 परिचय / 1:00 ...")
        # don't bleed the second-language list into the chapters. YouTube
        # itself only treats the first contiguous run starting at 0:00 as the
        # progress-bar chapters; this matches that behavior.
        desc = out["description"] or ""
        _LEADING_SEP_RE = re.compile(r"^[\s\-‐-―:|*•·→»]+")

        def _hms_to_sec(hms):
            parts = [int(p) for p in hms.split(":")]
            if len(parts) == 3:
                return parts[0] * 3600 + parts[1] * 60 + parts[2]
            if len(parts) == 2:
                return parts[0] * 60 + parts[1]
            return parts[0]

        last_sec = -1
        for line in desc.splitlines():
            line = line.strip()
            m = re.match(r"^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)$", line)
            if not m or len(m.group(2)) == 0:
                continue
            sec = _hms_to_sec(m.group(1))
            if sec <= last_sec:
                # Backwards jump — we've reached a duplicate / second-language
                # block. Stop parsing entirely; YouTube would too.
                break
            title = _LEADING_SEP_RE.sub("", m.group(2).strip()).strip()
            if title:
                out["chapters"].append({"time": m.group(1), "title": title})
                last_sec = sec

        # commentThreads.list
        r2 = client.get(
            f"{base}/commentThreads",
            params={
                "part": "snippet",
                "videoId": video_id,
                "key": api_key,
                "maxResults": 50,
                "order": "relevance",
                "textFormat": "plainText",
            },
        )
        if r2.is_success:
            data2 = r2.json()
            for item in data2.get("items", []):
                try:
                    text = item["snippet"]["topLevelComment"]["snippet"].get("textDisplay") or item["snippet"]["topLevelComment"]["snippet"].get("textOriginal", "")
                    if text:
                        out["comments"].append(text[:500])
                except (KeyError, TypeError):
                    pass
    return out


@youtube_router.get("/video/meta")
def video_meta(url: str):
    """Fast metadata fetch via YouTube Data API (~1 sec). No GPT call."""
    try:
        video_id = extract_video_id(url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    try:
        meta = fetch_youtube_meta(video_id)
    except HTTPException:
        raise
    except Exception as e:
        print(f"[VIDEO-META] Error for {video_id}: {e}", flush=True)
        raise HTTPException(status_code=502, detail=f"YouTube metadata failed: {str(e)}")

    return {
        "title": meta.get("title", ""),
        "channel": meta.get("channel_title", ""),
        "description": (meta.get("description") or "")[:3000],
        "chapters": meta.get("chapters", []),
        "duration": meta.get("duration", 0),
        "lang": meta.get("lang", ""),
        "has_captions": meta.get("has_captions", True),
    }


class PreviewSummaryRequest(BaseModel):
    video_id: str | None = None
    url: str | None = None


@youtube_router.post("/summary/preview-from-meta")
@limiter.limit("30/minute")
def preview_summary_from_meta(request: Request, req: PreviewSummaryRequest):
    """No-subs path: fetch YouTube meta (title, description, comments, chapters) and summarize with GPT."""
    try:
        if req.video_id:
            video_id = req.video_id
        elif req.url:
            video_id = extract_video_id(req.url)
        else:
            raise HTTPException(status_code=400, detail="Provide video_id or url")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    try:
        meta = fetch_youtube_meta(video_id)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"YouTube metadata failed: {str(e)}")

    if not meta.get("title") and not meta.get("description"):
        raise HTTPException(status_code=404, detail="Video not found or no metadata")

    from openai_client import get_client as _get_client
    from openai import OpenAI

    client: OpenAI = _get_client()
    chunks = [
        f"Title: {meta.get('title', '')}",
        f"Channel: {meta.get('channel_title', '')}",
        f"Description:\n{meta.get('description', '')[:8000]}",
    ]
    if meta.get("chapters"):
        chapters_text = "\n".join(f"  {c.get('time', '')} {c.get('title', '')}" for c in meta["chapters"][:50])
        chunks.append(f"Chapters (from description):\n{chapters_text}")
    if meta.get("comments"):
        comments_text = "\n".join(meta["comments"][:30])
        chunks.append(f"Sample comments:\n{comments_text}")

    user_content = "\n\n".join(chunks)
    system = (
        "You summarize what a video is about using ONLY the title, description, chapters, and comments below. "
        "Write 2 to 3 short paragraphs in plain language. No headings or bullets. "
        "This is a preview from metadata; a full transcript-based summary may follow later."
    )
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user_content},
        ],
        max_tokens=600,
    )
    text = (resp.choices[0].message.content or "").strip()
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    if not paragraphs:
        paragraphs = [text] if text else ["No preview could be generated."]
    return {"summary": paragraphs, "meta": {"title": meta.get("title"), "channel": meta.get("channel_title")}}
