-- =============================================================================
-- Google Translate cost protection — Supabase schema migration
-- =============================================================================
-- Created: 2026-05-13
--
-- Why: pre-launch cost-control sweep — translate had no cache, no per-IP
-- cap, and no global $ kill-switch. Karaoke had all three; translate didn't.
--
-- What this creates:
--   • rs_translation_cache         — content-hash keyed cross-user cache
--                                    (one row per unique (text, src→tgt) pair)
--   • rs_translate_daily_usage     — global daily char counter + USD cap
--   • rs_translate_ip_daily        — per-IP daily char counter
--   • reserve_translate_chars RPC  — atomic two-table cap check + increment
--
-- Pricing model (Google Translate v2): $20 per 1M characters → $0.00002/char.
--   • Default global cap: $15/day = 750,000 chars = ~5h of transcript × 3 langs
--   • Default per-IP cap: 333,000 chars/day = ~5h of transcript × 1 lang
-- Both configurable via env vars (TRANSLATE_DAILY_CAP_USD, TRANSLATE_PER_IP_DAILY_CHARS).
--
-- Mirrors the karaoke pattern from 2026_05_01_lazy_karaoke_schema.sql:
--   • RLS on, no policies = service-role only access
--   • Atomic conditional UPDATE in the RPC (race-safe under concurrent traffic)
--   • Mid-day cap changes honored via the p_*_cap parameters (admin can lower
--     the cap mid-day and the next call sees it)
--
-- After running: verify with `SELECT count(*) FROM public.rs_translation_cache;` (0).
-- =============================================================================


-- =============================================================================
-- rs_translation_cache: content-hash keyed cross-user cache
-- =============================================================================
-- Each row = one cached translation. Key = sha256 of canonical input + langs.
-- Cross-user reuse: popular videos get free translations after the first viewer
-- pays. `result_json` shape depends on caller — for `translate_text` it's
-- `{"text": "..."}`, for `translate_lines` it's `{"lines": [{id, text}, ...]}`.

create table public.rs_translation_cache (
  content_hash       text        not null,         -- sha256(canonical input)
  source_lang        text        not null,
  target_lang        text        not null,

  result_json        jsonb       not null,         -- shape per caller (see header)
  char_count         integer     not null,         -- input chars (for cost analysis)

  created_at         timestamptz not null default now(),
  last_accessed_at   timestamptz not null default now(),
  hit_count          integer     not null default 0,

  primary key (content_hash, source_lang, target_lang)
);

-- LRU index for future eviction (if/when the table outgrows the free Supabase tier).
create index rs_translation_cache_lru_idx
  on public.rs_translation_cache (last_accessed_at);

-- Service-role only access (no public read/write):
alter table public.rs_translation_cache enable row level security;


-- =============================================================================
-- rs_translate_daily_usage: global daily char counter + USD cap
-- =============================================================================
-- One row per UTC day. Tracks billed chars against the daily USD cap.
-- Mirrors asr_provider_daily_usage. `billed_chars` accumulates only for cache MISSES
-- that actually go to Google — cache hits are free and don't increment.

create table public.rs_translate_daily_usage (
  usage_date         date          primary key,
  billed_chars       bigint        not null default 0,
  spend_cap_usd      numeric(10,2),
  updated_at         timestamptz   not null default now()
);

alter table public.rs_translate_daily_usage enable row level security;


-- =============================================================================
-- rs_translate_ip_daily: per-IP daily char counter
-- =============================================================================
-- Tracks per-IP char spend for the day. Each row = (date, IP). Old rows are
-- never read after their day rolls over — a daily cleanup cron can prune
-- rows older than 7 days if the table grows (not pre-built; revisit if
-- row count exceeds ~1M).

create table public.rs_translate_ip_daily (
  usage_date         date         not null,
  ip                 text         not null,
  chars_used         bigint       not null default 0,
  updated_at         timestamptz  not null default now(),
  primary key (usage_date, ip)
);

alter table public.rs_translate_ip_daily enable row level security;


-- =============================================================================
-- reserve_translate_chars: atomic two-table cap check + increment RPC
-- =============================================================================
-- Called BEFORE submitting to Google. Checks BOTH the global daily $ cap AND
-- the per-IP char cap atomically. Returns the post-increment counters on
-- success. Returns 0 rows on cap_hit (caller treats as a refusal).
--
-- Atomicity: SQL functions execute within a single transaction. We use
-- `SELECT ... FOR UPDATE` to lock the date rows so concurrent calls serialize
-- on the same row. All checks happen BEFORE any UPDATEs commit — if either
-- check fails, the function returns early and no counters were touched.
--
-- Cap conversion: p_global_cap_usd is in USD, converted to chars internally
-- via p_rate_per_million ($20 default for Google Translate v2). Passing
-- p_global_cap_usd <= 0 means "no cap" (admin path / local dev).
--
-- Per-IP cap: p_per_ip_cap_chars in raw chars (skipping the USD round-trip
-- because per-IP is naturally a char limit, not a $ limit). 0 = no per-IP cap.
-- Empty p_ip = skip per-IP check entirely (trusted-server-side calls).

create or replace function public.reserve_translate_chars(
  p_chars             bigint,
  p_ip                text,
  p_global_cap_usd    numeric,
  p_per_ip_cap_chars  bigint,
  p_rate_per_million  numeric default 20.00
) returns table(global_chars_after bigint, ip_chars_after bigint) language plpgsql as $$
declare
  v_global_billed     bigint;
  v_ip_used           bigint := 0;
  v_global_cap_chars  bigint;
begin
  -- Convert global cap (USD) to chars. -1 = no cap (admin / local dev).
  v_global_cap_chars := case
    when p_global_cap_usd <= 0 then -1
    else floor(p_global_cap_usd * 1000000.0 / p_rate_per_million)::bigint
  end;

  -- Upsert + lock today's global row.
  insert into public.rs_translate_daily_usage (usage_date, billed_chars, spend_cap_usd)
  values (current_date, 0, p_global_cap_usd)
  on conflict (usage_date) do update set spend_cap_usd = excluded.spend_cap_usd;

  select billed_chars into v_global_billed
    from public.rs_translate_daily_usage
   where usage_date = current_date
   for update;

  -- Global cap check — exit early if exceeded (no row updates committed yet).
  if v_global_cap_chars >= 0 and v_global_billed + p_chars > v_global_cap_chars then
    return;
  end if;

  -- Upsert + lock today's per-IP row (skip if no IP given — trusted-server path).
  if p_ip is not null and p_ip <> '' then
    insert into public.rs_translate_ip_daily (usage_date, ip, chars_used)
    values (current_date, p_ip, 0)
    on conflict (usage_date, ip) do nothing;

    select chars_used into v_ip_used
      from public.rs_translate_ip_daily
     where usage_date = current_date and ip = p_ip
     for update;

    -- Per-IP cap check.
    if p_per_ip_cap_chars > 0 and v_ip_used + p_chars > p_per_ip_cap_chars then
      return;
    end if;
  end if;

  -- Both checks passed — commit the increments.
  update public.rs_translate_daily_usage
     set billed_chars = billed_chars + p_chars,
         updated_at   = now()
   where usage_date = current_date;

  if p_ip is not null and p_ip <> '' then
    update public.rs_translate_ip_daily
       set chars_used = chars_used + p_chars,
           updated_at = now()
     where usage_date = current_date and ip = p_ip;
  end if;

  return query select v_global_billed + p_chars, v_ip_used + p_chars;
end;
$$;


-- =============================================================================
-- Verification queries (run these after migration to confirm)
-- =============================================================================
-- Should return 0:
--   SELECT count(*) FROM public.rs_translation_cache;
--   SELECT count(*) FROM public.rs_translate_daily_usage;
--   SELECT count(*) FROM public.rs_translate_ip_daily;
--
-- Should list 1 function:
--   SELECT proname FROM pg_proc WHERE proname = 'reserve_translate_chars';
--
-- Quick smoke-test the reservation RPC (no real Google call, just exercises
-- the function — this WILL create today's row in rs_translate_daily_usage):
--   SELECT * FROM public.reserve_translate_chars(0, '127.0.0.1', 15.00, 333000, 20.00);
--   SELECT * FROM public.rs_translate_daily_usage;
--   SELECT * FROM public.rs_translate_ip_daily;
--   -- Expected: row for today with billed_chars=0, spend_cap_usd=15.00
--   --           row for (today, 127.0.0.1) with chars_used=0
--
-- Cap-hit smoke-test (should return 0 rows):
--   SELECT * FROM public.reserve_translate_chars(1000000, '127.0.0.1', 15.00, 333000, 20.00);
--   -- 1M chars × $20/M = $20 > $15 cap → 0 rows
