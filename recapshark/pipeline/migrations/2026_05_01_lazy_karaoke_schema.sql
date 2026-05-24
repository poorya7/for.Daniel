-- =============================================================================
-- Lazy Karaoke — Supabase schema migration (v1)
-- =============================================================================
-- Created: 2026-05-01
--
-- What this creates:
--   • karaoke_chunks         — cache table for chunk word output (per-video, per-range)
--   • asr_provider_daily_usage     — daily cap accounting (replaces .asr_provider_usage.json)
--   • reserve_asr_provider_seconds — atomic conditional reservation RPC
--   • release_asr_provider_reservation — release reservation on claim-fail RPC
--   • finalize_asr_provider_billing — convert reservation to billed seconds RPC
--   • karaoke_savings_today  — telemetry view (30 days of cost/usage)
--
-- Safe to run on existing Supabase project — all CREATE statements are new
-- objects; no ALTER on existing tables. RLS enabled with no policies = service-
-- role only access (no public can touch these).
--
-- After running: verify with `SELECT count(*) FROM karaoke_chunks;` (should be 0).
-- =============================================================================


-- =============================================================================
-- karaoke_chunks: cache table for chunk word output
-- =============================================================================
-- Each row = one chunk's worth of word-level karaoke timestamps from AsrProvider.
-- Key = (video_id, start_sec, dur_sec, lang, provider, config_hash).
-- Cross-user reuse: popular videos get free karaoke after the first viewer pays.
--
-- Status state machine: pending → ready (success) OR pending → failed (chunk-
-- specific failure). Global failures (cap_hit, queue_timeout, audio_not_ready)
-- do NOT cache — they delete/skip the row to avoid poisoning the cache key.

create type public.karaoke_chunk_status as enum ('pending', 'ready', 'failed');

create table public.karaoke_chunks (
  id            bigserial primary key,
  video_id      text        not null,
  start_sec     integer     not null,
  dur_sec       integer     not null,
  lang          text        not null default '',         -- canonical: empty/null/und/auto → ''
  provider      text        not null default 'asr_provider',
  config_hash   text        not null,                    -- e.g. 'asr_provider-v1-overlap15'
  status        public.karaoke_chunk_status not null default 'pending',

  words         jsonb,                                   -- nullable; populated when status='ready'
  audio_seconds double precision,                        -- billed-to-AsrProvider duration
  cost_usd      numeric(10, 4),                          -- audio_seconds * 0.00017
  error_code    text,                                    -- non-null when status='failed'
  locked_until  timestamptz,                             -- 120s lock for in-flight ownership

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  last_accessed_at  timestamptz not null default now(),

  -- Status-aware integrity constraints:
  constraint karaoke_ready_has_words check (
    status <> 'ready' or words is not null
  ),
  constraint karaoke_ready_has_billing check (
    status <> 'ready' or (audio_seconds is not null and cost_usd is not null)
  ),
  constraint karaoke_failed_has_error check (
    status <> 'failed' or error_code is not null
  )
);

-- Unique index = the cache key. Used by single-flight INSERT-or-takeover logic.
create unique index karaoke_chunks_key_idx
  on public.karaoke_chunks (video_id, start_sec, dur_sec, lang, provider, config_hash);

-- Status + lock index for stale-takeover queries (find pending rows whose
-- locked_until has expired).
create index karaoke_chunks_status_lock_idx
  on public.karaoke_chunks (status, locked_until);

-- LRU index — only ready rows participate in eviction (when we eventually add it).
create index karaoke_chunks_lru_idx
  on public.karaoke_chunks (last_accessed_at)
  where status = 'ready';

-- Service-role only access (no public read/write):
alter table public.karaoke_chunks enable row level security;
-- (no policies = service-role only by default; the FastAPI server uses service-role key)


-- =============================================================================
-- asr_provider_daily_usage: daily cap accounting (replaces .asr_provider_usage.json)
-- =============================================================================
-- One row per day. Tracks reserved + billed seconds against the daily USD cap.
-- Atomic conditional UPDATE in the reserve RPC prevents race conditions under
-- concurrent traffic.

create table public.asr_provider_daily_usage (
  usage_date         date primary key,
  reserved_seconds   double precision not null default 0,
  billed_seconds     double precision not null default 0,
  spend_cap_usd      numeric(10, 2),
  updated_at         timestamptz not null default now()
);

alter table public.asr_provider_daily_usage enable row level security;


-- =============================================================================
-- reserve_asr_provider_seconds: atomic conditional reservation RPC
-- =============================================================================
-- Called BEFORE submitting to AsrProvider. Reserves seconds against the daily cap.
-- Honors mid-day cap changes via the p_cap_usd parameter (admin can lower the
-- cap mid-day and the next call sees it). p_cap_usd <= 0 means "no cap" (admin
-- bypass path).
--
-- Returns the new reserved_seconds total on success. Returns 0 rows on cap_hit.
--
-- Atomic: the check and the increment happen in the same UPDATE statement so
-- 25 concurrent requests at exactly $0.001 cap will see exactly N succeed and
-- (25-N) get cap_hit, where N matches the cap math precisely.

create or replace function public.reserve_asr_provider_seconds(
  p_seconds         double precision,
  p_cap_usd         numeric,
  p_rate_per_second numeric default 0.00017
) returns table(reserved_seconds double precision) language sql as $$
  -- Ensure today's row exists.
  insert into public.asr_provider_daily_usage (usage_date, reserved_seconds, billed_seconds, spend_cap_usd)
  values (current_date, 0, 0, p_cap_usd)
  on conflict (usage_date) do nothing;

  -- Atomic conditional UPDATE. Uses p_cap_usd in BOTH the conditional check AND
  -- the stored value (so admin lowering the cap mid-day takes effect on next call).
  -- p_cap_usd <= 0 means "no cap" (admin path).
  update public.asr_provider_daily_usage
     set reserved_seconds = reserved_seconds + p_seconds,
         spend_cap_usd = p_cap_usd,
         updated_at = now()
   where usage_date = current_date
     and (p_cap_usd <= 0 or (reserved_seconds + p_seconds) * p_rate_per_second <= p_cap_usd)
   returning reserved_seconds;
$$;


-- =============================================================================
-- release_asr_provider_reservation: release a reservation on claim-fail
-- =============================================================================
-- Called when reserve_asr_provider_seconds succeeds but a downstream step (claim-pending,
-- semaphore acquire) fails BEFORE AsrProvider accepts the init request. Once AsrProvider
-- init accepts, the seconds become BILLED via finalize_asr_provider_billing — NEVER
-- released, regardless of polling outcome (AsrProvider bills regardless).

create or replace function public.release_asr_provider_reservation(
  p_seconds double precision
) returns void language sql as $$
  update public.asr_provider_daily_usage
     set reserved_seconds = greatest(0, reserved_seconds - p_seconds),
         updated_at = now()
   where usage_date = current_date;
$$;


-- =============================================================================
-- finalize_asr_provider_billing: convert reservation to billed seconds
-- =============================================================================
-- Called after AsrProvider init accepts the job. Moves p_seconds from
-- reserved_seconds bucket to billed_seconds bucket so cap math stays consistent.
-- Atomic: the move happens in a single UPDATE.

create or replace function public.finalize_asr_provider_billing(
  p_seconds double precision
) returns void language sql as $$
  update public.asr_provider_daily_usage
     set reserved_seconds = greatest(0, reserved_seconds - p_seconds),
         billed_seconds   = billed_seconds + p_seconds,
         updated_at = now()
   where usage_date = current_date;
$$;


-- =============================================================================
-- karaoke_savings_today: telemetry view (30 days)
-- =============================================================================
-- Aggregates daily karaoke chunk activity for dashboard charting + telemetry.
-- Powers the "actual savings vs counterfactual no-cache" launch comms metric.

create or replace view public.karaoke_savings_today as
select
  date_trunc('day', created_at)::date as day,
  count(*) filter (where status = 'ready')                  as chunks_ready,
  count(*) filter (where status = 'failed')                 as chunks_failed,
  sum(audio_seconds) filter (where status = 'ready')        as asr_provider_seconds,
  sum(cost_usd) filter (where status = 'ready')             as actual_cost_usd
from public.karaoke_chunks
where created_at >= current_date - interval '30 days'
group by 1
order by 1 desc;


-- =============================================================================
-- No eviction cron at launch (decision D10/D28)
-- =============================================================================
-- Each row is tiny (~5-10 KB JSON); the data was already paid to AsrProvider, so
-- evicting popular content forces us to re-pay later. Cheaper to let the table
-- grow.
--
-- Revisit ONLY if the table exceeds 10 GB OR row count exceeds ~1M (whichever
-- comes first). At that point ship a daily cron with whatever retention window
-- the data justifies. Until then: no cron, no churn, no decision to revisit
-- monthly.


-- =============================================================================
-- Verification queries (run these after migration to confirm)
-- =============================================================================
-- Should return 0:
--   SELECT count(*) FROM public.karaoke_chunks;
--   SELECT count(*) FROM public.asr_provider_daily_usage;
--
-- Should list 3 functions:
--   SELECT proname FROM pg_proc WHERE proname IN ('reserve_asr_provider_seconds',
--   'release_asr_provider_reservation', 'finalize_asr_provider_billing');
--
-- Should return the view:
--   SELECT * FROM public.karaoke_savings_today;
--
-- Quick smoke-test the reservation RPC (no real AsrProvider call, just exercises
-- the function — this WILL create today's row in asr_provider_daily_usage):
--   SELECT * FROM public.reserve_asr_provider_seconds(0, 5.00, 0.00017);
--   SELECT * FROM public.asr_provider_daily_usage;
--   -- Expected: row for today with reserved_seconds=0, spend_cap_usd=5.00
--   SELECT public.release_asr_provider_reservation(0);
