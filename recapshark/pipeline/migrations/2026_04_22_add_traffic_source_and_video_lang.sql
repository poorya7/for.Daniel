-- 2026-04-22 — add traffic-source attribution + main video language to rs_sessions.
--
-- Rationale (see docs/_tech/06_ANALYTICS.md): the analytics dashboard needs to
-- show *how* a visitor landed (direct vs search vs social vs referral) and the
-- main language of the video they pasted, plus support filtering on both. None
-- of these signals existed before this migration:
--
--   * traffic_source / traffic_medium come from GA4's collected_traffic_source
--     struct (per-event session attribution). The ETL now extracts the value
--     of the earliest event in each session and stores it here.
--   * landed_via is a small derived enum we compute in the ETL from the medium
--     ('(none)' → direct, 'organic' → search, 'social' → social, 'referral' →
--     referral, anything else → other). Stored separately so the dashboard
--     filter is fast (no LIKEs against medium strings) and so we can tweak the
--     bucketing rules later without re-querying BQ.
--   * video_lang is the language of the video the visitor processed. GA4 used
--     to receive only video_id on the video_processed event; the frontend now
--     also fires video_lang_detected once the lang is known, and the ETL picks
--     up the first video_lang seen per session.
--
-- Backfill: traffic_source / traffic_medium / landed_via *can* be backfilled by
-- re-running the ETL for the past N days (GA4 has the raw data). video_lang
-- *cannot* be backfilled — historical sessions never fired the new event, so
-- those rows will stay NULL. New sessions will populate it normally.
--
-- Run this in the Supabase SQL editor before the next ETL run. All columns are
-- nullable + have no default, so existing rows are unaffected.

ALTER TABLE rs_sessions
  ADD COLUMN IF NOT EXISTS traffic_source TEXT,
  ADD COLUMN IF NOT EXISTS traffic_medium TEXT,
  ADD COLUMN IF NOT EXISTS landed_via     TEXT,
  ADD COLUMN IF NOT EXISTS video_lang     TEXT;

-- Indexes on landed_via + device support the new dashboard filter dropdowns
-- without table scans (today the dashboard only filters in Python, but if we
-- ever push filters into PostgREST these indexes are ready).
CREATE INDEX IF NOT EXISTS rs_sessions_landed_via_idx ON rs_sessions (landed_via);
CREATE INDEX IF NOT EXISTS rs_sessions_device_idx     ON rs_sessions (device);
