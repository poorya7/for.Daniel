"""Named Entity Recognition + all-caps recasing for transcripts.

Analyzes transcript text and returns:
  - entities: list of {text, type} for highlighting (deduplicated, ordered by
    first occurrence). Types map to frontend CSS classes:
      PERSON  -> tx-name  (purple)
      ORG     -> tx-org   (blue)
      GPE     -> tx-gpe   (teal)
      EVENT   -> tx-event (indigo)
    Other spaCy types (DATE, MONEY, CARDINAL, etc.) are ignored — those are
    already handled by the frontend regex in entity-highlighter.js.
  - recased_text: a properly-sentence-cased version of the text IFF the
    source was mostly all-caps (YouTube auto-captions sometimes shout
    everything). null otherwise. Frontend swaps this in when present.

Activation:
  - Set ENABLE_NER=true in .env to turn on.
  - Falls back to a no-op (returns empty entities, no recasing) if:
      * ENABLE_NER is unset/false
      * spaCy isn't installed
      * the requested language model isn't downloaded
      * any runtime error occurs during analysis
    All paths are logged but never raise — transcript pipeline keeps working.

Languages:
  - English only at launch (en_core_web_sm). Add models per-language below
    in _MODEL_BY_LANG as needed. RTL scripts (fa/ar/he) skipped — no case
    to fix, and spaCy NER quality on those is poor without bigger models.
"""
from __future__ import annotations

from config import enable_ner as _enable_ner
import re
import sys
from typing import Optional

# ── Tunables ─────────────────────────────────────────────────────────────
# Threshold for "this transcript is all-caps and should be recased."
# Counts non-stopword tokens that contain >=2 letters and have NO lowercase.
# 80% means >= 80% of qualifying words are written in pure uppercase.
_ALL_CAPS_THRESHOLD = 0.80

# Per-language spaCy model. Add entries here to support more languages.
# Each model needs to be downloaded once on the server with:
#   python -m spacy download <model_name>
_MODEL_BY_LANG = {
    "en": "en_core_web_sm",
    # Future:
    # "es": "es_core_news_sm",
    # "fr": "fr_core_news_sm",
    # "de": "de_core_news_sm",
}

# spaCy entity labels we care about, mapped to frontend CSS class names.
# Anything not in this map is dropped from the response.
#
# DATE / CARDINAL / ORDINAL / MONEY / PERCENT / QUANTITY are routed to the
# same DATE/NUM buckets the regex pipeline uses on the frontend, so:
#   - digit-form numbers ("31") still get caught by the regex (and would
#     win the masking conflict against any overlapping NER claim)
#   - word-form numbers ("seventy four", "first", "ten percent",
#     "twenty dollars", "three meters") get caught here by spaCy and
#     show in the same green/orange color as their digit equivalents
#   - natural-language dates ("yesterday", "next Friday") get the same
#     orange as ISO/slash dates
_ENTITY_TYPE_MAP = {
    "PERSON":   "PERSON",
    "ORG":      "ORG",
    "GPE":      "GPE",       # cities, countries, states
    "LOC":      "GPE",       # non-GPE locations (mountains, oceans) — fold into GPE
    "EVENT":    "EVENT",
    "FAC":      "ORG",       # buildings, airports — fold into ORG
    "NORP":     "ORG",       # nationalities, religious or political groups — fold into ORG
    "DATE":     "DATE",      # natural-language dates ("yesterday", "next Friday")
    "CARDINAL": "NUM",       # word-form numbers ("seventy four", "three")
    "ORDINAL":  "NUM",       # ordinals ("first", "twenty-fifth")
    "MONEY":    "NUM",       # monetary phrases ("twenty dollars")
    "PERCENT":  "NUM",       # percent phrases ("ten percent")
    "QUANTITY": "NUM",       # measurements ("three meters")
}

# ── State ────────────────────────────────────────────────────────────────
# Lazy-loaded spaCy and model cache. Kept module-level so a single process
# loads each model exactly once (~200MB RAM per model, so pay it once).
_spacy = None  # the imported spacy module, or False if unavailable
_models: dict[str, object] = {}  # lang -> loaded nlp pipeline


def is_enabled() -> bool:
    """True iff NER should run. Cheap; called on every request."""
    return _enable_ner()


def _try_import_spacy():
    """Import spaCy lazily. Returns the module or False on failure (and caches)."""
    global _spacy
    if _spacy is not None:
        return _spacy
    try:
        import spacy  # type: ignore
        _spacy = spacy
        return _spacy
    except Exception as e:
        print(f"[NER] spaCy not available, NER disabled: {e}", file=sys.stderr, flush=True)
        _spacy = False
        return False


def _get_model(lang: str):
    """Load (and cache) the spaCy pipeline for `lang`. Returns None if unsupported."""
    if lang in _models:
        return _models[lang]
    model_name = _MODEL_BY_LANG.get(lang)
    if not model_name:
        return None
    spacy = _try_import_spacy()
    if not spacy:
        return None
    try:
        # Disable components we don't use (parser, lemmatizer) for speed.
        # The NER component + its prereqs (tok2vec, tagger, attribute_ruler) stay.
        nlp = spacy.load(model_name, disable=["parser", "lemmatizer"])
        _models[lang] = nlp
        print(f"[NER] Loaded model {model_name} for lang={lang}", flush=True)
        return nlp
    except Exception as e:
        print(f"[NER] Failed to load {model_name}: {e}", file=sys.stderr, flush=True)
        # Cache the failure as None so we don't retry every request.
        _models[lang] = None
        return None


def _is_all_caps(text: str) -> bool:
    """Heuristic: is this transcript mostly shouting?

    Counts tokens with >= 2 letters. A token is "all-caps" if it has any
    uppercase letters and zero lowercase letters. If >= _ALL_CAPS_THRESHOLD
    of qualifying tokens are all-caps, the whole transcript is treated as
    needing recasing.

    Single-character tokens (`I`, `A`) and tokens with no letters (`123`,
    `!!!`) are excluded — they're capital-by-rule, not by shouting.
    """
    if not text:
        return False
    # Find all "word" tokens — at least 2 letters of any case.
    tokens = re.findall(r"[A-Za-z]{2,}", text)
    if len(tokens) < 5:
        # Too short to make a confident call; assume normal case.
        return False
    all_caps_count = sum(1 for t in tokens if not any(c.islower() for c in t))
    return (all_caps_count / len(tokens)) >= _ALL_CAPS_THRESHOLD


def recase(text: str, entity_texts: list[str]) -> str:
    """Reconstruct properly-cased text from an all-caps original.

    Public helper — exposed so the transcript route can recase individual
    segments using the SAME entity list that was detected on the joined
    full text. Without per-segment recasing, only the full transcript
    would lose its all-caps; the per-segment text used by video subtitles
    and row rendering would still be SHOUTING.

    Rules:
      1. Lowercase everything.
      2. Capitalize the first alphabetic character at the start of the
         text, and after every sentence terminator (`.`, `!`, `?`) plus
         whitespace.
      3. Lowercase standalone pronoun `i` -> `I`.
      4. For each entity surface form, find every word-bounded occurrence
         in the lowercased text and Title Case it (each word in the entity
         starts with an uppercase letter). "white house correspondents
         dinner" -> "White House Correspondents Dinner".

    Entity matching uses word boundaries so "trump" inside "trumpet"
    won't be over-capitalized — but spaCy NER doesn't typically emit
    entity surface forms that are substrings of other words, so this is
    a defensive bound rather than an everyday concern.
    """
    if not text:
        return text
    lowered = text.lower()
    # Mutable char buffer so we can splice in uppercase letters at specific
    # indices without quadratic string concatenation.
    chars = list(lowered)

    def _cap_at(idx: int) -> None:
        if 0 <= idx < len(chars) and chars[idx].isalpha():
            chars[idx] = chars[idx].upper()

    # First non-whitespace alphabetic char of the buffer.
    m = re.search(r"[A-Za-z]", lowered)
    if m:
        _cap_at(m.start())
    # After every sentence terminator + space(s).
    for m in re.finditer(r"[.!?]\s+([A-Za-z])", lowered):
        _cap_at(m.start(1))
    # Standalone pronoun "i" — whitespace-bounded `i` that isn't part of
    # a longer word. Also handles `i'm`, `i'll`, etc. via the apostrophe
    # case in the lookahead.
    for m in re.finditer(r"(?<=\s)i(?=\s|'|$|[.,!?])", lowered):
        _cap_at(m.start())

    # Entity capitalization — Title Case each word in each entity span.
    for ent_text in entity_texts:
        if not ent_text or len(ent_text) < 2:
            continue
        ent_lower = ent_text.lower()
        # Word-boundary regex; escape regex meta in the entity text so
        # punctuation like "U.S." or "D.C." matches literally.
        pattern = r"\b" + re.escape(ent_lower) + r"\b"
        for m in re.finditer(pattern, lowered):
            start, end = m.start(), m.end()
            at_word_start = True
            for i in range(start, end):
                c = chars[i]
                if c.isspace() or c in "-'":
                    at_word_start = True
                    continue
                if at_word_start and c.isalpha():
                    chars[i] = c.upper()
                at_word_start = False

    return "".join(chars)


def _dedupe_entities(doc) -> list[dict]:
    """Build the response entity list — one per surface form, ordered by
    first occurrence. Frontend uses these to colorize matching spans in
    each row, so we don't need positional info on the wire (regex with
    word boundaries handles it cheaply per row)."""
    seen: dict[tuple[str, str], int] = {}  # (lowered_text, type) -> first_idx
    out: list[dict] = []
    for ent in doc.ents:
        ftype = _ENTITY_TYPE_MAP.get(ent.label_)
        if not ftype:
            continue
        text = ent.text.strip()
        if len(text) < 2:
            continue  # skip 1-char "entities" (rare but spaCy can emit them)
        key = (text.lower(), ftype)
        if key in seen:
            continue
        seen[key] = len(out)
        out.append({"text": text, "type": ftype})
    return out


def analyze(text: str, lang: str = "en") -> dict:
    """Public entry point. Returns:
        {
          "entities": [{"text": "Stephen Colbert", "type": "PERSON"}, ...],
          "recased_text": "Welcome friends and neighbors..." or None,
        }

    Always returns a valid dict — never raises. If NER is disabled,
    unsupported, or fails midway, returns the empty result and the caller
    proceeds with the original text.
    """
    empty = {"entities": [], "recased_text": None}
    if not is_enabled():
        return empty
    if not text or len(text.strip()) < 20:
        # Too short to bother with NER.
        return empty
    # Strip any 2-letter region/script suffix so 'fa-IR' uses the 'fa' model.
    base_lang = (lang or "en").split("-")[0].lower()
    nlp = _get_model(base_lang)
    if nlp is None:
        return empty

    try:
        # If the text is all-caps, run NER on the lowercased version —
        # spaCy's NER is trained on properly-cased text and accuracy
        # collapses on UPPERCASE INPUT. The recased output uses the
        # entity surface forms from the lowered doc.
        all_caps = _is_all_caps(text)
        analysis_text = text.lower() if all_caps else text
        doc = nlp(analysis_text)
        entities = _dedupe_entities(doc)
        if all_caps:
            ent_texts = [e["text"] for e in entities]
            recased_text = recase(text, ent_texts)
        else:
            recased_text = None
        return {"entities": entities, "recased_text": recased_text}
    except Exception as e:
        # NER failure shouldn't break the transcript pipeline.
        print(f"[NER] analyze() failed (lang={lang}): {e}", file=sys.stderr, flush=True)
        return empty
