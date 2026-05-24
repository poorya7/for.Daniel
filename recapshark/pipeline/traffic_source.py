"""Traffic-source bucketing — leaf module shared by ETL + analytics.

Buckets GA4's traffic_medium / traffic_source pair into a small enum the
dashboard understands. Lives in its own leaf module so both
`pipeline/etl_sessions.py` (writes the bucket into `rs_sessions.landed_via`
on upsert) and `pipeline/analytics/filters.py` (reads it back, with this as
a fallback for old rows that pre-date the ETL writing the column) can
import without a circular dependency.

Buckets:
  direct   — medium '(none)' / null / 'none' / source '(direct)'
  search   — medium 'organic' (google/bing/etc.) or 'cpc'/'paid'
  social   — medium 'social' / 'social-network' / source matches a known social host
  referral — medium 'referral'
  other    — anything else (email, affiliate, custom UTM, …)
"""

from typing import Optional


SOCIAL_HOSTS = frozenset({
    "facebook.com", "instagram.com", "tiktok.com", "x.com", "twitter.com",
    "t.co", "reddit.com", "linkedin.com", "youtube.com", "pinterest.com",
})


def derive_landed_via(medium: Optional[str], source: Optional[str]) -> Optional[str]:
    m = (medium or "").strip().lower()
    s = (source or "").strip().lower()
    if not m and not s:
        return None
    if m in ("(none)", "none", "") and (not s or s in ("(direct)", "direct")):
        return "direct"
    if "organic" in m or m in ("cpc", "ppc", "paidsearch", "paid_search"):
        return "search"
    if "social" in m or s in SOCIAL_HOSTS:
        return "social"
    if m == "referral":
        return "referral"
    return "other"
