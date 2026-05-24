"""
Pipeline shared infrastructure (NOT domain-specific).

Things that live here are general-purpose primitives used across multiple
domains (analytics, karaoke, transcript, etc.). Anything domain-specific
belongs in its own subpackage.
"""

from .rate_limit import AsyncTokenBucket

__all__ = ["AsyncTokenBucket"]
