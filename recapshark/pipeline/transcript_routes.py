"""SubsProvider transcript and subtitle routes."""
import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

from config import subs_provider_api_key, youtube_api_key
from get_audio import extract_video_id
import ner  # local module — graceful no-op if disabled / spaCy missing

transcript_router = APIRouter()

_SUBS_PROVIDER_API_URL = "https://api.example.com/v1/transcript"


# ── Language ↔ script reconciliation ──
# Maps each supported BCP-47-ish lang code to the Unicode script its text is
# written in. Used by _reconcile_lang_with_script to decide whether
# SubsProvider's reported lang is consistent with the actual transcript text.
_LANG_SCRIPT = {
    # Latin script
    "en": "latin", "es": "latin", "fr": "latin", "de": "latin", "it": "latin",
    "pt": "latin", "nl": "latin", "pl": "latin", "tr": "latin", "sv": "latin",
    "no": "latin", "da": "latin", "fi": "latin", "cs": "latin", "sk": "latin",
    "hu": "latin", "ro": "latin", "hr": "latin", "sl": "latin", "lt": "latin",
    "lv": "latin", "et": "latin", "id": "latin", "ms": "latin", "vi": "latin",
    "tl": "latin", "sw": "latin", "eu": "latin", "ca": "latin", "gl": "latin",
    "cy": "latin", "is": "latin", "ga": "latin", "mt": "latin", "sq": "latin",
    "af": "latin", "az": "latin",
    # Arabic script
    "ar": "arabic", "fa": "arabic", "ur": "arabic", "ku": "arabic", "ps": "arabic",
    # CJK (Chinese / Japanese / Korean — same script bucket for our purposes)
    "zh": "cjk", "zh-cn": "cjk", "zh-tw": "cjk", "ja": "cjk", "ko": "cjk",
    # Cyrillic
    "ru": "cyrillic", "uk": "cyrillic", "bg": "cyrillic", "sr": "cyrillic",
    "mk": "cyrillic", "be": "cyrillic", "kk": "cyrillic",
    # Devanagari
    "hi": "devanagari", "mr": "devanagari", "ne": "devanagari", "sa": "devanagari",
    # Hebrew
    "he": "hebrew", "iw": "hebrew",
    # Thai
    "th": "thai",
    # Greek
    "el": "greek",
}


def _dominant_script(text: str) -> str:
    """Return the dominant Unicode script of `text` ('latin', 'arabic', 'cjk',
    'cyrillic', 'devanagari', 'hebrew', 'thai', 'greek', or 'unknown').

    Only counts script-bearing characters; ignores digits, punctuation, and
    whitespace so a transcript of mostly numbers + spaces doesn't mislabel
    itself. Determined by character count, not percentage — the highest
    bucket wins."""
    counts = {}
    for ch in text:
        cp = ord(ch)
        if (0x0041 <= cp <= 0x024F) or (0x1E00 <= cp <= 0x1EFF):
            counts["latin"] = counts.get("latin", 0) + 1
        elif (0x0600 <= cp <= 0x06FF) or (0x0750 <= cp <= 0x077F) or (0x08A0 <= cp <= 0x08FF):
            counts["arabic"] = counts.get("arabic", 0) + 1
        elif (0x4E00 <= cp <= 0x9FFF) or (0x3040 <= cp <= 0x30FF) or (0xAC00 <= cp <= 0xD7AF):
            counts["cjk"] = counts.get("cjk", 0) + 1
        elif 0x0400 <= cp <= 0x04FF:
            counts["cyrillic"] = counts.get("cyrillic", 0) + 1
        elif 0x0900 <= cp <= 0x097F:
            counts["devanagari"] = counts.get("devanagari", 0) + 1
        elif 0x0590 <= cp <= 0x05FF:
            counts["hebrew"] = counts.get("hebrew", 0) + 1
        elif 0x0E00 <= cp <= 0x0E7F:
            counts["thai"] = counts.get("thai", 0) + 1
        elif 0x0370 <= cp <= 0x03FF:
            counts["greek"] = counts.get("greek", 0) + 1
    if not counts:
        return "unknown"
    return max(counts, key=counts.get)


def _reconcile_lang_with_script(reported_lang, sample_text):
    """Decide the final lang for a transcript by comparing SubsProvider's reported
    lang against the dominant Unicode script of the text.

    - If reported_lang's expected script matches the dominant script → trust it.
    - If reported_lang is unknown to us → trust it (don't second-guess).
    - On a real mismatch → run langdetect once as a tie-breaker; only accept
      its result when it ALSO matches the dominant script. Otherwise keep
      SubsProvider's lang (better to be wrong on the BCP-47 code than to load
      the whole UI in the wrong script direction)."""
    norm = (reported_lang or "").lower()
    dominant = _dominant_script(sample_text)
    expected = _LANG_SCRIPT.get(norm)

    if dominant == "unknown" or expected is None or expected == dominant:
        # Either: no script-bearing chars (unusable signal), or we don't have
        # a script mapping for this lang (be lenient), or the reported lang
        # already matches the actual script. All three: trust SubsProvider.
        return reported_lang

    # Genuine mismatch — SubsProvider's lang says one script, the text shows
    # another. Try langdetect as a fallback, but only accept it when it
    # produces a lang in the *correct* script.
    try:
        from langdetect import detect
        detected = (detect(sample_text[:500]) or "").lower()
        detected_script = _LANG_SCRIPT.get(detected)
        if detected_script == dominant:
            print(
                f"[SUBS] script mismatch: SubsProvider={reported_lang!r} (expects "
                f"{expected!r}) but dominant script is {dominant!r}; "
                f"langdetect={detected!r} matches → override",
                flush=True,
            )
            return detected
        print(
            f"[SUBS] script mismatch: SubsProvider={reported_lang!r}, dominant="
            f"{dominant!r}, langdetect={detected!r} (also wrong script) — "
            f"keeping SubsProvider's {reported_lang!r}",
            flush=True,
        )
    except Exception as e:
        print(
            f"[SUBS] script mismatch but langdetect failed ({e}) — "
            f"keeping SubsProvider's {reported_lang!r}",
            flush=True,
        )
    return reported_lang


def _normalize_lang_code(code):
    """Lower-case and strip region tags so 'EN-US' / 'en_us' / 'en' all
    collapse to 'en'. Returns '' for falsy input. Keeps the special CJK
    region codes that we actually use ('zh-CN', 'zh-TW') untouched, since
    SubsProvider distinguishes them."""
    if not code:
        return ""
    code = str(code).replace("_", "-").lower().strip()
    base = code.split("-")[0]
    if base == "zh" and "-" in code:
        # Preserve zh-cn / zh-tw / zh-hk distinctions
        return code
    return base


def _get_video_default_lang(video_url: str) -> str:
    """Return the video's original-audio language code (BCP-47, lower-cased)
    from YouTube Data API. Falls back to defaultLanguage when
    defaultAudioLanguage is missing (common on older videos). Returns ''
    on any failure — caller treats empty as "no hint, let SubsProvider guess".

    Cost: one ~200ms YouTube Data API call (videos.list with part=snippet)
    before each SubsProvider fetch — worth it to stop multi-track videos from
    being returned in the wrong language. fetch_youtube_meta is intentionally
    NOT used here even though it sounds related: it also pulls top-50
    comments via commentThreads, which is slow and rate-limit-prone. We only
    need the snippet, so we make a direct minimal call."""
    try:
        from get_audio import extract_video_id as _extract
        import httpx
        vid = _extract(video_url)
        api_key = youtube_api_key()
        if not api_key:
            print("[SUBS] default-lang lookup skipped: YOUTUBE_API_KEY not set", flush=True)
            return ""
        with httpx.Client(timeout=5.0) as client:
            r = client.get(
                "https://www.googleapis.com/youtube/v3/videos",
                params={"part": "snippet", "id": vid, "key": api_key},
            )
            r.raise_for_status()
            items = (r.json() or {}).get("items", [])
            if not items:
                print(f"[SUBS] default-lang lookup: no items returned for {vid}", flush=True)
                return ""
            sn = items[0].get("snippet", {}) or {}
            raw = sn.get("defaultAudioLanguage") or sn.get("defaultLanguage") or ""
            normalized = _normalize_lang_code(raw)
            print(f"[SUBS] default-lang lookup: defaultAudioLanguage={sn.get('defaultAudioLanguage')!r}, defaultLanguage={sn.get('defaultLanguage')!r} → hint={normalized!r}", flush=True)
            return normalized
    except Exception as e:
        print(f"[SUBS] default-lang lookup failed: {e}", flush=True)
        return ""


def _subs_provider_via_subprocess(url: str, lang_hint: str = ""):
    """Fetch transcript via subprocess to avoid Cloudflare 1010 (first req fast, 2nd+ throttled in server context).

    `lang_hint` is the BCP-47 language code we want SubsProvider to return — for
    videos with multiple caption tracks (e.g., English original + Arabic
    auto-translation) this picks the right one. When empty, SubsProvider picks
    whichever track its native mode considers default."""

    api_key = subs_provider_api_key()
    if not api_key:
        raise HTTPException(status_code=500, detail="SUBS_PROVIDER_API_KEY not set in .env")

    script_dir = Path(__file__).resolve().parent
    env = os.environ.copy()
    env["SUBS_PROVIDER_URL"] = url
    if lang_hint:
        env["SUBS_PROVIDER_LANG"] = lang_hint
    result = subprocess.run(
        [sys.executable, str(script_dir / "_subs_provider_fetch.py")],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        cwd=str(script_dir.parent),
    )
    if result.returncode != 0:
        err = result.stderr or result.stdout or "Subprocess failed"
        try:
            data = json.loads(err)
            raise HTTPException(status_code=502, detail=data.get("error", err))
        except json.JSONDecodeError:
            raise HTTPException(status_code=502, detail=str(err)[:200])
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="Invalid response from subprocess")


@transcript_router.get("/transcript/subs_provider")
def subs_provider_transcript(url: str):
    """Test endpoint: fetch transcript via SubsProvider (subprocess to avoid Cloudflare 1010). Returns content + lang."""
    try:
        extract_video_id(url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    try:
        data = _subs_provider_via_subprocess(url)
        return {"content": data.get("content", ""), "lang": data.get("lang")}
    except HTTPException:
        raise
    except Exception as e:
        err_msg = str(e)
        if hasattr(e, "message"):
            err_msg = getattr(e, "message", err_msg)
        raise HTTPException(status_code=502, detail=err_msg)


@transcript_router.get("/transcript/lang-debug")
def lang_debug(url: str):
    """Debug endpoint: dump every signal we have about a video's language so
    we can see why SubsProvider is returning the "wrong" caption track for a
    given URL. Hits YouTube Data API for snippet + SubsProvider for metadata +
    SubsProvider transcript with various lang/mode combos. Used by the
    /lang-debug.html test page."""
    out = {"url": url}
    try:
        vid = extract_video_id(url)
        out["video_id"] = vid
    except ValueError as e:
        return {"error": str(e), "url": url}

    # ── 1) YouTube Data API: full snippet ──
    try:
        import httpx
        api_key = youtube_api_key()
        if not api_key:
            out["youtube_snippet"] = {"_error": "YOUTUBE_API_KEY not set"}
        else:
            with httpx.Client(timeout=10.0) as client:
                r = client.get(
                    "https://www.googleapis.com/youtube/v3/videos",
                    params={"part": "snippet", "id": vid, "key": api_key},
                )
                r.raise_for_status()
                items = (r.json() or {}).get("items", [])
                sn = items[0].get("snippet", {}) if items else {}
                out["youtube_snippet"] = {
                    "title": sn.get("title"),
                    "defaultLanguage": sn.get("defaultLanguage"),
                    "defaultAudioLanguage": sn.get("defaultAudioLanguage"),
                    "channel": sn.get("channelTitle"),
                }
    except Exception as e:
        out["youtube_snippet"] = {"_error": str(e)[:200]}

    # ── 2) SubsProvider metadata (might list available tracks) ──
    try:
        api_key = subs_provider_api_key()
        if not api_key:
            out["subs_provider_metadata"] = {"_error": "SUBS_PROVIDER_API_KEY not set"}
        else:
            from subs_provider import SubsProvider
            client = SubsProvider(api_key=api_key)
            try:
                meta = client.metadata(url=url)
                # Convert object to dict (best effort) so JSON serialisation works.
                if hasattr(meta, "__dict__"):
                    out["subs_provider_metadata"] = {k: v for k, v in vars(meta).items()
                                                if not k.startswith("_")}
                else:
                    out["subs_provider_metadata"] = {"_repr": repr(meta)[:500]}
            except Exception as inner:
                out["subs_provider_metadata"] = {"_error": str(inner)[:200]}
    except Exception as e:
        out["subs_provider_metadata"] = {"_error": str(e)[:200]}

    # ── 3) SubsProvider transcript with various combos ──
    def _try_subs_provider(mode, lang_hint):
        try:
            data = _subs_provider_via_subprocess(url, lang_hint or "")
            content = data.get("content", "") or ""
            return {
                "mode": mode,
                "lang_hint": lang_hint or "(none)",
                "returned_lang": data.get("lang"),
                "content_preview": content[:200],
                "content_length": len(content),
                "segment_count": len(data.get("segments") or []),
            }
        except HTTPException as e:
            return {"mode": mode, "lang_hint": lang_hint or "(none)",
                    "_http_error": str(e.detail)[:200]}
        except Exception as e:
            return {"mode": mode, "lang_hint": lang_hint or "(none)",
                    "_error": str(e)[:200]}

    # NOTE: _subs_provider_via_subprocess always tries native then falls back to
    # auto, so the "mode" label here is informational (signalling which
    # lang_hint we used) rather than a true mode-selector.
    out["subs_provider_no_hint"] = _try_subs_provider("native+auto fallback", "")
    out["subs_provider_lang_en"] = _try_subs_provider("native+auto fallback", "en")
    out["subs_provider_lang_ar"] = _try_subs_provider("native+auto fallback", "ar")

    return out


@transcript_router.get("/transcript/subs_provider-generate")
async def subs_provider_generate_transcript(url: str):
    """Fetch full transcript via SubsProvider mode=generate (audio transcription on their end)."""
    import asyncio
    from urllib.parse import urlencode

    try:
        extract_video_id(url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    api_key = subs_provider_api_key()
    if not api_key:
        raise HTTPException(status_code=500, detail="SUBS_PROVIDER_API_KEY not set in .env")

    qs = urlencode({"url": url, "mode": "generate"})
    full_url = f"{_SUBS_PROVIDER_API_URL}?{qs}"

    t0 = time.time()
    print(f"[TRANSCRIPT] SubsProvider generate request at {t0:.3f}", flush=True)

    curl_cmd = "curl.exe" if os.name == "nt" else "curl"
    if os.name != "nt":
        path = os.environ.get("PATH", "/usr/bin:/bin")
        cmd = ["env", "-i", f"PATH={path}", curl_cmd, "-sS", "--max-time", "120", "-4", "--noproxy", "*",
               "-H", f"x-api-key: {api_key}", "-H", "Accept: application/json", full_url]
        run_env = None
    else:
        cmd = [curl_cmd, "-sS", "--max-time", "120", "-4", "--noproxy", "*",
               "-H", f"x-api-key: {api_key}", "-H", "Accept: application/json", full_url]
        run_env = os.environ

    def _run_curl():
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=run_env)
        return proc.communicate(timeout=125)

    stdout, stderr = await asyncio.to_thread(_run_curl)
    elapsed_ms = int((time.time() - t0) * 1000)

    if not stdout:
        err_reason = stderr.decode().strip() or "no stderr output"
        print(f"[TRANSCRIPT] curl FAILED in {elapsed_ms}ms — {err_reason}", flush=True)
        raise HTTPException(status_code=502, detail=f"curl failed ({elapsed_ms}ms): {err_reason}")

    body = stdout.decode()
    print(f"[TRANSCRIPT] curl done in {elapsed_ms}ms, len={len(body)}", flush=True)

    data = json.loads(body)
    content = data.get("content", [])
    lang = data.get("lang")

    if isinstance(content, list):
        segments = [{"text": c.get("text", ""), "start": c.get("startTime", 0)} for c in content]
        full_text = " ".join(s["text"] for s in segments)
    else:
        segments = []
        full_text = content or ""

    # NER: detect names + recase if all-caps. Runs in a worker thread
    # because spaCy is CPU-bound (would block the event loop otherwise).
    # Graceful no-op when ENABLE_NER is unset/false or spaCy unavailable.
    ner_result = await asyncio.to_thread(ner.analyze, full_text, lang or "en") if full_text else {"entities": [], "recased_text": None}

    # If the transcript was all-caps and got recased, also recase each
    # segment using the same entity list — otherwise video subtitles +
    # the rebuilt transcript rows would still be SHOUTING.
    if ner_result.get("recased_text") and segments:
        ent_texts = [e["text"] for e in ner_result["entities"]]
        full_text = ner_result["recased_text"]
        segments = [
            {**seg, "text": ner.recase(seg.get("text", ""), ent_texts)}
            for seg in segments
        ]

    return {
        "transcript": {"segments": segments, "text": full_text},
        "elapsed_ms": elapsed_ms,
        "lang": lang,
        "entities": ner_result["entities"],
        "recased_text": ner_result["recased_text"],
    }


@transcript_router.get("/transcript/subs")
async def subs_fast(request: Request, url: str, mode: str = None):
    """Fetch subs via SubsProvider SDK subprocess (replaces curl approach which
    was hanging on TLS renegotiation in some Windows schannel contexts).
    Returns empty on failure so the pipeline can fall back to AsrProvider."""
    import asyncio

    ip = request.client.host if request.client else "?"
    print(f"[SUBS] === ENDPOINT HIT at {time.time():.3f} === mode={mode} ip={ip}", flush=True)

    try:
        extract_video_id(url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if not subs_provider_api_key():
        raise HTTPException(status_code=500, detail="SUBS_PROVIDER_API_KEY not set in .env")

    # ── Resolve the video's original language up front ──
    # YouTube videos can have multiple caption tracks (creator's original +
    # auto-translated copies into 100+ languages). Without a hint, SubsProvider
    # picks an arbitrary one — frequently NOT the original — which is how we
    # ended up loading English videos in Arabic. Use YouTube Data API's
    # defaultAudioLanguage (or defaultLanguage as a fallback) to tell SubsProvider
    # exactly which track we want. The lookup is its own ~200ms call but it
    # runs in parallel with nothing else worth waiting on. If it fails or the
    # field is empty (older videos lack it), pass no hint and fall back to
    # the legacy "let SubsProvider pick" behavior.
    lang_hint = await asyncio.to_thread(_get_video_default_lang, url)
    if lang_hint:
        print(f"[SUBS] resolved default audio lang={lang_hint!r} for {url}", flush=True)

    t0 = time.time()
    try:
        # Run the blocking subprocess call in a thread so we don't block the event loop
        data = await asyncio.to_thread(_subs_provider_via_subprocess, url, lang_hint)
    except HTTPException as e:
        elapsed_ms = int((time.time() - t0) * 1000)
        print(f"[SUBS] subprocess HTTP error in {elapsed_ms}ms — {e.detail}", flush=True)
        return {"content": "", "segments": [], "lang": "en", "elapsed_ms": elapsed_ms, "_error": str(e.detail)[:200]}
    except Exception as e:
        elapsed_ms = int((time.time() - t0) * 1000)
        print(f"[SUBS] subprocess EXCEPTION in {elapsed_ms}ms — {str(e)[:200]}", flush=True)
        return {"content": "", "segments": [], "lang": "en", "elapsed_ms": elapsed_ms, "_error": str(e)[:200]}

    elapsed_ms = int((time.time() - t0) * 1000)
    raw_segments = data.get("segments") or []
    plain_text = data.get("content", "") or ""
    lang = data.get("lang")

    # Normalize segments to the {text, start, end} shape the frontend expects
    segments = []
    for item in raw_segments:
        text = (item.get("text") or "").strip()
        if not text:
            continue
        # SubsProvider returns offset/duration in milliseconds → convert to seconds
        start = item.get("offset", 0) / 1000
        dur = item.get("duration", 0) / 1000
        segments.append({"text": text, "start": start, "end": start + dur})

    if not plain_text and segments:
        plain_text = " ".join(s["text"] for s in segments)

    print(f"[SUBS] SDK done in {elapsed_ms}ms, {len(segments)} segments, {len(plain_text)} chars, lang={lang!r}", flush=True)

    # ── Script-aware language sanity check ──
    # SubsProvider reports the lang YouTube assigns to the caption track, which is
    # almost always correct for creator-uploaded captions. We previously ran
    # langdetect on the first 500 chars and unconditionally overwrote
    # SubsProvider's lang — but langdetect is a Naive Bayes classifier that's
    # non-deterministic and frequently mislabels English text as Arabic,
    # Indonesian, Tagalog, etc. when it sees a few proper nouns or unusual
    # phrasing. Result: English videos sometimes loaded in the wrong locale.
    #
    # New rule: trust SubsProvider UNLESS the actual text's dominant Unicode
    # script disagrees with SubsProvider's reported lang (e.g., SubsProvider says
    # "en" but the text is mostly Arabic characters). Script detection from
    # Unicode code-point ranges is deterministic and ~100% reliable for
    # distinguishing Latin / Arabic / CJK / Cyrillic / Devanagari / Hebrew /
    # Thai / Greek. Only on a real mismatch do we fall back to langdetect to
    # pick a replacement lang.
    if plain_text and len(plain_text) > 50:
        lang = _reconcile_lang_with_script(lang, plain_text[:1000])

    # NER: detect names + recase if all-caps. Runs in a worker thread
    # because spaCy is CPU-bound (would block the event loop otherwise).
    # Graceful no-op when ENABLE_NER is unset/false or spaCy unavailable.
    ner_result = await asyncio.to_thread(ner.analyze, plain_text, lang or "en") if plain_text else {"entities": [], "recased_text": None}

    # If the transcript was all-caps and got recased, also recase each
    # segment using the same entity list — otherwise video subtitles +
    # the rebuilt transcript rows would still be SHOUTING.
    if ner_result.get("recased_text") and segments:
        ent_texts = [e["text"] for e in ner_result["entities"]]
        plain_text = ner_result["recased_text"]
        segments = [
            {**seg, "text": ner.recase(seg.get("text", ""), ent_texts)}
            for seg in segments
        ]

    return {
        "content": plain_text,
        "segments": segments,
        "lang": lang or "en",
        "elapsed_ms": elapsed_ms,
        "entities": ner_result["entities"],
        "recased_text": ner_result["recased_text"],
    }
