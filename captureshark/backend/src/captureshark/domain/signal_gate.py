"""Backend signal gate — rejects input the LLM has nothing to chew on.

This is the **server-side** half of the gate the frontend already runs
on text input + voice recording duration. The frontend stops the
obvious garbage at the source (instant feedback, no round-trip). This
module catches the cases the frontend can't see:

  * Voice transcripts that came back empty/garbage after Whisper ran
    (Whisper notoriously hallucinates canned phrases on silence —
    "Thank you for watching", "Bye", just "you").
  * Direct API hits from scripts or broken clients that skipped the
    frontend gate.

The heuristic mirrors the frontend rule exactly so the two gates feel
identical when the backend one fires (a rejection is a rejection, no
matter who issued it):

  * Pure-empty / whitespace → reject
  * Single character → reject
  * 2-char tokens with no digit / "@" / whitespace → reject (catches
    "um", "hi" etc.; intentionally also catches real 2-char names like
    "Bo" — the false-positive cost is small vs the noise cost)
  * Anything matching the Whisper hallucination denylist → reject

The denylist is a fixed set chosen from common Whisper-on-silence
artefacts. If real users hit a hallucination we missed, the symptom
will be an empty/garbage review card; that's the trigger to add it.
"""

from __future__ import annotations

import re


# Whisper-on-silence hallucinations. Compared case-insensitively against
# the full trimmed transcript — i.e. these are MATCHED-ON-EQUALITY, not
# substrings, so a real transcript containing "thank you" as part of a
# larger sentence still passes. Add new entries as real-world captures
# expose them.
_WHISPER_HALLUCINATIONS: frozenset[str] = frozenset(
    {
        "you",
        "you.",
        "bye",
        "bye.",
        "bye!",
        "thanks",
        "thanks.",
        "thank you",
        "thank you.",
        "thank you!",
        "thanks for watching",
        "thanks for watching.",
        "thanks for watching!",
        "thank you for watching",
        "thank you for watching.",
        "thank you for watching!",
        "thank you for watching, see you next time",
        "thanks for watching, see you next time",
        "please subscribe",
        "subscribe",
    }
)


# `\d` covers ASCII digits. `\s` covers whitespace. `@` is literal.
# Any of these in a short string means the user provided structure
# (a number, an email-shaped token, multiple words) that's worth a
# round-trip even at 2 chars.
_STRUCTURE_RE = re.compile(r"[\d@\s]")


def passes_signal_gate(text: str) -> bool:
    """Return True if `text` is worth sending to the extraction LLM.

    Mirrors the frontend `_isReady` rule plus a Whisper-hallucination
    denylist for the voice path. Pure function, no I/O — easy to unit-test
    by handing in canned strings.
    """
    trimmed = text.strip()
    if not trimmed:
        return False
    if trimmed.lower() in _WHISPER_HALLUCINATIONS:
        return False
    if len(trimmed) < 2:
        return False
    if len(trimmed) < 3 and not _STRUCTURE_RE.search(trimmed):
        return False
    return True
