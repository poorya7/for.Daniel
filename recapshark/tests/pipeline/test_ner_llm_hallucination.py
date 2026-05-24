"""Standalone smoke test for the hallucination guard in ner_llm.

Run before deploys to confirm the guard still drops fake entities. The guard
is load-bearing — without it, the LLM's invented names get highlighted as
real ones in the transcript.

Usage:
    cd pipeline
    .\\venv\\Scripts\\python.exe test_ner_llm_hallucination.py

Exits 0 on success, 1 on any failure. Prints PASS/FAIL per case.
No dependencies beyond the project venv.
"""
from __future__ import annotations

import sys

# Ensure UTF-8 stdout so Persian / Arabic test cases don't crash on Windows.
sys.stdout.reconfigure(encoding="utf-8")

from ner_llm import _filter_hallucinations  # type: ignore


_FAILS: list[str] = []


def _check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        _FAILS.append(name)


def case_real_entity_kept() -> None:
    """An entity that actually appears in the text should survive."""
    text = "Joe Rogan interviewed Elon Musk last Tuesday."
    entities = [
        {"text": "Joe Rogan", "type": "PERSON"},
        {"text": "Elon Musk", "type": "PERSON"},
    ]
    kept, dropped = _filter_hallucinations(entities, text)
    _check("real entities kept", len(kept) == 2 and len(dropped) == 0,
           f"kept={kept} dropped={dropped}")


def case_hallucinated_dropped() -> None:
    """An entity NOT in the text must be dropped (the whole point of the guard)."""
    text = "Joe Rogan interviewed Elon Musk last Tuesday."
    entities = [
        {"text": "Joe Rogan", "type": "PERSON"},
        {"text": "Bill Gates", "type": "PERSON"},  # not in text
    ]
    kept, dropped = _filter_hallucinations(entities, text)
    kept_texts = [e["text"] for e in kept]
    dropped_texts = [e["text"] for e in dropped]
    _check("hallucination dropped",
           kept_texts == ["Joe Rogan"] and dropped_texts == ["Bill Gates"],
           f"kept={kept_texts} dropped={dropped_texts}")


def case_case_insensitive_match() -> None:
    """Surface form casing differences from the source shouldn't drop a match."""
    text = "joe rogan interviewed elon musk last tuesday."  # all lowercase
    entities = [
        {"text": "Joe Rogan", "type": "PERSON"},   # title case
        {"text": "ELON MUSK", "type": "PERSON"},   # all caps
    ]
    kept, _ = _filter_hallucinations(entities, text)
    _check("case-insensitive match", len(kept) == 2,
           f"kept={[e['text'] for e in kept]}")


def case_too_short_dropped() -> None:
    """Single-character entities are dropped — too noisy to highlight."""
    text = "I went to the park."
    entities = [
        {"text": "I", "type": "PERSON"},   # 1 char
        {"text": "", "type": "PERSON"},    # empty
    ]
    kept, dropped = _filter_hallucinations(entities, text)
    reasons = [d.get("reason") for d in dropped]
    _check("too-short and empty dropped",
           len(kept) == 0 and reasons.count("too_short") == 2,
           f"kept={kept} dropped reasons={reasons}")


def case_bad_type_dropped() -> None:
    """Unknown entity types (typo'd or invented) are dropped."""
    text = "Apple released a new iPhone."
    entities = [
        {"text": "Apple", "type": "ORG"},        # valid
        {"text": "iPhone", "type": "PRODUCT"},   # PRODUCT isn't in our taxonomy
    ]
    kept, dropped = _filter_hallucinations(entities, text)
    kept_texts = [e["text"] for e in kept]
    drop_reasons = [d.get("reason") for d in dropped]
    _check("bad type dropped",
           kept_texts == ["Apple"] and drop_reasons == ["bad_type"],
           f"kept={kept_texts} drop_reasons={drop_reasons}")


def case_persian_unicode() -> None:
    """Persian / Arabic / non-Latin text must work — UTF-8 normalization
    must not break Unicode matching."""
    text = "دسی لیدیک با لیندزی گراهام مصاحبه کرد."
    entities = [
        {"text": "دسی لیدیک", "type": "PERSON"},     # in text
        {"text": "لیندزی گراهام", "type": "PERSON"},  # in text
        {"text": "ترامپ", "type": "PERSON"},          # NOT in text → drop
    ]
    kept, dropped = _filter_hallucinations(entities, text)
    kept_texts = [e["text"] for e in kept]
    drop_texts = [e["text"] for e in dropped]
    _check("persian unicode handled",
           len(kept) == 2 and drop_texts == ["ترامپ"],
           f"kept={kept_texts} dropped={drop_texts}")


def case_substring_in_word_kept() -> None:
    """Loose substring is intentional — frontend regex enforces word
    boundaries when applying highlights, so a substring like 'Joe' inside
    'Joel' staying through the guard is harmless. Documenting the
    intent here so a future tightening change is deliberate."""
    text = "Joel Smith was on the show."
    entities = [
        {"text": "Joe", "type": "PERSON"},  # substring of 'Joel'
    ]
    kept, _ = _filter_hallucinations(entities, text)
    _check("loose substring kept (boundary enforcement is frontend's job)",
           len(kept) == 1)


def case_dedupe_independence() -> None:
    """The hallucination filter does NOT dedupe — that's a separate stage.
    Two valid entries for the same surface form both survive here; the
    `_dedupe()` call later removes the duplicate."""
    text = "Joe Rogan and Joe Rogan and Joe Rogan."
    entities = [
        {"text": "Joe Rogan", "type": "PERSON"},
        {"text": "Joe Rogan", "type": "PERSON"},
    ]
    kept, _ = _filter_hallucinations(entities, text)
    _check("filter does not dedupe", len(kept) == 2)


def main() -> int:
    print("Hallucination guard tests:")
    case_real_entity_kept()
    case_hallucinated_dropped()
    case_case_insensitive_match()
    case_too_short_dropped()
    case_bad_type_dropped()
    case_persian_unicode()
    case_substring_in_word_kept()
    case_dedupe_independence()

    print()
    if _FAILS:
        print(f"FAILED: {len(_FAILS)} case(s) — {_FAILS}")
        return 1
    print("All cases passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
