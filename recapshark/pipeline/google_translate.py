"""
RecapShark — Google Cloud Translation API wrapper.
Fast translation for all languages except the 13 advanced-model ones.
"""

import logging
import re
import requests

from config import google_translate_api_key
from langs import ADVANCED_MODEL_LANGS


logger = logging.getLogger(__name__)


# Languages that need GPT-4o instead of Google Translate (re-aliased from
# the canonical `ADVANCED_MODEL_LANGS` in pipeline.langs).
GOOGLE_SKIP_LANGS = ADVANCED_MODEL_LANGS


def _get_api_key():
    # Phase 4b/B5 (2026-05-08): routed through `config.google_translate_api_key()`.
    # Dropped the module-level `_API_KEY = None` cache because the config
    # getter is a single dict lookup — caching adds zero perf, and removing
    # it eliminates the stale-empty-string class of bug if the module is
    # imported before .env loads.
    return google_translate_api_key()


def is_google_lang(lang_code: str) -> bool:
    """Return True if this language should use Google Translate (not GPT)."""
    return lang_code not in GOOGLE_SKIP_LANGS and bool(_get_api_key())


def _clean(text: str) -> str:
    """Remove [bleep] and similar bracketed noise from translated text."""
    # Handle various forms: [bleep], [Bleep], [BLEEP], [ bleep ], [__], HTML-encoded brackets
    text = text.replace('&#39;', "'")  # Google sometimes HTML-encodes
    text = re.sub(r'\s*\[\s*bleep\s*\]\s*', ' ', text, flags=re.IGNORECASE)
    text = re.sub(r'\s*\[\s*__\s*\]\s*', ' ', text)
    text = re.sub(r'\s*\[\s*beep\s*\]\s*', ' ', text, flags=re.IGNORECASE)
    # Strip remaining English stage directions (Google keeps originals alongside translations)
    text = re.sub(r'\s*\[[A-Z][A-Z\s]{2,}\]\s*', ' ', text)
    text = re.sub(r'  +', ' ', text)  # collapse double spaces
    return text.strip()


def translate_text(text: str, source_lang: str, target_lang: str) -> str:
    """Translate a single text string via Google Cloud Translation API v2."""
    key = _get_api_key()
    if not key:
        raise RuntimeError('GOOGLE_TRANSLATE_API_KEY not set')

    resp = requests.post(
        'https://translation.googleapis.com/language/translate/v2',
        params={'key': key},
        json={
            'q': text,
            'source': source_lang,
            'target': target_lang,
            'format': 'text',
        },
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    return _clean(data['data']['translations'][0]['translatedText'])


def _translate_batch(batch: list[dict], source_lang: str, target_lang: str, key: str) -> list[dict]:
    """Translate a single batch of {id, text} dicts (max 128 items — Google v2 API limit)."""
    texts = [item['text'] for item in batch]

    resp = requests.post(
        'https://translation.googleapis.com/language/translate/v2',
        params={'key': key},
        json={
            'q': texts,
            'source': source_lang,
            'target': target_lang,
            'format': 'text',
        },
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    translations = data['data']['translations']

    result = []
    for i, item in enumerate(batch):
        result.append({
            'id': item['id'],
            'text': _clean(translations[i]['translatedText']) if i < len(translations) else item['text'],
        })
    return result


# Google Translate v2 API limit: max 128 segments per request
_MAX_SEGMENTS = 128


def translate_lines(lines: list[dict], source_lang: str, target_lang: str) -> list[dict]:
    """Translate a list of {id, text} dicts. Auto-batches into chunks of 128 and runs in parallel."""
    if not lines:
        return []

    key = _get_api_key()
    if not key:
        raise RuntimeError('GOOGLE_TRANSLATE_API_KEY not set')

    import time
    t0 = time.time()

    # Small enough for one request — no batching needed
    if len(lines) <= _MAX_SEGMENTS:
        logger.info("[GOOGLE-BATCH] %d lines, single request (%s -> %s)", len(lines), source_lang, target_lang)
        result = _translate_batch(lines, source_lang, target_lang, key)
        logger.info("[GOOGLE-BATCH] Done in %.1fs", time.time() - t0)
        return result

    # Split into chunks and fire in parallel
    from concurrent.futures import ThreadPoolExecutor, as_completed

    batches = [lines[i:i + _MAX_SEGMENTS] for i in range(0, len(lines), _MAX_SEGMENTS)]
    logger.info("[GOOGLE-BATCH] %d lines -> %d batches of %d (%s -> %s)", len(lines), len(batches), _MAX_SEGMENTS, source_lang, target_lang)
    results = [None] * len(batches)
    errors = []

    with ThreadPoolExecutor(max_workers=len(batches)) as pool:
        futures = {
            pool.submit(_translate_batch, batch, source_lang, target_lang, key): idx
            for idx, batch in enumerate(batches)
        }
        for f in as_completed(futures):
            idx = futures[f]
            try:
                results[idx] = f.result()
            except Exception as e:
                errors.append((idx, str(e)))
                logger.warning("[GOOGLE-BATCH] Batch %d/%d FAILED: %s", idx + 1, len(batches), e)

    if errors:
        logger.warning("[GOOGLE-BATCH] %d batch(es) failed!", len(errors))
        raise RuntimeError(f"Google Translate: {len(errors)}/{len(batches)} batches failed")

    # Merge in order
    merged = []
    for batch_result in results:
        merged.extend(batch_result)

    elapsed = time.time() - t0
    logger.info("[GOOGLE-BATCH] Done! %d lines in %.1fs (%d parallel batches)", len(merged), elapsed, len(batches))
    return merged
