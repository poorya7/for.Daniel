"""
YouTube Video Metadata
Extracts video ID, metadata, and captions via yt-dlp (no audio download).
"""

import html
import re
from urllib.request import urlopen
from urllib.error import URLError

import yt_dlp


def extract_video_id(url: str) -> str:
    """Extract video ID from various YouTube URL formats."""
    patterns = [
        r'(?:v=|/v/|youtu\.be/)([a-zA-Z0-9_-]{11})',
        r'^([a-zA-Z0-9_-]{11})$'
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    raise ValueError(f"Could not extract video ID from: {url}")


def _parse_vtt(raw: str) -> str:
    """Strip VTT/SRT timestamps and metadata, deduplicate lines, return plain text."""
    lines = raw.split("\n")
    seen = set()
    text_lines = []
    for line in lines:
        line = line.strip()
        if not line or line.startswith("WEBVTT") or line.startswith("Kind:") or line.startswith("Language:"):
            continue
        if re.match(r"^\d+$", line):
            continue
        if re.match(r"\d{2}:\d{2}[:\.]", line):
            continue
        clean = re.sub(r"<[^>]+>", "", line)
        clean = re.sub(r"\{[^}]+\}", "", clean)
        clean = html.unescape(clean).strip()
        if not clean or clean in seen:
            continue
        seen.add(clean)
        text_lines.append(clean)
    return " ".join(text_lines)


def _fetch_captions_text(info: dict) -> str | None:
    """Extract English caption text from yt-dlp info dict. Returns plain text or None."""
    subs = info.get("subtitles") or {}
    auto = info.get("automatic_captions") or {}

    for lang in ("en", "en-orig", "en-US"):
        source = subs.get(lang) or auto.get(lang)
        if source:
            break
    else:
        for key in subs:
            if key.startswith("en"):
                source = subs[key]
                break
        else:
            for key in auto:
                if key.startswith("en"):
                    source = auto[key]
                    break
            else:
                return None

    preferred = ["vtt", "srt", "srv3", "json3"]
    url = None
    for fmt in preferred:
        for entry in source:
            if entry.get("ext") == fmt:
                url = entry.get("url")
                break
        if url:
            break
    if not url and source:
        url = source[0].get("url")
    if not url:
        return None

    try:
        with urlopen(url, timeout=10) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        text = _parse_vtt(raw)
        return text if len(text) > 50 else None
    except (URLError, OSError) as e:
        print(f"[WARN] Caption fetch failed: {e}")
        return None


def get_video_metadata(video_url: str) -> dict:
    """Extract metadata (chapters, title, duration, captions) from YouTube without downloading."""
    ydl_opts = {
        'quiet': True,
        'no_warnings': True,
        'skip_download': True,
        'writesubtitles': True,
        'writeautomaticsub': True,
        'subtitleslangs': ['en', 'en-US', 'en-GB', 'en-orig'],
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(video_url, download=False)

    chapters = []
    for ch in (info.get("chapters") or []):
        title = ch.get("title", "") or ""
        if title.startswith("<Untitled"):
            title = ""
        chapters.append({
            "title": title,
            "start_time": ch.get("start_time", 0),
            "end_time": ch.get("end_time", 0),
        })

    captions = _fetch_captions_text(info)

    upload_date = info.get("upload_date") or ""
    if len(upload_date) == 8:
        upload_date = f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:]}"

    return {
        "title": info.get("title"),
        "channel": info.get("uploader") or info.get("channel"),
        "duration": info.get("duration"),
        "upload_date": upload_date,
        "chapters": chapters,
        "captions": captions,
    }


