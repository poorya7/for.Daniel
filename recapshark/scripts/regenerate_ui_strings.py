"""
Regenerate src/js/core/ui-strings.js from a single canonical English source
using GPT-4o, with one consistent prompt across all 105 supported languages.

Why this exists: the dict was originally hand-translated inline by an AI,
which produced quality drift across the 100+ language long tail (casual
register particularly tricky for Persian, Arabic, etc). Running everything
through one careful prompt with structured JSON output gives us a
defensible, re-runnable baseline.

Usage:
    python scripts/regenerate_ui_strings.py [--dry-run]

Reads OPENAI_API_KEY from .env at the project root (pipeline/openai_client.py
helper). Costs ~$1-2 per full run (~105 API calls @ ~1k tokens each).

Output: overwrites src/js/core/ui-strings.js with new translations.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# ── Make pipeline/ importable so we can reuse get_client() ──
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "pipeline"))
from openai_client import get_client  # noqa: E402

OUTPUT_PATH = PROJECT_ROOT / "src" / "js" / "core" / "ui-strings.js"

# ── Source strings (English) ──
SOURCE = {
    "chapters": "Chapters",
    "contextHeader": "Context from RecapShark.com",
    "recapTemplate": "Here's your 1 minute recap",
    "chatGreeting": (
        "Hey! I've watched the full video. Ask me anything. "
        "Key moments, context, opinions, or anything you missed."
    ),
}

# ── Languages ──
# Exact set + ordering matches the original chapters dict in ui-strings.js.
# Names are from lang-meta.js LANG_META[*].name. Code 'en' is special-cased
# (no API call needed — uses SOURCE directly).
LANGS = [
    ("en", "English"),
    ("fa", "Persian (Farsi)"),
    ("es", "Spanish"),
    ("pt", "Portuguese"),
    ("fr", "French"),
    ("zh", "Chinese (Simplified)"),
    ("de", "German"),
    ("ja", "Japanese"),
    ("ko", "Korean"),
    ("hi", "Hindi"),
    ("ar", "Arabic"),
    ("ru", "Russian"),
    ("it", "Italian"),
    ("tr", "Turkish"),
    ("nl", "Dutch"),
    ("pl", "Polish"),
    ("sv", "Swedish"),
    ("da", "Danish"),
    ("fi", "Finnish"),
    ("no", "Norwegian"),
    ("el", "Greek"),
    ("he", "Hebrew"),
    ("th", "Thai"),
    ("vi", "Vietnamese"),
    ("id", "Indonesian"),
    ("ms", "Malay"),
    ("uk", "Ukrainian"),
    ("cs", "Czech"),
    ("ro", "Romanian"),
    ("hu", "Hungarian"),
    ("bg", "Bulgarian"),
    ("hr", "Croatian"),
    ("sk", "Slovak"),
    ("sr", "Serbian"),
    ("bn", "Bengali"),
    ("ta", "Tamil"),
    ("ur", "Urdu"),
    ("fil", "Filipino (Tagalog)"),
    ("sw", "Swahili"),
    ("ca", "Catalan"),
    ("af", "Afrikaans"),
    ("et", "Estonian"),
    ("lv", "Latvian"),
    ("lt", "Lithuanian"),
    ("sl", "Slovenian"),
    ("te", "Telugu"),
    ("mr", "Marathi"),
    ("gu", "Gujarati"),
    ("kn", "Kannada"),
    ("ml", "Malayalam"),
    ("pa", "Punjabi"),
    ("si", "Sinhala"),
    ("ne", "Nepali"),
    ("my", "Burmese (Myanmar)"),
    ("km", "Khmer"),
    ("lo", "Lao"),
    ("zh-TW", "Chinese (Traditional, Taiwan)"),
    ("mn", "Mongolian"),
    ("ku", "Kurdish (Kurmanji)"),
    ("az", "Azerbaijani"),
    ("uz", "Uzbek"),
    ("kk", "Kazakh"),
    ("ky", "Kyrgyz"),
    ("tg", "Tajik"),
    ("ka", "Georgian"),
    ("hy", "Armenian"),
    ("ps", "Pashto"),
    ("am", "Amharic"),
    ("ha", "Hausa"),
    ("yo", "Yoruba"),
    ("ig", "Igbo"),
    ("zu", "Zulu"),
    ("xh", "Xhosa"),
    ("so", "Somali"),
    ("rw", "Kinyarwanda"),
    ("mg", "Malagasy"),
    ("sq", "Albanian"),
    ("mk", "Macedonian"),
    ("bs", "Bosnian"),
    ("is", "Icelandic"),
    ("mt", "Maltese"),
    ("ga", "Irish (Gaeilge)"),
    ("cy", "Welsh"),
    ("gl", "Galician"),
    ("eu", "Basque"),
    ("be", "Belarusian"),
    ("ht", "Haitian Creole"),
    ("mi", "Māori"),
    ("sm", "Samoan"),
    ("haw", "Hawaiian"),
    ("bo", "Tibetan"),
    ("eo", "Esperanto"),
    ("lb", "Luxembourgish"),
    ("co", "Corsican"),
    ("su", "Sundanese"),
    ("jv", "Javanese"),
    ("ceb", "Cebuano"),
    ("gd", "Scottish Gaelic"),
    ("tt", "Tatar"),
    ("tk", "Turkmen"),
    ("wo", "Wolof"),
    ("ti", "Tigrinya"),
    ("om", "Oromo"),
    ("sd", "Sindhi"),
    ("fj", "Fijian"),
    ("to", "Tongan"),
]

# ── Prompt ──
PROMPT_TEMPLATE = """You are a professional translator producing native-speaker-quality UI copy for a video summarization app called RecapShark.

Translate the following 4 short strings from English into {lang_name} (ISO code: {lang_code}).

REQUIREMENTS — read carefully:
1. CASUAL, conversational register. Use the informal "you" pronoun where the language distinguishes formal/informal (du/Sie, tu/usted, tu/vous, ты/Вы, etc).
2. Sound like a fluent native speaker, not a literal word-for-word translation. Natural idiomatic phrasing > literal accuracy.
3. Keep "RecapShark.com" as-is (do not translate or transliterate the brand name).
4. For "Here's your 1 minute recap": keep "1 minute" intact (do not change the duration). It's a fixed phrase regardless of actual video length.
5. For "chatGreeting": preserve the friendly tone and the conversational flow. The 4 listed items (Key moments, context, opinions, or anything you missed) should remain as a comma-separated list.
6. "chapters" should be the natural word for chapters/sections (already established in this app — match common UI conventions for {lang_name}).
7. Output ONLY a JSON object with the 4 keys. No explanation, no preamble, no formatting other than the JSON.

English source:
- chapters: {chapters}
- contextHeader: {contextHeader}
- recapTemplate: {recapTemplate}
- chatGreeting: {chatGreeting}

Output JSON:
{{"chapters": "...", "contextHeader": "...", "recapTemplate": "...", "chatGreeting": "..."}}"""


def translate_lang(client, code: str, name: str) -> dict:
    """Single-lang translation. Returns dict with the 4 keys."""
    if code == "en":
        return dict(SOURCE)

    prompt = PROMPT_TEMPLATE.format(
        lang_name=name,
        lang_code=code,
        chapters=SOURCE["chapters"],
        contextHeader=SOURCE["contextHeader"],
        recapTemplate=SOURCE["recapTemplate"],
        chatGreeting=SOURCE["chatGreeting"],
    )

    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
        temperature=0.3,
    )
    raw = response.choices[0].message.content
    parsed = json.loads(raw)

    # Validate all 4 keys present + non-empty
    for k in ("chapters", "contextHeader", "recapTemplate", "chatGreeting"):
        if not parsed.get(k):
            raise ValueError(f"Missing/empty key {k!r} for lang {code!r}: {raw!r}")

    return parsed


def js_escape(s: str) -> str:
    """Escape a string for embedding in single-quoted JS literal."""
    return s.replace("\\", "\\\\").replace("'", "\\'")


def render_dict(key: str, comment: str, translations: dict) -> str:
    """Render one top-level UI_STRINGS key (chapters / contextHeader / etc)."""
    lines = [f"  /* ── {comment} ── */", f"  {key}: {{"]
    for code, _name in LANGS:
        val = translations.get(code, {}).get(key, "")
        if not val:
            continue
        # Quote the code if it contains a hyphen ('zh-TW') — JS object keys
        # without hyphens are bareword-ok, with hyphens need quotes.
        code_lit = f"'{code}'" if "-" in code else code
        lines.append(f"    {code_lit}: '{js_escape(val)}',")
    lines.append("  },")
    return "\n".join(lines)


def render_file(translations: dict) -> str:
    """Build the full ui-strings.js content."""
    return f"""/**
 * UI string translations — static dictionary for in-app labels.
 *
 * Content translations (title/summary/chapters-list/transcript) go through
 * the translation API. This file covers short, stable UI labels where the
 * cost/latency of API translation isn't justified.
 *
 * GENERATED — do not hand-edit individual entries unless you also update
 * the source/prompt and re-run scripts/regenerate_ui_strings.py.
 *
 * Tone: casual / conversational. Where a lang distinguishes formal/informal
 * "you", informal is used (matches the friendly product voice).
 */

export const UI_STRINGS = {{
{render_dict('chapters', '"Chapters" — section label', translations)}

{render_dict('contextHeader', '"Context from RecapShark.com" — header above the context block', translations)}

{render_dict('recapTemplate', "Recap intro label (always reads '1 minute' regardless of actual video length — deliberate product choice)", translations)}

{render_dict('chatGreeting', 'Chat greeting bubble — friendly intro', translations)}
}};

/**
 * Resolve a UI string for the given language, with English fallback.
 * Accepts region variants (e.g. 'fa-IR' → falls back to 'fa').
 */
export function uiString(key, lang) {{
  const map = UI_STRINGS[key];
  if (!map) return '';
  if (!lang) return map.en || '';
  if (map[lang]) return map[lang];
  const base = lang.split('-')[0];
  if (map[base]) return map[base];
  return map.en || '';
}}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="Translate + print but don't overwrite ui-strings.js")
    ap.add_argument("--limit", type=int, default=None,
                    help="Only translate the first N langs (for testing)")
    args = ap.parse_args()

    client = get_client()
    langs_to_run = LANGS[:args.limit] if args.limit else LANGS

    translations = {}
    print(f"Translating {len(langs_to_run)} languages...", flush=True)
    for i, (code, name) in enumerate(langs_to_run, 1):
        # ASCII-safe print: Windows cp1252 console can't encode chars like
        # the macron in "Māori" → script would crash on print, even though
        # the API call itself succeeded. Replace non-ASCII for display only.
        safe_name = name.encode('ascii', 'replace').decode('ascii')
        print(f"  [{i:3d}/{len(langs_to_run)}] {code:6s} {safe_name} ... ", end="", flush=True)
        try:
            result = translate_lang(client, code, name)
            translations[code] = result
            print("ok")
        except Exception as e:
            print(f"FAILED: {e}")
            # Don't crash — keep going so we can see all failures at once
            translations[code] = {}

    failed = [c for c, t in translations.items() if not t]
    if failed:
        print(f"\n[WARN] {len(failed)} langs failed: {failed}")
        print("        These will be missing from the output. Re-run to retry.")

    output = render_file(translations)
    if args.dry_run:
        # Write to a sibling file so we can inspect via Read tool / editor
        # without fighting Windows console encoding when printing non-ASCII.
        dry_path = OUTPUT_PATH.with_suffix(".dry-run.js")
        dry_path.write_text(output, encoding="utf-8")
        print(f"\n[DRY RUN] Wrote preview to {dry_path} ({len(output)} bytes)")
    else:
        OUTPUT_PATH.write_text(output, encoding="utf-8")
        print(f"\nWrote {OUTPUT_PATH} ({len(output)} bytes)")


if __name__ == "__main__":
    main()
